// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import {
  MockSlackChannelId,
  MockSlackMessageId,
  MockSlackUserId,
  MockSlackWorkspaceId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { MockSlackGatewayLive } from "./MockSlackGateway.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { SlackAgentInstanceStoreLive } from "./SlackAgentInstanceStore.ts";
import { SlackAgentRunStoreLive } from "./SlackAgentRunStore.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { SlackAgentIntakeLive, slackAgentStateForAdmissionOutcome } from "./SlackAgentIntake.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { SlackAgentInstanceStore } from "../Services/SlackAgentInstanceStore.ts";
import { SlackAgentIntake } from "../Services/SlackAgentIntake.ts";
import { SlackAgentRunStore } from "../Services/SlackAgentRunStore.ts";
import { SlackAgentGateway } from "../Services/SlackAgentGateway.ts";
import { SlackChatBridge } from "../../slack/Services/SlackChatBridge.ts";
import { SlackChatBridgeThreadDeletedError } from "../../slack/Services/SlackChatBridge.ts";
import { SlackChatReplyRelay } from "../../slack/Services/SlackChatReplyRelay.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";

const blockingExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.never,
  continueWithAnswers: () => Effect.die("no continuation in Slack intake tests"),
} satisfies StepExecutorShape);

const testSecretStore = Layer.succeed(ServerSecretStore.ServerSecretStore, {
  get: () => Effect.succeed(Option.none()),
  set: () => Effect.void,
  create: () => Effect.void,
  getOrCreateRandom: () => Effect.die("unused"),
  remove: () => Effect.void,
} satisfies ServerSecretStore.ServerSecretStore["Service"]);

