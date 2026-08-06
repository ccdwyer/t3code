// @effect-diagnostics nodeBuiltinImport:off
/**
 * C2 durability E2E (plan §C2, spec AC1/8/13): a worktree produces a
 * markdown plan, a captioned image, and a video; the finalizer ingests
 * them; the worktree is then REMOVED entirely; every kind must still be
 * fully readable — bytes, caption, and a partial (seek) window for the
 * video — from durable storage alone.
 */
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
import { decideRange } from "../../assets/artifactServing.ts";
import {
  TicketArtifactFinalizer,
  TicketWorktreeLocator,
} from "../Services/TicketArtifactFinalizer.ts";
import { TicketArtifactPaths, TicketArtifactStore } from "../Services/TicketArtifactStore.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { TicketArtifactFinalizerLive } from "./TicketArtifactFinalizer.ts";
import { TicketArtifactStoreLive } from "./TicketArtifactStore.ts";

const harness = (pathBox: { path: string }) => {
  const locatorLayer = Layer.succeed(TicketWorktreeLocator, {
    locate: () => Effect.sync(() => ({ path: pathBox.path })),
  });
  const committerLayer = Layer.succeed(WorkflowEventCommitter, {
    commit: () => Effect.sync(() => undefined as never),
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
        return out.sort((left, right) =>
          Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
        );
      }),
  } as never);
  const pathsLayer = Layer.effect(
    TicketArtifactPaths,
    Effect.promise(async () => ({
      rootDir: await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "ticket-artifacts-e2e-")),
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

// A tiny but real-shaped payload per kind. The "video" is >1 read window
// so the partial read exercises a genuine interior slice.
const PLAN_MD = "# Plan\n\nSteps one and two.\n";
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from(randomUUID().repeat(8)),
]);
const CAPTION = "Board after the fix — lane counts visible.";
const VIDEO_BYTES = Buffer.concat([
  Buffer.from("Eߣwebm-header", "utf8"),
  Buffer.alloc(64 * 1024, 0x5a),
  Buffer.from("cluster-tail", "utf8"),
]);

describe("ticket-artifact durability E2E (C2)", () => {
  it.effect("md + captioned png + webm survive worktree deletion; video is range-readable", () => {
    const pathBox = { path: "unset" };
    return Effect.gen(function* () {
      const ticketId = TicketId.make(randomUUID());
      const worktree = yield* Effect.promise(() =>
        Fs.mkdtemp(NodePath.join(Os.tmpdir(), "ticket-artifacts-e2e-wt-")),
      );
      pathBox.path = worktree;
      const dir = NodePath.join(worktree, ".t3", "ticket", String(ticketId), "artifacts");
      yield* Effect.promise(async () => {
        await Fs.mkdir(dir, { recursive: true });
        await Fs.writeFile(NodePath.join(dir, "PLAN.md"), PLAN_MD);
        await Fs.writeFile(NodePath.join(dir, "after.png"), PNG_BYTES);
        await Fs.writeFile(NodePath.join(dir, "after.png.caption.md"), CAPTION);
        await Fs.writeFile(NodePath.join(dir, "demo.webm"), VIDEO_BYTES);
      });

      const finalizer = yield* TicketArtifactFinalizer;
      const store = yield* TicketArtifactStore;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
          INSERT INTO projection_ticket
            (ticket_id, board_id, title, current_lane_key, status, created_at, updated_at)
          VALUES (${String(ticketId)}, ${"b"}, ${"t"}, ${"l"}, ${"idle"}, ${"2026-08-05T00:00:00Z"}, ${"2026-08-05T00:00:00Z"})
        `;
      const result = yield* finalizer.finalizeStep({
        ticketId,
        stepRunId: undefined,
      });
      assert.isTrue(result.ok);

      // The durability moment: the worktree is GONE from here on.
      yield* Effect.promise(() => Fs.rm(worktree, { recursive: true, force: true }));

      const rows = yield* store.list(ticketId);
      assert.deepEqual(
        rows.map((row) => [row.name, row.kind] as const),
        [
          ["PLAN.md", "markdown"],
          ["after.png", "image"],
          ["demo.webm", "video"],
        ],
      );
      const image = rows.find((row) => row.name === "after.png");
      assert.equal(image?.description, CAPTION);

      // AC8: markdown text readable inline from durable storage.
      const planRow = rows.find((row) => row.name === "PLAN.md");
      assert.isDefined(planRow);
      if (planRow !== undefined) {
        const inline = yield* store.readInlineText(ticketId, planRow.artifactId, 4096);
        assert.equal(inline, PLAN_MD);
      }

      // AC1: image bytes byte-identical via the verified-blob primitive.
      assert.isDefined(image);
      if (image !== undefined) {
        const blob = yield* store.openVerifiedBlob(image);
        assert.isNotNull(blob);
        if (blob !== null) {
          const bytes = yield* blob.read(blob.size);
          yield* blob.close();
          assert.isTrue(Buffer.from(bytes).equals(PNG_BYTES));
        }
      }

      // AC13: the video serves a real interior Range window (seek).
      const video = rows.find((row) => row.name === "demo.webm");
      assert.isDefined(video);
      if (video !== undefined) {
        assert.equal(video.byteSize, VIDEO_BYTES.length);
        const blob = yield* store.openVerifiedBlob(video);
        assert.isNotNull(blob);
        if (blob !== null) {
          const decision = decideRange(`bytes=${String(VIDEO_BYTES.length - 512)}-`, blob.size);
          assert.equal(decision.kind, "partial");
          if (decision.kind === "partial") {
            const slice = yield* blob.readRange(decision.start, decision.end);
            assert.isTrue(
              Buffer.from(slice).equals(VIDEO_BYTES.subarray(VIDEO_BYTES.length - 512)),
            );
          }
          yield* blob.close();
        }
      }
    }).pipe(Effect.provide(harness(pathBox))) as never;
  });
});
