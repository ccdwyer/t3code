// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import {
  MockSlackChannelId,
  MockSlackMessageId,
  MockSlackUserId,
  MockSlackWorkspaceId,
  ProjectId,
  type SlackAgentInstanceView,
  type WorkflowEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { SlackAgentDeliveryDispatcher } from "../Services/SlackAgentDeliveryDispatcher.ts";
import { SlackAgentGateway } from "../Services/SlackAgentGateway.ts";
import { SlackAgentInstanceStore } from "../Services/SlackAgentInstanceStore.ts";
import { SlackAgentIntake } from "../Services/SlackAgentIntake.ts";
import { SlackAgentRunStore } from "../Services/SlackAgentRunStore.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { MockSlackGatewayLive } from "./MockSlackGateway.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { SlackAgentInstanceStoreLive } from "./SlackAgentInstanceStore.ts";
import { SlackAgentIntakeLive } from "./SlackAgentIntake.ts";
import { SlackAgentRunStoreLive } from "./SlackAgentRunStore.ts";
import { makeSlackAgentDeliveryDispatcherLive } from "./SlackAgentDeliveryDispatcher.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

const boardDefinition = {
  name: "Personal Slack PR lane",
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
          instruction: "Implement the Slack request.",
        },
        { key: "open-pr", type: "pullRequest" as const, action: "open" as const },
      ],
    },
  ],
};

const blockingExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.never,
  continueWithAnswers: () => Effect.die("no continuation in Slack integration tests"),
} satisfies StepExecutorShape);

const layer = it.layer(
  SlackAgentIntakeLive.pipe(
    Layer.provideMerge(SlackAgentInstanceStoreLive),
    Layer.provideMerge(SlackAgentRunStoreLive),
    Layer.provideMerge(makeSlackAgentDeliveryDispatcherLive()),
    Layer.provideMerge(MockSlackGatewayLive),
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
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const mentionFor = (
  target: Pick<SlackAgentInstanceView, "instanceId" | "botUserId">,
  suffix: "chris" | "theo" | "julius",
  threadTs: string,
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
        messageId: MockSlackMessageId.make(`root-${suffix}`),
        ts: `${threadTs.slice(0, threadTs.indexOf("."))}.000000`,
        authorUserId: MockSlackUserId.make(`user-root-${suffix}`),
        authorLabel: "Taylor",
        text: `Background for ${suffix}.`,
      },
      {
        messageId: MockSlackMessageId.make(`trigger-${suffix}`),
        ts: threadTs,
        authorUserId: MockSlackUserId.make(`user-${suffix}`),
        authorLabel: suffix,
        text: `<@${target.botUserId}> Implement the shared request and open the ${suffix} PR.`,
      },
    ],
    triggerMessageId: MockSlackMessageId.make(`trigger-${suffix}`),
  }) as const;

const ticketPrOpened = (
  ticketId: string,
  eventId: string,
  prNumber: number,
  url: string,
  branch: string,
): WorkflowEvent =>
  ({
    eventId,
    ticketId,
    occurredAt: "2026-08-07T00:00:01.000Z",
    type: "TicketPrOpened",
    payload: {
      stepRunId: `step-${eventId}`,
      prNumber,
      url,
      branch,
      remoteName: "origin",
      repo: "acme/t3code",
    },
  }) as never;

const countRows = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      table === "projection_ticket"
        ? yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS "count" FROM projection_ticket`
        : table === "slack_agent_run"
          ? yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS "count" FROM slack_agent_run`
          : table === "slack_agent_delivery"
            ? yield* sql<{
                readonly count: number;
              }>`SELECT COUNT(*) AS "count" FROM slack_agent_delivery`
            : yield* sql<{
                readonly count: number;
              }>`SELECT COUNT(*) AS "count" FROM mock_slack_thread`;
    return rows[0]?.count ?? 0;
  });

