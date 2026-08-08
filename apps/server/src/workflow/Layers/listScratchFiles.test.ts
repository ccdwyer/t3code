// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { TicketId, WORKFLOW_WS_METHODS, type WorkflowTicketArtifact } from "@t3tools/contracts";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";

import { make as makeWorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import { workflowRpcHandlers } from "./WorkflowRpcHandlers.ts";

/**
 * The scratch half of `workflow.listTicketArtifacts` (spec
 * 2026-08-06-scratch-artifact-viewer §D). These run against a REAL temp
 * worktree because the behaviors under test — contained open, symlink refusal,
 * canonical artifacts exclusion — are filesystem behaviors that a mocked
 * filesystem would assert away.
 */

const TICKET = "ticket-1";

const TEMP_DIRS: Array<string> = [];
afterAll(() => {
  // Each case makes a temp worktree; without this they accumulate under the
  // system temp dir across watch and CI runs.
  for (const dir of TEMP_DIRS) NodeFS.rmSync(dir, { recursive: true, force: true });
});

const makeWorktree = () => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scratch-rpc-"));
  TEMP_DIRS.push(cwd);
  const ticketDir = NodePath.join(cwd, ".t3", "ticket", TICKET);
  NodeFS.mkdirSync(ticketDir, { recursive: true });
  return { cwd, ticketDir };
};

/** One merged provide: chaining them can break service lifecycles. */
const PLATFORM = NodeServices.layer;
const PATHS = WorkspacePaths.layer.pipe(Layer.provide(PLATFORM));
const ENTRIES = WorkspaceEntries.layer.pipe(Layer.provide(Layer.mergeAll(PATHS, PLATFORM)));
const TEST_LAYER = Layer.mergeAll(PATHS, ENTRIES, PLATFORM);

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);

