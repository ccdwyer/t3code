import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  SlackAgentCreateInstanceInput,
  SlackAgentHandle,
  SlackAgentHandleCollisionError,
  SlackAgentHandleSuffix,
  SlackAgentInstanceView,
  SlackAgentRunDetailView,
  SlackAgentSimulateMentionInput,
  SlackAgentSimulateMentionResult,
  SlackAgentThreadSnapshot,
} from "./index.ts";

describe("Slack agent contracts", () => {
  it.effect("accepts normalized t3 handles and rejects display mentions", () =>
    Effect.gen(function* () {
      const decodeHandle = Schema.decodeUnknownEffect(SlackAgentHandle);
      const decodeSuffix = Schema.decodeUnknownEffect(SlackAgentHandleSuffix);

      assert.equal(yield* decodeHandle("t3_chris"), "t3_chris");
      assert.equal(yield* decodeSuffix("chris_2"), "chris_2");

      const withAt = yield* Effect.exit(decodeHandle("@t3_chris"));
      assert.strictEqual(withAt._tag, "Failure");

      const uppercase = yield* Effect.exit(decodeSuffix("Chris"));
      assert.strictEqual(uppercase._tag, "Failure");

      const tooLong = yield* Effect.exit(decodeHandle(`t3_${"a".repeat(30)}`));
      assert.strictEqual(tooLong._tag, "Failure");
    }),
  );

  it.effect("requires create-instance acknowledgement and target identity", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SlackAgentCreateInstanceInput);
      const accepted = yield* decode({
        ownerLabel: "Chris",
        handleSuffix: "chris",
        target: {
          projectId: "project-1",
          boardId: "board-1",
          initialLane: "implement",
        },
        acknowledged: true,
      });

      assert.equal(accepted.target.boardId, "board-1");

      const missingAck = yield* Effect.exit(
        decode({
          ownerLabel: "Chris",
          handleSuffix: "chris",
          target: {
            projectId: "project-1",
            boardId: "board-1",
            initialLane: "implement",
          },
        }),
      );
      assert.strictEqual(missingAck._tag, "Failure");
    }),
  );

  it.effect("decodes instance views with derived setup state and metadata-only latest run", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SlackAgentInstanceView);
      const view = yield* decode({
        instanceId: "inst-1",
        handle: "t3_chris",
        ownerLabel: "Chris",
        botUserId: "bot-1",
        target: {
          projectId: "project-1",
          boardId: "board-1",
          initialLane: "implement",
        },
        enabled: true,
        state: "needs_setup",
        validation: {
          valid: false,
          reason: "No pullRequest/open step found after an agent step.",
          path: ["implement", "review"],
        },
        activeRunCount: 2,
        latestRun: {
          runId: "run-1",
          ticketId: "ticket-1",
          state: "running",
          updatedAt: "2026-08-07T12:00:00.000Z",
        },
        createdAt: "2026-08-07T11:00:00.000Z",
        updatedAt: "2026-08-07T12:00:00.000Z",
      });

      assert.equal(view.state, "needs_setup");
      assert.equal(view.latestRun?.state, "running");
      assert.notProperty(view.latestRun ?? {}, "snapshot");
    }),
  );

  it.effect("decodes simulation input so server-side bounds can return typed errors", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SlackAgentSimulateMentionInput);
      const input = yield* decode({
        instanceId: "inst-1",
        thread: {
          workspaceId: "workspace-1",
          channelId: "channel-1",
          channelName: "eng",
          threadTs: "1786123456.000001",
          threadKey: "demo-thread",
        },
        messages: [
          {
            messageId: "msg-1",
            ts: "1786123456.000001",
            authorUserId: "user-1",
            authorLabel: "Julius",
            text: "Can we fix this?",
          },
          {
            messageId: "msg-2",
            ts: "1786123460.000001",
            authorUserId: "user-2",
            authorLabel: "Chris",
            text: "<@bot-1> please patch it",
            attachments: [
              {
                id: "att-1",
                filename: "trace.txt",
                mediaType: "text/plain",
                sizeBytes: 42,
                permalink: "mock://files/att-1",
              },
            ],
          },
        ],
        triggerMessageId: "msg-2",
        externalEventId: "evt-1",
      });

      assert.equal(input.messages.length, 2);
      assert.equal(input.triggerMessageId, "msg-2");

      const overDomainLimit = yield* decode({
        instanceId: "inst-1",
        thread: {
          workspaceId: "workspace-1",
          channelId: "channel-1",
          channelName: "eng",
          threadTs: "1786123456.000001",
        },
        messages: Array.from({ length: 501 }, (_, index) => ({
          messageId: `msg-${index}`,
          ts: `1786123456.${String(index).padStart(6, "0")}`,
          authorUserId: "user-1",
          authorLabel: "Julius",
          text: "x",
        })),
        triggerMessageId: "msg-500",
      });
      assert.equal(overDomainLimit.messages.length, 501);
    }),
  );

  it.effect("decodes the duplicate-thread explanation returned by simulation", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SlackAgentSimulateMentionResult);
      const result = yield* decode({
        runId: "run-1",
        ticketId: "ticket-1",
        statusMessageId: "status-1",
        duplicate: true,
        state: "running",
        message:
          "This mock thread was already accepted. The later trigger was not added to the winning immutable snapshot.",
      });

      assert.include(result.message ?? "", "later trigger was not added");
    }),
  );

  it.effect("keeps the complete snapshot on the single-run detail surface", () =>
    Effect.gen(function* () {
      const decodeSnapshot = Schema.decodeUnknownEffect(SlackAgentThreadSnapshot);
      const snapshot = yield* decodeSnapshot({
        thread: {
          workspaceId: "workspace-1",
          channelId: "channel-1",
          channelName: "eng",
          threadTs: "1786123456.000001",
        },
        triggerEventId: "evt-1",
        triggerMessageId: "msg-2",
        triggerTs: "1786123460.000001",
        canonicalJsonBytes: 2048,
        messages: [
          {
            messageId: "msg-1",
            ts: "1786123456.000001",
            authorUserId: "user-1",
            authorLabel: "Julius",
            text: "Can we fix this?",
          },
          {
            messageId: "msg-2",
            ts: "1786123460.000001",
            authorUserId: "user-2",
            authorLabel: "Chris",
            text: "<@bot-1> please patch it",
            editedTs: "1786123461.000001",
          },
        ],
      });
      assert.equal(snapshot.messages[1]?.editedTs, "1786123461.000001");

      const decodeRun = Schema.decodeUnknownEffect(SlackAgentRunDetailView);
      const detail = yield* decodeRun({
        run: {
          runId: "run-1",
          instanceId: "inst-1",
          handle: "t3_chris",
          botUserId: "bot-1",
          ticketId: "ticket-1",
          thread: snapshot.thread,
          state: "pr_ready",
          statusMessageId: "status-1",
          prUrl: "https://github.com/acme/repo/pull/1",
          lastAppliedSequence: 2,
          createdAt: "2026-08-07T11:00:00.000Z",
          updatedAt: "2026-08-07T12:00:00.000Z",
        },
        snapshot,
        deliveries: [
          {
            deliveryId: "delivery-1",
            runId: "run-1",
            workflowSequence: 0,
            state: "delivered",
            attempts: 1,
            createdAt: "2026-08-07T11:00:00.000Z",
            updatedAt: "2026-08-07T11:00:01.000Z",
          },
        ],
      });

      assert.equal(detail.snapshot.messages.length, 2);
      assert.equal(detail.deliveries[0]?.workflowSequence, 0);
    }),
  );

  it.effect("decodes typed Slack-agent RPC errors", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SlackAgentHandleCollisionError);
      const error = yield* decode({
        _tag: "SlackAgentHandleCollisionError",
        handle: "t3_chris",
        message: "Handle already exists.",
      });
      assert.equal(error._tag, "SlackAgentHandleCollisionError");
      assert.equal(error.handle, "t3_chris");
    }),
  );
});