layer("SlackAgentMock integration", (it) => {
  it.effect(
    "routes concurrent personal mentions, duplicate retries, PR replies, and cleanup by originating thread",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        const readModel = yield* WorkflowReadModel;
        const instances = yield* SlackAgentInstanceStore;
        const intake = yield* SlackAgentIntake;
        const runs = yield* SlackAgentRunStore;
        const committer = yield* WorkflowEventCommitter;
        const dispatcher = yield* SlackAgentDeliveryDispatcher;
        const gateway = yield* SlackAgentGateway;
        const sql = yield* SqlClient.SqlClient;

        yield* registry.register("slack-integration-board" as never, boardDefinition);
        yield* readModel.registerBoard({
          boardId: "slack-integration-board" as never,
          projectId: ProjectId.make("project-slack"),
          name: boardDefinition.name,
          workflowFilePath: ".t3/workflows/slack-integration-board.json",
          workflowVersionHash: "version-slack",
          maxConcurrentTickets: 1,
        });

        const [chris, theo, julius] = yield* Effect.all([
          instances.create({
            workspaceId: "mock",
            ownerLabel: "Chris",
            handleSuffix: "chris",
            projectId: ProjectId.make("project-slack"),
            boardId: "slack-integration-board" as never,
            initialLane: "implement" as never,
          }),
          instances.create({
            workspaceId: "mock",
            ownerLabel: "Theo",
            handleSuffix: "theo",
            projectId: ProjectId.make("project-slack"),
            boardId: "slack-integration-board" as never,
            initialLane: "implement" as never,
          }),
          instances.create({
            workspaceId: "mock",
            ownerLabel: "Julius",
            handleSuffix: "julius",
            projectId: ProjectId.make("project-slack"),
            boardId: "slack-integration-board" as never,
            initialLane: "implement" as never,
          }),
        ]);

        const mentions = [
          mentionFor(chris, "chris", "100.000001"),
          mentionFor(theo, "theo", "200.000001"),
          mentionFor(julius, "julius", "300.000001"),
        ] as const;
        const accepted = yield* Effect.all(
          mentions.map((mention) => intake.acceptMention(mention)),
          { concurrency: "unbounded" },
        );

        assert.equal(accepted.length, 3);
        assert.equal(new Set(accepted.map((result) => result.run.runId)).size, 3);
        assert.equal(new Set(accepted.map((result) => result.run.ticketId)).size, 3);
        assert.equal(new Set(accepted.map((result) => result.run.instanceId)).size, 3);
        assert.equal(
          accepted.every((result) => !result.duplicate),
          true,
        );

        const tickets = yield* sql<{
          readonly ticketId: string;
          readonly title: string;
        }>`
          SELECT ticket_id AS "ticketId", title
          FROM projection_ticket
          WHERE board_id = 'slack-integration-board'
          ORDER BY ticket_id
        `;
        assert.equal(tickets.length, 3);
        assert.deepEqual(
          tickets.map((ticket) => `workflow/${ticket.ticketId}`),
          accepted.map((result) => `workflow/${result.run.ticketId}`).sort(),
        );
        assert.equal(
          tickets.every((ticket) => ticket.title.includes("Implement the shared request")),
          true,
        );

        for (const [index, result] of accepted.entries()) {
          const detail = yield* runs.getRun(result.run.runId);
          assert.isNotNull(detail);
          assert.equal(detail?.snapshot.messages.at(-1)?.text, mentions[index]!.messages[1]!.text);
          assert.equal(detail?.snapshot.thread.threadTs, mentions[index]!.thread.threadTs);
        }

        const duplicateRetries = yield* Effect.all(
          mentions.map((mention) => intake.acceptMention(mention)),
          { concurrency: "unbounded" },
        );
        assert.equal(
          duplicateRetries.every((result) => result.duplicate),
          true,
        );
        assert.deepEqual(
          duplicateRetries.map((result) => result.run.ticketId).sort(),
          accepted.map((result) => result.run.ticketId).sort(),
        );
        assert.equal(yield* countRows("projection_ticket"), 3);
        assert.equal(yield* countRows("slack_agent_run"), 3);

        for (const [index, result] of accepted.entries()) {
          const branch = `workflow/${result.run.ticketId}`;
          yield* committer.commit(
            ticketPrOpened(
              result.run.ticketId,
              `event-pr-${index + 1}`,
              101 + index,
              `https://github.com/acme/t3code/pull/${101 + index}`,
              branch,
            ) as never,
          );
        }
        yield* dispatcher.sweep();
        yield* dispatcher.sweep();

        for (const [index, result] of accepted.entries()) {
          const thread = yield* gateway.subscribeMockThread(result.run.thread);
          const replies = Object.values(thread?.statusReplies ?? {});
          assert.equal(replies.length, 1);
          const text = replies[0]?.text ?? "";
          const ownPr = `https://github.com/acme/t3code/pull/${101 + index}`;
          assert.include(text, ownPr);
          for (let other = 0; other < accepted.length; other += 1) {
            if (other !== index) {
              assert.notInclude(text, `https://github.com/acme/t3code/pull/${101 + other}`);
            }
          }
          assert.equal(replies[0]?.runId, result.run.runId);
          assert.deepEqual(
            replies[0]?.history.map((entry) => entry.text.includes(ownPr)),
            [false, true],
          );
        }

        const beforeTicketCleanup = accepted[0]!;
        yield* readModel.deleteTicketState(beforeTicketCleanup.run.ticketId);
        assert.isNull(yield* runs.getRun(beforeTicketCleanup.run.runId));
        assert.isNull(yield* gateway.subscribeMockThread(beforeTicketCleanup.run.thread));
        assert.equal(yield* countRows("slack_agent_run"), 2);
        assert.equal(yield* countRows("slack_agent_delivery"), 4);

        yield* readModel.deleteBoardTicketState("slack-integration-board" as never);
        assert.equal(yield* countRows("slack_agent_run"), 0);
        assert.equal(yield* countRows("slack_agent_delivery"), 0);
        assert.equal(yield* countRows("mock_slack_thread"), 0);
      }),
  );
});
