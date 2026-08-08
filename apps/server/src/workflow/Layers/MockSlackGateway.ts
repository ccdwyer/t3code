import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  SlackAgentGateway,
  SlackAgentGatewayError,
  type MockSlackStatusReply,
  type MockSlackThreadView,
  type SlackAgentGatewayShape,
} from "../Services/SlackAgentGateway.ts";
import {
  buildSlackThreadSnapshot,
  type SlackThreadMessageInput,
} from "../slack/slackThreadSnapshot.ts";

interface MockSlackThreadRow {
  readonly threadKey: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly threadTs: string;
  readonly messagesJson: string;
  readonly statusRepliesJson: string;
  readonly updatedAt: string;
}

const threadKeyFor = (input: {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadTs: string;
}) => `${input.workspaceId}:${input.channelId}:${input.threadTs}`;

const statusMessageIdFor = (runId: string) => `mock-status-${runId}`;
const isSlackAgentGatewayError = Schema.is(SlackAgentGatewayError);

const nowIso = Effect.gen(function* () {
  return DateTime.formatIso(yield* DateTime.now);
});

const wrap = <A>(message: string, effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new SlackAgentGatewayError({
          message,
          cause,
        }),
    ),
  );

const JsonString = Schema.fromJsonString(Schema.Unknown);
const encodeJsonString = Schema.encodeSync(JsonString);
const decodeJsonString = Schema.decodeUnknownSync(JsonString);

const parseMessages = (json: string): ReadonlyArray<SlackThreadMessageInput> =>
  decodeJsonString(json) as ReadonlyArray<SlackThreadMessageInput>;

const parseStatusReplies = (json: string): Record<string, MockSlackStatusReply> =>
  decodeJsonString(json) as Record<string, MockSlackStatusReply>;

const mergeMessagesById = (
  existing: ReadonlyArray<SlackThreadMessageInput>,
  incoming: ReadonlyArray<SlackThreadMessageInput>,
) => {
  const merged = new Map(existing.map((message) => [message.messageId, message]));
  for (const message of incoming) {
    if (!merged.has(message.messageId)) merged.set(message.messageId, message);
  }
  return [...merged.values()];
};

const slackTimestampValue = (ts: string) => {
  const [seconds = "0", micros = ""] = ts.split(".", 2);
  return BigInt(seconds) * 1_000_000n + BigInt(micros.padEnd(6, "0"));
};

