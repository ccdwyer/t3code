import type { AssetResource } from "@t3tools/contracts";
import {
  AssetAttachmentNotFoundError,
  AssetPreviewTypeValidationError,
  AssetProjectFaviconInspectionError,
  AssetProjectFaviconNotFoundError,
  AssetProjectFaviconResolutionError,
  AssetSigningKeyLoadError,
  AssetWorkspaceAssetInspectionError,
  AssetWorkspaceAssetNotFoundError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspacePathValidationError,
  AssetWorkspaceResolutionError,
  AssetWorkspaceRootNormalizationError,
} from "@t3tools/contracts";
import {
  isWorkspaceImagePreviewPath,
  isWorkspacePreviewEntryPath,
  WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
} from "@t3tools/shared/filePreview";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { detectArtifactKind, isValidTicketDirKey } from "../workflow/artifactRules.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const ASSET_ROUTE_PREFIX = "/api/assets";

const SIGNING_SECRET_NAME = "asset-access-signing-key";
const ASSET_TOKEN_TTL_MS = 60 * 60 * 1000;
// Ticket artifacts get a longer bucket (spec §Serving): <video> fetches
// ranges lazily and a 60-min URL would die mid-watch/mid-seek.
const TICKET_ARTIFACT_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const PROJECT_FAVICON_TOKEN_BUCKET_MS = 30 * 60 * 1000;
const PROJECT_FAVICON_VERSION_PREFIX = "v";
const PREVIEW_ASSET_EXTENSIONS = new Set([
  ...WORKSPACE_BROWSER_PREVIEW_EXTENSIONS,
  ...WORKSPACE_IMAGE_PREVIEW_EXTENSIONS,
  ".css",
  ".js",
  ".mjs",
  ".otf",
  ".ttf",
  ".woff",
  ".woff2",
]);

const AssetClaimsSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file"),
    workspaceRoot: Schema.String,
    baseRelativePath: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("workspace-file-exact"),
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("ticket-artifact"),
    ticketId: Schema.String,
    artifactId: Schema.String,
    expiresAt: Schema.Number,
  }),
  // Ticket SCRATCH file (spec 2026-08-06-scratch-artifact-viewer §C). Signed
  // for one exact worktree-relative path inside `.t3/ticket/<ticketId>/`, with
  // the mime resolved from the shared kind table at issue time. Deliberately
  // NOT reachable from the public AssetResource union — see
  // `TicketScratchResource` below.
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("ticket-scratch"),
    workspaceRoot: Schema.String,
    ticketId: Schema.String,
    relativePath: Schema.String,
    mime: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("attachment"),
    attachmentId: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("project-favicon"),
    workspaceRoot: Schema.String,
    relativePath: Schema.NullOr(Schema.String),
    expiresAt: Schema.Number,
  }),
]);
type AssetClaims = typeof AssetClaimsSchema.Type;

const AssetClaimsJson = Schema.fromJsonString(AssetClaimsSchema);
const decodeAssetClaims = Schema.decodeUnknownOption(AssetClaimsJson);
const encodeAssetClaims = Schema.encodeSync(AssetClaimsJson);

export type ResolvedAsset =
  | { readonly kind: "file"; readonly path: string }
  | {
      // Ticket artifact: the row was resolved DB-authoritatively and the blob
      // must be opened via the store's verified-fd primitive by the route.
      readonly kind: "ticket-artifact";
      readonly ticketId: string;
      readonly artifactId: string;
    }
  | {
      // Ticket scratch: a worktree file the route must open through the shared
      // contained-open primitive, rooted at the canonical ticket directory.
      // Everything here comes from the SIGNED claim; nothing from the request.
      readonly kind: "scratch-file";
      readonly workspaceRoot: string;
      readonly ticketId: string;
      readonly relativePath: string;
      readonly mime: string;
      readonly displayName: string;
    };

