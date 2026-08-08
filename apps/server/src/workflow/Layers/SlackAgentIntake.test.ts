// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import {
  MockSlackChannelId,
  MockSlackMessageId,
  MockSlackUserId,
  MockSlackWorkspaceId,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";

const blockingExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.never,
  continueWithAnswers: () => Effect.die("no continuation in Slack intake tests"),
} satisfies StepExecutorShape);

const layer = it.layer(
  SlackAgentIntakeLive.pipe(
    Layer.provideMerge(SlackAgentInstanceStoreLive),
    Layer.provideMerge(SlackAgentRunStoreLive),
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
          boardId: "slack-board-alpha" as never,
          initialLane: "implement" as never,
        });
        const beta = yield* instances.create({
          workspaceId: "mock",
          ownerLabel: "Beta",
          handleSuffix: "beta",
          projectId: ProjectId.make("project-beta"),
          boardId: "slack-board-beta" as never,
          initialLane: "implement" as never,
        });

        const mentionFor = (target: typeof alpha, suffix: string, threadTs: string) =>
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
          }) as const;

        const accepted = yield* Effect.all([
          intake.acceptMention(mentionFor(alpha, "alpha", "410.000001")),
          intake.acceptMention(mentionFor(beta, "beta", "420.000001")),
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
        WHERE ticket.ticket_id IN (${accepted[0]!.run.ticketId}, ${accepted[1]!.run.ticketId})
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
        boardId: "slack-board-owned-by-beta" as never,
        initialLane: "implement" as never,
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
        boardId: "slack-board" as never,
        initialLane: "implement" as never,
      });
      const theoInstance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Theo",
        handleSuffix: "theo",
        projectId: ProjectId.make("project-1"),
        boardId: "slack-board" as never,
        initialLane: "implement" as never,
      });
      const juliusInstance = yield* instances.create({
        workspaceId: "mock",
        ownerLabel: "Julius",
        handleSuffix: "julius",
        projectId: ProjectId.make("project-1"),
        boardId: "slack-board" as never,
        initialLane: "implement" as never,
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

      const laterMention = yield* intake.acceptMention({
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
      });
      assert.isTrue(laterMention.duplicate);
      assert.equal(laterMention.run.runId, accepted[0]!.run.runId);
      assert.include(laterMention.message ?? "", "later trigger was not added");

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
      const ticket = yield* readModel.getTicketDetail(accepted[0]!.run.ticketId);
      assert.equal(ticket?.ticket.title, "Please implement this safely and open a PR.");

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
        boardId: "slack-board-rollback" as never,
        initialLane: "implement" as never,
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
        boardId: "slack-board-oversized" as never,
        initialLane: "implement" as never,
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
