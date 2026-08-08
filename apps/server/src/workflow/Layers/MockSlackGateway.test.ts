import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { SlackAgentGateway } from "../Services/SlackAgentGateway.ts";
import { MockSlackGatewayLive } from "./MockSlackGateway.ts";

const createMockSlackThreadTable = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE IF NOT EXISTS mock_slack_thread (
        thread_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        status_replies_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workspace_id, channel_id, thread_ts)
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS slack_agent_run (
        run_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL
      )
    `;
  }),
);

const layer = it.layer(
  MockSlackGatewayLive.pipe(
    Layer.provideMerge(createMockSlackThreadTable),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const threadInput = {
  workspaceId: "T123",
  channelId: "C123",
  channelName: "eng",
  threadTs: "1000.000000",
  triggerEventId: "evt-1",
  triggerTs: "1000.000002",
  messages: [
    {
      messageId: "root",
      ts: "1000.000000",
      authorUserId: "U1",
      authorLabel: "Chris",
      text: "root",
    },
    {
      messageId: "trigger",
      ts: "1000.000002",
      authorUserId: "U2",
      authorLabel: "Taylor",
      text: "@t3_chris fix this",
    },
  ],
};

layer("MockSlackGateway", (it) => {
  it.effect("merges a later trigger into an existing thread exactly once", () =>
    Effect.gen(function* () {
      const gateway = yield* SlackAgentGateway;

      const first = yield* gateway.snapshotThreadThroughTrigger(threadInput);
      const laterInput = {
        ...threadInput,
        triggerEventId: "evt-later",
        triggerTs: "1000.000003",
        messages: [
          ...threadInput.messages,
          {
            messageId: "later-trigger",
            ts: "1000.000003",
            authorUserId: "U3",
            authorLabel: "Theo",
            text: "@t3_theo take the follow-up",
          },
        ],
      };
      const second = yield* gateway.snapshotThreadThroughTrigger(laterInput);
      const repeated = yield* gateway.snapshotThreadThroughTrigger(laterInput);

      assert.deepEqual(
        first.messages.map((message) => message.messageId),
        ["root", "trigger"],
      );
      assert.deepEqual(
        second.messages.map((message) => message.messageId),
        ["root", "trigger", "later-trigger"],
      );
      assert.equal(second.triggerMessageId, "later-trigger");
      assert.deepEqual(repeated.messages, second.messages);

      const thread = yield* gateway.subscribeMockThread(threadInput);
      assert.deepEqual(
        thread?.messages.map((message) => message.messageId),
        ["root", "trigger", "later-trigger"],
      );
    }),
  );

  it.effect("rejects a merge beyond 500 messages without growing the persisted thread", () =>
    Effect.gen(function* () {
      const gateway = yield* SlackAgentGateway;
      const messages = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_value, offset) => {
          const index = from + offset;
          return {
            messageId: `message-${index}`,
            ts: `5000.${String(index).padStart(6, "0")}`,
            authorUserId: "U1",
            authorLabel: "Chris",
            text: `Context ${index}`,
          };
        });
      const initialMessages = messages(1, 300);
      const key = {
        workspaceId: "T-bounded",
        channelId: "C-bounded",
        channelName: "eng",
        threadTs: "5000.000001",
      };
      yield* gateway.snapshotThreadThroughTrigger({
        ...key,
        triggerEventId: "evt-bounded-1",
        triggerTs: "5000.000300",
        triggerMessageId: "message-300",
        messages: initialMessages,
      });

      const oversized = yield* Effect.exit(
        gateway.snapshotThreadThroughTrigger({
          ...key,
          triggerEventId: "evt-bounded-2",
          triggerTs: "5000.000600",
          triggerMessageId: "message-600",
          messages: messages(301, 600),
        }),
      );

      assert.equal(oversized._tag, "Failure");
      const persisted = yield* gateway.subscribeMockThread(key);
      assert.equal(persisted?.messages.length, 300);
      assert.equal(persisted?.messages.at(-1)?.messageId, "message-300");
    }),
  );

  it.effect("rejects a disjoint older-trigger merge that would grow the thread past 500", () =>
    Effect.gen(function* () {
      const gateway = yield* SlackAgentGateway;
      const messages = (prefix: string, from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_value, offset) => {
          const index = from + offset;
          return {
            messageId: `${prefix}-${index}`,
            ts: `6000.${String(index).padStart(6, "0")}`,
            authorUserId: "U1",
            authorLabel: "Chris",
            text: `${prefix} context ${index}`,
          };
        });
      const key = {
        workspaceId: "T-bounded-older",
        channelId: "C-bounded-older",
        channelName: "eng",
        threadTs: "6000.000001",
      };
      yield* gateway.snapshotThreadThroughTrigger({
        ...key,
        triggerEventId: "evt-bounded-older-1",
        triggerTs: "6000.000500",
        triggerMessageId: "original-500",
        messages: messages("original", 1, 500),
      });

      const oversized = yield* Effect.exit(
        gateway.snapshotThreadThroughTrigger({
          ...key,
          triggerEventId: "evt-bounded-older-2",
          triggerTs: "6000.000250",
          triggerMessageId: "disjoint-250",
          messages: messages("disjoint", 1, 250),
        }),
      );

      assert.equal(oversized._tag, "Failure");
      const persisted = yield* gateway.subscribeMockThread(key);
      assert.equal(persisted?.messages.length, 500);
      assert.equal(persisted?.messages.at(-1)?.messageId, "original-500");
    }),
  );

  it.effect(
    "keeps several run status replies in one thread and treats delivery id as idempotent",
    () =>
      Effect.gen(function* () {
        const gateway = yield* SlackAgentGateway;
        yield* gateway.snapshotThreadThroughTrigger(threadInput);

        const first = yield* gateway.postOrUpdateStatus({
          workspaceId: "T123",
          channelId: "C123",
          channelName: "eng",
          threadTs: "1000.000000",
          runId: "run-1",
          deliveryId: "delivery-1",
          text: "Accepted by @t3_chris",
          now: "2026-08-07T00:00:00.000Z",
        });
        const duplicate = yield* gateway.postOrUpdateStatus({
          workspaceId: "T123",
          channelId: "C123",
          channelName: "eng",
          threadTs: "1000.000000",
          runId: "run-1",
          deliveryId: "delivery-1",
          text: "Should not overwrite",
          now: "2026-08-07T00:00:01.000Z",
        });
        const second = yield* gateway.postOrUpdateStatus({
          workspaceId: "T123",
          channelId: "C123",
          channelName: "eng",
          threadTs: "1000.000000",
          runId: "run-2",
          deliveryId: "delivery-2",
          text: "Accepted by @t3_taylor",
          now: "2026-08-07T00:00:02.000Z",
        });
        const updated = yield* gateway.postOrUpdateStatus({
          workspaceId: "T123",
          channelId: "C123",
          channelName: "eng",
          threadTs: "1000.000000",
          runId: "run-1",
          deliveryId: "delivery-3",
          statusMessageId: first.statusMessageId,
          text: "PR ready",
          now: "2026-08-07T00:00:03.000Z",
        });

        assert.equal(duplicate.statusMessageId, first.statusMessageId);
        assert.equal(second.statusMessageId === first.statusMessageId, false);
        assert.equal(updated.statusMessageId, first.statusMessageId);

        const thread = yield* gateway.subscribeMockThread({
          workspaceId: "T123",
          channelId: "C123",
          threadTs: "1000.000000",
        });
        assert.ok(thread);
        assert.equal(Object.keys(thread.statusReplies).length, 2);
        assert.equal(thread.statusReplies[first.statusMessageId]?.text, "PR ready");
        assert.equal(thread.statusReplies[first.statusMessageId]?.history.length, 2);
        assert.equal(thread.statusReplies[second.statusMessageId]?.text, "Accepted by @t3_taylor");
      }),
  );

  it.effect("serializes concurrent status replies from different runs in one thread", () =>
    Effect.gen(function* () {
      const gateway = yield* SlackAgentGateway;
      yield* gateway.snapshotThreadThroughTrigger({
        ...threadInput,
        workspaceId: "T-concurrent",
        channelId: "C-concurrent",
        threadTs: "4000.000000",
        triggerEventId: "evt-concurrent",
      });

      yield* Effect.all(
        [
          gateway.postOrUpdateStatus({
            workspaceId: "T-concurrent",
            channelId: "C-concurrent",
            channelName: "eng",
            threadTs: "4000.000000",
            runId: "run-concurrent-1",
            deliveryId: "delivery-concurrent-1",
            text: "Accepted by @t3_chris",
          }),
          gateway.postOrUpdateStatus({
            workspaceId: "T-concurrent",
            channelId: "C-concurrent",
            channelName: "eng",
            threadTs: "4000.000000",
            runId: "run-concurrent-2",
            deliveryId: "delivery-concurrent-2",
            text: "Accepted by @t3_theo",
          }),
        ],
        { concurrency: "unbounded" },
      );

      const thread = yield* gateway.subscribeMockThread({
        workspaceId: "T-concurrent",
        channelId: "C-concurrent",
        threadTs: "4000.000000",
      });
      assert.deepEqual(
        Object.values(thread?.statusReplies ?? {})
          .map((reply) => reply.runId)
          .sort(),
        ["run-concurrent-1", "run-concurrent-2"],
      );
    }),
  );

  it.effect("streams thread updates after the subscription is established", () =>
    Effect.gen(function* () {
      const gateway = yield* SlackAgentGateway;
      yield* gateway.snapshotThreadThroughTrigger(threadInput);
      const changes = yield* gateway.subscribeMockThreadChanges({
        workspaceId: "T123",
        channelId: "C123",
        threadTs: "1000.000000",
      });
      const nextFiber = yield* Stream.runHead(changes).pipe(Effect.forkChild);

      yield* gateway.postOrUpdateStatus({
        workspaceId: "T123",
        channelId: "C123",
        channelName: "eng",
        threadTs: "1000.000000",
        runId: "run-stream",
        deliveryId: "delivery-stream",
        text: "Live update",
      });

      const update = Option.getOrNull(yield* Fiber.join(nextFiber));
      assert.isNotNull(update);
      assert.equal(
        Object.values(update?.statusReplies ?? {}).find((reply) => reply.runId === "run-stream")
          ?.text,
        "Live update",
      );
    }),
  );

  it.effect("prunes only expired mock threads that have no linked run", () =>
    Effect.gen(function* () {
      const gateway = yield* SlackAgentGateway;
      const sql = yield* SqlClient.SqlClient;

      yield* gateway.snapshotThreadThroughTrigger(threadInput);
      yield* gateway.snapshotThreadThroughTrigger({
        ...threadInput,
        workspaceId: "T-runless",
        channelId: "C-runless",
        threadTs: "2000.000000",
        triggerEventId: "evt-runless",
      });
      yield* sql`
        UPDATE mock_slack_thread
        SET updated_at = '1900-01-01T00:00:00.000Z',
            status_replies_json = '{}'
      `;
      yield* sql`
        INSERT INTO slack_agent_run (
          run_id,
          instance_id,
          external_event_id,
          workspace_id,
          channel_id,
          channel_name,
          thread_key,
          thread_ts,
          trigger_ts,
          snapshot_json,
          snapshot_sha256,
          snapshot_bytes,
          ticket_id,
          status,
          created_at,
          updated_at
        )
        VALUES (
          'run-linked',
          'instance-linked',
          'event-linked',
          'T123',
          'C123',
          'eng',
          'T123:C123:1000.000000',
          '1000.000000',
          '1000.000002',
          '{}',
          'sha',
          2,
          'ticket-linked',
          'accepted',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* gateway.snapshotThreadThroughTrigger({
        ...threadInput,
        workspaceId: "T-new",
        channelId: "C-new",
        threadTs: "3000.000000",
        triggerEventId: "evt-new",
      });

      assert.ok(
        yield* gateway.subscribeMockThread({
          workspaceId: "T123",
          channelId: "C123",
          threadTs: "1000.000000",
        }),
      );
      assert.isNull(
        yield* gateway.subscribeMockThread({
          workspaceId: "T-runless",
          channelId: "C-runless",
          threadTs: "2000.000000",
        }),
      );
    }),
  );
});