function decodeClaims(encodedPayload: string): AssetClaims | null {
  try {
    return Option.getOrNull(decodeAssetClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

function decodeRelativePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

const optionOnNotFound = <A, R>(
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<Option.Option<A>, PlatformError.PlatformError, R> =>
  effect.pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none<A>()) : Effect.fail(error),
    }),
  );

const resolveCanonicalWorkspaceFile = Effect.fn("AssetAccess.resolveCanonicalWorkspaceFile")(
  function* (input: { readonly workspaceRoot: string; readonly relativePath: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
    const resolved = yield* workspacePaths.resolveRelativePathWithinRoot(input).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        WorkspacePathOutsideRootError: () => Effect.succeed(Option.none()),
      }),
    );
    if (Option.isNone(resolved)) return null;

    const [canonicalRoot, canonicalFile] = yield* Effect.all([
      optionOnNotFound(fileSystem.realPath(input.workspaceRoot)),
      optionOnNotFound(fileSystem.realPath(resolved.value.absolutePath)),
    ]);
    if (Option.isNone(canonicalRoot) || Option.isNone(canonicalFile)) return null;

    const path = yield* Path.Path;
    const relative = path.relative(canonicalRoot.value, canonicalFile.value);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

    const info = yield* optionOnNotFound(fileSystem.stat(canonicalFile.value));
    return Option.isSome(info) && info.value.type === "File" ? canonicalFile.value : null;
  },
);

