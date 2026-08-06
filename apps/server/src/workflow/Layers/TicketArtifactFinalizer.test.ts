// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as NodePath from "node:path";

import { TicketId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import {
  TicketArtifactFinalizer,
  TicketWorktreeLocator,
} from "../Services/TicketArtifactFinalizer.ts";
import {
  TicketArtifactPaths,
  TicketArtifactStore,
  type IngestReport,
} from "../Services/TicketArtifactStore.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { formatSkipNote, TicketArtifactFinalizerLive } from "./TicketArtifactFinalizer.ts";
import { TicketArtifactStoreLive } from "./TicketArtifactStore.ts";

describe("formatSkipNote", () => {
  const report = (over: Partial<IngestReport>): IngestReport => ({
    ingested: [],
    skips: [],
    ticketMissing: false,
    scanTruncated: false,
    ...over,
  });

  it("returns null for a clean report", () => {
    assert.isNull(formatSkipNote(report({ ingested: ["a.md"] })));
  });

  it("names allowed extensions for unknown-extension skips, in canonical order", () => {
    const note = formatSkipNote(
      report({
        skips: [
          { name: "z.pdf", reason: "unknown-extension" },
          { name: "a.svg", reason: "unknown-extension" },
        ],
      }),
    );
    assert.isNotNull(note);
    if (note !== null) {
      const aIndex = note.indexOf("a.svg");
      const zIndex = note.indexOf("z.pdf");
      assert.isAbove(zIndex, aIndex);
      assert.include(note, ".md");
      assert.include(note, ".webm");
    }
  });

  it("caps at 20 named files and reports scan truncation", () => {
    const skips = Array.from({ length: 25 }, (_, i) => ({
      name: `file-${String(i).padStart(2, "0")}.xyz`,
      reason: "unknown-extension" as const,
    }));
    const note = formatSkipNote(report({ skips, scanTruncated: true }));
    assert.isNotNull(note);
    if (note !== null) {
      assert.include(note, "…and 5 more");
      assert.include(note, "truncated at 500 entries");
      assert.notInclude(note, "file-21.xyz");
    }
  });
});

interface CommittedEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

const finalizerHarness = (pathBox: { path: string }, committed: Array<CommittedEvent>) => {
  const locatorLayer = Layer.succeed(TicketWorktreeLocator, {
    locate: () => Effect.sync(() => ({ path: pathBox.path })),
  });
  const committerLayer = Layer.succeed(WorkflowEventCommitter, {
    commit: (event: unknown) =>
      Effect.sync(() => {
        committed.push(event as unknown as CommittedEvent);
        return undefined as never;
      }),
    commitMany: () => Effect.die("unused"),
  } as never);
  const idsLayer = Layer.succeed(WorkflowIds, {
    ticketId: () => Effect.sync(() => TicketId.make(randomUUID())),
    pipelineRunId: () => Effect.die("unused"),
    scriptRunId: () => Effect.die("unused"),
    stepRunId: () => Effect.die("unused"),
    messageId: () => Effect.sync(() => randomUUID() as never),
    eventId: () => Effect.sync(() => randomUUID() as never),
    token: () => Effect.die("unused"),
    mappingId: () => Effect.sync(() => randomUUID()),
  } as never);
  const workspaceLayer = Layer.succeed(WorkspaceFileSystem, {
    listFilesRecursive: (input: { readonly cwd: string; readonly relativePath: string }) =>
      Effect.promise(async () => {
        const root = NodePath.join(input.cwd, input.relativePath);
        const out: Array<string> = [];
        const walk = async (dir: string, prefix: string): Promise<void> => {
          const entries = await Fs.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const entry of entries) {
            const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isDirectory()) await walk(NodePath.join(dir, entry.name), rel);
            else if (entry.isFile()) out.push(rel);
          }
        };
        await walk(root, "");
        return out;
      }),
  } as never);
  const pathsLayer = Layer.effect(
    TicketArtifactPaths,
    Effect.promise(async () => ({
      rootDir: await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "ticket-artifacts-final-")),
    })),
  );
  return TicketArtifactFinalizerLive.pipe(
    Layer.provideMerge(locatorLayer),
    Layer.provideMerge(TicketArtifactStoreLive),
    Layer.provideMerge(pathsLayer),
    Layer.provideMerge(committerLayer),
    Layer.provideMerge(idsLayer),
    Layer.provideMerge(workspaceLayer),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
};

describe("TicketArtifactFinalizer", () => {
  it.effect("scans the worktree artifacts dir, ingests, and posts a skip note", () => {
    const committed: Array<CommittedEvent> = [];
    const pathBox = { path: "unset" };
    return Effect.gen(function* () {
      const ticketId = TicketId.make(randomUUID());
      const worktree = yield* Effect.promise(() =>
        Fs.mkdtemp(NodePath.join(Os.tmpdir(), "ticket-artifacts-wt-")),
      );
      pathBox.path = worktree;
      const artifactsDir = NodePath.join(worktree, ".t3", "ticket", String(ticketId), "artifacts");
      yield* Effect.promise(async () => {
        await Fs.mkdir(artifactsDir, { recursive: true });
        await Fs.writeFile(NodePath.join(artifactsDir, "PLAN.md"), "# plan");
        await Fs.writeFile(NodePath.join(artifactsDir, "diagram.svg"), "<svg/>");
      });

      const finalizer = yield* TicketArtifactFinalizer;
      const store = yield* TicketArtifactStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_ticket
          (ticket_id, board_id, title, current_lane_key, status, created_at, updated_at)
        VALUES (${String(ticketId)}, ${"b"}, ${"t"}, ${"l"}, ${"idle"}, ${"2026-08-05T00:00:00Z"}, ${"2026-08-05T00:00:00Z"})
      `;

      const result = yield* finalizer.finalizeStep({ ticketId, stepRunId: undefined });
      assert.isTrue(result.ok);

      const rows = yield* store.list(ticketId);
      assert.deepEqual(
        rows.map((row) => row.name),
        ["PLAN.md"],
      );

      // The svg skip produced ONE aggregated agent note.
      assert.lengthOf(committed, 1);
      const note = committed[0];
      assert.equal(note?.type, "TicketMessagePosted");
      assert.include(String(note?.payload["body"]), "diagram.svg");
      assert.include(String(note?.payload["body"]), "unsupported extension");
    }).pipe(Effect.provide(finalizerHarness(pathBox, committed))) as never;
  });

  it.effect("no worktree = silent success; missing artifacts dir = silent success", () => {
    const committed: Array<CommittedEvent> = [];
    const pathBox = { path: "unset" };
    return Effect.gen(function* () {
      pathBox.path = yield* Effect.promise(() =>
        Fs.mkdtemp(NodePath.join(Os.tmpdir(), "ticket-artifacts-empty-")),
      );
      const finalizer = yield* TicketArtifactFinalizer;
      // Locator (stubbed to a dir with NO artifacts subtree) → empty scan.
      const result = yield* finalizer.finalizeStep({
        ticketId: TicketId.make(randomUUID()),
        stepRunId: undefined,
      });
      assert.isTrue(result.ok);
      assert.lengthOf(committed, 0);
    }).pipe(Effect.provide(finalizerHarness(pathBox, committed))) as never;
  });
});
