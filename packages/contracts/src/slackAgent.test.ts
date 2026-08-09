import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  SlackAgentConnectInstanceInput,
  SlackAgentCreateInstanceInput,
  SlackAgentCreateMockInstanceInput,
  SlackAgentHandle,
  SlackAgentHandleCollisionError,
  SlackAgentHandleSuffix,
  SlackAgentInstanceView,
  SlackAgentInvocation,
  SlackAgentProjectSelector,
  SlackAgentRunDetailView,
  SlackAgentRunSummaryView,
  SlackAgentSimulateMentionInput,
  SlackAgentSimulateMentionResult,
  SlackAgentThreadSnapshot,
  SlackAgentTarget,
  SlackAgentUpdateInstanceInput,
  normalizeSlackAgentTargetProjects,
} from "./index.ts";

const decodeSlackAgentProjectSelector = Schema.decodeUnknownEffect(SlackAgentProjectSelector);

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
        },
        appToken: "xapp-valid",
        botToken: "xoxb-valid",
        acknowledged: true,
      });

      assert.equal(accepted.target.projectId, "project-1");
      assert.equal(accepted.defaultModelSelection, undefined);

      const withDefaultModel = yield* decode({
        ownerLabel: "Chris",
        handleSuffix: "chris",
        target: {
          projectId: "project-1",
        },
        appToken: "xapp-valid",
        botToken: "xoxb-valid",
        defaultModelSelection: {
          instanceId: "codex",
          model: "gpt-5.5",
        },
        acknowledged: true,
      });
      assert.deepEqual(withDefaultModel.defaultModelSelection, {
        instanceId: "codex" as never,
        model: "gpt-5.5",
      });

      const missingAck = yield* Effect.exit(
        decode({
          ownerLabel: "Chris",
          handleSuffix: "chris",
          target: {
            projectId: "project-1",
          },
          appToken: "xapp-valid",
          botToken: "xoxb-valid",
        }),
      );
      assert.strictEqual(missingAck._tag, "Failure");

      const wrongToken = yield* Effect.exit(
        decode({
          ownerLabel: "Chris",
          handleSuffix: "chris",
          target: {
            projectId: "project-1",
          },
          appToken: "xoxb-wrong",
          botToken: "xapp-wrong",
          acknowledged: true,
        }),
      );
      assert.strictEqual(wrongToken._tag, "Failure");

      const missingTokens = yield* Effect.exit(
        decode({
          ownerLabel: "Chris",
          handleSuffix: "chris",
          target: {
            projectId: "project-1",
          },
          acknowledged: true,
        }),
      );
      assert.strictEqual(missingTokens._tag, "Failure");
    }),
  );

  it.effect("normalizes Slack agent targets to unique project bindings", () =>
    Effect.gen(function* () {
      const decodeTarget = Schema.decodeUnknownEffect(SlackAgentTarget);
      const target = yield* decodeTarget({
        projectId: "project-1",
        projects: [
          { projectId: "project-1", selector: "project-1" },
          { projectId: "project-2", selector: "two" },
          { projectId: "project-3", selector: "two" },
        ],
      });
      assert.deepEqual(
        normalizeSlackAgentTargetProjects(target).map(({ projectId, selector }) => ({
          projectId: String(projectId),
          selector: String(selector),
        })),
        [
          { projectId: "project-1", selector: "project-1" },
          { projectId: "project-2", selector: "two" },
        ],
      );

      const invalidSelectorProjectId = yield* decodeTarget({
        projectId: "Legacy Project.ID",
      });
      assert.deepEqual(
        normalizeSlackAgentTargetProjects(invalidSelectorProjectId).map(
          ({ projectId, selector }) => ({
            projectId: String(projectId),
            selector: String(selector),
          }),
        ),
        [{ projectId: "Legacy Project.ID", selector: "project" }],
      );

      const explicitDefaultAlias = yield* decodeTarget({
        projectId: "Legacy Project.ID",
        projects: [
          { projectId: "Legacy Project.ID", selector: "api" },
          { projectId: "project-2", selector: "web" },
        ],
      });
      assert.deepEqual(
        normalizeSlackAgentTargetProjects(explicitDefaultAlias).map(({ projectId, selector }) => ({
          projectId: String(projectId),
          selector: String(selector),
        })),
        [
          { projectId: "Legacy Project.ID", selector: "api" },
          { projectId: "project-2", selector: "web" },
        ],
      );

      const selector = yield* decodeSlackAgentProjectSelector("proj_2-dev");
      assert.equal(selector, "proj_2-dev");
      const uppercase = yield* Effect.exit(decodeSlackAgentProjectSelector("Project"));
      assert.equal(uppercase._tag, "Failure");
    }),
  );

  it.effect("decodes invocation project selectors", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SlackAgentInvocation);
      const chat = yield* decode({
        mode: "chat",
        projectSelector: "mobile",
      });
      assert.equal(chat.projectSelector, "mobile");
      const workflow = yield* decode({
        mode: "workflow",
        projectSelector: "api",
        target: {
          boardId: "board-1",
          initialLane: "implement",
        },
      });
      assert.equal(workflow.projectSelector, "api");
    }),
  );

  it.effect("accepts dev mock create input without Slack tokens", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SlackAgentCreateMockInstanceInput);
      const accepted = yield* decode({
        ownerLabel: "Chris",
        handleSuffix: "chris",
        target: {
          projectId: "project-1",
        },
        acknowledged: true,
      });

      assert.equal(accepted.ownerLabel, "Chris");
      assert.equal(accepted.target.projectId, "project-1");
      assert.equal(accepted.defaultModelSelection, undefined);

      const missingAck = yield* Effect.exit(
        decode({
          ownerLabel: "Chris",
          handleSuffix: "chris",
          target: {
            projectId: "project-1",
          },
        }),
      );
      assert.strictEqual(missingAck._tag, "Failure");
    }),
  );

  it.effect("decodes optional nullable Slack default model updates", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SlackAgentUpdateInstanceInput);
      const omitted = yield* decode({
        instanceId: "inst-1",
      });
      assert.equal(omitted.defaultModelSelection, undefined);

      const cleared = yield* decode({
        instanceId: "inst-1",
        defaultModelSelection: null,
      });
      assert.equal(cleared.defaultModelSelection, null);

      const selected = yield* decode({
        instanceId: "inst-1",
        defaultModelSelection: {
          instanceId: "claude",
          model: "opus-5",
        },
      });
      assert.deepEqual(selected.defaultModelSelection, {
        instanceId: "claude" as never,
        model: "opus-5",
      });
    }),
  );

  it.effect("requires reconnect credentials with Slack token prefixes", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SlackAgentConnectInstanceInput);
      const accepted = yield* decode({
        instanceId: "inst-1",
        appToken: "xapp-valid",
        botToken: "xoxb-valid",
      });
      assert.equal(accepted.instanceId, "inst-1");

      const invalid = yield* Effect.exit(
        decode({
          instanceId: "inst-1",
          appToken: "xoxb-wrong",
          botToken: "xapp-wrong",
        }),
      );
      assert.strictEqual(invalid._tag, "Failure");
    }),
  );

  it.effect("decodes instance views with derived setup state and metadata-only latest run", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SlackAgentInstanceView);
      const view = yield* decode({
        instanceId: "inst-1",
        kind: "slack",
        workspace: {
          workspaceId: "workspace-1",
          name: "T3",
        },
        appId: "app-1",
        botId: "bot-install-1",
        handle: "t3_chris",
        ownerLabel: "Chris",
        botUserId: "bot-1",
        target: {
          projectId: "project-1",
        },
        enabled: true,
        state: "needs_setup",
        validation: {
          valid: false,
          reason: "No pullRequest/open step found after an agent step.",
          path: ["implement", "review"],
        },
        activeRunCount: 2,
        credentialsConfigured: true,
        connection: {
          state: "error",
          lastError: "token revoked",
        },
        latestRun: {
          runId: "run-1",
          mode: "workflow",
          ticketId: "ticket-1",
          state: "running",
          updatedAt: "2026-08-07T12:00:00.000Z",
        },
        createdAt: "2026-08-07T11:00:00.000Z",
        updatedAt: "2026-08-07T12:00:00.000Z",
      });

      assert.equal(view.state, "needs_setup");
      assert.equal(view.kind, "slack");
      assert.equal(view.credentialsConfigured, true);
      assert.equal(view.connection.state, "error");
      assert.equal(view.defaultModelSelection, null);
      assert.equal(view.latestRun?.state, "running");
      assert.notProperty(view.latestRun ?? {}, "snapshot");
      assert.notProperty(view, "appToken");
      assert.notProperty(view, "botToken");
    }),
  );

  it.effect("decodes legacy mock instance views with compatible defaults", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SlackAgentInstanceView);
      const view = yield* decode({
        instanceId: "inst-legacy",
        handle: "t3_legacy",
        ownerLabel: "Legacy",
        botUserId: "bot-legacy",
        target: {
          projectId: "project-legacy",
        },
        enabled: true,
        state: "enabled",
        validation: {
          valid: true,
        },
        activeRunCount: 1,
        latestRun: {
          runId: "run-legacy",
          ticketId: "ticket-legacy",
          state: "running",
          updatedAt: "2026-08-07T12:00:00.000Z",
        },
        createdAt: "2026-08-07T11:00:00.000Z",
        updatedAt: "2026-08-07T12:00:00.000Z",
      });

      assert.equal(view.kind, "mock");
      assert.equal(view.workspace.workspaceId, "mock");
      assert.equal(view.credentialsConfigured, true);
      assert.equal(view.connection.state, "connected");
      assert.equal(view.defaultModelSelection, null);
      assert.equal(view.latestRun?.mode, "workflow");
      assert.equal(view.latestRun?.ticketId, "ticket-legacy");
      assert.notProperty(view.latestRun ?? {}, "threadId");
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
        invocation: {
          mode: "workflow",
          target: {
            boardId: "board-1",
            initialLane: "implement",
          },
        },
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
        mode: "workflow",
        ticketId: "ticket-1",
        statusMessageId: "status-1",
        duplicate: true,
        createdThread: false,
        state: "running",
        message:
          "This mock thread was already accepted. The later trigger was not added to the winning immutable snapshot.",
      });

      assert.include(result.message ?? "", "later trigger was not added");
    }),
  );

  it.effect("decodes run summaries with optional project id", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SlackAgentRunSummaryView);
      const run = yield* decode({
        runId: "run-1",
        instanceId: "inst-1",
        projectId: "project-1",
        handle: "t3_chris",
        botUserId: "bot-1",
        mode: "workflow",
        ticketId: "ticket-1",
        thread: {
          workspaceId: "workspace-1",
          channelId: "channel-1",
          channelName: "eng",
          threadTs: "1786123456.000001",
        },
        state: "accepted",
        lastAppliedSequence: -1,
        createdAt: "2026-08-07T11:00:00.000Z",
        updatedAt: "2026-08-07T11:00:00.000Z",
      });
      assert.equal(run.projectId, "project-1");

      const legacy = yield* decode({
        runId: "run-legacy",
        instanceId: "inst-1",
        handle: "t3_chris",
        botUserId: "bot-1",
        ticketId: "ticket-legacy",
        thread: {
          workspaceId: "workspace-1",
          channelId: "channel-1",
          channelName: "eng",
          threadTs: "1786123456.000001",
        },
        state: "accepted",
        lastAppliedSequence: -1,
        createdAt: "2026-08-07T11:00:00.000Z",
        updatedAt: "2026-08-07T11:00:00.000Z",
      });
      assert.equal(legacy.projectId, undefined);
      assert.equal(legacy.mode, "workflow");
    }),
  );

  it.effect("decodes legacy workflow simulation results with compatible defaults", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(SlackAgentSimulateMentionResult);
      const result = yield* decode({
        runId: "run-legacy",
        ticketId: "ticket-legacy",
        statusMessageId: "status-legacy",
        duplicate: false,
        state: "accepted",
      });

      assert.equal(result.mode, "workflow");
      assert.equal(result.createdThread, false);
      assert.equal(result.ticketId, "ticket-legacy");
      assert.notProperty(result, "threadId");
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
          mode: "workflow",
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

  it.effect("decodes legacy run detail payloads as workflow runs", () =>
    Effect.gen(function* () {
      const decodeRun = Schema.decodeUnknownEffect(SlackAgentRunDetailView);
      const snapshot = {
        thread: {
          workspaceId: "workspace-1",
          channelId: "channel-1",
          channelName: "eng",
          threadTs: "1786123456.000001",
        },
        triggerEventId: "evt-legacy",
        triggerMessageId: "msg-legacy",
        triggerTs: "1786123460.000001",
        canonicalJsonBytes: 512,
        messages: [
          {
            messageId: "msg-legacy",
            ts: "1786123460.000001",
            authorUserId: "user-1",
            authorLabel: "Chris",
            text: "<@bot-1> please patch it",
          },
        ],
      };

      const detail = yield* decodeRun({
        run: {
          runId: "run-legacy",
          instanceId: "inst-legacy",
          handle: "t3_legacy",
          botUserId: "bot-legacy",
          ticketId: "ticket-legacy",
          thread: snapshot.thread,
          state: "running",
          lastAppliedSequence: -1,
          createdAt: "2026-08-07T11:00:00.000Z",
          updatedAt: "2026-08-07T12:00:00.000Z",
        },
        snapshot,
        deliveries: [],
      });

      assert.equal(detail.run.mode, "workflow");
      assert.equal(detail.run.ticketId, "ticket-legacy");
      assert.notProperty(detail.run, "threadId");
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
