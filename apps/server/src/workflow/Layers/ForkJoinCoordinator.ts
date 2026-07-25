import type { BoardId, StepRunId, TicketId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  ForkJoinCoordinator,
  type ForkChildRecord,
  type ForkJoinCoordinatorShape,
  type ForkRecord,
} from "../Services/ForkJoinCoordinator.ts";
import { evaluateJoin, type BranchOutcome } from "../forkJoin.ts";

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const toError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrapSql = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toError("fork join coordinator sql failed")));

const loadForkRaw = (
  sql: SqlClient.SqlClient,
  stepRunId: string,
): Effect.Effect<ForkRecord | null, SqlError> =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly stepRunId: string;
      readonly parentTicketId: string;
      readonly boardId: string;
      readonly stepKey: string;
      readonly joinRequire: number;
      readonly onBranchFailure: string;
      readonly resolvedAt: string | null;
      readonly resolution: string | null;
    }>`
      SELECT
        step_run_id AS "stepRunId",
        parent_ticket_id AS "parentTicketId",
        board_id AS "boardId",
        step_key AS "stepKey",
        join_require AS "joinRequire",
        on_branch_failure AS "onBranchFailure",
        resolved_at AS "resolvedAt",
        resolution
      FROM projection_ticket_fork
      WHERE step_run_id = ${stepRunId}
    `;
    const head = rows[0];
    if (head === undefined) return null;
    const children = yield* sql<{
      readonly childKey: string;
      readonly ticketId: string;
      readonly laneKey: string;
      readonly titleSnapshot: string;
      readonly settledOutcome: string | null;
    }>`
      SELECT
        child_key AS "childKey",
        child_ticket_id AS "ticketId",
        lane_key AS "laneKey",
        title_snapshot AS "titleSnapshot",
        settled_outcome AS "settledOutcome"
      FROM projection_ticket_fork_child
      WHERE step_run_id = ${stepRunId}
      ORDER BY child_key ASC
    `;
    return {
      stepRunId: head.stepRunId as StepRunId,
      parentTicketId: head.parentTicketId as TicketId,
      boardId: head.boardId as BoardId,
      stepKey: head.stepKey,
      joinRequire: head.joinRequire,
      onBranchFailure: head.onBranchFailure as "failFast" | "waitImpossible",
      resolvedAt: head.resolvedAt,
      resolution: head.resolution as ForkRecord["resolution"],
      children: children.map(
        (c): ForkChildRecord => ({
          childKey: c.childKey,
          ticketId: c.ticketId as TicketId,
          laneKey: c.laneKey,
          titleSnapshot: c.titleSnapshot,
          settledOutcome: (c.settledOutcome as BranchOutcome | null) ?? null,
        }),
      ),
    } satisfies ForkRecord;
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const recordSpawn: ForkJoinCoordinatorShape["recordSpawn"] = (input) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* wrapSql(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO projection_ticket_fork (
                step_run_id, parent_ticket_id, board_id, step_key,
                join_require, on_branch_failure, spawn_seq, created_at
              ) VALUES (
                ${input.stepRunId},
                ${input.parentTicketId},
                ${input.boardId},
                ${input.stepKey},
                ${input.joinRequire},
                ${input.onBranchFailure},
                ${input.spawnSeq},
                ${createdAt}
              )
            `;
            for (const child of input.children) {
              yield* sql`
                INSERT INTO projection_ticket_fork_child (
                  step_run_id, child_ticket_id, child_key, title_snapshot, lane_key
                ) VALUES (
                  ${input.stepRunId},
                  ${child.ticketId},
                  ${child.childKey},
                  ${child.title},
                  ${child.laneKey}
                )
              `;
            }
            // Prefer propagated lineage root (nested forks); fall back to parent.
            const rootId = (input.rootTicketId ?? input.parentTicketId) as string;
            yield* sql`
              INSERT INTO workflow_fork_lineage (root_ticket_id, board_id, fork_count)
              VALUES (${rootId}, ${input.boardId}, 1)
              ON CONFLICT(root_ticket_id) DO UPDATE SET
                fork_count = fork_count + 1
            `;
          }),
        ),
      );
    });

  const settleChild: ForkJoinCoordinatorShape["settleChild"] = (input) =>
    Effect.gen(function* () {
      const settledAt = yield* nowIso;
      return yield* wrapSql(
        sql.withTransaction(
          Effect.gen(function* () {
            const mapping = yield* sql<{
              readonly stepRunId: string;
              readonly settledOutcome: string | null;
            }>`
              SELECT
                step_run_id AS "stepRunId",
                settled_outcome AS "settledOutcome"
              FROM projection_ticket_fork_child
              WHERE child_ticket_id = ${input.childTicketId}
            `;
            const row = mapping[0];
            if (row === undefined) {
              return { status: "unknown_child" as const };
            }

            const forkBefore = yield* loadForkRaw(sql, row.stepRunId);
            if (forkBefore === null) {
              return { status: "unknown_child" as const };
            }

            if (forkBefore.resolvedAt !== null) {
              if (row.settledOutcome === null) {
                yield* sql`
                  UPDATE projection_ticket_fork_child
                  SET settled_outcome = ${input.outcome}, settled_at = ${settledAt}
                  WHERE child_ticket_id = ${input.childTicketId}
                    AND settled_outcome IS NULL
                `;
              }
              const latest = (yield* loadForkRaw(sql, row.stepRunId)) ?? forkBefore;
              return { status: "already_settled" as const, fork: latest };
            }

            if (row.settledOutcome !== null) {
              return { status: "already_settled" as const, fork: forkBefore };
            }

            yield* sql`
              UPDATE projection_ticket_fork_child
              SET settled_outcome = ${input.outcome}, settled_at = ${settledAt}
              WHERE child_ticket_id = ${input.childTicketId}
                AND settled_outcome IS NULL
            `;
            // Confirm we claimed the child row (idempotent concurrent settlers).
            const afterClaim = yield* sql<{ readonly settledOutcome: string | null }>`
              SELECT settled_outcome AS "settledOutcome"
              FROM projection_ticket_fork_child
              WHERE child_ticket_id = ${input.childTicketId}
            `;
            if (afterClaim[0]?.settledOutcome !== input.outcome) {
              const latest = (yield* loadForkRaw(sql, row.stepRunId)) ?? forkBefore;
              return { status: "already_settled" as const, fork: latest };
            }

            const fork = yield* loadForkRaw(sql, row.stepRunId);
            if (fork === null) {
              return { status: "unknown_child" as const };
            }

            const outcomes: BranchOutcome[] = fork.children.map((c) =>
              c.settledOutcome === null ? "unsettled" : c.settledOutcome,
            );
            const join = evaluateJoin(outcomes, {
              require: fork.joinRequire,
              onBranchFailure: fork.onBranchFailure,
            });

            if (join.result === "wait") {
              return { status: "waiting" as const, fork, join };
            }

            // Claim resolve: only the winner of resolved_at IS NULL returns resolved.
            yield* sql`
              UPDATE projection_ticket_fork
              SET
                resolved_at = ${settledAt},
                resolution = ${join.result},
                resolution_succeeded = ${join.succeeded},
                resolution_failed = ${join.failed},
                resolution_cancelled = ${join.cancelled}
              WHERE step_run_id = ${fork.stepRunId}
                AND resolved_at IS NULL
            `;
            const changed = yield* sql<{ readonly n: number }>`SELECT changes() AS n`;
            const afterResolve = yield* loadForkRaw(sql, row.stepRunId);
            if (afterResolve === null) {
              return { status: "unknown_child" as const };
            }
            if ((changed[0]?.n ?? 0) > 0) {
              return { status: "resolved" as const, fork: afterResolve, join };
            }
            return { status: "already_settled" as const, fork: afterResolve };
          }),
        ),
      );
    });

  const getForkByStepRunId: ForkJoinCoordinatorShape["getForkByStepRunId"] = (stepRunId) =>
    wrapSql(loadForkRaw(sql, stepRunId as string));

  const getUnresolvedForkForParent: ForkJoinCoordinatorShape["getUnresolvedForkForParent"] = (
    parentTicketId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* wrapSql(sql<{ readonly stepRunId: string }>`
        SELECT step_run_id AS "stepRunId"
        FROM projection_ticket_fork
        WHERE parent_ticket_id = ${parentTicketId}
          AND resolved_at IS NULL
        ORDER BY spawn_seq DESC
        LIMIT 1
      `);
      const id = rows[0]?.stepRunId;
      if (id === undefined) return null;
      return yield* wrapSql(loadForkRaw(sql, id));
    });

  const getForkForChild: ForkJoinCoordinatorShape["getForkForChild"] = (childTicketId) =>
    Effect.gen(function* () {
      const rows = yield* wrapSql(sql<{ readonly stepRunId: string }>`
        SELECT step_run_id AS "stepRunId"
        FROM projection_ticket_fork_child
        WHERE child_ticket_id = ${childTicketId}
        LIMIT 1
      `);
      const id = rows[0]?.stepRunId;
      if (id === undefined) return null;
      return yield* wrapSql(loadForkRaw(sql, id));
    });

  return {
    recordSpawn,
    settleChild,
    getForkByStepRunId,
    getUnresolvedForkForParent,
    getForkForChild,
  } satisfies ForkJoinCoordinatorShape;
});

export const ForkJoinCoordinatorLive = Layer.effect(ForkJoinCoordinator, make);
