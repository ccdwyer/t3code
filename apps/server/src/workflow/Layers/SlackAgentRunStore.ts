import type {
  MockSlackThreadRef,
  SlackAgentDeliveryState,
  SlackAgentDeliveryView,
  SlackAgentInvocationMode,
  SlackAgentRunDetailView,
  SlackAgentRunSummaryView,
} from "@t3tools/contracts";
import { MockSlackSourceMessage } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  SlackAgentRunStore,
  SlackAgentRunStoreError,
  type SlackAgentRunStoreShape,
} from "../Services/SlackAgentRunStore.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";

type DbDeliveryState =
  | "pending"
  | "processing"
  | "delivering"
  | "sent"
  | "delivered"
  | "retrying"
  | "failed"
  | "superseded";

interface RunSummaryRow {
  readonly run_id: string;
  readonly instance_id: string;
  readonly project_id: string | null;
  readonly handle: string;
  readonly bot_user_id: string;
  readonly mode: SlackAgentInvocationMode;
  readonly t3_thread_id: string | null;
  readonly ticket_id: string | null;
  readonly workspace_id: string;
  readonly channel_id: string;
  readonly channel_name: string;
  readonly thread_key: string;
  readonly thread_ts: string;
  readonly status: SlackAgentRunSummaryView["state"];
  readonly status_message_id: string | null;
  readonly pr_url: string | null;
  readonly last_applied_sequence: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface RunDetailRow extends RunSummaryRow {
  readonly snapshot_json: string;
  readonly snapshot_bytes: number;
}

interface DeliveryRow {
  readonly delivery_id: string;
  readonly run_id: string;
  readonly workflow_sequence: number;
  readonly delivery_state: DbDeliveryState;
  readonly attempt_count: number;
  readonly next_attempt_at: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const toStoreError = (message: string) => (cause: unknown) =>
  new SlackAgentRunStoreError({ message, cause });

const wrap = <A>(message: string, effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toStoreError(message)));

const StoredSlackThreadSnapshot = Schema.Struct({
  workspaceId: Schema.String,
  channelId: Schema.String,
  channelName: Schema.String,
  threadTs: Schema.String,
  triggerEventId: Schema.String,
  triggerTs: Schema.String,
  triggerMessageId: Schema.String,
  messages: Schema.Array(MockSlackSourceMessage),
});
const decodeSnapshotJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredSlackThreadSnapshot),
);

const toContractDeliveryState = (state: DbDeliveryState): SlackAgentDeliveryState => {
  switch (state) {
    case "processing":
      return "delivering";
    case "sent":
      return "delivered";
    default:
      return state;
  }
};

const toThread = (row: RunSummaryRow): MockSlackThreadRef => ({
  workspaceId: row.workspace_id as never,
  channelId: row.channel_id as never,
  channelName: row.channel_name as never,
  threadTs: row.thread_ts as never,
  threadKey: row.thread_key as never,
});

const toRunSummary = (row: RunSummaryRow): SlackAgentRunSummaryView => ({
  runId: row.run_id as never,
  instanceId: row.instance_id as never,
  ...(row.project_id === null ? {} : { projectId: row.project_id as never }),
  handle: row.handle as never,
  botUserId: row.bot_user_id as never,
  mode: row.mode,
  ...(row.t3_thread_id === null ? {} : { threadId: row.t3_thread_id as never }),
  ...(row.ticket_id === null ? {} : { ticketId: row.ticket_id as never }),
  thread: toThread(row),
  state: row.status,
  ...(row.status_message_id === null ? {} : { statusMessageId: row.status_message_id as never }),
  ...(row.pr_url === null ? {} : { prUrl: row.pr_url }),
  lastAppliedSequence: row.last_applied_sequence,
  createdAt: row.created_at as never,
  updatedAt: row.updated_at as never,
});