const resolveCanonicalWorkspaceFileForRequest = (input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
}) =>
  resolveCanonicalWorkspaceFile(input).pipe(
    Effect.tapError((cause) =>
      Effect.logError("Failed to resolve canonical asset path.", {
        workspaceRoot: input.workspaceRoot,
        relativePath: input.relativePath,
        cause,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

/**
 * Server-private asset resource for ticket scratch files.
 *
 * This is deliberately NOT a member of the public `AssetResource` union
 * (`packages/contracts/src/assets.ts`). The generic `assets.createUrl` RPC
 * forwards every non-`workspace-file` resource straight to `issueAssetUrl`
 * (`ws.ts`), so a public tag would let any caller holding `orchestration:read`
 * mint a claim with a caller-chosen `workspaceRoot` and `mime` — containment
 * would be evaluated against the attacker's own root, and a chosen `text/html`
 * would be served under `sandbox allow-scripts`. Keeping the tag out of the
 * payload schema means a client cannot express it at all, which is stronger
 * than `ticket-artifact`'s runtime rejection.
 */
/**
 * The scan-relative tail of a ticket-scratch path: `.t3/ticket/<id>/<rest>`.
 * Returns `rest`, or null when the shape is wrong. Purely lexical — the real
 * containment decision is `openContained` against the canonical ticket dir;
 * this only rejects obviously-malformed claims early and cheaply.
 */
export const ticketScratchRelativeTail = (
  relativePath: string,
  ticketId: string,
): string | null => {
  if (relativePath.includes("\0") || relativePath.includes("\\")) return null;
  if (relativePath.startsWith("/")) return null;
  const prefix = `.t3/ticket/${ticketId}/`;
  if (!relativePath.startsWith(prefix)) return null;
  const rest = relativePath.slice(prefix.length);
  if (rest.length === 0) return null;
  const segments = rest.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return rest;
};

/**
 * Gates re-checked at SERVE time against the claim's own fields (spec §C).
 * Deliberately the same predicate the issuer uses, so the two cannot drift.
 * Canonical containment and the `artifacts/` exclusion are NOT here — those
 * need the filesystem and are enforced by the route's contained open.
 */
const isValidTicketScratchClaim = (claims: {
  readonly ticketId: string;
  readonly relativePath: string;
  readonly mime: string;
}): boolean => {
  if (!isValidTicketDirKey(claims.ticketId)) return false;
  const rest = ticketScratchRelativeTail(claims.relativePath, claims.ticketId);
  if (rest === null) return false;
  // The mime must be one the shared kind table would have produced for this
  // name, so a tampered-but-somehow-signed mime cannot pick the CSP class.
  const detected = detectArtifactKind(rest);
  return detected !== null && detected.mime === claims.mime;
};

export interface TicketScratchResource {
  readonly _tag: "ticket-scratch";
  readonly workspaceRoot: string;
  readonly ticketId: string;
  readonly relativePath: string;
  readonly mime: string;
}

export const issueAssetUrl = Effect.fn("AssetAccess.issueAssetUrl")(function* (input: {
  readonly resource: AssetResource;
  readonly workspaceRoot?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  let expiresAt = (yield* Clock.currentTimeMillis) + ASSET_TOKEN_TTL_MS;
  let claims: AssetClaims;
  let fileName: string;

  switch (input.resource._tag) {
    case "workspace-file": {
      if (!input.workspaceRoot) {
        return yield* new AssetWorkspaceContextNotFoundError({
          resource: input.resource,
        });
      }
      const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceRootNormalizationError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const relativePath = path.isAbsolute(input.resource.path)
        ? path.relative(workspaceRoot, input.resource.path)
        : input.resource.path;
      const resolved = yield* workspacePaths
        .resolveRelativePathWithinRoot({ workspaceRoot, relativePath })
        .pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspacePathValidationError({
                resource: input.resource,
                cause,
              }),
          ),
        );
      if (!isWorkspacePreviewEntryPath(resolved.relativePath)) {
        return yield* new AssetPreviewTypeValidationError({
          resource: input.resource,
        });
      }
      const canonicalFile = yield* resolveCanonicalWorkspaceFile({
        workspaceRoot,
        relativePath: resolved.relativePath,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceAssetInspectionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      if (!canonicalFile) {
        return yield* new AssetWorkspaceAssetNotFoundError({
          resource: input.resource,
        });
      }
      const canonicalWorkspaceRoot = yield* fileSystem.realPath(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceResolutionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      claims = isWorkspaceImagePreviewPath(resolved.relativePath)
        ? {
            version: 1,
            kind: "workspace-file-exact",
            workspaceRoot: canonicalWorkspaceRoot,
            relativePath: resolved.relativePath,
            expiresAt,
          }
        : {
            version: 1,
            kind: "workspace-file",
            workspaceRoot: canonicalWorkspaceRoot,
            baseRelativePath: path.dirname(resolved.relativePath),
            expiresAt,
          };
      fileName = path.basename(resolved.relativePath);
      break;
    }
    case "ticket-artifact": {
      // DB-authoritative pair; existence is verified at serve time via the
      // store's verified-open. The 6h bucket overrides the default TTL.
      expiresAt = (yield* Clock.currentTimeMillis) + TICKET_ARTIFACT_TOKEN_TTL_MS;
      claims = {
        version: 1,
        kind: "ticket-artifact",
        ticketId: input.resource.ticketId,
        artifactId: input.resource.artifactId,
        expiresAt,
      };
      fileName = input.resource.fileName.slice(input.resource.fileName.lastIndexOf("/") + 1);
      break;
    }
    case "attachment": {
      const config = yield* ServerConfig.ServerConfig;
      const attachmentPath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: input.resource.attachmentId,
      });
      if (!attachmentPath) {
        return yield* new AssetAttachmentNotFoundError({
          resource: input.resource,
        });
      }
      claims = {
        version: 1,
        kind: "attachment",
        attachmentId: input.resource.attachmentId,
        expiresAt,
      };
      fileName = path.basename(attachmentPath);
      break;
    }
    case "project-favicon": {
      const workspaceRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.resource.cwd).pipe(
        Effect.mapError(
          (cause) =>
            new AssetWorkspaceRootNormalizationError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const faviconResolver = yield* ProjectFaviconResolver.ProjectFaviconResolver;
      const faviconPath = yield* faviconResolver.resolvePath(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new AssetProjectFaviconResolutionError({
              resource: input.resource,
              cause,
            }),
        ),
      );
      const relativePath = faviconPath ? path.relative(workspaceRoot, faviconPath) : null;
      const canonicalFaviconPath = relativePath
        ? yield* resolveCanonicalWorkspaceFile({ workspaceRoot, relativePath }).pipe(
            Effect.mapError(
              (cause) =>
                new AssetProjectFaviconInspectionError({
                  resource: input.resource,
                  cause,
                }),
            ),
          )
        : null;
      if (relativePath && !canonicalFaviconPath) {
        return yield* new AssetProjectFaviconNotFoundError({
          resource: input.resource,
        });
      }
      claims = {
        version: 1,
        kind: "project-favicon",
        workspaceRoot: yield* fileSystem.realPath(workspaceRoot).pipe(
          Effect.mapError(
            (cause) =>
              new AssetWorkspaceResolutionError({
                resource: input.resource,
                cause,
              }),
          ),
        ),
        relativePath,
        expiresAt,
      };
      if (relativePath && canonicalFaviconPath) {
        const crypto = yield* Crypto.Crypto;
        const faviconBytes = yield* fileSystem.readFile(canonicalFaviconPath).pipe(
          Effect.mapError(
            (cause) =>
              new AssetProjectFaviconInspectionError({
                resource: input.resource,
                cause,
              }),
          ),
        );
        const revision = yield* crypto.digest("SHA-256", faviconBytes).pipe(
          Effect.map(Encoding.encodeHex),
          Effect.mapError(
            (cause) =>
              new AssetProjectFaviconInspectionError({
                resource: input.resource,
                cause,
              }),
          ),
        );
        fileName = `${PROJECT_FAVICON_VERSION_PREFIX}${revision}-${path.basename(relativePath)}`;
      } else {
        fileName = PROJECT_FAVICON_FALLBACK_MARKER;
      }
      break;
    }
  }

  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
    Effect.mapError(
      (cause) =>
        new AssetSigningKeyLoadError({
          resource: input.resource,
          cause,
        }),
    ),
  );
  if (claims.kind === "project-favicon") {
    const issuedAt = yield* Clock.currentTimeMillis;
    expiresAt =
      (Math.floor(issuedAt / PROJECT_FAVICON_TOKEN_BUCKET_MS) + 2) *
      PROJECT_FAVICON_TOKEN_BUCKET_MS;
    claims = { ...claims, expiresAt };
  }
  const encodedPayload = base64UrlEncode(encodeAssetClaims(claims));
  const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
  return {
    relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`,
    expiresAt,
  };
});

/**
 * Sign a URL for one exact ticket-scratch file (spec §C).
 *
 * A separate entry point rather than an arm of `issueAssetUrl`, for two
 * reasons: the resource must not appear in the public `AssetResource` union
 * (see `TicketScratchResource`), and `Schema.TaggedStruct` leaves `_tag`
 * optional on the decoded type, so adding a server-private member would defeat
 * the discriminated narrowing the existing switch relies on.
 *
 * The CALLER is responsible for the containment gates (§C 1-5) — it holds the
 * verified handle from `openContained` and has already proven the path is a
 * regular file inside the canonical ticket directory, outside `artifacts/`, of
 * a recognized kind, and within the size cap. This function only signs.
 */
export const issueTicketScratchUrl = Effect.fn("AssetAccess.issueTicketScratchUrl")(function* (
  resource: TicketScratchResource,
) {
  const path = yield* Path.Path;
  const expiresAt = (yield* Clock.currentTimeMillis) + TICKET_ARTIFACT_TOKEN_TTL_MS;
  const claims: AssetClaims = {
    version: 1,
    kind: "ticket-scratch",
    workspaceRoot: resource.workspaceRoot,
    ticketId: resource.ticketId,
    relativePath: resource.relativePath,
    mime: resource.mime,
    expiresAt,
  };
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
  const encodedPayload = base64UrlEncode(encodeAssetClaims(claims));
  const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
  // The URL tail is the BASENAME only; nested scratch names keep their full
  // relative path in the (signed) claim. Serve time compares the tail to the
  // claim basename as an integrity check and never joins it into a path.
  const fileName = path.basename(resource.relativePath);
  return {
    relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`,
    expiresAt,
  };
});

export const resolveAsset = Effect.fn("AssetAccess.resolveAsset")(function* (
  token: string,
  relativePath: string,
) {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
    Effect.tapError((cause) => Effect.logError("Failed to load the asset signing key.", { cause })),
    Effect.orElseSucceed(() => null),
  );
  if (!signingSecret) return null;
  if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))) return null;

  const claims = decodeClaims(encodedPayload);
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;

  if (claims.kind === "ticket-artifact") {
    // Resolution + verified open happen in the route via TicketArtifactStore
    // (ticket-bound getRow + openVerifiedBlob); this layer only proves the
    // signature and TTL.
    return {
      kind: "ticket-artifact",
      ticketId: claims.ticketId,
      artifactId: claims.artifactId,
    } satisfies ResolvedAsset;
  }

  if (claims.kind === "attachment") {
    const config = yield* ServerConfig.ServerConfig;
    const attachmentPath = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: claims.attachmentId,
    });
    if (!attachmentPath) return null;
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* optionOnNotFound(fileSystem.stat(attachmentPath)).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to inspect attachment asset.", {
          attachmentId: claims.attachmentId,
          path: attachmentPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );
    return Option.isSome(info) && info.value.type === "File"
      ? ({ kind: "file", path: attachmentPath } satisfies ResolvedAsset)
      : null;
  }

  if (claims.kind === "project-favicon") {
    if (claims.relativePath === null) return null;
    const faviconPath = yield* resolveCanonicalWorkspaceFileForRequest({
      workspaceRoot: claims.workspaceRoot,
      relativePath: claims.relativePath,
    });
    return faviconPath ? ({ kind: "file", path: faviconPath } satisfies ResolvedAsset) : null;
  }

  const decodedPath = decodeRelativePath(relativePath);
  if (decodedPath === null) return null;
  const path = yield* Path.Path;
  if (claims.kind === "ticket-scratch") {
    // Integrity check ONLY: the tail must be the claim's basename. It is never
    // joined into a path — the served path comes wholly from the claim.
    if (decodedPath !== path.basename(claims.relativePath)) return null;
    // Re-validate the issuance gates against the claim's own fields, so a
    // claim minted before a rule tightened cannot outlive it.
    if (!isValidTicketScratchClaim(claims)) return null;
    return {
      kind: "scratch-file",
      workspaceRoot: claims.workspaceRoot,
      ticketId: claims.ticketId,
      relativePath: claims.relativePath,
      mime: claims.mime,
      displayName: path.basename(claims.relativePath),
    } satisfies ResolvedAsset;
  }
  if (claims.kind === "workspace-file-exact") {
    if (decodedPath !== path.basename(claims.relativePath)) return null;
    const exactWorkspaceFile = yield* resolveCanonicalWorkspaceFileForRequest({
      workspaceRoot: claims.workspaceRoot,
      relativePath: claims.relativePath,
    });
    return exactWorkspaceFile
      ? ({ kind: "file", path: exactWorkspaceFile } satisfies ResolvedAsset)
      : null;
  }
  const segments = decodedPath.split(/[\\/]/);
  if (
    decodedPath.length === 0 ||
    decodedPath.includes("\0") ||
    segments.some((segment) => segment === "." || segment === ".." || segment.startsWith(".")) ||
    !PREVIEW_ASSET_EXTENSIONS.has(path.extname(decodedPath).toLowerCase())
  ) {
    return null;
  }
  const joinedRelativePath =
    claims.baseRelativePath === "." ? decodedPath : path.join(claims.baseRelativePath, decodedPath);
  const workspaceFile = yield* resolveCanonicalWorkspaceFileForRequest({
    workspaceRoot: claims.workspaceRoot,
    relativePath: joinedRelativePath,
  });
  return workspaceFile ? ({ kind: "file", path: workspaceFile } satisfies ResolvedAsset) : null;
});
