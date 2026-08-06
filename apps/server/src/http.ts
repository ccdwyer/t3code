// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import { TicketId } from "@t3tools/contracts";

import {
  ASSET_ROUTE_PREFIX,
  resolveAsset,
  ticketScratchRelativeTail,
} from "./assets/AssetAccess.ts";
import { artifactHeaders, decideRange } from "./assets/artifactServing.ts";
import {
  activeContentFor,
  ARTIFACT_FILE_CAPS,
  detectArtifactKind,
} from "./workflow/artifactRules.ts";
import {
  decideScratchServe,
  openContained,
  resolveSubdirectoryRealpath,
  resolveTicketScratchRoot,
  SCRATCH_OPEN_OPTIONS,
} from "./workflow/containedOpen.ts";
import { TicketArtifactStore } from "./workflow/Services/TicketArtifactStore.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];
export const httpCompressionLayer = HttpRouter.middleware(HttpMiddleware.compression(), {
  global: true,
});

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    //
    // T3CODE_DEV_ALLOWED_ORIGINS covers dev servers reached from a second
    // origin — a tailnet name, a LAN IP, a phone. Browser dev normally proxies
    // through Vite and is same-origin (no preflight at all), so this is a
    // safety net for the desktop renderer and any direct-to-backend caller.
    return HttpRouter.cors({
      ...(devOrigin
        ? {
            allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS, ...config.devAllowedOrigins],
            credentials: true,
          }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }, traceRelayRequest),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

// Base headers for artifact-adjacent 404s (spec: no resolved row/kind → base
// set only; the HTML CSP is moot without a resolved kind).
const ARTIFACT_BASE_404_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
} as const;

/**
 * Serve a resolved ticket-artifact claim (spec §Serving): DB-authoritative
 * row lookup (ticket-bound), the store's verified-fd open, the pinned Range
 * decision table, and the pinned header set — identical for GET and HEAD
 * (HEAD carries no body). Open-ended range responses are clamped to an 8 MiB
 * window (RFC-legal; browsers follow up), bounding per-request memory.
 */
const ARTIFACT_RANGE_WINDOW_BYTES = 8 * 1024 * 1024;

const serveTicketArtifact = (
  asset: { readonly ticketId: string; readonly artifactId: string },
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const storeOption = yield* Effect.serviceOption(TicketArtifactStore);
    if (Option.isNone(storeOption)) {
      return HttpServerResponse.text("Not Found", {
        status: 404,
        headers: ARTIFACT_BASE_404_HEADERS,
      });
    }
    const store = storeOption.value;
    const row = yield* store
      .getRow(TicketId.make(asset.ticketId), asset.artifactId)
      .pipe(Effect.orElseSucceed(() => null));
    if (row === null) {
      return HttpServerResponse.text("Not Found", {
        status: 404,
        headers: ARTIFACT_BASE_404_HEADERS,
      });
    }
    const rowHeaders = artifactHeaders({
      mime: row.mime,
      displayName: row.name,
      activeContent: activeContentFor(row.mime),
    });
    const blob = yield* store.openVerifiedBlob(row).pipe(Effect.orElseSucceed(() => null));
    if (blob === null) {
      // Row RESOLVED: the reduced base set is reserved for no-row cases; an
      // unavailable blob still answers with the artifact's full header set.
      return HttpServerResponse.empty({ status: 404, headers: rowHeaders });
    }

    return yield* Effect.gen(function* () {
      const headers = rowHeaders;
      const isHead = request.method === "HEAD";
      const rangeHeader = request.headers["range"];
      const decision = decideRange(rangeHeader, blob.size);

      if (decision.kind === "unsatisfiable") {
        const unsatisfiableHeaders = {
          ...headers,
          "Content-Range": `bytes */${String(blob.size)}`,
        };
        // Empty body for GET too, so HEAD parity is byte-for-byte on headers
        // (a text body would add a diverging Content-Length).
        return HttpServerResponse.empty({ status: 416, headers: unsatisfiableHeaders });
      }
      if (decision.kind === "partial") {
        // The 8 MiB window applies ONLY to server-chosen ends (start- and
        // -suffix forms, where a shorter 206 is RFC-legal); explicit
        // start-end ranges are client-bounded and served exactly per the
        // pinned table.
        const end = decision.openEnded
          ? Math.min(decision.end, decision.start + ARTIFACT_RANGE_WINDOW_BYTES - 1)
          : decision.end;
        const partialHeaders = {
          ...headers,
          "Content-Range": `bytes ${String(decision.start)}-${String(end)}/${String(blob.size)}`,
          "Content-Length": String(end - decision.start + 1),
        };
        if (isHead) {
          return HttpServerResponse.empty({ status: 206, headers: partialHeaders });
        }
        const body = yield* blob
          .readRange(decision.start, end)
          .pipe(Effect.orElseSucceed(() => null));
        if (body === null) {
          return HttpServerResponse.empty({ status: 404, headers: rowHeaders });
        }
        return HttpServerResponse.uint8Array(body, { status: 206, headers: partialHeaders });
      }
      const fullHeaders = { ...headers, "Content-Length": String(blob.size) };
      if (isHead) {
        return HttpServerResponse.empty({ status: 200, headers: fullHeaders });
      }
      const body = yield* blob.read(blob.size).pipe(Effect.orElseSucceed(() => null));
      if (body === null) {
        return HttpServerResponse.empty({ status: 404, headers: rowHeaders });
      }
      return HttpServerResponse.uint8Array(body, { status: 200, headers: fullHeaders });
    }).pipe(Effect.ensuring(blob.close()));
  });

