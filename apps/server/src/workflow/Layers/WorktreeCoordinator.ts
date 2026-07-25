import type { TicketId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { createHash } from "node:crypto";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  WorktreeCoordinator,
  type OverlapGateResult,
  type WorktreeCoordinatorShape,
} from "../Services/WorktreeCoordinator.ts";
import { decideOverlapAction } from "../worktreeOverlap.ts";

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const toError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrapSql = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toError("worktree coordinator sql failed")));

const fingerprint = (paths: ReadonlyArray<string>, a: string, b: string) =>
  createHash("sha256")
    .update([...paths].sort().join("\0"))
    .update("\0")
    .update([a, b].sort().join("\0"))
    .digest("hex");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRegistry: WorktreeCoordinatorShape["upsertRegistry"] = (input) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* wrapSql(sql`
        INSERT INTO ticket_worktree_registry (
          ticket_id, repo_root, branch, created_at
        ) VALUES (
          ${input.ticketId}, ${input.repoRoot}, ${input.branch}, ${createdAt}
        )
        ON CONFLICT(ticket_id) DO UPDATE SET
          repo_root = excluded.repo_root,
          branch = excluded.branch
      `);
    });

  const replaceChangedPaths: WorktreeCoordinatorShape["replaceChangedPaths"] = (input) =>
    Effect.gen(function* () {
      const refreshedAt = yield* nowIso;
      const capped = input.paths.slice(0, 500);
      const truncated = input.paths.length > 500 ? 1 : 0;
      // SPEC §2.1: path rows + meta + registry stamp in one transaction so a
      // concurrent gate never observes a mid-rewrite empty/partial set.
      yield* wrapSql(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM ticket_changed_paths WHERE ticket_id = ${input.ticketId}
            `;
            for (const path of capped) {
              yield* sql`
                INSERT INTO ticket_changed_paths (ticket_id, path)
                VALUES (${input.ticketId}, ${path})
              `;
            }
            yield* sql`
              INSERT INTO ticket_changed_paths_meta (
                ticket_id, source_ref, file_count, truncated, refreshed_at
              ) VALUES (
                ${input.ticketId}, ${input.sourceRef}, ${capped.length}, ${truncated}, ${refreshedAt}
              )
              ON CONFLICT(ticket_id) DO UPDATE SET
                source_ref = excluded.source_ref,
                file_count = excluded.file_count,
                truncated = excluded.truncated,
                refreshed_at = excluded.refreshed_at
            `;
            // Facet-independent landedness marker (SPEC §2.1).
            yield* sql`
              UPDATE ticket_worktree_registry
              SET last_post_checkpoint_at = ${refreshedAt}
              WHERE ticket_id = ${input.ticketId}
            `;
          }),
        ),
      );
    });

  const hasActiveHold: WorktreeCoordinatorShape["hasActiveHold"] = (ticketId) =>
    wrapSql(sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n
      FROM ticket_parallelism_hold
      WHERE ticket_id = ${ticketId}
        AND released_at IS NULL
    `).pipe(Effect.map((rows) => (rows[0]?.n ?? 0) > 0));

  const releaseHold: WorktreeCoordinatorShape["releaseHold"] = (ticketId) =>
    Effect.gen(function* () {
      const releasedAt = yield* nowIso;
      yield* wrapSql(sql`
        UPDATE ticket_parallelism_hold
        SET released_at = ${releasedAt}
        WHERE ticket_id = ${ticketId}
          AND released_at IS NULL
      `);
    });

  const releaseHoldsBlockedBy: WorktreeCoordinatorShape["releaseHoldsBlockedBy"] = (
    blockerTicketId,
  ) =>
    Effect.gen(function* () {
      const held = yield* wrapSql(sql<{ readonly ticketId: string }>`
        SELECT ticket_id AS "ticketId"
        FROM ticket_parallelism_hold
        WHERE blocked_by_ticket_id = ${blockerTicketId}
          AND released_at IS NULL
      `);
      if (held.length === 0) {
        return [] as ReadonlyArray<TicketId>;
      }
      const releasedAt = yield* nowIso;
      yield* wrapSql(sql`
        UPDATE ticket_parallelism_hold
        SET released_at = ${releasedAt}
        WHERE blocked_by_ticket_id = ${blockerTicketId}
          AND released_at IS NULL
      `);
      return held.map((r) => r.ticketId as TicketId);
    });

  const evaluateOverlapGate: WorktreeCoordinatorShape["evaluateOverlapGate"] = (input) =>
    Effect.gen(function* () {
      const ownPaths = yield* wrapSql(sql<{ readonly path: string }>`
        SELECT path FROM ticket_changed_paths WHERE ticket_id = ${input.ticketId}
      `).pipe(Effect.map((rows) => rows.map((r) => r.path)));
      const ownMeta = yield* wrapSql(sql<{
        readonly truncated: number;
      }>`
        SELECT truncated FROM ticket_changed_paths_meta WHERE ticket_id = ${input.ticketId}
      `);
      const ownTruncated = (ownMeta[0]?.truncated ?? 0) === 1;

      if (ownPaths.length === 0 && !ownTruncated) {
        return {
          decision: { action: "none" as const },
          withTicketId: null,
        } satisfies OverlapGateResult;
      }

      // Sibling in-flight tickets sharing a repo with path cache.
      const siblings = yield* wrapSql(sql<{
        readonly ticketId: string;
        readonly createdAt: string;
      }>`
        SELECT
          reg.ticket_id AS "ticketId",
          ticket.created_at AS "createdAt"
        FROM ticket_worktree_registry AS reg
        INNER JOIN projection_ticket AS ticket
          ON ticket.ticket_id = reg.ticket_id
        INNER JOIN ticket_changed_paths_meta AS meta
          ON meta.ticket_id = reg.ticket_id
        WHERE reg.repo_root = (
          SELECT repo_root FROM ticket_worktree_registry
          WHERE ticket_id = ${input.ticketId}
        )
          AND reg.ticket_id != ${input.ticketId}
          AND ticket.terminal_at IS NULL
        ORDER BY ticket.created_at ASC, reg.ticket_id ASC
      `);

      let best: {
        readonly withTicketId: string;
        readonly decision: ReturnType<typeof decideOverlapAction>;
        readonly createdAt: string;
      } | null = null;

      for (const sib of siblings) {
        const sibPaths = yield* wrapSql(sql<{ readonly path: string }>`
          SELECT path FROM ticket_changed_paths WHERE ticket_id = ${sib.ticketId}
        `).pipe(Effect.map((rows) => rows.map((r) => r.path)));
        const sibMeta = yield* wrapSql(sql<{ readonly truncated: number }>`
          SELECT truncated FROM ticket_changed_paths_meta WHERE ticket_id = ${sib.ticketId}
        `);
        const sibTruncated = (sibMeta[0]?.truncated ?? 0) === 1;
        let decision = decideOverlapAction(input.policy, ownPaths, sibPaths, input.ignorePaths);
        // Serialize fail-closed when either side's path cache is truncated —
        // missing paths must not silently allow concurrent work (review J1).
        if (
          decision.action === "none" &&
          input.policy === "serialize" &&
          (ownTruncated || sibTruncated)
        ) {
          decision = {
            action: "serialized",
            paths: ["(truncated-path-cache)"],
            totalPathCount: 1,
            truncated: true,
          };
        }
        if (decision.action === "none") continue;
        if (
          best === null ||
          sib.createdAt < best.createdAt ||
          (sib.createdAt === best.createdAt && sib.ticketId < best.withTicketId)
        ) {
          best = {
            withTicketId: sib.ticketId,
            decision,
            createdAt: sib.createdAt,
          };
        }
      }

      if (best === null) {
        return {
          decision: { action: "none" as const },
          withTicketId: null,
        } satisfies OverlapGateResult;
      }

      const withTicketId = best.withTicketId as TicketId;
      // Fingerprint over full path set identity when available (total count + sample).
      const paths = best.decision.action === "none" ? [] : best.decision.paths;
      const totalForFp = best.decision.action === "none" ? 0 : best.decision.totalPathCount;
      const fp = fingerprint(
        [...paths, `total:${totalForFp}`],
        input.ticketId as string,
        withTicketId as string,
      );

      if (best.decision.action === "warned") {
        // Fingerprint-gated: only report once per pair+path set.
        const existing = yield* wrapSql(sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM ticket_overlap_reported
          WHERE ticket_id = ${input.ticketId}
            AND with_ticket_id = ${withTicketId}
            AND fingerprint = ${fp}
        `);
        if ((existing[0]?.n ?? 0) === 0) {
          const reportedAt = yield* nowIso;
          yield* wrapSql(sql`
            INSERT OR REPLACE INTO ticket_overlap_reported (
              ticket_id, with_ticket_id, fingerprint, reported_at
            ) VALUES (
              ${input.ticketId}, ${withTicketId}, ${fp}, ${reportedAt}
            )
          `);
        }
        return {
          decision: best.decision,
          withTicketId,
        } satisfies OverlapGateResult;
      }

      // serialize: later ticket (higher created_at) holds; if we are the loser, hold.
      const ownCreated = yield* wrapSql(sql<{ readonly createdAt: string }>`
        SELECT created_at AS "createdAt"
        FROM projection_ticket
        WHERE ticket_id = ${input.ticketId}
      `);
      const ownAt = ownCreated[0]?.createdAt ?? "";
      const weLose =
        ownAt > best.createdAt ||
        (ownAt === best.createdAt && (input.ticketId as string) > best.withTicketId);

      if (!weLose) {
        return {
          decision: best.decision,
          withTicketId,
        } satisfies OverlapGateResult;
      }

      const heldAt = yield* nowIso;
      yield* wrapSql(sql`
        INSERT INTO ticket_parallelism_hold (
          ticket_id, kind, blocked_by_ticket_id, lane_key, lane_entry_token,
          pipeline_run_id, step_run_id, held_at
        ) VALUES (
          ${input.ticketId},
          'serialize',
          ${withTicketId},
          ${input.laneKey},
          ${input.laneEntryToken},
          ${input.pipelineRunId},
          ${input.stepRunId},
          ${heldAt}
        )
        ON CONFLICT(ticket_id) DO UPDATE SET
          kind = excluded.kind,
          blocked_by_ticket_id = excluded.blocked_by_ticket_id,
          lane_key = excluded.lane_key,
          lane_entry_token = excluded.lane_entry_token,
          pipeline_run_id = excluded.pipeline_run_id,
          step_run_id = excluded.step_run_id,
          held_at = excluded.held_at,
          released_at = NULL,
          resume_pipeline_run_id = NULL
      `);

      return {
        decision: best.decision,
        withTicketId,
        hold: {
          kind: "serialize" as const,
          blockedByTicketId: withTicketId,
        },
      } satisfies OverlapGateResult;
    });

  return {
    upsertRegistry,
    replaceChangedPaths,
    evaluateOverlapGate,
    hasActiveHold,
    releaseHold,
    releaseHoldsBlockedBy,
  } satisfies WorktreeCoordinatorShape;
});

export const WorktreeCoordinatorLive = Layer.effect(WorktreeCoordinator, make);