describe("listTicketArtifacts — scratch rows", () => {
  const listScratch = (cwd: string) =>
    Effect.gen(function* () {
      const handlers = workflowRpcHandlers({
        observeRpcEffect: (_name: string, effect: unknown) => effect,
        workspaceFileSystem: yield* makeWorkspaceFileSystem,
        ticketWorktrees: {
          resolveForTicket: () => Effect.succeed({ cwd, baseRef: "main" }),
        },
        issueScratchUrl: (input: { readonly relativePath: string }) =>
          Effect.succeed({
            relativeUrl: `/api/assets/tok/${NodePath.basename(input.relativePath)}`,
          }),
      } as never) as unknown as Record<
        string,
        (input: unknown) => Effect.Effect<{
          readonly scratch: ReadonlyArray<WorkflowTicketArtifact>;
        }>
      >;
      const handler = handlers[WORKFLOW_WS_METHODS.listTicketArtifacts];
      if (handler === undefined) throw new Error("listTicketArtifacts handler missing");
      const result = yield* handler({ ticketId: TicketId.make(TICKET) });
      return result.scratch;
    }).pipe(Effect.provide(TEST_LAYER));

  const byName = (rows: ReadonlyArray<WorkflowTicketArtifact>, name: string) =>
    rows.find((row) => row.name === name);

  it.effect("never reads a binary as a string, and serves it by URL instead", () =>
    Effect.gen(function* () {
      const { cwd, ticketDir } = makeWorktree();
      NodeFS.writeFileSync(NodePath.join(ticketDir, "screenshot.png"), PNG_BYTES);
      const rows = yield* listScratch(cwd);
      const png = byName(rows, "screenshot.png");
      assert.equal(png?.kind, "image");
      assert.equal(png?.byteSize, PNG_BYTES.length);
      // The regression this whole spec exists for: no PNG bytes as text.
      assert.isUndefined(png?.content);
      assert.isDefined(png?.url);
      // No row anywhere carries the PNG's bytes as text.
      assert.isFalse(rows.some((row) => (row.content ?? "").includes("PNG")));
    }),
  );

  it.effect("inlines markdown and text, and gives them no url", () =>
    Effect.gen(function* () {
      const { cwd, ticketDir } = makeWorktree();
      NodeFS.writeFileSync(NodePath.join(ticketDir, "PLAN.md"), "# plan");
      NodeFS.writeFileSync(NodePath.join(ticketDir, "run.log"), "line one");
      const rows = yield* listScratch(cwd);
      assert.equal(byName(rows, "PLAN.md")?.kind, "markdown");
      assert.equal(byName(rows, "PLAN.md")?.content, "# plan");
      assert.isUndefined(byName(rows, "PLAN.md")?.url);
      assert.equal(byName(rows, "run.log")?.kind, "text");
      assert.equal(byName(rows, "run.log")?.content, "line one");
    }),
  );

  it.effect("lists a 0-byte file with byteSize 0 and empty content, not as a skip", () =>
    Effect.gen(function* () {
      const { cwd, ticketDir } = makeWorktree();
      NodeFS.writeFileSync(NodePath.join(ticketDir, "PLAN.md"), "");
      const rows = yield* listScratch(cwd);
      const plan = byName(rows, "PLAN.md");
      assert.equal(plan?.byteSize, 0);
      assert.equal(plan?.content, "");
    }),
  );

  it.effect("classifies an unknown extension as binary with no content and no url", () =>
    Effect.gen(function* () {
      const { cwd, ticketDir } = makeWorktree();
      NodeFS.writeFileSync(NodePath.join(ticketDir, "notes.zip"), "PKbinary");
      const rows = yield* listScratch(cwd);
      const zip = byName(rows, "notes.zip");
      assert.equal(zip?.kind, "binary");
      assert.isUndefined(zip?.content);
      // No signed claim exists for an unknown extension — issuing one would be
      // an arbitrary-worktree-file read primitive.
      assert.isUndefined(zip?.url);
    }),
  );

  it.effect("recognizes SVG as an image", () =>
    Effect.gen(function* () {
      const { cwd, ticketDir } = makeWorktree();
      NodeFS.writeFileSync(NodePath.join(ticketDir, "diagram.svg"), "<svg/>");
      const rows = yield* listScratch(cwd);
      assert.equal(byName(rows, "diagram.svg")?.kind, "image");
      assert.isDefined(byName(rows, "diagram.svg")?.url);
    }),
  );

  it.effect("keeps artifacts/** out of the scratch list, including a case alias", () =>
    Effect.gen(function* () {
      const { cwd, ticketDir } = makeWorktree();
      NodeFS.mkdirSync(NodePath.join(ticketDir, "artifacts"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(ticketDir, "artifacts", "kept.md"), "durable");
      NodeFS.writeFileSync(NodePath.join(ticketDir, "PLAN.md"), "# plan");
      const rows = yield* listScratch(cwd);
      assert.isDefined(byName(rows, "PLAN.md"));
      assert.isUndefined(rows.find((row) => row.name.toLowerCase().startsWith("artifacts/")));
    }),
  );

  it.effect("hides integration-owned SOURCE_SLACK.md while leaving other scratch visible", () =>
    Effect.gen(function* () {
      const { cwd, ticketDir } = makeWorktree();
      NodeFS.writeFileSync(NodePath.join(ticketDir, "SOURCE_SLACK.md"), "private slack transcript");
      NodeFS.writeFileSync(NodePath.join(ticketDir, "PLAN.md"), "# plan");
      const rows = yield* listScratch(cwd);
      assert.isDefined(byName(rows, "PLAN.md"));
      assert.isUndefined(byName(rows, "SOURCE_SLACK.md"));
      assert.isFalse(rows.some((row) => (row.content ?? "").includes("private slack transcript")));
    }),
  );

  it.effect("skips a symlink pointing at another file in the workspace", () =>
    Effect.gen(function* () {
      // Pre-existing leak: this file's contents used to be inlined verbatim.
      const { cwd, ticketDir } = makeWorktree();
      NodeFS.writeFileSync(NodePath.join(cwd, "secret.env"), "TOKEN=supersecret");
      NodeFS.symlinkSync(NodePath.join(cwd, "secret.env"), NodePath.join(ticketDir, "notes.md"));
      NodeFS.writeFileSync(NodePath.join(ticketDir, "PLAN.md"), "# plan");
      const rows = yield* listScratch(cwd);
      assert.isUndefined(byName(rows, "notes.md"));
      assert.isFalse(rows.some((row) => (row.content ?? "").includes("supersecret")));
      // The legitimate row still lists — one skip must not fail the listing.
      assert.isDefined(byName(rows, "PLAN.md"));
    }),
  );

  it.effect("counts EMITTED rows against the cap so skips cannot starve real files", () =>
    Effect.gen(function* () {
      const { cwd, ticketDir } = makeWorktree();
      NodeFS.writeFileSync(NodePath.join(cwd, "outside.md"), "nope");
      // 25 skipped symlinks sort before "zz-real.md"; a slice(0, 20) over
      // candidates would consume every slot and list nothing real.
      for (let index = 0; index < 25; index += 1) {
        NodeFS.symlinkSync(
          NodePath.join(cwd, "outside.md"),
          NodePath.join(ticketDir, `aa-${String(index).padStart(2, "0")}.md`),
        );
      }
      NodeFS.writeFileSync(NodePath.join(ticketDir, "zz-real.md"), "# real");
      const rows = yield* listScratch(cwd);
      assert.isDefined(byName(rows, "zz-real.md"));
      assert.equal(byName(rows, "zz-real.md")?.content, "# real");
    }),
  );
});