const MockSlackChatBridgeLive = Layer.effect(
  SlackChatBridge,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return SlackChatBridge.of({
      deliverUserMessage: (input) =>
        Effect.gen(function* () {
          yield* sql`
            CREATE TABLE IF NOT EXISTS test_slack_deleted_thread (
              thread_id TEXT PRIMARY KEY
            )
          `;
          yield* sql`
            CREATE TABLE IF NOT EXISTS test_slack_delete_during_delivery (
              thread_id TEXT PRIMARY KEY
            )
          `;
          yield* sql`
            CREATE TABLE IF NOT EXISTS test_slack_rejected_turn_command (
              command_id TEXT PRIMARY KEY
            )
          `;
          const previouslyRejected = yield* sql<{ readonly found: number }>`
            SELECT 1 AS found
            FROM test_slack_rejected_turn_command
            WHERE command_id = ${input.startTurnCommandId}
            LIMIT 1
          `;
          if (previouslyRejected.length > 0) {
            return yield* new SlackChatBridgeThreadDeletedError({
              threadId: input.threadId,
              message: "Test turn command was previously rejected after deletion.",
            });
          }
          const deleteDuringDelivery = yield* sql<{ readonly found: number }>`
            SELECT 1 AS found
            FROM test_slack_delete_during_delivery
            WHERE thread_id = ${input.threadId}
            LIMIT 1
          `;
          if (deleteDuringDelivery.length > 0) {
            yield* sql`
              INSERT INTO test_slack_rejected_turn_command (command_id)
              VALUES (${input.startTurnCommandId})
            `;
            return yield* new SlackChatBridgeThreadDeletedError({
              threadId: input.threadId,
              message: "Test thread was deleted during turn dispatch.",
            });
          }
          const deleted = yield* sql<{ readonly found: number }>`
            SELECT 1 AS found
            FROM test_slack_deleted_thread
            WHERE thread_id = ${input.threadId}
            LIMIT 1
          `;
          if (deleted.length > 0) {
            return yield* new SlackChatBridgeThreadDeletedError({
              threadId: input.threadId,
              message: "Test thread was deleted.",
            });
          }
          yield* sql`
              CREATE TABLE IF NOT EXISTS test_slack_chat_bridge_delivery (
                project_id TEXT NOT NULL,
                default_model_instance_id TEXT,
                default_model TEXT,
                thread_id TEXT NOT NULL,
                create_thread_command_id TEXT NOT NULL,
                start_turn_command_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                title TEXT NOT NULL,
                text TEXT NOT NULL,
                UNIQUE (start_turn_command_id),
                UNIQUE (message_id)
              )
            `;
          const existing = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM test_slack_chat_bridge_delivery
              WHERE thread_id = ${input.threadId}
            `;
          yield* sql`
              INSERT OR IGNORE INTO test_slack_chat_bridge_delivery (
                project_id,
                default_model_instance_id,
                default_model,
                thread_id,
                create_thread_command_id,
                start_turn_command_id,
                message_id,
                title,
                text
              ) VALUES (
                ${input.projectId},
                ${input.defaultModelSelection?.instanceId ?? null},
                ${input.defaultModelSelection?.model ?? null},
                ${input.threadId},
                ${input.createThreadCommandId},
                ${input.startTurnCommandId},
                ${input.messageId},
                ${input.title},
                ${(existing[0]?.count ?? 0) === 0 ? input.text : (input.existingThreadText ?? input.text)}
              )
            `;
          return {
            threadId: input.threadId,
            createdThread: (existing[0]?.count ?? 0) === 0,
          };
        }).pipe(Effect.catchTag("SqlError", (cause) => Effect.die(cause))),
    });
  }),
);

const MockSlackChatReplyRelayLive = Layer.effect(
  SlackChatReplyRelay,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return SlackChatReplyRelay.of({
      notifyChatLinked: (threadId) =>
        Effect.gen(function* () {
          yield* sql`
            CREATE TABLE IF NOT EXISTS test_slack_chat_reply_link (
              thread_id TEXT PRIMARY KEY
            )
          `;
          yield* sql`
            INSERT OR IGNORE INTO test_slack_chat_reply_link (thread_id)
            VALUES (${threadId})
          `;
        }).pipe(Effect.orDie),
      start: () => Effect.void,
    });
  }),
);

const layer = it.layer(
  SlackAgentIntakeLive.pipe(
    Layer.provideMerge(SlackAgentInstanceStoreLive),
    Layer.provideMerge(SlackAgentRunStoreLive),
    Layer.provideMerge(MockSlackGatewayLive),
    Layer.provideMerge(MockSlackChatBridgeLive),
    Layer.provideMerge(MockSlackChatReplyRelayLive),
    Layer.provideMerge(WorkflowEngineLayer),
    Layer.provideMerge(WorkflowEventCommitterLive),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(WorkflowRoutingContextBuilderLive),
    Layer.provideMerge(ApprovalGateLive),
    Layer.provideMerge(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(blockingExecutor),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(testSecretStore),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const boardDefinition = {
  name: "Slack PR work",
  settings: { maxConcurrentTickets: 1 },
  lanes: [
    {
      key: "implement",
      name: "Implement",
      entry: "auto" as const,
      pipeline: [
        {
          key: "code",
          type: "agent" as const,
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "Implement the request.",
        },
        { key: "open-pr", type: "pullRequest" as const, action: "open" as const },
      ],
    },
  ],
};

it("maps every workflow admission outcome to the initial Slack run state", () => {
  assert.equal(slackAgentStateForAdmissionOutcome("moved"), "running");
  assert.equal(slackAgentStateForAdmissionOutcome("queued"), "queued");
  assert.equal(slackAgentStateForAdmissionOutcome("none"), "accepted");
});

layer("SlackAgentIntake", (it) => {
  it.effect(
    "accepts instances targeting different registered projects in the same environment",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        const instances = yield* SlackAgentInstanceStore;
        const intake = yield* SlackAgentIntake;
        const readModel = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;

        yield* registry.register("slack-board-alpha" as never, boardDefinition);
        yield* registry.register("slack-board-beta" as never, boardDefinition);
        yield* readModel.registerBoard({
          boardId: "slack-board-alpha" as never,
          projectId: ProjectId.make("project-alpha"),
          name: "Alpha Slack PR work",
          workflowFilePath: ".t3/workflows/slack-board-alpha.json",
          workflowVersionHash: "version-alpha",
          maxConcurrentTickets: 1,
        });
        yield* readModel.registerBoard({
          boardId: "slack-board-beta" as never,
          projectId: ProjectId.make("project-beta"),
          name: "Beta Slack PR work",
          workflowFilePath: ".t3/workflows/slack-board-beta.json",
          workflowVersionHash: "version-beta",
          maxConcurrentTickets: 1,
        });
        const alpha = yield* instances.create({
          workspaceId: "mock",
          ownerLabel: "Alpha",
          handleSuffix: "alpha",
          projectId: ProjectId.make("project-alpha"),
        });
        const beta = yield* instances.create({
          workspaceId: "mock",
          ownerLabel: "Beta",
          handleSuffix: "beta",
          projectId: ProjectId.make("project-beta"),
        });

        const mentionFor = (
          target: typeof alpha,
          suffix: string,
          threadTs: string,
          boardId: "slack-board-alpha" | "slack-board-beta",
        ) =>
          ({
            instanceId: target.instanceId,
            botUserId: target.botUserId,
            externalEventId: `event-${suffix}`,
            thread: {
              workspaceId: MockSlackWorkspaceId.make("mock"),
              channelId: MockSlackChannelId.make("engineering"),
              channelName: "engineering",
              threadTs,
            },
            messages: [
              {
                messageId: MockSlackMessageId.make(`message-${suffix}`),
                ts: threadTs,
                authorUserId: MockSlackUserId.make(`user-${suffix}`),
                authorLabel: suffix,
                text: `<@${target.botUserId}> Implement ${suffix} and open a PR.`,
              },
            ],
            triggerMessageId: MockSlackMessageId.make(`message-${suffix}`),
            workflowAuthorized: true,
            invocation: {
              mode: "workflow",
              target: { boardId: boardId as never, initialLane: "implement" as never },
            },
          }) as const;

        const accepted = yield* Effect.all([
          intake.acceptMention(mentionFor(alpha, "alpha", "410.000001", "slack-board-alpha")),
          intake.acceptMention(mentionFor(beta, "beta", "420.000001", "slack-board-beta")),
        ]);
        assert.equal(accepted.filter((result) => !result.duplicate).length, 2);

        const rows = yield* sql<{
          readonly ticketId: string;
          readonly boardId: string;
          readonly projectId: string;
        }>`
        SELECT ticket.ticket_id AS "ticketId", ticket.board_id AS "boardId", board.project_id AS "projectId"
        FROM projection_ticket AS ticket
        JOIN projection_board AS board ON board.board_id = ticket.board_id
          WHERE ticket.ticket_id IN (${accepted[0]!.run.ticketId!}, ${accepted[1]!.run.ticketId!})
        ORDER BY board.project_id
      `;
        assert.deepEqual(
          rows.map((row) => ({ boardId: row.boardId, projectId: row.projectId })),
          [
            { boardId: "slack-board-alpha", projectId: "project-alpha" },
            { boardId: "slack-board-beta", projectId: "project-beta" },
          ],
        );
      }),
  );

  it.effect("rejects an instance whose target project does not own the board", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const instances = yield* SlackAgentInstanceStore;
      const intake = yield* SlackAgentIntake;
      const readModel = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;

      yield* registry.register("slack-board-owned-by-beta" as never, boardDefinition);
      yield* readModel.registerBoard({
        boardId: "slack-board-owned-by-beta" as never,
        projectId: ProjectId.make("project-beta"),
        name: "Beta Slack PR work",
        workflowFilePath: ".t3/workflows/slack-board-owned-by-beta.json",
        workflowVersionHash: "version-beta",
        maxConcurrentTickets: 1,
      });
      const mismatched = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Mismatch",
        handleSuffix: "mismatch",
        projectId: ProjectId.make("project-missing"),
      });

      const result = yield* Effect.exit(
        intake.acceptMention({
          instanceId: mismatched.instanceId,
          botUserId: mismatched.botUserId,
          externalEventId: "event-mismatch",
          thread: {
            workspaceId: MockSlackWorkspaceId.make("mock"),
            channelId: MockSlackChannelId.make("engineering"),
            channelName: "engineering",
            threadTs: "430.000001",
          },
          messages: [
            {
              messageId: MockSlackMessageId.make("message-mismatch"),
              ts: "430.000001",
              authorUserId: MockSlackUserId.make("user-mismatch"),
              authorLabel: "Mismatch",
              text: `<@${mismatched.botUserId}> This should not run.`,
            },
          ],
          triggerMessageId: MockSlackMessageId.make("message-mismatch"),
          workflowAuthorized: true,
          invocation: {
            mode: "workflow",
            target: {
              boardId: "slack-board-owned-by-beta" as never,
              initialLane: "implement" as never,
            },
          },
        }),
      );

      if (result._tag !== "Failure") {
        throw new Error("Expected mismatched project ownership to fail.");
      }
      assert.include(result.cause.toString(), 'does not belong to project "project-missing"');
      const rows = yield* sql<{ readonly tickets: number; readonly runs: number }>`
        SELECT
          (SELECT COUNT(*) FROM projection_ticket WHERE board_id = 'slack-board-owned-by-beta') AS tickets,
          (
            SELECT COUNT(*)
            FROM slack_agent_run AS run
            JOIN slack_agent_instance AS instance ON instance.instance_id = run.instance_id
            WHERE instance.handle = 't3_mismatch'
          ) AS runs
      `;
      assert.deepEqual(rows[0], { tickets: 0, runs: 0 });
    }),
  );

  it.effect("validates workflow boards against the selected project", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const instances = yield* SlackAgentInstanceStore;
      const intake = yield* SlackAgentIntake;
      const readModel = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;

      yield* registry.register("slack-board-selected-beta" as never, boardDefinition);
      yield* readModel.registerBoard({
        boardId: "slack-board-selected-beta" as never,
        projectId: ProjectId.make("project-beta"),
        name: "Beta Slack PR work",
        workflowFilePath: ".t3/workflows/slack-board-selected-beta.json",
        workflowVersionHash: "version-beta",
        maxConcurrentTickets: 1,
      });
      const instance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Workflow Selector",
        handleSuffix: "workflow_selector",
        projectId: ProjectId.make("project-alpha"),
        projects: [
          {
            projectId: ProjectId.make("project-beta"),
            selector: "beta" as never,
          },
        ],
      });

      const accepted = yield* intake.acceptMention({
        instanceId: instance.instanceId,
        botUserId: instance.botUserId,
        externalEventId: "event-workflow-selector",
        thread: {
          workspaceId: MockSlackWorkspaceId.make("mock"),
          channelId: MockSlackChannelId.make("workflow-selector"),
          channelName: "workflow-selector",
          threadTs: "440.000001",
        },
        messages: [
          {
            messageId: MockSlackMessageId.make("message-workflow-selector"),
            ts: "440.000001",
            authorUserId: MockSlackUserId.make("user-workflow-selector"),
            authorLabel: "Chris",
            text: `<@${instance.botUserId}> workflow board:slack-board-selected-beta lane:implement project:beta`,
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-workflow-selector"),
        workflowAuthorized: true,
        invocation: {
          mode: "workflow",
          projectSelector: "beta" as never,
          target: {
            boardId: "slack-board-selected-beta" as never,
            initialLane: "implement" as never,
          },
        },
      });

      assert.isFalse(accepted.duplicate);
      assert.equal(accepted.run.mode, "workflow");
      assert.equal(accepted.run.projectId, "project-beta");
      const rows = yield* sql<{ readonly boardProjectId: string; readonly runProjectId: string }>`
        SELECT board.project_id AS "boardProjectId", run.project_id AS "runProjectId"
        FROM slack_agent_run AS run
        JOIN projection_ticket AS ticket ON ticket.ticket_id = run.ticket_id
        JOIN projection_board AS board ON board.board_id = ticket.board_id
        WHERE run.run_id = ${accepted.run.runId}
      `;
      assert.deepStrictEqual(rows[0], {
        boardProjectId: "project-beta",
        runProjectId: "project-beta",
      });
    }),
  );

  it.effect("defaults to chat and delivers the full Slack context to the project", () =>
    Effect.gen(function* () {
      const instances = yield* SlackAgentInstanceStore;
      const intake = yield* SlackAgentIntake;
      const runs = yield* SlackAgentRunStore;
      const sql = yield* SqlClient.SqlClient;

      const instance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Chat",
        handleSuffix: "chat",
        projectId: ProjectId.make("project-chat"),
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("grok-main"),
          model: "grok-4.5",
        },
      });

      const accepted = yield* intake.acceptMention({
        instanceId: instance.instanceId,
        botUserId: instance.botUserId,
        externalEventId: "event-chat-initial",
        thread: {
          workspaceId: MockSlackWorkspaceId.make("mock"),
          channelId: MockSlackChannelId.make("engineering"),
          channelName: "engineering",
          threadTs: "510.000001",
        },
        messages: [
          {
            messageId: MockSlackMessageId.make("message-chat-root"),
            ts: "510.000001",
            authorUserId: MockSlackUserId.make("user-root"),
            authorLabel: "Chris",
            text: "Here is the background.",
          },
          {
            messageId: MockSlackMessageId.make("message-chat-trigger"),
            ts: "510.000002",
            authorUserId: MockSlackUserId.make("user-trigger"),
            authorLabel: "Alex",
            text: `<@${instance.botUserId}> Can you look into this?`,
            attachments: [
              {
                id: "F-chat-1",
                filename: "trace.txt",
                mediaType: "text/plain",
                sizeBytes: 42,
                permalink: "https://mock.slack/files/F-chat-1",
              },
            ],
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-chat-trigger"),
      });

      assert.isFalse(accepted.duplicate);
      assert.isTrue(accepted.createdThread);
      assert.equal(accepted.run.mode, "chat");
      assert.equal(accepted.run.projectId, "project-chat");
      assert.isDefined(accepted.run.threadId);
      assert.isUndefined(accepted.run.ticketId);
      assert.equal(accepted.run.state, "connected");
      const linkedNotifications = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId"
        FROM test_slack_chat_reply_link
        WHERE thread_id = ${accepted.run.threadId!}
      `;
      assert.deepStrictEqual(linkedNotifications, [{ threadId: accepted.run.threadId }]);

      const detail = yield* runs.getRun(accepted.run.runId);
      assert.equal(detail?.snapshot.messages.length, 2);
      const deliveries = yield* sql<{
        readonly projectId: string;
        readonly defaultModelInstanceId: string | null;
        readonly defaultModel: string | null;
        readonly threadId: string;
        readonly text: string;
      }>`
        SELECT
          project_id AS "projectId",
          default_model_instance_id AS "defaultModelInstanceId",
          default_model AS "defaultModel",
          thread_id AS "threadId",
          text
        FROM test_slack_chat_bridge_delivery
        WHERE thread_id = ${accepted.run.threadId!}
      `;
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.projectId, "project-chat");
      assert.equal(deliveries[0]?.defaultModelInstanceId, "grok-main");
      assert.equal(deliveries[0]?.defaultModel, "grok-4.5");
      assert.include(deliveries[0]?.text ?? "", "Here is the background.");
      assert.include(deliveries[0]?.text ?? "", "Can you look into this?");
      assert.include(deliveries[0]?.text ?? "", "trace.txt (text/plain, 42 bytes)");

      const replayWithNewEventId = yield* intake.acceptMention({
        instanceId: instance.instanceId,
        botUserId: instance.botUserId,
        externalEventId: "event-chat-initial-redelivery",
        thread: {
          workspaceId: MockSlackWorkspaceId.make("mock"),
          channelId: MockSlackChannelId.make("engineering"),
          channelName: "engineering",
          threadTs: "510.000001",
        },
        messages: detail!.snapshot.messages,
        triggerMessageId: MockSlackMessageId.make("message-chat-trigger"),
      });
      assert.isTrue(replayWithNewEventId.duplicate);
      const earlierSnapshotMessageReplay = yield* intake.acceptMention({
        instanceId: instance.instanceId,
        botUserId: instance.botUserId,
        externalEventId: "event-chat-earlier-message-redelivery",
        thread: {
          workspaceId: MockSlackWorkspaceId.make("mock"),
          channelId: MockSlackChannelId.make("engineering"),
          channelName: "engineering",
          threadTs: "510.000001",
        },
        messages: detail!.snapshot.messages,
        triggerMessageId: MockSlackMessageId.make("message-chat-root"),
      });
      assert.isTrue(earlierSnapshotMessageReplay.duplicate);
      const afterReplay = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM test_slack_chat_bridge_delivery
        WHERE thread_id = ${accepted.run.threadId!}
      `;
      assert.equal(afterReplay[0]?.count, 1);
    }),
  );

  it.effect("routes selected chat projects and pins linked follow-ups to the run project", () =>
    Effect.gen(function* () {
      const instances = yield* SlackAgentInstanceStore;
      const intake = yield* SlackAgentIntake;
      const sql = yield* SqlClient.SqlClient;

      const instance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Chat Selector",
        handleSuffix: "chat_selector",
        projectId: ProjectId.make("project-alpha"),
        projects: [
          {
            projectId: ProjectId.make("project-beta"),
            selector: "beta" as never,
          },
        ],
      });
      const initial = {
        instanceId: instance.instanceId,
        botUserId: instance.botUserId,
        externalEventId: "event-chat-selector-initial",
        thread: {
          workspaceId: MockSlackWorkspaceId.make("mock"),
          channelId: MockSlackChannelId.make("selector"),
          channelName: "selector",
          threadTs: "515.000001",
        },
        messages: [
          {
            messageId: MockSlackMessageId.make("message-chat-selector-initial"),
            ts: "515.000001",
            authorUserId: MockSlackUserId.make("user-selector"),
            authorLabel: "Chris",
            text: `<@${instance.botUserId}> project:beta Start a chat on beta.`,
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-chat-selector-initial"),
        invocation: {
          mode: "chat" as const,
          projectSelector: "beta" as never,
        },
      };

      const accepted = yield* intake.acceptMention(initial);
      assert.equal(accepted.run.projectId, "project-beta");
      assert.isDefined(accepted.run.threadId);

      yield* instances.update(instance.instanceId, {
        projectId: ProjectId.make("project-gamma"),
      });

      const followup = yield* intake.acceptMention({
        ...initial,
        externalEventId: "event-chat-selector-followup",
        messages: [
          ...initial.messages,
          {
            messageId: MockSlackMessageId.make("message-chat-selector-followup"),
            ts: "515.000002",
            authorUserId: MockSlackUserId.make("user-selector-followup"),
            authorLabel: "Alex",
            text: "project:gamma this should stay on beta.",
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-chat-selector-followup"),
        invocation: {
          mode: "chat" as const,
          projectSelector: "gamma" as never,
        },
      });

      assert.isFalse(followup.duplicate);
      assert.equal(followup.run.runId, accepted.run.runId);
      assert.equal(followup.run.projectId, "project-beta");
      const deliveries = yield* sql<{ readonly projectId: string; readonly text: string }>`
        SELECT project_id AS "projectId", text
        FROM test_slack_chat_bridge_delivery
        WHERE thread_id = ${accepted.run.threadId!}
        ORDER BY rowid ASC
      `;
      assert.deepStrictEqual(
        deliveries.map((delivery) => delivery.projectId),
        ["project-beta", "project-beta"],
      );
      assert.include(deliveries[1]?.text ?? "", "this should stay on beta.");
    }),
  );

  it.effect("rejects unknown project selectors with available aliases", () =>
    Effect.gen(function* () {
      const instances = yield* SlackAgentInstanceStore;
      const intake = yield* SlackAgentIntake;

      const instance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Unknown Selector",
        handleSuffix: "unknown_selector",
        projectId: ProjectId.make("project-alpha"),
        projects: [
          {
            projectId: ProjectId.make("project-beta"),
            selector: "beta" as never,
          },
        ],
      });

      const result = yield* Effect.exit(
        intake.acceptMention({
          instanceId: instance.instanceId,
          botUserId: instance.botUserId,
          externalEventId: "event-chat-selector-unknown",
          thread: {
            workspaceId: MockSlackWorkspaceId.make("mock"),
            channelId: MockSlackChannelId.make("selector-errors"),
            channelName: "selector-errors",
            threadTs: "516.000001",
          },
          messages: [
            {
              messageId: MockSlackMessageId.make("message-chat-selector-unknown"),
              ts: "516.000001",
              authorUserId: MockSlackUserId.make("user-selector-unknown"),
              authorLabel: "Chris",
              text: `<@${instance.botUserId}> project:missing Start a chat.`,
            },
          ],
          triggerMessageId: MockSlackMessageId.make("message-chat-selector-unknown"),
          invocation: {
            mode: "chat",
            projectSelector: "missing" as never,
          },
        }),
      );

      if (result._tag !== "Failure") {
        throw new Error("Expected unknown selector to fail.");
      }
      assert.include(result.cause.toString(), 'Slack project selector "missing"');
      assert.include(result.cause.toString(), "project");
      assert.include(result.cause.toString(), "beta");
    }),
  );

  it.effect("delivers chat follow-ups as new turns and treats retries as duplicates", () =>
    Effect.gen(function* () {
      const instances = yield* SlackAgentInstanceStore;
      const intake = yield* SlackAgentIntake;
      const sql = yield* SqlClient.SqlClient;

      const instance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Chat Followup",
        handleSuffix: "chat_followup",
        projectId: ProjectId.make("project-chat-followup"),
      });
      const initial = {
        instanceId: instance.instanceId,
        botUserId: instance.botUserId,
        externalEventId: "event-chat-followup-initial",
        thread: {
          workspaceId: MockSlackWorkspaceId.make("mock"),
          channelId: MockSlackChannelId.make("engineering"),
          channelName: "engineering",
          threadTs: "520.000001",
        },
        messages: [
          {
            messageId: MockSlackMessageId.make("message-chat-followup-root"),
            ts: "520.000001",
            authorUserId: MockSlackUserId.make("user-root"),
            authorLabel: "Chris",
            text: `<@${instance.botUserId}> Start a chat from this.`,
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-chat-followup-root"),
      } as const;

      const accepted = yield* intake.acceptMention(initial);
      const followup = {
        ...initial,
        externalEventId: "event-chat-followup-reply",
        messages: [
          ...initial.messages,
          {
            messageId: MockSlackMessageId.make("message-chat-followup-reply"),
            ts: "520.000002",
            authorUserId: MockSlackUserId.make("user-reply"),
            authorLabel: "Alex",
            text: "Here is one more detail.",
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-chat-followup-reply"),
      } as const;

      const delivered = yield* intake.acceptMention(followup);
      const retry = yield* intake.acceptMention(followup);

      assert.isFalse(delivered.duplicate);
      assert.isFalse(delivered.createdThread);
      assert.isTrue(retry.duplicate);
      assert.equal(delivered.run.runId, accepted.run.runId);
      const deliveries = yield* sql<{ readonly text: string }>`
        SELECT text
        FROM test_slack_chat_bridge_delivery
        WHERE thread_id = ${accepted.run.threadId!}
        ORDER BY rowid ASC
      `;
      assert.equal(deliveries.length, 2);
      assert.include(deliveries[1]?.text ?? "", "Here is one more detail.");
      assert.notInclude(deliveries[1]?.text ?? "", "Start a chat from this.");
      const runRows = yield* sql<{ readonly statusMessageId: string | null }>`
        SELECT status_message_id AS "statusMessageId"
        FROM slack_agent_run
        WHERE run_id = ${accepted.run.runId}
      `;
      assert.equal(runRows[0]?.statusMessageId, `mock-status-${accepted.run.runId}`);
    }),
  );

  it.effect("relinks a Slack chat when its T3 thread was deleted", () =>
    Effect.gen(function* () {
      const instances = yield* SlackAgentInstanceStore;
      const intake = yield* SlackAgentIntake;
      const sql = yield* SqlClient.SqlClient;

      const instance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Deleted Chat Recovery",
        handleSuffix: "deleted_chat_recovery",
        projectId: ProjectId.make("project-deleted-chat-recovery"),
      });
      const initial = {
        instanceId: instance.instanceId,
        botUserId: instance.botUserId,
        externalEventId: "event-deleted-chat-initial",
        thread: {
          workspaceId: MockSlackWorkspaceId.make("mock"),
          channelId: MockSlackChannelId.make("deleted-chat"),
          channelName: "deleted-chat",
          threadTs: "521.000001",
        },
        messages: [
          {
            messageId: MockSlackMessageId.make("message-deleted-chat-root"),
            ts: "521.000001",
            authorUserId: MockSlackUserId.make("user-deleted-chat-root"),
            authorLabel: "Chris",
            text: `<@${instance.botUserId}> Start this chat.`,
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-deleted-chat-root"),
      } as const;
      const accepted = yield* intake.acceptMention(initial);
      const deletedThreadId = accepted.run.threadId!;
      yield* sql`
        INSERT INTO test_slack_deleted_thread (thread_id)
        VALUES (${deletedThreadId})
      `;

      const recoveryInput = {
        ...initial,
        externalEventId: "event-deleted-chat-recovery",
        messages: [
          ...initial.messages,
          {
            messageId: MockSlackMessageId.make("message-deleted-chat-recovery"),
            ts: "521.000002",
            authorUserId: MockSlackUserId.make("user-deleted-chat-recovery"),
            authorLabel: "Alex",
            text: "Continue after the deleted T3 thread.",
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-deleted-chat-recovery"),
      } as const;
      const recovered = yield* intake.acceptMention(recoveryInput);
      const retry = yield* intake.acceptMention(recoveryInput);

      assert.equal(recovered.run.runId, accepted.run.runId);
      assert.notEqual(recovered.run.threadId, deletedThreadId);
      assert.isTrue(recovered.createdThread);
      assert.isTrue(retry.duplicate);
      const run = yield* sql<{ readonly threadId: string }>`
        SELECT t3_thread_id AS "threadId"
        FROM slack_agent_run
        WHERE run_id = ${accepted.run.runId}
      `;
      assert.equal(run[0]?.threadId, recovered.run.threadId);
      const recoveredDeliveries = yield* sql<{ readonly text: string }>`
        SELECT text
        FROM test_slack_chat_bridge_delivery
        WHERE thread_id = ${recovered.run.threadId!}
      `;
      assert.equal(recoveredDeliveries.length, 1);
      assert.include(recoveredDeliveries[0]?.text ?? "", "Start this chat.");
      assert.include(recoveredDeliveries[0]?.text ?? "", "Continue after the deleted T3 thread.");
    }),
  );

  it.effect("uses a fresh turn command when deletion races Slack message delivery", () =>
    Effect.gen(function* () {
      const instances = yield* SlackAgentInstanceStore;
      const intake = yield* SlackAgentIntake;
      const sql = yield* SqlClient.SqlClient;

      const instance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Deleted Chat Dispatch Race",
        handleSuffix: "deleted_chat_dispatch_race",
        projectId: ProjectId.make("project-deleted-chat-dispatch-race"),
      });
      const initial = {
        instanceId: instance.instanceId,
        botUserId: instance.botUserId,
        externalEventId: "event-deleted-chat-dispatch-race-initial",
        thread: {
          workspaceId: MockSlackWorkspaceId.make("mock"),
          channelId: MockSlackChannelId.make("deleted-chat-dispatch-race"),
          channelName: "deleted-chat-dispatch-race",
          threadTs: "522.000001",
        },
        messages: [
          {
            messageId: MockSlackMessageId.make("message-deleted-chat-dispatch-race-root"),
            ts: "522.000001",
            authorUserId: MockSlackUserId.make("user-deleted-chat-dispatch-race-root"),
            authorLabel: "Chris",
            text: `<@${instance.botUserId}> Start this chat.`,
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-deleted-chat-dispatch-race-root"),
      } as const;
      const accepted = yield* intake.acceptMention(initial);
      yield* sql`
        INSERT INTO test_slack_delete_during_delivery (thread_id)
        VALUES (${accepted.run.threadId!})
      `;

      const recoveryInput = {
        ...initial,
        externalEventId: "event-deleted-chat-dispatch-race-recovery",
        messages: [
          ...initial.messages,
          {
            messageId: MockSlackMessageId.make("message-deleted-chat-dispatch-race-recovery"),
            ts: "522.000002",
            authorUserId: MockSlackUserId.make("user-deleted-chat-dispatch-race-recovery"),
            authorLabel: "Alex",
            text: "Continue after the delete race.",
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-deleted-chat-dispatch-race-recovery"),
      } as const;
      const recovered = yield* intake.acceptMention(recoveryInput);
      const retry = yield* intake.acceptMention(recoveryInput);

      assert.equal(recovered.run.runId, accepted.run.runId);
      assert.notEqual(recovered.run.threadId, accepted.run.threadId);
      assert.isTrue(recovered.createdThread);
      assert.isTrue(retry.duplicate);
      const deliveries = yield* sql<{
        readonly startTurnCommandId: string;
        readonly text: string;
      }>`
        SELECT
          start_turn_command_id AS "startTurnCommandId",
          text
        FROM test_slack_chat_bridge_delivery
        WHERE thread_id = ${recovered.run.threadId!}
      `;
      const rejected = yield* sql<{ readonly commandId: string }>`
        SELECT command_id AS "commandId"
        FROM test_slack_rejected_turn_command
      `;
      assert.equal(deliveries.length, 1);
      assert.equal(rejected.length, 1);
      assert.notEqual(deliveries[0]?.startTurnCommandId, rejected[0]?.commandId);
      assert.include(deliveries[0]?.text ?? "", "Continue after the delete race.");
    }),
  );

  it.effect("serializes distinct first chat events without dropping either Slack message", () =>
    Effect.gen(function* () {
      const instances = yield* SlackAgentInstanceStore;
      const intake = yield* SlackAgentIntake;
      const sql = yield* SqlClient.SqlClient;
      const instance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Chat Race",
        handleSuffix: "chat_race",
        projectId: ProjectId.make("project-chat-race"),
      });
      const first = {
        instanceId: instance.instanceId,
        botUserId: instance.botUserId,
        externalEventId: "event-chat-race-1",
        thread: {
          workspaceId: MockSlackWorkspaceId.make("mock"),
          channelId: MockSlackChannelId.make("engineering"),
          channelName: "engineering",
          threadTs: "525.000001",
          threadKey: "race-key-a",
        },
        messages: [
          {
            messageId: MockSlackMessageId.make("message-chat-race-1"),
            ts: "525.000001",
            authorUserId: MockSlackUserId.make("user-race-1"),
            authorLabel: "Chris",
            text: `<@${instance.botUserId}> First request.`,
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-chat-race-1"),
      } as const;
      const second = {
        ...first,
        externalEventId: "event-chat-race-2",
        thread: { ...first.thread, threadKey: "race-key-b" },
        messages: [
          ...first.messages,
          {
            messageId: MockSlackMessageId.make("message-chat-race-2"),
            ts: "525.000002",
            authorUserId: MockSlackUserId.make("user-race-2"),
            authorLabel: "Alex",
            text: "Second detail.",
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-chat-race-2"),
      } as const;

      const results = yield* Effect.all(
        [intake.acceptMention(first), intake.acceptMention(second)],
        { concurrency: "unbounded" },
      );
      assert.equal(new Set(results.map((result) => result.run.runId)).size, 1);
      const deliveries = yield* sql<{ readonly text: string }>`
        SELECT text
        FROM test_slack_chat_bridge_delivery
        WHERE thread_id = ${results[0]!.run.threadId!}
        ORDER BY rowid ASC
      `;
      const transcript = deliveries.map((delivery) => delivery.text).join("\n");
      assert.equal(transcript.split("First request.").length - 1, 1);
      assert.equal(transcript.split("Second detail.").length - 1, 1);
    }),
  );

  it.effect("recovers an orphaned initial chat dispatch with the next distinct Slack event", () =>
    Effect.gen(function* () {
      const instances = yield* SlackAgentInstanceStore;
      const intake = yield* SlackAgentIntake;
      const sql = yield* SqlClient.SqlClient;
      const instance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Chat Recovery",
        handleSuffix: "chat_recovery",
        projectId: ProjectId.make("project-chat-recovery"),
      });
      yield* sql`
        CREATE TRIGGER fail_chat_recovery_run_insert
        BEFORE INSERT ON slack_agent_run
        WHEN NEW.external_event_id = 'event-chat-recovery-1'
        BEGIN
          SELECT RAISE(ABORT, 'injected chat run insert failure');
        END
      `;
      const first = {
        instanceId: instance.instanceId,
        botUserId: instance.botUserId,
        externalEventId: "event-chat-recovery-1",
        thread: {
          workspaceId: MockSlackWorkspaceId.make("mock"),
          channelId: MockSlackChannelId.make("recovery"),
          channelName: "recovery",
          threadTs: "526.000001",
        },
        messages: [
          {
            messageId: MockSlackMessageId.make("message-chat-recovery-1"),
            ts: "526.000001",
            authorUserId: MockSlackUserId.make("user-chat-recovery-1"),
            authorLabel: "Chris",
            text: `<@${instance.botUserId}> Recovery first request.`,
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-chat-recovery-1"),
      } as const;

      assert.equal((yield* Effect.exit(intake.acceptMention(first)))._tag, "Failure");
      yield* sql`DROP TRIGGER fail_chat_recovery_run_insert`;

      const recovered = yield* intake.acceptMention({
        ...first,
        externalEventId: "event-chat-recovery-2",
        messages: [
          ...first.messages,
          {
            messageId: MockSlackMessageId.make("message-chat-recovery-2"),
            ts: "526.000002",
            authorUserId: MockSlackUserId.make("user-chat-recovery-2"),
            authorLabel: "Alex",
            text: "Recovery second detail.",
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-chat-recovery-2"),
      });

      assert.isFalse(recovered.createdThread);
      const deliveries = yield* sql<{ readonly text: string }>`
        SELECT text
        FROM test_slack_chat_bridge_delivery
        WHERE thread_id = ${recovered.run.threadId!}
        ORDER BY rowid ASC
      `;
      const transcript = deliveries.map((delivery) => delivery.text).join("\n");
      assert.equal(transcript.split("Recovery first request.").length - 1, 1);
      assert.equal(transcript.split("Recovery second detail.").length - 1, 1);
    }),
  );

  it.effect("atomically creates one workflow ticket/run for concurrent duplicate mentions", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const instances = yield* SlackAgentInstanceStore;
      const intake = yield* SlackAgentIntake;
      const runs = yield* SlackAgentRunStore;
      const gateway = yield* SlackAgentGateway;
      const readModel = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;

      yield* registry.register("slack-board" as never, boardDefinition);
      yield* readModel.registerBoard({
        boardId: "slack-board" as never,
        projectId: ProjectId.make("project-1"),
        name: boardDefinition.name,
        workflowFilePath: ".t3/workflows/slack-board.json",
        workflowVersionHash: "version-1",
        maxConcurrentTickets: 1,
      });
      const instance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Chris",
        handleSuffix: "chris",
        projectId: ProjectId.make("project-1"),
      });
      const theoInstance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Theo",
        handleSuffix: "theo",
        projectId: ProjectId.make("project-1"),
      });
      const juliusInstance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Julius",
        handleSuffix: "julius",
        projectId: ProjectId.make("project-1"),
      });
      const mention = {
        instanceId: instance.instanceId,
        botUserId: instance.botUserId,
        externalEventId: "event-1",
        thread: {
          workspaceId: MockSlackWorkspaceId.make("mock"),
          channelId: MockSlackChannelId.make("engineering"),
          channelName: "engineering",
          threadTs: "100.000001",
        },
        messages: [
          {
            messageId: MockSlackMessageId.make("message-1"),
            ts: "100.000001",
            authorUserId: MockSlackUserId.make("user-chris"),
            authorLabel: "Chris",
            text: "<@mockbot> Please implement this safely and open a PR.",
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-1"),
        workflowAuthorized: true,
        invocation: {
          mode: "workflow",
          target: { boardId: "slack-board" as never, initialLane: "implement" as never },
        },
      } as const;
      const mentionFor = (target: typeof theoInstance, suffix: string, threadTs: string) => ({
        ...mention,
        instanceId: target.instanceId,
        botUserId: target.botUserId,
        externalEventId: `event-${suffix}`,
        thread: { ...mention.thread, threadTs },
        messages: [
          {
            ...mention.messages[0],
            messageId: MockSlackMessageId.make(`message-${suffix}`),
            ts: threadTs,
            text: `<@${target.botUserId}> Implement the ${suffix} request.`,
          },
        ],
        triggerMessageId: MockSlackMessageId.make(`message-${suffix}`),
      });

      const accepted = yield* Effect.all(
        [
          intake.acceptMention(mention),
          intake.acceptMention(mention),
          intake.acceptMention(mentionFor(theoInstance, "theo", "200.000001")),
          intake.acceptMention(mentionFor(juliusInstance, "julius", "300.000001")),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(new Set(accepted.map((result) => result.run.runId)).size, 3);
      assert.equal(new Set(accepted.map((result) => result.run.ticketId)).size, 3);
      assert.equal(new Set(accepted.map((result) => result.run.instanceId)).size, 3);
      assert.equal(accepted.filter((result) => !result.duplicate).length, 3);
      assert.equal(accepted.filter((result) => result.duplicate).length, 1);

      const laterInput = {
        ...mention,
        externalEventId: "event-2",
        messages: [
          ...mention.messages,
          {
            messageId: MockSlackMessageId.make("message-2"),
            ts: "100.000002",
            authorUserId: MockSlackUserId.make("user-alex"),
            authorLabel: "Alex",
            text: `<@${instance.botUserId}> Following up in the same thread.`,
          },
        ],
        triggerMessageId: MockSlackMessageId.make("message-2"),
      } as const;
      const followups = yield* Effect.all(
        [intake.acceptMention(laterInput), intake.acceptMention(laterInput)],
        { concurrency: "unbounded" },
      );
      const laterMention = followups.find((result) => !result.duplicate)!;
      assert.isFalse(laterMention.duplicate);
      assert.equal(followups.filter((result) => result.duplicate).length, 1);
      assert.equal(laterMention.run.runId, accepted[0]!.run.runId);
      assert.isFalse(laterMention.createdThread);

      const run = yield* runs.getRun(accepted[0]!.run.runId);
      assert.isNotNull(run);
      assert.equal(run?.snapshot.messages.length, 1);
      assert.equal(run?.snapshot.messages[0]?.text, mention.messages[0].text);
      const sourceThread = yield* gateway.subscribeMockThread({
        workspaceId: mention.thread.workspaceId,
        channelId: mention.thread.channelId,
        threadTs: mention.thread.threadTs,
      });
      assert.deepEqual(
        sourceThread?.messages.map((message) => message.messageId),
        ["message-1", "message-2"],
      );
      const ticket = yield* readModel.getTicketDetail(accepted[0]!.run.ticketId!);
      assert.equal(ticket?.ticket.title, "Please implement this safely and open a PR.");
      assert.isTrue(
        ticket?.messages.some((message) =>
          message.body.includes("Following up in the same thread."),
        ),
      );
      assert.equal(
        ticket?.messages.filter((message) =>
          message.body.includes("Following up in the same thread."),
        ).length,
        1,
      );

      yield* sql`
        UPDATE slack_agent_ingested_event
        SET state = 'pending', delivered_at = NULL
        WHERE run_id = ${laterMention.run.runId}
          AND trigger_message_id = 'message-2'
      `;
      const recoveredFollowup = yield* intake.acceptMention(laterInput);
      assert.isFalse(recoveredFollowup.createdThread);
      const ticketAfterRecovery = yield* readModel.getTicketDetail(accepted[0]!.run.ticketId!);
      assert.equal(
        ticketAfterRecovery?.messages.filter((message) =>
          message.body.includes("Following up in the same thread."),
        ).length,
        1,
      );
      const recoveredIngestion = yield* sql<{ readonly state: string }>`
        SELECT state
        FROM slack_agent_ingested_event
        WHERE run_id = ${laterMention.run.runId}
          AND trigger_message_id = 'message-2'
      `;
      assert.equal(recoveredIngestion[0]?.state, "delivered");

      const unauthorizedFollowup = yield* Effect.exit(
        intake.acceptMention({
          ...mention,
          workflowAuthorized: false,
          externalEventId: "event-unauthorized-followup",
          messages: [
            ...mention.messages,
            {
              messageId: MockSlackMessageId.make("message-unauthorized-followup"),
              ts: "100.000003",
              authorUserId: MockSlackUserId.make("user-unauthorized"),
              authorLabel: "Mallory",
              text: "This must not reach the workflow ticket.",
            },
          ],
          triggerMessageId: MockSlackMessageId.make("message-unauthorized-followup"),
        }),
      );
      assert.equal(unauthorizedFollowup._tag, "Failure");
      const ticketAfterUnauthorized = yield* readModel.getTicketDetail(accepted[0]!.run.ticketId!);
      assert.isFalse(
        ticketAfterUnauthorized?.messages.some((message) =>
          message.body.includes("This must not reach the workflow ticket."),
        ) ?? false,
      );

      const counts = yield* sql<{ readonly tickets: number; readonly runs: number }>`
        SELECT
          (SELECT COUNT(*) FROM projection_ticket WHERE board_id = 'slack-board') AS tickets,
          (
            SELECT COUNT(*)
            FROM slack_agent_run AS run
            JOIN projection_ticket AS ticket ON ticket.ticket_id = run.ticket_id
            WHERE ticket.board_id = 'slack-board'
          ) AS runs
      `;
      assert.deepEqual(counts[0], { tickets: 3, runs: 3 });
      const runRows = yield* sql<{
        readonly handle: string;
        readonly status: string;
        readonly payloadJson: string;
      }>`
        SELECT instance.handle, run.status, delivery.payload_json AS "payloadJson"
        FROM slack_agent_run AS run
        JOIN slack_agent_instance AS instance ON instance.instance_id = run.instance_id
        JOIN projection_ticket AS ticket ON ticket.ticket_id = run.ticket_id
        JOIN slack_agent_delivery AS delivery ON delivery.run_id = run.run_id
        WHERE delivery.workflow_sequence = 0
          AND ticket.board_id = 'slack-board'
        ORDER BY run.created_at, run.run_id
      `;
      assert.equal(runRows.length, 3);
      const chrisPayload = runRows.find((row) => row.handle === "t3_chris")?.payloadJson ?? "";
      assert.include(chrisPayload, "Accepted by @t3_chris");
      assert.include(chrisPayload, "t3://ticket/");
      assert.include(chrisPayload, "Plan:");
    }),
  );

  it.effect("rolls back the workflow ticket when run insertion fails", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const instances = yield* SlackAgentInstanceStore;
      const intake = yield* SlackAgentIntake;
      const readModel = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;

      yield* registry.register("slack-board-rollback" as never, boardDefinition);
      yield* readModel.registerBoard({
        boardId: "slack-board-rollback" as never,
        projectId: ProjectId.make("project-rollback"),
        name: boardDefinition.name,
        workflowFilePath: ".t3/workflows/slack-board-rollback.json",
        workflowVersionHash: "version-rollback",
        maxConcurrentTickets: 1,
      });
      const instance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Rollback",
        handleSuffix: "rollback",
        projectId: ProjectId.make("project-rollback"),
      });
      yield* sql`
        CREATE TRIGGER fail_slack_run_insert
        BEFORE INSERT ON slack_agent_run
        WHEN NEW.external_event_id = 'event-rollback'
        BEGIN
          SELECT RAISE(ABORT, 'injected Slack run insert failure');
        END
      `;

      const result = yield* Effect.exit(
        intake.acceptMention({
          instanceId: instance.instanceId,
          botUserId: instance.botUserId,
          externalEventId: "event-rollback",
          thread: {
            workspaceId: MockSlackWorkspaceId.make("mock"),
            channelId: MockSlackChannelId.make("rollback"),
            channelName: "rollback",
            threadTs: "900.000001",
          },
          messages: [
            {
              messageId: MockSlackMessageId.make("message-rollback"),
              ts: "900.000001",
              authorUserId: MockSlackUserId.make("user-rollback"),
              authorLabel: "Chris",
              text: `<@${instance.botUserId}> This must roll back.`,
            },
          ],
          triggerMessageId: MockSlackMessageId.make("message-rollback"),
          workflowAuthorized: true,
          invocation: {
            mode: "workflow",
            target: {
              boardId: "slack-board-rollback" as never,
              initialLane: "implement" as never,
            },
          },
        }),
      );
      assert.equal(result._tag, "Failure");

      const rows = yield* sql<{ readonly tickets: number; readonly runs: number }>`
        SELECT
          (
            SELECT COUNT(*) FROM projection_ticket
            WHERE board_id = 'slack-board-rollback'
          ) AS tickets,
          (
            SELECT COUNT(*) FROM slack_agent_run
            WHERE instance_id = ${instance.instanceId}
          ) AS runs
      `;
      assert.deepEqual(rows[0], { tickets: 0, runs: 0 });
    }),
  );

  it.effect("returns a typed oversized error before creating workflow state", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const instances = yield* SlackAgentInstanceStore;
      const intake = yield* SlackAgentIntake;
      const readModel = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;

      yield* registry.register("slack-board-oversized" as never, boardDefinition);
      yield* readModel.registerBoard({
        boardId: "slack-board-oversized" as never,
        projectId: ProjectId.make("project-oversized"),
        name: boardDefinition.name,
        workflowFilePath: ".t3/workflows/slack-board-oversized.json",
        workflowVersionHash: "version-oversized",
        maxConcurrentTickets: 1,
      });
      const instance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Oversized",
        handleSuffix: "oversized",
        projectId: ProjectId.make("project-oversized"),
      });
      const messages = Array.from({ length: 501 }, (_value, index) => ({
        messageId: MockSlackMessageId.make(`message-${index}`),
        ts: `910.${String(index).padStart(6, "0")}`,
        authorUserId: MockSlackUserId.make("user-oversized"),
        authorLabel: "Chris",
        text: index === 500 ? `<@${instance.botUserId}> Ship this.` : "Context",
      }));

      const error = yield* intake
        .acceptMention({
          instanceId: instance.instanceId,
          botUserId: instance.botUserId,
          externalEventId: "event-oversized",
          thread: {
            workspaceId: MockSlackWorkspaceId.make("mock"),
            channelId: MockSlackChannelId.make("oversized"),
            channelName: "oversized",
            threadTs: "910.000000",
          },
          messages,
          triggerMessageId: MockSlackMessageId.make("message-500"),
          workflowAuthorized: true,
          invocation: {
            mode: "workflow",
            target: {
              boardId: "slack-board-oversized" as never,
              initialLane: "implement" as never,
            },
          },
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "SlackAgentOversizedSnapshotError");

      const rows = yield* sql<{ readonly tickets: number; readonly runs: number }>`
        SELECT
          (
            SELECT COUNT(*) FROM projection_ticket
            WHERE board_id = 'slack-board-oversized'
          ) AS tickets,
          (
            SELECT COUNT(*) FROM slack_agent_run
            WHERE instance_id = ${instance.instanceId}
          ) AS runs
      `;
      assert.deepEqual(rows[0], { tickets: 0, runs: 0 });
    }),
  );
});
