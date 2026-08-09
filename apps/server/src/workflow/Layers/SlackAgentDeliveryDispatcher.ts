import type { SlackAgentDeliveryView } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SlackAgentGateway } from "../Services/SlackAgentGateway.ts";
import {
  SlackAgentDeliveryDispatcher,
  type SlackAgentDeliveryDispatcherShape,
} from "../Services/SlackAgentDeliveryDispatcher.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
const DEFAULT_DRAIN_LIMIT = 20;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 3_600_000;

interface SlackDeliveryRow {
  readonly deliveryId: string;
  readonly runId: string;
  readonly workflowSequence: number;
  readonly operation: string;
  readonly payloadJson: string;
  readonly attemptCount: number;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly threadTs: string;
  readonly statusMessageId: string | null;
  readonly lastAppliedSequence: number;
}

interface SlackDeliveryFailure {
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export interface SlackAgentDeliveryDispatcherLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly drainLimit?: number;
}

type SlackAgentDeliveryDatabaseState = SlackAgentDeliveryView["state"] | "processing" | "sent";

export const normalizeSlackAgentDeliveryState = (
  state: SlackAgentDeliveryDatabaseState,
): SlackAgentDeliveryView["state"] =>
  state === "processing" ? "delivering" : state === "sent" ? "delivered" : state;

export const claimSlackAgentDeliveryRow = (sql: SqlClient.SqlClient, deliveryId: string) =>
  sql<{ readonly deliveryId: string }>`
    UPDATE slack_agent_delivery
    SET delivery_state = 'delivering'
    WHERE delivery_id = ${deliveryId} AND delivery_state IN ('pending', 'retrying')
    RETURNING delivery_id AS "deliveryId"
  `;

const retryable = (message: string, retryAfterMs?: number): SlackDeliveryFailure => ({
  message,
  retryable: true,
  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});

const permanent = (message: string): SlackDeliveryFailure => ({
  message,
  retryable: false,
});

const decodePayloadJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const makeSlackAgentDeliveryDispatcher = (options: SlackAgentDeliveryDispatcherLiveOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const gateway = yield* SlackAgentGateway;
    const deliveryChanges = yield* PubSub.unbounded<SlackAgentDeliveryView>();
    const sweepIntervalMs = Math.max(1, options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const drainLimit = Math.max(1, Math.floor(options.drainLimit ?? DEFAULT_DRAIN_LIMIT));

    const deliveryView = (deliveryId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly deliveryId: string;
          readonly runId: string;
          readonly workflowSequence: number;
          readonly state: SlackAgentDeliveryDatabaseState;
          readonly attempts: number;
          readonly nextAttemptAt: string | null;
          readonly lastError: string | null;
          readonly createdAt: string;
          readonly updatedAt: string;
        }>`
          SELECT
            delivery_id AS "deliveryId",
            run_id AS "runId",
            workflow_sequence AS "workflowSequence",
            delivery_state AS "state",
            attempt_count AS "attempts",
            next_attempt_at AS "nextAttemptAt",
            last_error AS "lastError",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM slack_agent_delivery
          WHERE delivery_id = ${deliveryId}
        `;
        const row = rows[0];
        if (row === undefined) {
          return null;
        }
        return {
          deliveryId: row.deliveryId as SlackAgentDeliveryView["deliveryId"],
          runId: row.runId as SlackAgentDeliveryView["runId"],
          workflowSequence: row.workflowSequence,
          state: normalizeSlackAgentDeliveryState(row.state),
          attempts: row.attempts,
          ...(row.nextAttemptAt === null ? {} : { nextAttemptAt: row.nextAttemptAt }),
          ...(row.lastError === null ? {} : { lastError: row.lastError }),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        } satisfies SlackAgentDeliveryView;
      });

    const publishDeliveryChange = (deliveryId: string) =>
      Effect.flatMap(deliveryView(deliveryId), (delivery) =>
        delivery === null
          ? Effect.void
          : PubSub.publish(deliveryChanges, delivery).pipe(Effect.asVoid),
      );

    const markFailed = (deliveryId: string, attempt: number, message: string) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE slack_agent_delivery
          SET delivery_state = 'failed',
              attempt_count = ${attempt},
              last_error = ${message},
              updated_at = ${now}
          WHERE delivery_id = ${deliveryId}
        `;
        yield* publishDeliveryChange(deliveryId);
      });

    const recordFailure = (row: SlackDeliveryRow, failure: SlackDeliveryFailure) =>
      Effect.gen(function* () {
        if (!failure.retryable) {
          yield* markFailed(row.deliveryId, row.attemptCount, failure.message);
          return;
        }
        const attempt = row.attemptCount + 1;
        if (attempt >= MAX_ATTEMPTS) {
          yield* markFailed(row.deliveryId, attempt, failure.message);
          return;
        }
        const delayMs =
          failure.retryAfterMs === undefined
            ? Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** row.attemptCount)
            : Math.min(BACKOFF_CAP_MS, failure.retryAfterMs);
        const now = yield* DateTime.now;
        const nowIso = DateTime.formatIso(now);
        const nextAttemptAt = DateTime.formatIso(
          DateTime.addDuration(now, Duration.millis(delayMs)),
        );
        yield* sql`
          UPDATE slack_agent_delivery
          SET delivery_state = 'retrying',
              attempt_count = ${attempt},
              next_attempt_at = ${nextAttemptAt},
              last_error = ${failure.message},
              updated_at = ${nowIso}
          WHERE delivery_id = ${row.deliveryId}
        `;
        yield* publishDeliveryChange(row.deliveryId);
      });

    const markSuperseded = (deliveryId: string) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE slack_agent_delivery
          SET delivery_state = 'superseded',
              updated_at = ${now}
          WHERE delivery_id = ${deliveryId}
        `;
        yield* publishDeliveryChange(deliveryId);
      });

    const claimRow = (deliveryId: string) =>
      claimSlackAgentDeliveryRow(sql, deliveryId).pipe(Effect.map((rows) => rows.length > 0));

    const parsePayload = (json: string) =>
      decodePayloadJson(json).pipe(Effect.mapError(() => permanent("malformed payload_json")));

    const refreshRunState = (row: SlackDeliveryRow) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly statusMessageId: string | null;
          readonly lastAppliedSequence: number;
        }>`
          SELECT
            status_message_id AS "statusMessageId",
            last_applied_sequence AS "lastAppliedSequence"
          FROM slack_agent_run
          WHERE run_id = ${row.runId}
        `;
        const run = rows[0];
        return run === undefined
          ? row
          : {
              ...row,
              statusMessageId: run.statusMessageId,
              lastAppliedSequence: run.lastAppliedSequence,
            };
      });

    const markDelivered = (row: SlackDeliveryRow, statusMessageId: string) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* sql`
            UPDATE slack_agent_run
            SET status_message_id = ${statusMessageId},
                last_applied_sequence = ${row.workflowSequence},
                updated_at = ${now}
            WHERE run_id = ${row.runId}
          `;
            yield* sql`
            UPDATE slack_agent_delivery
            SET delivery_state = 'delivered',
                last_error = NULL,
                updated_at = ${now}
            WHERE delivery_id = ${row.deliveryId}
          `;
          }),
        )
        .pipe(Effect.tap(() => publishDeliveryChange(row.deliveryId)));

    const processRow = (row: SlackDeliveryRow): Effect.Effect<void> =>
      Effect.gen(function* () {
        const preflight = yield* refreshRunState(row);
        if (preflight.operation === "update" && preflight.statusMessageId === null) {
          return;
        }
        if (!(yield* claimRow(row.deliveryId))) {
          return;
        }
        yield* publishDeliveryChange(row.deliveryId);
        const currentRow = yield* refreshRunState(row);

        if (currentRow.workflowSequence <= currentRow.lastAppliedSequence) {
          yield* markSuperseded(currentRow.deliveryId);
          return;
        }

        // A direct status post may win the race against the initial accepted
        // delivery (for example, a very fast Slack follow-up). Once the run has
        // an editable Slack message, replaying the older operation="post" row
        // would overwrite that newer text. Treat the stale post as superseded;
        // later sequenced update rows can still edit the existing message.
        if (currentRow.operation === "post" && currentRow.statusMessageId !== null) {
          yield* markSuperseded(currentRow.deliveryId);
          return;
        }

        if (currentRow.operation === "update" && currentRow.statusMessageId === null) {
          yield* sql`
            UPDATE slack_agent_delivery
            SET delivery_state = 'pending',
                updated_at = ${DateTime.formatIso(yield* DateTime.now)}
            WHERE delivery_id = ${currentRow.deliveryId}
          `;
          yield* publishDeliveryChange(currentRow.deliveryId);
          return;
        }

        const payload = (yield* parsePayload(currentRow.payloadJson)) as {
          readonly text?: unknown;
        };
        const result = yield* gateway
          .postOrUpdateStatus({
            workspaceId: currentRow.workspaceId,
            channelId: currentRow.channelId,
            channelName: currentRow.channelName,
            threadTs: currentRow.threadTs,
            runId: currentRow.runId,
            deliveryId: currentRow.deliveryId,
            text: typeof payload.text === "string" ? payload.text : currentRow.payloadJson,
            ...(currentRow.statusMessageId === null
              ? {}
              : { statusMessageId: currentRow.statusMessageId }),
          })
          .pipe(
            Effect.mapError((error) =>
              retryable(
                error.message === "" ? "Slack status delivery failed" : error.message,
                error.retryAfterMs,
              ),
            ),
          );
        yield* markDelivered(currentRow, result.statusMessageId);
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasDies(cause) || Cause.hasInterrupts(cause)
            ? Effect.die(Cause.squash(cause))
            : Effect.gen(function* () {
                const squashed = Cause.squash(cause);
                const failure: SlackDeliveryFailure =
                  squashed !== null && typeof squashed === "object" && "retryable" in squashed
                    ? (squashed as SlackDeliveryFailure)
                    : retryable(String(squashed));
                yield* recordFailure(row, failure).pipe(
                  Effect.catchCause((recordCause) =>
                    Cause.hasDies(recordCause) || Cause.hasInterrupts(recordCause)
                      ? Effect.die(Cause.squash(recordCause))
                      : Effect.logWarning("workflow.slack-agent.record-failure-failed", {
                          deliveryId: row.deliveryId,
                          recordCause,
                        }),
                  ),
                );
              }),
        ),
      );

    const processRun = (runId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<SlackDeliveryRow>`
          SELECT
            d.delivery_id AS "deliveryId",
            d.run_id AS "runId",
            d.workflow_sequence AS "workflowSequence",
            d.operation AS "operation",
            d.payload_json AS "payloadJson",
            d.attempt_count AS "attemptCount",
            r.workspace_id AS "workspaceId",
            r.channel_id AS "channelId",
            r.channel_name AS "channelName",
            r.thread_ts AS "threadTs",
            r.status_message_id AS "statusMessageId",
            r.last_applied_sequence AS "lastAppliedSequence"
          FROM slack_agent_delivery
          d JOIN slack_agent_run r ON r.run_id = d.run_id
          WHERE d.run_id = ${runId}
            AND d.delivery_state IN ('pending', 'retrying')
            AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ${DateTime.formatIso(yield* DateTime.now)})
          ORDER BY workflow_sequence ASC
          LIMIT ${drainLimit}
        `;
        for (const row of rows) {
          yield* processRow(row);
          const states = yield* sql<{ readonly state: string }>`
            SELECT delivery_state AS "state"
            FROM slack_agent_delivery
            WHERE delivery_id = ${row.deliveryId}
          `;
          const state = states[0]?.state;
          // A retryable or still-pending head remains the per-run head of line.
          // A terminally failed update may be skipped so a newer status can
          // still land, but an unsent accepted post must keep blocking because
          // no editable status_message_id exists yet.
          if (
            state === "retrying" ||
            state === "pending" ||
            state === "delivering" ||
            (state === "failed" && row.workflowSequence === 0)
          ) {
            break;
          }
        }
      });

    const sweep: SlackAgentDeliveryDispatcherShape["sweep"] = (options) =>
      Effect.gen(function* () {
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const chatOnly = options?.chatOnly === true ? 1 : 0;
        const runRows = yield* sql<{ readonly runId: string; readonly minSequence: number }>`
          SELECT delivery.run_id AS "runId", MIN(delivery.workflow_sequence) AS "minSequence"
          FROM slack_agent_delivery AS delivery
          JOIN slack_agent_run AS run ON run.run_id = delivery.run_id
          WHERE delivery.delivery_state IN ('pending', 'retrying')
            AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= ${nowIso})
            AND (${chatOnly} = 0 OR run.mode = 'chat')
          GROUP BY delivery.run_id
          ORDER BY MIN(delivery.created_at) ASC
          LIMIT ${drainLimit}
        `.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("workflow.slack-agent.select-failed", { cause }).pipe(
              Effect.as(
                [] as ReadonlyArray<{ readonly runId: string; readonly minSequence: number }>,
              ),
            ),
          ),
        );
        yield* Effect.forEach(
          runRows,
          (row) =>
            processRun(row.runId).pipe(
              Effect.catchCause((cause) =>
                Cause.hasDies(cause) || Cause.hasInterrupts(cause)
                  ? Effect.die(Cause.squash(cause))
                  : Effect.logWarning("workflow.slack-agent.run-failed", {
                      runId: row.runId,
                      cause,
                    }),
              ),
            ),
          {
            concurrency: "unbounded",
            discard: true,
          },
        );
      });

    const recoverStaleClaims: SlackAgentDeliveryDispatcherShape["recoverStaleClaims"] = () =>
      sql`
        UPDATE slack_agent_delivery
        SET delivery_state = 'pending'
        WHERE delivery_state = 'delivering'
      `.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("workflow.slack-agent.recover-stale-claims-failed", { cause }),
        ),
      );

    const retryDelivery: SlackAgentDeliveryDispatcherShape["retryDelivery"] = (deliveryId) =>
      Effect.gen(function* () {
        const selected = yield* sql<{
          readonly deliveryId: string;
          readonly runId: string;
          readonly workflowSequence: number;
        }>`
          SELECT
            delivery_id AS "deliveryId",
            run_id AS "runId",
            workflow_sequence AS "workflowSequence"
          FROM slack_agent_delivery
          WHERE delivery_id = ${deliveryId}
            AND delivery_state = 'failed'
        `;
        const row = selected[0];
        if (row === undefined) {
          return null;
        }
        const newerApplicable = yield* sql<{ readonly deliveryId: string }>`
          SELECT delivery_id AS "deliveryId"
          FROM slack_agent_delivery
          WHERE run_id = ${row.runId}
            AND delivery_state <> 'superseded'
            AND workflow_sequence > ${row.workflowSequence}
          LIMIT 1
        `;
        if (row.workflowSequence > 0 && newerApplicable.length > 0) {
          yield* markSuperseded(row.deliveryId);
          return yield* deliveryView(deliveryId);
        }
        yield* sql`
          UPDATE slack_agent_delivery
          SET delivery_state = 'pending',
              next_attempt_at = NULL,
              last_error = NULL,
              updated_at = ${DateTime.formatIso(yield* DateTime.now)}
          WHERE delivery_id = ${row.deliveryId}
        `;
        const retried = yield* deliveryView(deliveryId);
        if (retried !== null) {
          yield* PubSub.publish(deliveryChanges, retried);
        }
        return retried;
      });

    const subscribeRunChanges: SlackAgentDeliveryDispatcherShape["subscribeRunChanges"] = (runId) =>
      PubSub.subscribe(deliveryChanges).pipe(
        Effect.map((subscription) =>
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((delivery) => String(delivery.runId) === runId),
          ),
        ),
      );

    const start: SlackAgentDeliveryDispatcherShape["start"] = (options) =>
      Effect.gen(function* () {
        yield* recoverStaleClaims();
        yield* Effect.forkScoped(
          sweep(options).pipe(
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("workflow.slack-agent.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );
        yield* Effect.logInfo("workflow.slack-agent.started", {
          sweepIntervalMs,
          chatOnly: options?.chatOnly === true,
        });
      });

    return {
      sweep,
      recoverStaleClaims,
      retryDelivery,
      subscribeRunChanges,
      start,
    } satisfies SlackAgentDeliveryDispatcherShape;
  });

export const makeSlackAgentDeliveryDispatcherLive = (
  options: SlackAgentDeliveryDispatcherLiveOptions = {},
) => Layer.effect(SlackAgentDeliveryDispatcher, makeSlackAgentDeliveryDispatcher(options));
