// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ASSET_ROUTE_PREFIX, issueTicketScratchUrl, resolveAsset } from "./AssetAccess.ts";

/**
 * The signed round trip for ticket-scratch claims (spec
 * 2026-08-06-scratch-artifact-viewer §C): a real issued URL is torn back apart
 * and fed to `resolveAsset`, so the integrity check, the lexical gates, and the
 * signature all run exactly as they do in the route.
 */

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-scratch-asset-test-",
});
const testLayer = Layer.mergeAll(
  configLayer,
  WorkspacePaths.layer,
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

const TICKET = "ticket-1";

const splitUrl = (relativeUrl: string) => {
  const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
  const separatorIndex = suffix.indexOf("/");
  return {
    token: suffix.slice(0, separatorIndex),
    segment: suffix.slice(separatorIndex + 1),
  };
};

const makeWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-scratch-wt-",
  });
  const ticketDir = NodePath.join(root, ".t3", "ticket", TICKET);
  mkdirSync(NodePath.join(ticketDir, "artifacts"), { recursive: true });
  writeFileSync(NodePath.join(ticketDir, "shot.png"), "PNGDATA");
  writeFileSync(NodePath.join(ticketDir, "diagram.svg"), "<svg/>");
  return { root, ticketDir };
});

const scratch = (root: string, relativePath: string, mime: string) =>
  ({
    _tag: "ticket-scratch",
    workspaceRoot: root,
    ticketId: TICKET,
    relativePath,
    mime,
  }) as const;

describe("ticket-scratch signed asset", () => {
  it.effect("round-trips a signed media URL back to the claimed file", () =>
    Effect.gen(function* () {
      const { root } = yield* makeWorktree;
      const issued = yield* issueTicketScratchUrl(
        scratch(root, `.t3/ticket/${TICKET}/shot.png`, "image/png"),
      );
      const { token, segment } = splitUrl(issued.relativeUrl);
      // The URL tail is the BASENAME only.
      expect(segment).toBe("shot.png");
      expect(yield* resolveAsset(token, segment)).toEqual({
        kind: "scratch-file",
        workspaceRoot: root,
        ticketId: TICKET,
        relativePath: `.t3/ticket/${TICKET}/shot.png`,
        mime: "image/png",
        displayName: "shot.png",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses to resolve when the URL segment is not the claim's basename", () =>
    Effect.gen(function* () {
      const { root } = yield* makeWorktree;
      const issued = yield* issueTicketScratchUrl(
        scratch(root, `.t3/ticket/${TICKET}/shot.png`, "image/png"),
      );
      const { token } = splitUrl(issued.relativeUrl);
      // The segment is an integrity check; it is never joined into a path.
      expect(yield* resolveAsset(token, "other.png")).toBeNull();
      expect(yield* resolveAsset(token, "../secret.env")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a tampered signature", () =>
    Effect.gen(function* () {
      const { root } = yield* makeWorktree;
      const issued = yield* issueTicketScratchUrl(
        scratch(root, `.t3/ticket/${TICKET}/shot.png`, "image/png"),
      );
      const { token, segment } = splitUrl(issued.relativeUrl);
      const payload = token.split(".")[0] ?? "";
      expect(yield* resolveAsset(`${payload}.deadbeef`, segment)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses to MINT a claim outside the ticket scratch directory", () =>
    Effect.gen(function* () {
      const { root } = yield* makeWorktree;
      const attempt = (relativePath: string) =>
        issueTicketScratchUrl(scratch(root, relativePath, "image/png")).pipe(
          Effect.orElseSucceed(() => null),
        );
      expect(yield* attempt("shot.png")).toBeNull();
      expect(yield* attempt(`.t3/ticket/${TICKET}/../../../x.png`)).toBeNull();
      expect(yield* attempt(`.t3/ticket/other-ticket/shot.png`)).toBeNull();
      expect(yield* attempt(`.t3/ticket/${TICKET}/`)).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses to mint a claim whose mime disagrees with the extension", () =>
    Effect.gen(function* () {
      const { root } = yield* makeWorktree;
      // A caller-chosen text/html mime would otherwise pick the CSP class.
      const result = yield* issueTicketScratchUrl(
        scratch(root, `.t3/ticket/${TICKET}/shot.png`, "text/html; charset=utf-8"),
      ).pipe(Effect.orElseSucceed(() => null));
      expect(result).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses an unknown extension", () =>
    Effect.gen(function* () {
      const { root } = yield* makeWorktree;
      const result = yield* issueTicketScratchUrl(
        scratch(root, `.t3/ticket/${TICKET}/notes.zip`, "application/zip"),
      ).pipe(Effect.orElseSucceed(() => null));
      expect(result).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("signs SVG with its own mime so the route can sandbox it", () =>
    Effect.gen(function* () {
      const { root } = yield* makeWorktree;
      const issued = yield* issueTicketScratchUrl(
        scratch(root, `.t3/ticket/${TICKET}/diagram.svg`, "image/svg+xml"),
      );
      const { token, segment } = splitUrl(issued.relativeUrl);
      expect(yield* resolveAsset(token, segment)).toMatchObject({
        kind: "scratch-file",
        mime: "image/svg+xml",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("mints for a symlinked name — the refusal is the route's contained open", () =>
    Effect.gen(function* () {
      const { root, ticketDir } = yield* makeWorktree;
      writeFileSync(NodePath.join(root, "secret.png"), "outside");
      symlinkSync(NodePath.join(root, "secret.png"), NodePath.join(ticketDir, "link.png"));
      // Issuance is deliberately LEXICAL; the filesystem refusal belongs to
      // `openContained` (see containedOpen.test.ts). Pinned so the division of
      // responsibility is explicit rather than assumed.
      const issued = yield* issueTicketScratchUrl(
        scratch(root, `.t3/ticket/${TICKET}/link.png`, "image/png"),
      );
      expect(issued.relativeUrl).toContain(ASSET_ROUTE_PREFIX);
    }).pipe(Effect.provide(testLayer)),
  );
});
