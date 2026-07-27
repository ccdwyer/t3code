import type { BoardId, LaneKey, TicketId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import {
  WorkflowSlaSweeper,
  type WorkflowSlaSweepResult,
  type WorkflowSlaSweeperShape,
} from "../Services/WorkflowSlaSweeper.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_MAX_ACTIONS_PER_SWEEP = 50;
const MIN_SLA_BUDGET_MS = 60_000;

export interface WorkflowSlaSweeperLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly maxActionsPerSweep?: number;
  readonly nowMs?: Effect.Effect<number>;
}

interface SlaLaneTarget {
  readonly boardId: BoardId;
  readonly laneKey: LaneKey;
  readonly budgetMs: number;
}

interface SlaCandidateRow {
  readonly ticketId: TicketId;
  readonly currentLaneKey: LaneKey;
  readonly currentLaneEntryToken: string;
  readonly currentLaneEnteredAt: string;
}

const makeWorkflowSlaSweeper = (options?: WorkflowSlaSweeperLiveOptions) =>
  Effect.gen(function* () {
    const boardRegistry = yield* BoardRegistry;
    const engine = yield* WorkflowEngine;
    const sql = yield* SqlClient.SqlClient;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const maxActionsPerSweep = Math.max(
      1,
      Math.floor(options?.maxActionsPerSweep ?? DEFAULT_MAX_ACTIONS_PER_SWEEP),
    );
    const nowMs = options?.nowMs ?? Clock.currentTimeMillis;
    let nextSweepCursorKey: string | null = null;

    const targetKey = (target: Pick<SlaLaneTarget, "boardId" | "laneKey">) =>
      `${target.boardId as string}::${target.laneKey as string}`;

    const rotateTargets = (targets: ReadonlyArray<SlaLaneTarget>) => {
      if (nextSweepCursorKey === null || targets.length === 0) {
        return targets;
      }
      const startIndex = targets.findIndex((t) => targetKey(t) === nextSweepCursorKey);
      if (startIndex <= 0) {
        return targets;
      }
      return [...targets.slice(startIndex), ...targets.slice(0, startIndex)];
    };

    const candidatesForLane = (
      boardId: BoardId,
      laneKey: LaneKey,
      cutoffIso: string,
      limit: number,
    ) =>
      sql<SlaCandidateRow>`
        SELECT
          ticket_id AS "ticketId",
          current_lane_key AS "currentLaneKey",
          current_lane_entry_token AS "currentLaneEntryToken",
          current_lane_entered_at AS "currentLaneEnteredAt"
        FROM projection_ticket
        WHERE board_id = ${boardId}
          AND current_lane_key = ${laneKey}
          AND current_lane_entry_token IS NOT NULL
          AND current_lane_entered_at IS NOT NULL
          AND current_lane_entered_at < ${cutoffIso}
          AND status NOT IN ('parked', 'queued')
          AND terminal_at IS NULL
          AND (
            (sla_breached_entry_token IS NULL AND current_lane_entry_token IS NOT NULL)
            OR sla_breached_entry_token != current_lane_entry_token
          )
        ORDER BY current_lane_entered_at ASC, ticket_id ASC
        LIMIT ${limit}
      `;

    const sweep: WorkflowSlaSweeperShape["sweep"] = () =>
      Effect.gen(function* () {
        const boards = yield* boardRegistry.listDefinitions().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("workflow.sla-sweeper.list-definitions-failed", { cause }).pipe(
              Effect.as(
                [] as ReadonlyArray<{
                  readonly boardId: BoardId;
                  readonly definition: {
                    readonly lanes: ReadonlyArray<{
                      readonly key: LaneKey;
                      readonly terminal?: boolean;
                      readonly sla?: { readonly budget: Duration.Duration };
                    }>;
                  };
                }>,
              ),
            ),
          ),
        );

        const targets: Array<SlaLaneTarget> = [];
        for (const board of boards) {
          for (const lane of board.definition.lanes) {
            if (lane.terminal === true || lane.sla === undefined) {
              continue;
            }
            const budgetMs = Duration.toMillis(lane.sla.budget);
            // Defense-in-depth: skip sub-minute / non-finite budgets.
            if (
              !Number.isFinite(budgetMs) ||
              !Number.isSafeInteger(budgetMs) ||
              budgetMs < MIN_SLA_BUDGET_MS
            ) {
              continue;
            }
            targets.push({
              boardId: board.boardId,
              laneKey: lane.key,
              budgetMs,
            });
          }
        }

        const ordered = rotateTargets(targets);
        const now = yield* nowMs;
        let candidateCount = 0;
        let actionCount = 0;
        let remaining = maxActionsPerSweep;
        // One SLA action per ticket per sweep.
        const actedTickets = new Set<string>();

        for (const target of ordered) {
          if (remaining <= 0) {
            break;
          }
          const cutoffIso = DateTime.formatIso(DateTime.makeUnsafe(now - target.budgetMs));
          const candidates = yield* candidatesForLane(
            target.boardId,
            target.laneKey,
            cutoffIso,
            remaining,
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("workflow.sla-sweeper.candidate-query-failed", {
                boardId: target.boardId,
                laneKey: target.laneKey,
                cause,
              }).pipe(Effect.as([] as ReadonlyArray<SlaCandidateRow>)),
            ),
          );
          candidateCount += candidates.length;

          for (const candidate of candidates) {
            if (remaining <= 0) {
              break;
            }
            if (actedTickets.has(candidate.ticketId as string)) {
              continue;
            }
            const outcome = yield* engine
              .escalateTicketSla({
                ticketId: candidate.ticketId,
                expectedLaneKey: candidate.currentLaneKey,
                expectedEntryToken: candidate.currentLaneEntryToken,
                nowMs: Effect.succeed(now),
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("workflow.sla-sweeper.escalate-failed", {
                    ticketId: candidate.ticketId,
                    cause,
                  }).pipe(Effect.as("stale" as const)),
                ),
              );
            actedTickets.add(candidate.ticketId as string);
            if (outcome === "stale") {
              // Guard mismatch is expected under races — not a failure.
              continue;
            }
            actionCount += 1;
            remaining -= 1;
          }
          nextSweepCursorKey = targetKey(target);
        }

        return {
          candidateCount,
          actionCount,
          failedCount: 0,
        } satisfies WorkflowSlaSweepResult;
      });

    /**
     * Re-attempt any answered agent question whose continuation never started.
     *
     * The debt is derived from the event log, so it is already durable — what
     * was missing is a TRIGGER after boot. A continuation that lost a claim
     * race would otherwise sit until the next restart with the operator's
     * answer stranded. This tick is that trigger: the sweep is idempotent (it
     * only acts where a round is answered and unowed), so re-running it costs
     * nothing when there is nothing to do.
     */
    const resumeStrandedQuestions = engine
      .resumeAnsweredQuestions()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("workflow.sla-sweeper.resume-questions-failed", { cause }),
        ),
      );

    const start: WorkflowSlaSweeperShape["start"] = () =>
      sweep().pipe(
        Effect.andThen(resumeStrandedQuestions),
        Effect.catchCause((cause) =>
          Effect.logWarning("workflow.sla-sweeper.sweep-failed", { cause }),
        ),
        Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
        Effect.forkScoped,
        Effect.asVoid,
      );

    return { sweep, start } satisfies WorkflowSlaSweeperShape;
  });

export const WorkflowSlaSweeperLive = (options?: WorkflowSlaSweeperLiveOptions) =>
  Layer.effect(WorkflowSlaSweeper, makeWorkflowSlaSweeper(options));

export const WorkflowSlaSweeperLiveDefault = WorkflowSlaSweeperLive();