const cutoffSevenDaysBefore = (iso: string) =>
  DateTime.formatIso(DateTime.subtract(DateTime.makeUnsafe(iso), { days: 7 }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threadChanges = yield* PubSub.unbounded<MockSlackThreadView>();

  const findThread = (input: {
    readonly workspaceId: string;
    readonly channelId: string;
    readonly threadTs: string;
  }) =>
    wrap(
      "MockSlackGateway.findThread",
      sql<MockSlackThreadRow>`
        SELECT
          thread_key AS "threadKey",
          workspace_id AS "workspaceId",
          channel_id AS "channelId",
          channel_name AS "channelName",
          thread_ts AS "threadTs",
          messages_json AS "messagesJson",
          status_replies_json AS "statusRepliesJson",
          updated_at AS "updatedAt"
        FROM mock_slack_thread
        WHERE workspace_id = ${input.workspaceId}
          AND channel_id = ${input.channelId}
          AND thread_ts = ${input.threadTs}
        LIMIT 1
      `,
    ).pipe(Effect.map((rows) => rows[0] ?? null));

  const upsertThread = (input: {
    readonly workspaceId: string;
    readonly channelId: string;
    readonly channelName: string;
    readonly threadTs: string;
    readonly messages: ReadonlyArray<SlackThreadMessageInput>;
    readonly statusReplies: Record<string, MockSlackStatusReply>;
    readonly updatedAt: string;
  }) =>
    wrap(
      "MockSlackGateway.upsertThread",
      sql`
        INSERT INTO mock_slack_thread
          (thread_key, workspace_id, channel_id, channel_name, thread_ts, messages_json, status_replies_json, updated_at)
        VALUES
          (
            ${threadKeyFor(input)},
            ${input.workspaceId},
            ${input.channelId},
            ${input.channelName},
            ${input.threadTs},
            ${encodeJsonString(input.messages)},
            ${encodeJsonString(input.statusReplies)},
            ${input.updatedAt}
          )
        ON CONFLICT(workspace_id, channel_id, thread_ts) DO UPDATE SET
          channel_name = excluded.channel_name,
          messages_json = excluded.messages_json,
          status_replies_json = excluded.status_replies_json,
          updated_at = excluded.updated_at
      `,
    ).pipe(Effect.asVoid);

  const toView = (row: MockSlackThreadRow): MockSlackThreadView => ({
    threadKey: row.threadKey,
    workspaceId: row.workspaceId,
    channelId: row.channelId,
    channelName: row.channelName,
    threadTs: row.threadTs,
    messages: parseMessages(row.messagesJson),
    statusReplies: parseStatusReplies(row.statusRepliesJson),
    updatedAt: row.updatedAt,
  });

  const publishCurrentThread = (input: {
    readonly workspaceId: string;
    readonly channelId: string;
    readonly threadTs: string;
  }) =>
    Effect.flatMap(findThread(input), (row) =>
      row === null ? Effect.void : PubSub.publish(threadChanges, toView(row)).pipe(Effect.asVoid),
    );

  const pruneRunlessThreads = (at: string) =>
    wrap(
      "MockSlackGateway.pruneRunlessThreads",
      sql`
        DELETE FROM mock_slack_thread
        WHERE updated_at < ${cutoffSevenDaysBefore(at)}
          AND NOT EXISTS (
            SELECT 1
            FROM slack_agent_run AS run
            WHERE run.workspace_id = mock_slack_thread.workspace_id
              AND run.channel_id = mock_slack_thread.channel_id
              AND run.thread_ts = mock_slack_thread.thread_ts
          )
      `,
    ).pipe(Effect.asVoid);

  const snapshotThreadThroughTrigger: SlackAgentGatewayShape["snapshotThreadThroughTrigger"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      yield* pruneRunlessThreads(at);
      const existing = yield* findThread(input);
      const existingMessages = existing === null ? [] : parseMessages(existing.messagesJson);
      const messages = mergeMessagesById(existingMessages, input.messages);
      const snapshot = yield* buildSlackThreadSnapshot({
        ...input,
        messages,
      });
      const persistedMessages = mergeMessagesById(existingMessages, snapshot.messages).sort(
        (left, right) => {
          const leftValue = slackTimestampValue(left.ts);
          const rightValue = slackTimestampValue(right.ts);
          return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
        },
      );
      const latestPersistedMessage = persistedMessages.at(-1);
      if (latestPersistedMessage !== undefined) {
        // An older trigger can produce a bounded snapshot while its disjoint
        // messages would make the persisted mock-thread view exceed the same
        // limits. Validate the complete candidate before replacing the row.
        yield* buildSlackThreadSnapshot({
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          channelName: input.channelName,
          threadTs: input.threadTs,
          triggerEventId: input.triggerEventId,
          triggerTs: latestPersistedMessage.ts,
          triggerMessageId: latestPersistedMessage.messageId,
          messages: persistedMessages,
          ...(input.maxMessages === undefined ? {} : { maxMessages: input.maxMessages }),
          ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        });
      }
      yield* upsertThread({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        channelName: input.channelName,
        threadTs: input.threadTs,
        messages: persistedMessages,
        statusReplies: existing === null ? {} : parseStatusReplies(existing.statusRepliesJson),
        updatedAt: at,
      });
      yield* publishCurrentThread(input);
      return snapshot;
    });

  const postOrUpdateStatus: SlackAgentGatewayShape["postOrUpdateStatus"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const at = input.now ?? (yield* nowIso);
          const existing = yield* findThread(input);
          const messages = existing === null ? [] : parseMessages(existing.messagesJson);
          const statusReplies =
            existing === null ? {} : parseStatusReplies(existing.statusRepliesJson);
          const existingForRun = Object.values(statusReplies).find(
            (reply) => reply.runId === input.runId,
          );
          const statusMessageId =
            input.statusMessageId ??
            existingForRun?.statusMessageId ??
            statusMessageIdFor(input.runId);
          const current = statusReplies[statusMessageId] ?? {
            statusMessageId,
            runId: input.runId,
            text: "",
            updatedAt: at,
            history: [],
          };
          if (current.history.some((entry) => entry.deliveryId === input.deliveryId)) {
            return {
              changed: false,
              result: { threadKey: threadKeyFor(input), statusMessageId },
            };
          }

          statusReplies[statusMessageId] = {
            statusMessageId,
            runId: current.runId,
            text: input.text,
            updatedAt: at,
            history: [
              ...current.history,
              {
                deliveryId: input.deliveryId,
                text: input.text,
                updatedAt: at,
              },
            ],
          };

          yield* upsertThread({
            workspaceId: input.workspaceId,
            channelId: input.channelId,
            channelName: input.channelName,
            threadTs: input.threadTs,
            messages,
            statusReplies,
            updatedAt: at,
          });

          return {
            changed: true,
            result: { threadKey: threadKeyFor(input), statusMessageId },
          };
        }),
      )
      .pipe(
        Effect.flatMap(({ changed, result }) =>
          changed ? publishCurrentThread(input).pipe(Effect.as(result)) : Effect.succeed(result),
        ),
        Effect.mapError((cause) =>
          isSlackAgentGatewayError(cause)
            ? cause
            : new SlackAgentGatewayError({
                message: "MockSlackGateway.postOrUpdateStatus transaction failed",
                cause,
              }),
        ),
      );

  const subscribeMockThread: SlackAgentGatewayShape["subscribeMockThread"] = (input) =>
    Effect.gen(function* () {
      const row = yield* findThread(input);
      if (row === null) return null;
      return toView(row);
    });

  const subscribeMockThreadChanges: SlackAgentGatewayShape["subscribeMockThreadChanges"] = (
    input,
  ) =>
    PubSub.subscribe(threadChanges).pipe(
      Effect.map((subscription) =>
        Stream.fromSubscription(subscription).pipe(
          Stream.filter((thread) => thread.threadKey === threadKeyFor(input)),
        ),
      ),
    );

  return {
    snapshotThreadThroughTrigger,
    postOrUpdateStatus,
    subscribeMockThread,
    subscribeMockThreadChanges,
  } satisfies SlackAgentGatewayShape;
});

export const MockSlackGatewayLive = Layer.effect(SlackAgentGateway, make);