const toDelivery = (row: DeliveryRow): SlackAgentDeliveryView => ({
  deliveryId: row.delivery_id as never,
  runId: row.run_id as never,
  workflowSequence: row.workflow_sequence,
  state: toContractDeliveryState(row.delivery_state),
  attempts: row.attempt_count,
  ...(row.next_attempt_at === null ? {} : { nextAttemptAt: row.next_attempt_at as never }),
  ...(row.last_error === null ? {} : { lastError: row.last_error }),
  createdAt: row.created_at as never,
  updatedAt: row.updated_at as never,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ids = yield* WorkflowIds;

  const selectRunRows = (where: Effect.Effect<ReadonlyArray<RunSummaryRow>, SqlError>) =>
    wrap("Failed to read Slack agent run", where).pipe(
      Effect.map((rows) => rows.map(toRunSummary)),
    );

  const runSummaryById = (runId: string) =>
    selectRunRows(sql<RunSummaryRow>`
      SELECT
        r.run_id,
        r.instance_id,
        r.project_id,
        i.handle,
        i.bot_user_id,
        r.mode,
        r.t3_thread_id,
        r.ticket_id,
        r.workspace_id,
        r.channel_id,
        r.channel_name,
        r.thread_key,
        r.thread_ts,
        r.status,
        r.status_message_id,
        r.pr_url,
        r.last_applied_sequence,
        r.created_at,
        r.updated_at
      FROM slack_agent_run AS r
      JOIN slack_agent_instance AS i ON i.instance_id = r.instance_id
      WHERE r.run_id = ${runId}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const listDeliveries: SlackAgentRunStoreShape["listDeliveries"] = (runId) =>
    wrap(
      "Failed to list Slack agent deliveries",
      sql<DeliveryRow>`
        SELECT
          delivery_id,
          run_id,
          workflow_sequence,
          delivery_state,
          attempt_count,
          next_attempt_at,
          last_error,
          created_at,
          updated_at
        FROM slack_agent_delivery
        WHERE run_id = ${String(runId)}
        ORDER BY workflow_sequence ASC
      `,
    ).pipe(Effect.map((rows) => rows.map(toDelivery)));

  const getRunSummary: SlackAgentRunStoreShape["getRunSummary"] = (runId) =>
    runSummaryById(String(runId));

  const getRun: SlackAgentRunStoreShape["getRun"] = (runId) =>
    Effect.gen(function* () {
      const rows = yield* wrap(
        "Failed to read Slack agent run detail",
        sql<RunDetailRow>`
          SELECT
            r.run_id,
            r.instance_id,
        r.project_id,
            i.handle,
            i.bot_user_id,
            r.mode,
            r.t3_thread_id,
            r.ticket_id,
            r.workspace_id,
            r.channel_id,
            r.channel_name,
            r.thread_key,
            r.thread_ts,
            r.status,
            r.status_message_id,
            r.pr_url,
            r.last_applied_sequence,
            r.created_at,
            r.updated_at,
            r.snapshot_json,
            r.snapshot_bytes
          FROM slack_agent_run AS r
          JOIN slack_agent_instance AS i ON i.instance_id = r.instance_id
          WHERE r.run_id = ${String(runId)}
          LIMIT 1
        `,
      );
      const row = rows[0];
      if (row === undefined) return null;
      const deliveries = yield* listDeliveries(row.run_id as never);
      const snapshot = yield* decodeSnapshotJson(row.snapshot_json).pipe(
        Effect.mapError(toStoreError("Failed to decode Slack agent run snapshot")),
      );
      return {
        run: toRunSummary(row),
        snapshot: {
          thread: {
            workspaceId: snapshot.workspaceId as never,
            channelId: snapshot.channelId as never,
            channelName: snapshot.channelName as never,
            threadTs: snapshot.threadTs as never,
            threadKey: row.thread_key as never,
          },
          triggerEventId: snapshot.triggerEventId as never,
          triggerMessageId: snapshot.triggerMessageId as never,
          triggerTs: snapshot.triggerTs as never,
          messages: snapshot.messages,
          canonicalJsonBytes: row.snapshot_bytes,
        },
        deliveries,
      } satisfies SlackAgentRunDetailView;
    });

  const getRunByTicketId: SlackAgentRunStoreShape["getRunByTicketId"] = (ticketId) =>
    selectRunRows(sql<RunSummaryRow>`
      SELECT
        r.run_id,
        r.instance_id,
        r.project_id,
        i.handle,
        i.bot_user_id,
        r.mode,
        r.t3_thread_id,
        r.ticket_id,
        r.workspace_id,
        r.channel_id,
        r.channel_name,
        r.thread_key,
        r.thread_ts,
        r.status,
        r.status_message_id,
        r.pr_url,
        r.last_applied_sequence,
        r.created_at,
        r.updated_at
      FROM slack_agent_run AS r
      JOIN slack_agent_instance AS i ON i.instance_id = r.instance_id
      WHERE r.ticket_id = ${ticketId}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const getRunByDeliveryId: SlackAgentRunStoreShape["getRunByDeliveryId"] = (deliveryId) =>
    selectRunRows(sql<RunSummaryRow>`
      SELECT
        r.run_id,
        r.instance_id,
        r.project_id,
        i.handle,
        i.bot_user_id,
        r.mode,
        r.t3_thread_id,
        r.ticket_id,
        r.workspace_id,
        r.channel_id,
        r.channel_name,
        r.thread_key,
        r.thread_ts,
        r.status,
        r.status_message_id,
        r.pr_url,
        r.last_applied_sequence,
        r.created_at,
        r.updated_at
      FROM slack_agent_run AS r
      JOIN slack_agent_instance AS i ON i.instance_id = r.instance_id
      JOIN slack_agent_delivery AS d ON d.run_id = r.run_id
      WHERE d.delivery_id = ${String(deliveryId)}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const findByExternalEvent: SlackAgentRunStoreShape["findByExternalEvent"] = (
    instanceId,
    externalEventId,
  ) =>
    selectRunRows(sql<RunSummaryRow>`
      SELECT
        r.run_id,
        r.instance_id,
        r.project_id,
        i.handle,
        i.bot_user_id,
        r.mode,
        r.t3_thread_id,
        r.ticket_id,
        r.workspace_id,
        r.channel_id,
        r.channel_name,
        r.thread_key,
        r.thread_ts,
        r.status,
        r.status_message_id,
        r.pr_url,
        r.last_applied_sequence,
        r.created_at,
        r.updated_at
      FROM slack_agent_run AS r
      JOIN slack_agent_instance AS i ON i.instance_id = r.instance_id
      WHERE r.instance_id = ${String(instanceId)}
        AND (
          r.external_event_id = ${externalEventId}
          OR EXISTS (
            SELECT 1
            FROM slack_agent_ingested_event AS event
            WHERE event.run_id = r.run_id
              AND event.external_event_id = ${externalEventId}
          )
        )
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const findBySourceThread: SlackAgentRunStoreShape["findBySourceThread"] = (
    instanceId,
    workspaceId,
    channelId,
    threadTs,
  ) =>
    selectRunRows(sql<RunSummaryRow>`
      SELECT
        r.run_id,
        r.instance_id,
        r.project_id,
        i.handle,
        i.bot_user_id,
        r.mode,
        r.t3_thread_id,
        r.ticket_id,
        r.workspace_id,
        r.channel_id,
        r.channel_name,
        r.thread_key,
        r.thread_ts,
        r.status,
        r.status_message_id,
        r.pr_url,
        r.last_applied_sequence,
        r.created_at,
        r.updated_at
      FROM slack_agent_run AS r
      JOIN slack_agent_instance AS i ON i.instance_id = r.instance_id
      WHERE r.instance_id = ${String(instanceId)}
        AND r.workspace_id = ${workspaceId}
        AND r.channel_id = ${channelId}
        AND r.thread_ts = ${threadTs}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const findRootChatByChannel: SlackAgentRunStoreShape["findRootChatByChannel"] = (
    instanceId,
    workspaceId,
    channelId,
  ) =>
    selectRunRows(sql<RunSummaryRow>`
      SELECT
        r.run_id,
        r.instance_id,
        r.project_id,
        i.handle,
        i.bot_user_id,
        r.mode,
        r.t3_thread_id,
        r.ticket_id,
        r.workspace_id,
        r.channel_id,
        r.channel_name,
        r.thread_key,
        r.thread_ts,
        r.status,
        r.status_message_id,
        r.pr_url,
        r.last_applied_sequence,
        r.created_at,
        r.updated_at
      FROM slack_agent_run AS r
      JOIN slack_agent_instance AS i ON i.instance_id = r.instance_id
      WHERE r.instance_id = ${String(instanceId)}
        AND r.workspace_id = ${workspaceId}
        AND r.channel_id = ${channelId}
        AND r.mode = 'chat'
        AND r.thread_ts = r.trigger_ts
      ORDER BY r.created_at ASC, r.run_id ASC
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const findChatByThreadId: SlackAgentRunStoreShape["findChatByThreadId"] = (threadId) =>
    selectRunRows(sql<RunSummaryRow>`
      SELECT
        r.run_id,
        r.instance_id,
        r.project_id,
        i.handle,
        i.bot_user_id,
        r.mode,
        r.t3_thread_id,
        r.ticket_id,
        r.workspace_id,
        r.channel_id,
        r.channel_name,
        r.thread_key,
        r.thread_ts,
        r.status,
        r.status_message_id,
        r.pr_url,
        r.last_applied_sequence,
        r.created_at,
        r.updated_at
      FROM slack_agent_run AS r
      JOIN slack_agent_instance AS i ON i.instance_id = r.instance_id
      WHERE r.mode = 'chat'
        AND r.t3_thread_id = ${String(threadId)}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const enqueueDelivery: SlackAgentRunStoreShape["enqueueDelivery"] = Effect.fn(
    "SlackAgentRunStore.enqueueDelivery",
  )(function* (input) {
    const eventId = yield* ids.eventId();
    const deliveryId = `slackdeliv-${eventId}`;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* wrap(
      "Failed to enqueue Slack agent delivery",
      sql`
        INSERT INTO slack_agent_delivery (
          delivery_id,
          run_id,
          workflow_sequence,
          kind,
          operation,
          payload_json,
          delivery_state,
          attempt_count,
          status_message_id,
          next_attempt_at,
          last_error,
          created_at,
          updated_at
        ) VALUES (
          ${deliveryId},
          ${String(input.runId)},
          ${input.workflowSequence},
          ${input.kind},
          ${input.operation},
          ${input.payloadJson},
          'pending',
          0,
          NULL,
          ${input.nextAttemptAt ?? null},
          NULL,
          ${now},
          ${now}
        )
      `,
    );
    const rows = yield* listDeliveries(String(input.runId) as never);
    const delivery = rows.find((row) => row.deliveryId === deliveryId);
    if (delivery === undefined) {
      return yield* new SlackAgentRunStoreError({ message: "Enqueued delivery disappeared" });
    }
    return delivery;
  });

  const createRunWithAcceptedDelivery: SlackAgentRunStoreShape["createRunWithAcceptedDelivery"] =
    Effect.fn("SlackAgentRunStore.createRunWithAcceptedDelivery")(function* (input) {
      if (input.mode === "chat" && (input.threadId === undefined || input.threadId === null)) {
        return yield* new SlackAgentRunStoreError({
          message: "Chat Slack agent runs require a threadId",
        });
      }
      if (input.mode === "workflow" && (input.ticketId === undefined || input.ticketId === null)) {
        return yield* new SlackAgentRunStoreError({
          message: "Workflow Slack agent runs require a ticketId",
        });
      }
      const eventId = yield* ids.eventId();
      const runId = String(input.runId ?? `slackrun-${eventId}`);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* wrap(
        "Failed to create Slack agent run",
        sql`
          INSERT INTO slack_agent_run (
            run_id,
            instance_id,
            project_id,
            external_event_id,
            mode,
            workspace_id,
            channel_id,
            channel_name,
            thread_key,
            thread_ts,
            trigger_ts,
            snapshot_json,
            snapshot_sha256,
            snapshot_bytes,
            t3_thread_id,
            ticket_id,
            status,
            status_message_id,
            pr_url,
            last_applied_sequence,
            created_at,
            updated_at
          ) VALUES (
            ${runId},
            ${String(input.instanceId)},
            COALESCE(${input.projectId ?? null}, (
              SELECT project_id
              FROM slack_agent_instance
              WHERE instance_id = ${String(input.instanceId)}
            )),
            ${input.externalEventId},
            ${input.mode},
            ${input.workspaceId},
            ${input.channelId},
            ${input.channelName},
            ${input.threadKey},
            ${input.threadTs},
            ${input.triggerTs},
            ${input.snapshotJson},
            ${input.snapshotSha256},
            ${input.snapshotBytes},
            ${input.threadId ?? null},
            ${input.ticketId ?? null},
            ${input.status},
            NULL,
            NULL,
            -1,
            ${now},
            ${now}
          )
        `,
      );
      yield* enqueueDelivery({
        runId,
        workflowSequence: 0,
        kind: "accepted",
        operation: "post",
        payloadJson: input.acceptedPayloadJson,
        nextAttemptAt: input.nextAttemptAt ?? now,
      });
      const created = yield* runSummaryById(runId);
      if (created === null) {
        return yield* new SlackAgentRunStoreError({ message: "Created Slack run disappeared" });
      }
      return created;
    });

  const markDeliverySent: SlackAgentRunStoreShape["markDeliverySent"] = Effect.fn(
    "SlackAgentRunStore.markDeliverySent",
  )(function* (deliveryId, statusMessageId) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* wrap(
      "Failed to mark Slack agent delivery sent",
      sql`
        UPDATE slack_agent_delivery
        SET delivery_state = 'sent',
            status_message_id = COALESCE(${statusMessageId ?? null}, status_message_id),
            updated_at = ${now}
        WHERE delivery_id = ${String(deliveryId)}
      `,
    );
    if (statusMessageId !== undefined && statusMessageId !== null) {
      yield* wrap(
        "Failed to store Slack agent status message id",
        sql`
          UPDATE slack_agent_run
          SET status_message_id = ${statusMessageId},
              updated_at = ${now}
          WHERE run_id = (
            SELECT run_id FROM slack_agent_delivery WHERE delivery_id = ${String(deliveryId)}
          )
        `,
      );
    }
  });

  const markDeliveryFailed: SlackAgentRunStoreShape["markDeliveryFailed"] = Effect.fn(
    "SlackAgentRunStore.markDeliveryFailed",
  )(function* (deliveryId, lastError, nextAttemptAt) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* wrap(
      "Failed to mark Slack agent delivery failed",
      sql`
        UPDATE slack_agent_delivery
        SET delivery_state = 'failed',
            attempt_count = attempt_count + 1,
            last_error = ${lastError},
            next_attempt_at = ${nextAttemptAt},
            updated_at = ${now}
        WHERE delivery_id = ${String(deliveryId)}
      `,
    );
  });

  const markDeliverySuperseded: SlackAgentRunStoreShape["markDeliverySuperseded"] = Effect.fn(
    "SlackAgentRunStore.markDeliverySuperseded",
  )(function* (deliveryId) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* wrap(
      "Failed to mark Slack agent delivery superseded",
      sql`
        UPDATE slack_agent_delivery
        SET delivery_state = 'superseded',
            updated_at = ${now}
        WHERE delivery_id = ${String(deliveryId)}
      `,
    );
  });

  const updateRunStatus: SlackAgentRunStoreShape["updateRunStatus"] = Effect.fn(
    "SlackAgentRunStore.updateRunStatus",
  )(function* (input) {
    const current = yield* runSummaryById(String(input.runId));
    if (current === null) {
      return yield* new SlackAgentRunStoreError({ message: "Slack agent run not found" });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* wrap(
      "Failed to update Slack agent run status",
      sql`
        UPDATE slack_agent_run
        SET status = COALESCE(${input.status ?? null}, status),
            pr_url = CASE
              WHEN ${input.prUrl === undefined ? 0 : 1} = 0 THEN pr_url
              ELSE ${input.prUrl ?? null}
            END,
            status_message_id = CASE
              WHEN ${input.statusMessageId === undefined ? 0 : 1} = 0 THEN status_message_id
              ELSE ${input.statusMessageId ?? null}
            END,
            last_applied_sequence = COALESCE(${input.lastAppliedSequence ?? null}, last_applied_sequence),
            updated_at = ${now}
        WHERE run_id = ${String(input.runId)}
      `,
    );
  });

  const relinkChatThread: SlackAgentRunStoreShape["relinkChatThread"] = Effect.fn(
    "SlackAgentRunStore.relinkChatThread",
  )(function* (input) {
    const current = yield* runSummaryById(String(input.runId));
    if (current === null || current.mode !== "chat") {
      return yield* new SlackAgentRunStoreError({
        message: "Slack chat run not found",
      });
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* wrap(
      "Failed to relink Slack chat thread",
      sql`
        UPDATE slack_agent_run
        SET t3_thread_id = ${String(input.threadId)},
            updated_at = ${now}
        WHERE run_id = ${String(input.runId)}
          AND mode = 'chat'
      `,
    );
    const updated = yield* runSummaryById(String(input.runId));
    if (updated === null) {
      return yield* new SlackAgentRunStoreError({
        message: "Relinked Slack chat run disappeared",
      });
    }
    return updated;
  });

  const reserveIngestedEvent: SlackAgentRunStoreShape["reserveIngestedEvent"] = Effect.fn(
    "SlackAgentRunStore.reserveIngestedEvent",
  )(function* (input) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* wrap(
      "Failed to reserve Slack agent ingested event",
      sql`
        INSERT OR IGNORE INTO slack_agent_ingested_event (
          run_id,
          external_event_id,
          trigger_message_id,
          message_id,
          state,
          created_at,
          delivered_at
        ) VALUES (
          ${String(input.runId)},
          ${input.externalEventId},
          ${input.triggerMessageId},
          ${input.messageId},
          'pending',
          ${now},
          NULL
        )
      `,
    );
    const rows = yield* wrap(
      "Failed to read Slack agent ingested event",
      sql<{ readonly state: "pending" | "delivered" }>`
        SELECT state
        FROM slack_agent_ingested_event
        WHERE run_id = ${String(input.runId)}
          AND (
            external_event_id = ${input.externalEventId}
            OR trigger_message_id = ${input.triggerMessageId}
          )
        LIMIT 1
      `,
    );
    return rows[0]?.state === "delivered";
  });

  const markIngestedEventDelivered: SlackAgentRunStoreShape["markIngestedEventDelivered"] =
    Effect.fn("SlackAgentRunStore.markIngestedEventDelivered")(function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* wrap(
        "Failed to mark Slack agent ingested event delivered",
        sql`
          UPDATE slack_agent_ingested_event
          SET state = 'delivered',
              delivered_at = ${now}
          WHERE run_id = ${String(input.runId)}
            AND (
              external_event_id = ${input.externalEventId}
              OR trigger_message_id = ${input.triggerMessageId}
            )
        `,
      );
    });

  const seedDeliveredIngestedEvents: SlackAgentRunStoreShape["seedDeliveredIngestedEvents"] =
    Effect.fn("SlackAgentRunStore.seedDeliveredIngestedEvents")(function* (input) {
      if (input.events.length === 0) return;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* Effect.forEach(
        input.events,
        (event) =>
          wrap(
            "Failed to seed delivered Slack agent ingested event",
            sql`
              INSERT OR IGNORE INTO slack_agent_ingested_event (
                run_id,
                external_event_id,
                trigger_message_id,
                message_id,
                state,
                created_at,
                delivered_at
              ) VALUES (
                ${String(input.runId)},
                ${event.externalEventId},
                ${event.triggerMessageId},
                ${event.messageId},
                'delivered',
                ${now},
                ${now}
              )
            `,
          ),
        { discard: true },
      );
    });

  const pruneRunlessMockThreads: SlackAgentRunStoreShape["pruneRunlessMockThreads"] = (cutoffIso) =>
    Effect.gen(function* () {
      const rows = yield* wrap(
        "Failed to count runless mock Slack threads",
        sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM mock_slack_thread AS thread
          WHERE thread.updated_at < ${cutoffIso}
            AND NOT EXISTS (
              SELECT 1
              FROM slack_agent_run AS run
              WHERE run.workspace_id = thread.workspace_id
                AND run.channel_id = thread.channel_id
                AND run.thread_ts = thread.thread_ts
            )
        `,
      );
      yield* wrap(
        "Failed to prune runless mock Slack threads",
        sql`
          DELETE FROM mock_slack_thread
          WHERE updated_at < ${cutoffIso}
            AND NOT EXISTS (
              SELECT 1
              FROM slack_agent_run AS run
              WHERE run.workspace_id = mock_slack_thread.workspace_id
                AND run.channel_id = mock_slack_thread.channel_id
                AND run.thread_ts = mock_slack_thread.thread_ts
            )
        `,
      );
      return rows[0]?.count ?? 0;
    });

  return {
    createRunWithAcceptedDelivery,
    getRun,
    getRunSummary,
    getRunByTicketId,
    getRunByDeliveryId,
    findByExternalEvent,
    findBySourceThread,
    findRootChatByChannel,
    findChatByThreadId,
    relinkChatThread,
    reserveIngestedEvent,
    markIngestedEventDelivered,
    seedDeliveredIngestedEvents,
    enqueueDelivery,
    listDeliveries,
    markDeliverySent,
    markDeliveryFailed,
    markDeliverySuperseded,
    updateRunStatus,
    pruneRunlessMockThreads,
  } satisfies SlackAgentRunStoreShape;
});

export const SlackAgentRunStoreLive = Layer.effect(SlackAgentRunStore, make);
