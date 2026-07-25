// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorktreeCoordinator } from "../Services/WorktreeCoordinator.ts";
import { WorktreeCoordinatorLive } from "./WorktreeCoordinator.ts";

const layer = it.layer(
  WorktreeCoordinatorLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorktreeCoordinator Phase A", (it) => {
  it.effect("replaceChangedPaths + serialize hold for later ticket", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const coord = yield* WorktreeCoordinator;

      // Seed two tickets on same "repo".
      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        ) VALUES
          ('t-early', 'b1', 'Early', 'impl', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('t-late', 'b1', 'Late', 'impl', 'running', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
      `;

      yield* coord.upsertRegistry({
        ticketId: "t-early" as never,
        repoRoot: "/tmp/repo",
        branch: "workflow/t-early",
      });
      yield* coord.upsertRegistry({
        ticketId: "t-late" as never,
        repoRoot: "/tmp/repo",
        branch: "workflow/t-late",
      });

      yield* coord.replaceChangedPaths({
        ticketId: "t-early" as never,
        sourceRef: "ref-early",
        paths: ["src/a.ts", "src/b.ts"],
      });
      yield* coord.replaceChangedPaths({
        ticketId: "t-late" as never,
        sourceRef: "ref-late",
        paths: ["src/a.ts", "src/c.ts"],
      });

      const warn = yield* coord.evaluateOverlapGate({
        ticketId: "t-late" as never,
        boardId: "b1" as never,
        policy: "warn",
        ignorePaths: [],
        laneKey: "impl",
        laneEntryToken: "tok",
        pipelineRunId: "pipe",
        stepRunId: "step",
      });
      assert.equal(warn.decision.action, "warned");
      assert.equal(warn.withTicketId, "t-early");
      assert.isUndefined(warn.hold);

      const ser = yield* coord.evaluateOverlapGate({
        ticketId: "t-late" as never,
        boardId: "b1" as never,
        policy: "serialize",
        ignorePaths: [],
        laneKey: "impl",
        laneEntryToken: "tok-late",
        pipelineRunId: "pipe-late",
        stepRunId: "step-late",
      });
      assert.equal(ser.decision.action, "serialized");
      assert.isDefined(ser.hold);
      assert.equal(ser.hold?.blockedByTicketId, "t-early");
      assert.isTrue(yield* coord.hasActiveHold("t-late" as never));
      assert.isFalse(yield* coord.hasActiveHold("t-early" as never));
    }),
  );

  it.effect("ignore paths remove overlap", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const coord = yield* WorktreeCoordinator;

      yield* sql`
        INSERT OR IGNORE INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        ) VALUES
          ('t-a', 'b2', 'A', 'impl', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('t-b', 'b2', 'B', 'impl', 'running', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
      `;
      yield* coord.upsertRegistry({
        ticketId: "t-a" as never,
        repoRoot: "/tmp/repo2",
        branch: "workflow/t-a",
      });
      yield* coord.upsertRegistry({
        ticketId: "t-b" as never,
        repoRoot: "/tmp/repo2",
        branch: "workflow/t-b",
      });
      yield* coord.replaceChangedPaths({
        ticketId: "t-a" as never,
        sourceRef: "r",
        paths: ["dist/out.js"],
      });
      yield* coord.replaceChangedPaths({
        ticketId: "t-b" as never,
        sourceRef: "r",
        paths: ["dist/out.js"],
      });

      const gate = yield* coord.evaluateOverlapGate({
        ticketId: "t-b" as never,
        boardId: "b2" as never,
        policy: "serialize",
        ignorePaths: ["dist/"],
        laneKey: "impl",
        laneEntryToken: "tok",
        pipelineRunId: "p",
        stepRunId: "s",
      });
      assert.equal(gate.decision.action, "none");
      assert.isUndefined(gate.hold);
    }),
  );

  it.effect("releaseHold clears hasActiveHold", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const coord = yield* WorktreeCoordinator;

      yield* sql`
        INSERT OR IGNORE INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        ) VALUES
          ('t-hold-a', 'b4', 'A', 'impl', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('t-hold-b', 'b4', 'B', 'impl', 'running', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
      `;
      yield* coord.upsertRegistry({
        ticketId: "t-hold-a" as never,
        repoRoot: "/tmp/repo4",
        branch: "workflow/t-hold-a",
      });
      yield* coord.upsertRegistry({
        ticketId: "t-hold-b" as never,
        repoRoot: "/tmp/repo4",
        branch: "workflow/t-hold-b",
      });
      yield* coord.replaceChangedPaths({
        ticketId: "t-hold-a" as never,
        sourceRef: "r",
        paths: ["shared.ts"],
      });
      yield* coord.replaceChangedPaths({
        ticketId: "t-hold-b" as never,
        sourceRef: "r",
        paths: ["shared.ts"],
      });
      const ser = yield* coord.evaluateOverlapGate({
        ticketId: "t-hold-b" as never,
        boardId: "b4" as never,
        policy: "serialize",
        ignorePaths: [],
        laneKey: "impl",
        laneEntryToken: "tok",
        pipelineRunId: "p",
        stepRunId: "s",
      });
      assert.isDefined(ser.hold);
      assert.isTrue(yield* coord.hasActiveHold("t-hold-b" as never));
      yield* coord.releaseHold("t-hold-b" as never);
      assert.isFalse(yield* coord.hasActiveHold("t-hold-b" as never));
    }),
  );

  it.effect("releaseHoldsBlockedBy clears holds when blocker finishes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const coord = yield* WorktreeCoordinator;

      yield* sql`
        INSERT OR IGNORE INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        ) VALUES
          ('t-blk-a', 'b6', 'A', 'impl', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('t-blk-b', 'b6', 'B', 'impl', 'running', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
      `;
      yield* coord.upsertRegistry({
        ticketId: "t-blk-a" as never,
        repoRoot: "/tmp/repo6",
        branch: "workflow/t-blk-a",
      });
      yield* coord.upsertRegistry({
        ticketId: "t-blk-b" as never,
        repoRoot: "/tmp/repo6",
        branch: "workflow/t-blk-b",
      });
      yield* coord.replaceChangedPaths({
        ticketId: "t-blk-a" as never,
        sourceRef: "r",
        paths: ["x.ts"],
      });
      yield* coord.replaceChangedPaths({
        ticketId: "t-blk-b" as never,
        sourceRef: "r",
        paths: ["x.ts"],
      });
      yield* coord.evaluateOverlapGate({
        ticketId: "t-blk-b" as never,
        boardId: "b6" as never,
        policy: "serialize",
        ignorePaths: [],
        laneKey: "impl",
        laneEntryToken: "tok",
        pipelineRunId: "p",
        stepRunId: "s",
      });
      assert.isTrue(yield* coord.hasActiveHold("t-blk-b" as never));
      const n = yield* coord.releaseHoldsBlockedBy("t-blk-a" as never);
      assert.isTrue(n >= 1);
      assert.isFalse(yield* coord.hasActiveHold("t-blk-b" as never));
    }),
  );

  it.effect("serialize fail-closed when path cache is truncated", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const coord = yield* WorktreeCoordinator;

      yield* sql`
        INSERT OR IGNORE INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        ) VALUES
          ('t-trunc-a', 'b5', 'A', 'impl', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('t-trunc-b', 'b5', 'B', 'impl', 'running', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
      `;
      yield* coord.upsertRegistry({
        ticketId: "t-trunc-a" as never,
        repoRoot: "/tmp/repo5",
        branch: "workflow/t-trunc-a",
      });
      yield* coord.upsertRegistry({
        ticketId: "t-trunc-b" as never,
        repoRoot: "/tmp/repo5",
        branch: "workflow/t-trunc-b",
      });
      // Distinct paths (no intersection) but mark early ticket truncated.
      yield* coord.replaceChangedPaths({
        ticketId: "t-trunc-a" as never,
        sourceRef: "r",
        paths: ["only-a.ts"],
      });
      yield* sql`
        UPDATE ticket_changed_paths_meta SET truncated = 1 WHERE ticket_id = 't-trunc-a'
      `;
      yield* coord.replaceChangedPaths({
        ticketId: "t-trunc-b" as never,
        sourceRef: "r",
        paths: ["only-b.ts"],
      });
      // replaceChangedPaths rewrites meta — re-stamp truncated on A after B refresh
      // by setting truncated again (A meta still exists).
      yield* sql`
        UPDATE ticket_changed_paths_meta SET truncated = 1 WHERE ticket_id = 't-trunc-a'
      `;

      const gate = yield* coord.evaluateOverlapGate({
        ticketId: "t-trunc-b" as never,
        boardId: "b5" as never,
        policy: "serialize",
        ignorePaths: [],
        laneKey: "impl",
        laneEntryToken: "tok",
        pipelineRunId: "p",
        stepRunId: "s",
      });
      assert.equal(gate.decision.action, "serialized");
      assert.isDefined(gate.hold);
      assert.equal(gate.hold?.blockedByTicketId, "t-trunc-a");
    }),
  );

  it.effect("replaceChangedPaths is atomic (meta + paths + registry stamp)", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const coord = yield* WorktreeCoordinator;

      yield* sql`
        INSERT OR IGNORE INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        ) VALUES
          ('t-tx', 'b3', 'Tx', 'impl', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;
      yield* coord.upsertRegistry({
        ticketId: "t-tx" as never,
        repoRoot: "/tmp/repo3",
        branch: "workflow/t-tx",
      });
      yield* coord.replaceChangedPaths({
        ticketId: "t-tx" as never,
        sourceRef: "ref-1",
        paths: ["a.ts", "b.ts"],
      });
      const paths = yield* sql<{ readonly path: string }>`
        SELECT path FROM ticket_changed_paths WHERE ticket_id = 't-tx' ORDER BY path
      `;
      assert.deepEqual(
        paths.map((p) => p.path),
        ["a.ts", "b.ts"],
      );
      const meta = yield* sql<{ readonly fileCount: number; readonly sourceRef: string }>`
        SELECT file_count AS "fileCount", source_ref AS "sourceRef"
        FROM ticket_changed_paths_meta WHERE ticket_id = 't-tx'
      `;
      assert.equal(meta[0]?.fileCount, 2);
      assert.equal(meta[0]?.sourceRef, "ref-1");
      const reg = yield* sql<{ readonly stamped: string | null }>`
        SELECT last_post_checkpoint_at AS stamped FROM ticket_worktree_registry
        WHERE ticket_id = 't-tx'
      `;
      assert.isNotNull(reg[0]?.stamped);

      // Replace fully (not merge).
      yield* coord.replaceChangedPaths({
        ticketId: "t-tx" as never,
        sourceRef: "ref-2",
        paths: ["c.ts"],
      });
      const paths2 = yield* sql<{ readonly path: string }>`
        SELECT path FROM ticket_changed_paths WHERE ticket_id = 't-tx'
      `;
      assert.deepEqual(
        paths2.map((p) => p.path),
        ["c.ts"],
      );
    }),
  );
});