/**
 * Serve a resolved ticket-scratch claim (spec 2026-08-06-scratch-artifact-viewer
 * §C). Structurally `serveTicketArtifact` minus the DB lookup, and with the
 * same verified-handle discipline: ONE `openContained` rooted at the canonical
 * ticket directory, and every subsequent decision — size, Range math, bytes —
 * taken from that handle's fstat and positional reads. Nothing is re-derived
 * from a path, so there is no stat-then-open window.
 */
const serveTicketScratch = (
  asset: {
    readonly workspaceRoot: string;
    readonly ticketId: string;
    readonly relativePath: string;
    readonly mime: string;
    readonly displayName: string;
  },
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    const notFound = HttpServerResponse.text("Not Found", {
      status: 404,
      headers: ARTIFACT_BASE_404_HEADERS,
    });

    // Anchored to the canonical workspace root: a symlinked `.t3`/`ticket`/
    // `<id>` ancestor would otherwise pivot the contain-root and every later
    // check would enforce containment inside the attacker's directory.
    const ticketDirReal = yield* Effect.promise(() =>
      resolveTicketScratchRoot(asset.workspaceRoot, asset.ticketId),
    );
    if (ticketDirReal === null) return notFound;

    const absolutePath = NodePath.join(asset.workspaceRoot, asset.relativePath);

    // acquireRelease, not open-then-ensuring: an interrupt landing between a
    // successful open and the installation of the finalizer would leak the
    // descriptor. The scope owns the handle from the moment it exists.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* Effect.acquireRelease(
          Effect.promise(() =>
            // SCRATCH_OPEN_OPTIONS, same as the listing: without the hard-link
            // refusal here, a path listed as a normal file can be swapped for a
            // hard link to a secret between issuance and this GET.
            openContained(absolutePath, ticketDirReal, SCRATCH_OPEN_OPTIONS),
          ),
          (handle) =>
            handle === null
              ? Effect.void
              : Effect.promise(() => handle.handle.close().catch(() => undefined)),
        );
        if (opened === null) return notFound;
        const artifactsReal = yield* Effect.promise(() =>
          resolveSubdirectoryRealpath(ticketDirReal, "artifacts"),
        );
        // Kind is re-derived from the SAME scan-relative tail the issuer and the
        // claim validator use, not the full `.t3/...` path, so the three cannot
        // diverge if the kind rules ever grow name-based checks.
        const tail = ticketScratchRelativeTail(asset.relativePath, asset.ticketId);
        const detected = tail === null ? null : detectArtifactKind(tail);
        // The decision sequence lives in `decideScratchServe` so it is testable
        // without HTTP plumbing: every branch answers 404, and a regression in
        // any of them would otherwise be silent.
        if (
          decideScratchServe({
            realPath: opened.realPath,
            artifactsRealPath: artifactsReal,
            kind: detected?.kind ?? null,
            size: opened.size,
            capForKind: detected === null ? null : ARTIFACT_FILE_CAPS[detected.kind],
          }) !== "serve"
        ) {
          return notFound;
        }

        const headers = artifactHeaders({
          mime: asset.mime,
          displayName: asset.displayName,
          activeContent: activeContentFor(asset.mime),
        });
        const isHead = request.method === "HEAD";
        const decision = decideRange(request.headers["range"], opened.size);

        if (decision.kind === "unsatisfiable") {
          return HttpServerResponse.empty({
            status: 416,
            headers: { ...headers, "Content-Range": `bytes */${String(opened.size)}` },
          });
        }

        const readExactly = (start: number, length: number) =>
          // `Effect.promise` would turn an ordinary read failure into a defect
          // (500). Every other unavailable case on this route answers 404, so a
          // failed read does too; interruption still propagates.
          Effect.tryPromise(async () => {
            const buffer = Buffer.alloc(length);
            let readTotal = 0;
            while (readTotal < length) {
              const { bytesRead } = await opened.handle.read(
                buffer,
                readTotal,
                length - readTotal,
                start + readTotal,
              );
              if (bytesRead === 0) break;
              readTotal += bytesRead;
            }
            // A truncation between the fstat and the read would otherwise send a
            // body shorter than the Content-Length we already promised.
            return readTotal === length ? new Uint8Array(buffer) : null;
          }).pipe(Effect.orElseSucceed(() => null));

        if (decision.kind === "partial") {
          const end = decision.openEnded
            ? Math.min(decision.end, decision.start + ARTIFACT_RANGE_WINDOW_BYTES - 1)
            : decision.end;
          const length = end - decision.start + 1;
          const partialHeaders = {
            ...headers,
            "Content-Range": `bytes ${String(decision.start)}-${String(end)}/${String(opened.size)}`,
            "Content-Length": String(length),
          };
          if (isHead) return HttpServerResponse.empty({ status: 206, headers: partialHeaders });
          const body = yield* readExactly(decision.start, length);
          if (body === null) return notFound;
          return HttpServerResponse.uint8Array(body, { status: 206, headers: partialHeaders });
        }

        // NOTE on memory: the 8 MiB window clamps only SERVER-chosen range ends.
        // An explicit `start-end` is served exactly (the pinned Range table), and
        // a plain GET returns the whole body, so a single request can allocate up
        // to ARTIFACT_FILE_CAPS[kind]. That per-kind cap — re-checked against the
        // current size above — is the intended bound, not the window.
        const fullHeaders = { ...headers, "Content-Length": String(opened.size) };
        if (isHead) return HttpServerResponse.empty({ status: 200, headers: fullHeaders });
        const body = yield* readExactly(0, opened.size);
        if (body === null) return notFound;
        return HttpServerResponse.uint8Array(body, { status: 200, headers: fullHeaders });
      }),
    );
  });

const assetRouteHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }

  const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
  const separatorIndex = suffix.indexOf("/");
  if (separatorIndex <= 0) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }

  const asset = yield* resolveAsset(
    suffix.slice(0, separatorIndex),
    suffix.slice(separatorIndex + 1),
  );
  if (!asset) {
    // Safe headers on EVERY asset 404 — an unresolved claim (bad signature,
    // expired, segment mismatch) must not answer more loosely than a resolved
    // one that then failed.
    return HttpServerResponse.text("Not Found", {
      status: 404,
      headers: ARTIFACT_BASE_404_HEADERS,
    });
  }
  if (asset.kind === "ticket-artifact") {
    return yield* serveTicketArtifact(asset, request);
  }
  if (asset.kind === "scratch-file") {
    return yield* serveTicketScratch(asset, request);
  }
  return yield* HttpServerResponse.file(asset.path, {
    status: 200,
    headers: {
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  }).pipe(
    Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
  );
});

// "*" method match: the router has no HEAD verb, and HEAD parity is pinned
// (spec §Serving) — the handler branches on request.method, answering GET and
// HEAD and refusing everything else.
export const assetRouteLayer = HttpRouter.add(
  "*",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "GET" && request.method !== "HEAD") {
      return HttpServerResponse.text("Method Not Allowed", { status: 405 });
    }
    return yield* assetRouteHandler;
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isDevProxiedPath(url.value.pathname)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
