import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AuthEnvironmentScope,
  AuthStandardClientScopes,
  AuthWorkflowOperateScope,
  AuthWorkflowReadScope,
} from "./auth.ts";
import {
  BoardStreamItem,
  BoardTemplateSummary,
  WORKFLOW_WS_METHODS,
  WorkflowCreateChoice,
  WorkflowCreateWorkflowBoardInput,
  WorkflowCreateWorkflowBoardResult,
  WorkflowGenerateWorkflowDraftInput,
  WorkflowGenerateWorkflowDraftResult,
  WorkflowListBoardTemplatesResult,
  WorkflowRpcError,
  MockSlackThreadStreamEvent,
  SlackAgentRunStreamEvent,
  WsWorkflowConnectSlackAgentInstanceRpc,
  WsWorkflowCreateSlackAgentInstanceRpc,
  WsWorkflowCreateMockSlackAgentInstanceRpc,
  WsWorkflowAnswerTicketStepRpc,
  WsWorkflowDisconnectSlackAgentInstanceRpc,
  WsWorkflowSteerTicketStepRpc,
  WsWorkflowCreateTicketRpc,
  WsWorkflowDeleteBoardRpc,
  WsWorkflowDeleteSlackAgentInstanceRpc,
  WsWorkflowDisableSlackAgentInstanceRpc,
  WsWorkflowEnableSlackAgentInstanceRpc,
  WsWorkflowEditTicketRpc,
  WsWorkflowGetSlackAgentRunRpc,
  WsWorkflowGetBoardDefinitionRpc,
  WsWorkflowGetBoardVersionRpc,
  WsWorkflowListSlackAgentInstancesRpc,
  WsWorkflowListBoardVersionsRpc,
  WsWorkflowGetTicketDiffRpc,
  WsWorkflowRenameBoardRpc,
  WsWorkflowRetrySlackAgentDeliveryRpc,
  WsWorkflowSaveBoardDefinitionRpc,
  WsWorkflowSimulateSlackMentionRpc,
  WsWorkflowSubscribeBoardRpc,
  WsWorkflowSubscribeMockSlackThreadRpc,
  WsWorkflowSubscribeSlackAgentRunRpc,
  WsWorkflowTestSlackAgentConnectionRpc,
  WsWorkflowUpdateSlackAgentInstanceRpc,
  WsWorkflowListOutboundConnectionsRpc,
  WsWorkflowCreateOutboundConnectionRpc,
  WsWorkflowDeleteOutboundConnectionRpc,
  WsWorkflowGetBoardMetricsRpc,
  WsWorkflowCreateWorkflowBoardRpc,
  WsWorkflowGenerateWorkflowDraftRpc,
  WsWorkflowListBoardTemplatesRpc,
} from "./index.ts";

const decodeAuthScope = Schema.decodeUnknownEffect(AuthEnvironmentScope);
const decodeBoardStreamItem = Schema.decodeUnknownEffect(BoardStreamItem);
const decodeAnswerTicketStepPayload = Schema.decodeUnknownEffect(
  WsWorkflowAnswerTicketStepRpc.payloadSchema,
);
const decodeSteerTicketStepPayload = Schema.decodeUnknownEffect(
  WsWorkflowSteerTicketStepRpc.payloadSchema,
);
const decodeEditTicketPayload = Schema.decodeUnknownEffect(WsWorkflowEditTicketRpc.payloadSchema);
const decodeCreateTicketPayload = Schema.decodeUnknownEffect(
  WsWorkflowCreateTicketRpc.payloadSchema,
);
const decodeSaveBoardPayload = Schema.decodeUnknownEffect(
  WsWorkflowSaveBoardDefinitionRpc.payloadSchema,
);

describe("workflow RPC contracts", () => {
  it("declares workflow websocket method names", () => {
    assert.equal(WORKFLOW_WS_METHODS.createTicket, "workflow.createTicket");
    assert.equal(WORKFLOW_WS_METHODS.deleteBoard, "workflow.deleteBoard");
    assert.equal(WORKFLOW_WS_METHODS.renameBoard, "workflow.renameBoard");
    assert.equal(WORKFLOW_WS_METHODS.getBoardDefinition, "workflow.getBoardDefinition");
    assert.equal(WORKFLOW_WS_METHODS.saveBoardDefinition, "workflow.saveBoardDefinition");
    assert.equal(WORKFLOW_WS_METHODS.listBoardVersions, "workflow.listBoardVersions");
    assert.equal(WORKFLOW_WS_METHODS.getBoardVersion, "workflow.getBoardVersion");
    assert.equal(WORKFLOW_WS_METHODS.subscribeBoard, "workflow.subscribeBoard");
    assert.equal(WORKFLOW_WS_METHODS.getTicketDiff, "workflow.getTicketDiff");
    assert.equal(WORKFLOW_WS_METHODS.answerTicketStep, "workflow.answerTicketStep");
    assert.equal(WORKFLOW_WS_METHODS.steerTicketStep, "workflow.steerTicketStep");
    assert.equal(WORKFLOW_WS_METHODS.editTicket, "workflow.editTicket");
    assert.equal(WORKFLOW_WS_METHODS.deleteTicket, "workflow.deleteTicket");
  });

  it.effect("decodes board snapshots for subscription streams", () =>
    Effect.gen(function* () {
      const item = yield* decodeBoardStreamItem({
        kind: "snapshot",
        snapshot: {
          projectId: "project-1",
          board: {
            boardId: "board-1",
            name: "Delivery",
            lanes: [
              {
                key: "backlog",
                name: "Backlog",
                entry: "manual",
                pipelineStepCount: 0,
              },
              {
                key: "review",
                name: "Review",
                entry: "manual",
                pipelineStepCount: 0,
                sla: { budget: "4 hours", escalateTo: "escalation" },
              },
              {
                key: "escalation",
                name: "Escalation",
                entry: "manual",
                pipelineStepCount: 0,
              },
            ],
          },
          tickets: [
            {
              ticketId: "ticket-1",
              boardId: "board-1",
              title: "Ship workflow UI",
              currentLaneKey: "backlog",
              status: "idle",
            },
            {
              ticketId: "ticket-2",
              boardId: "board-1",
              title: "Breached review",
              currentLaneKey: "review",
              status: "idle",
              slaBreachedAt: "2026-06-13T04:00:00.000Z",
            },
          ],
        },
      });

      assert.equal(item.kind, "snapshot");
      if (item.kind === "snapshot") {
        assert.equal(item.snapshot.tickets[0]?.title, "Ship workflow UI");
        assert.equal(item.snapshot.board.lanes[1]?.sla?.escalateTo, "escalation");
        assert.equal(item.snapshot.tickets[1]?.slaBreachedAt, "2026-06-13T04:00:00.000Z");
      }
    }),
  );

  it.effect("adds workflow scopes to the environment and standard client grants", () =>
    Effect.gen(function* () {
      assert.equal(yield* decodeAuthScope(AuthWorkflowReadScope), AuthWorkflowReadScope);
      assert.equal(yield* decodeAuthScope(AuthWorkflowOperateScope), AuthWorkflowOperateScope);
      assert.isTrue(AuthStandardClientScopes.includes(AuthWorkflowReadScope));
      assert.isTrue(AuthStandardClientScopes.includes(AuthWorkflowOperateScope));
    }),
  );

  it("exports workflow RPC definitions and error type", () => {
    assert.isDefined(WsWorkflowCreateTicketRpc);
    assert.isDefined(WsWorkflowDeleteBoardRpc);
    assert.isDefined(WsWorkflowRenameBoardRpc);
    assert.isDefined(WsWorkflowGetBoardDefinitionRpc);
    assert.isDefined(WsWorkflowSaveBoardDefinitionRpc);
    assert.isDefined(WsWorkflowListBoardVersionsRpc);
    assert.isDefined(WsWorkflowGetBoardVersionRpc);
    assert.isDefined(WsWorkflowSubscribeBoardRpc);
    assert.isDefined(WsWorkflowAnswerTicketStepRpc);
    assert.isDefined(WsWorkflowSteerTicketStepRpc);
    assert.isDefined(WsWorkflowEditTicketRpc);
    assert.isDefined(WsWorkflowGetTicketDiffRpc);
    assert.equal(new WorkflowRpcError({ message: "workflow failed" })._tag, "WorkflowRpcError");
  });

  it.effect("decodes ticket collaboration RPC payloads", () =>
    Effect.gen(function* () {
      const answer = yield* decodeAnswerTicketStepPayload({
        stepRunId: "sr-1",
        text: "Use the sandbox account.",
        attachments: [
          {
            kind: "image",
            id: "img-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1200,
            dataUrl: "data:image/png;base64,AAAA",
          },
        ],
      });
      const steer = yield* decodeSteerTicketStepPayload({
        ticketId: "ticket-1",
        stepRunId: "sr-1",
        messageId: "msg-steer-1",
        text: "Also update the tests",
      });
      const edit = yield* decodeEditTicketPayload({
        ticketId: "ticket-1",
        title: "Clarify provider routing",
        description: "",
      });

      assert.equal(answer.text, "Use the sandbox account.");
      assert.equal(answer.attachments?.[0]?.kind, "image");
      assert.equal(steer.messageId, "msg-steer-1");
      assert.equal(steer.text, "Also update the tests");
      assert.equal(edit.description, "");
    }),
  );

  it.effect("bounds createTicket title and description length at decode", () =>
    Effect.gen(function* () {
      // A reasonable ticket decodes fine.
      const ok = yield* decodeCreateTicketPayload({
        boardId: "board-1",
        title: "Ship the workflow UI",
        description: "A normal description.",
        initialLane: "backlog",
      });
      assert.equal(ok.title, "Ship the workflow UI");

      // Title over 200 chars is rejected.
      const longTitle = yield* Effect.exit(
        decodeCreateTicketPayload({
          boardId: "board-1",
          title: "x".repeat(201),
          initialLane: "backlog",
        }),
      );
      assert.strictEqual(longTitle._tag, "Failure");

      // Description over 4000 chars is rejected.
      const longDescription = yield* Effect.exit(
        decodeCreateTicketPayload({
          boardId: "board-1",
          title: "fine",
          description: "y".repeat(4001),
          initialLane: "backlog",
        }),
      );
      assert.strictEqual(longDescription._tag, "Failure");

      // Empty/whitespace title is rejected (mirrors the engine's TicketCreated schema).
      const emptyTitle = yield* Effect.exit(
        decodeCreateTicketPayload({
          boardId: "board-1",
          title: "   ",
          initialLane: "backlog",
        }),
      );
      assert.strictEqual(emptyTitle._tag, "Failure");

      // editTicket title is bounded the same way.
      const longEditTitle = yield* Effect.exit(
        decodeEditTicketPayload({
          ticketId: "ticket-1",
          title: "z".repeat(201),
        }),
      );
      assert.strictEqual(longEditTitle._tag, "Failure");
    }),
  );

  it.effect("requires the loaded board version when saving board definitions", () =>
    Effect.gen(function* () {
      const payload = yield* decodeSaveBoardPayload({
        boardId: "board-1",
        definition: {
          name: "Delivery",
          lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
        },
        expectedVersionHash: "hash-before",
      });

      assert.equal((payload as any).expectedVersionHash, "hash-before");

      const missingVersion = yield* Effect.exit(
        decodeSaveBoardPayload({
          boardId: "board-1",
          definition: {
            name: "Delivery",
            lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
          },
        }),
      );
      assert.strictEqual(missingVersion._tag, "Failure");
    }),
  );

  it("declares outbound connection websocket method names", () => {
    assert.equal(WORKFLOW_WS_METHODS.listOutboundConnections, "workflow.listOutboundConnections");
    assert.equal(WORKFLOW_WS_METHODS.createOutboundConnection, "workflow.createOutboundConnection");
    assert.equal(WORKFLOW_WS_METHODS.deleteOutboundConnection, "workflow.deleteOutboundConnection");
  });

  it("exports outbound connection RPC definitions", () => {
    assert.isDefined(WsWorkflowListOutboundConnectionsRpc);
    assert.isDefined(WsWorkflowCreateOutboundConnectionRpc);
    assert.isDefined(WsWorkflowDeleteOutboundConnectionRpc);
  });

  it("declares getBoardMetrics websocket method name", () => {
    assert.equal(WORKFLOW_WS_METHODS.getBoardMetrics, "workflow.getBoardMetrics");
  });

  it("exports getBoardMetrics RPC definition", () => {
    assert.isDefined(WsWorkflowGetBoardMetricsRpc);
  });

  it.effect("decodes getBoardMetrics request payload and response", () =>
    Effect.gen(function* () {
      const decodePayload = Schema.decodeUnknownEffect(WsWorkflowGetBoardMetricsRpc.payloadSchema);
      const decodeSuccess = Schema.decodeUnknownEffect(WsWorkflowGetBoardMetricsRpc.successSchema);

      const payload = yield* decodePayload({
        boardId: "board-1",
        windowDays: 7,
      });
      assert.equal(payload.boardId, "board-1");
      assert.equal(payload.windowDays, 7);

      const payloadDefault = yield* decodePayload({ boardId: "board-2" });
      assert.equal(payloadDefault.boardId, "board-2");
      assert.isUndefined(payloadDefault.windowDays);

      const success = yield* decodeSuccess({
        windowDays: 7,
        generatedAt: "2026-06-14T00:00:00.000Z",
        throughput: { created: 3, shipped: 2 },
        cycleTime: { count: 2, p50Ms: 50000, p90Ms: 90000, avgMs: 70000 },
        wipByLane: [],
        statusBreakdown: { idle: 5, running: 1 },
        attention: { blocked: 0, waitingOnUser: 1, parked: 0, oldest: [] },
        routeOutcomes: [],
        manualMoveCount: 0,
        stepStats: [],
      });
      assert.equal(success.windowDays, 7);
      assert.equal(success.throughput.shipped, 2);
      assert.equal(success.cycleTime.p50Ms, 50000);
    }),
  );

  it.effect("decodes outbound connection RPC payloads and responses", () =>
    Effect.gen(function* () {
      const decodeCreatePayload = Schema.decodeUnknownEffect(
        WsWorkflowCreateOutboundConnectionRpc.payloadSchema,
      );
      const decodeListSuccess = Schema.decodeUnknownEffect(
        WsWorkflowListOutboundConnectionsRpc.successSchema,
      );
      const decodeCreateSuccess = Schema.decodeUnknownEffect(
        WsWorkflowCreateOutboundConnectionRpc.successSchema,
      );
      const decodeDeletePayload = Schema.decodeUnknownEffect(
        WsWorkflowDeleteOutboundConnectionRpc.payloadSchema,
      );

      const createPayload = yield* decodeCreatePayload({
        kind: "webhook",
        displayName: "CI Alerts",
        url: "https://hooks.example.com/notify",
      });
      assert.equal(createPayload.kind, "webhook");
      assert.equal(createPayload.displayName, "CI Alerts");

      const listSuccess = yield* decodeListSuccess({
        connections: [
          {
            connectionRef: "conn-1",
            kind: "slack",
            displayName: "Eng alerts",
            createdAt: "2026-06-14T00:00:00.000Z",
          },
        ],
      });
      assert.equal(listSuccess.connections[0]?.kind, "slack");

      const createSuccess = yield* decodeCreateSuccess({
        connection: {
          connectionRef: "conn-2",
          kind: "webhook",
          displayName: "CI Alerts",
          createdAt: "2026-06-14T00:00:00.000Z",
        },
      });
      assert.equal(createSuccess.connection.connectionRef, "conn-2");

      const deletePayload = yield* decodeDeletePayload({
        connectionRef: "conn-1",
      });
      assert.equal(deletePayload.connectionRef, "conn-1");
    }),
  );

  it("declares Slack-agent websocket method names", () => {
    assert.equal(WORKFLOW_WS_METHODS.listSlackAgentInstances, "workflow.listSlackAgentInstances");
    assert.equal(WORKFLOW_WS_METHODS.createSlackAgentInstance, "workflow.createSlackAgentInstance");
    assert.equal(
      WORKFLOW_WS_METHODS.createMockSlackAgentInstance,
      "workflow.createMockSlackAgentInstance",
    );
    assert.equal(
      WORKFLOW_WS_METHODS.connectSlackAgentInstance,
      "workflow.connectSlackAgentInstance",
    );
    assert.equal(
      WORKFLOW_WS_METHODS.disconnectSlackAgentInstance,
      "workflow.disconnectSlackAgentInstance",
    );
    assert.equal(WORKFLOW_WS_METHODS.testSlackAgentConnection, "workflow.testSlackAgentConnection");
    assert.equal(WORKFLOW_WS_METHODS.updateSlackAgentInstance, "workflow.updateSlackAgentInstance");
    assert.equal(
      WORKFLOW_WS_METHODS.disableSlackAgentInstance,
      "workflow.disableSlackAgentInstance",
    );
    assert.equal(WORKFLOW_WS_METHODS.enableSlackAgentInstance, "workflow.enableSlackAgentInstance");
    assert.equal(WORKFLOW_WS_METHODS.deleteSlackAgentInstance, "workflow.deleteSlackAgentInstance");
    assert.equal(WORKFLOW_WS_METHODS.simulateSlackMention, "workflow.simulateSlackMention");
    assert.equal(WORKFLOW_WS_METHODS.getSlackAgentRun, "workflow.getSlackAgentRun");
    assert.equal(WORKFLOW_WS_METHODS.subscribeSlackAgentRun, "workflow.subscribeSlackAgentRun");
    assert.equal(WORKFLOW_WS_METHODS.retrySlackAgentDelivery, "workflow.retrySlackAgentDelivery");
    assert.equal(WORKFLOW_WS_METHODS.subscribeMockSlackThread, "workflow.subscribeMockSlackThread");
  });

  it("exports Slack-agent RPC definitions", () => {
    assert.isDefined(WsWorkflowListSlackAgentInstancesRpc);
    assert.isDefined(WsWorkflowCreateSlackAgentInstanceRpc);
    assert.isDefined(WsWorkflowCreateMockSlackAgentInstanceRpc);
    assert.isDefined(WsWorkflowConnectSlackAgentInstanceRpc);
    assert.isDefined(WsWorkflowDisconnectSlackAgentInstanceRpc);
    assert.isDefined(WsWorkflowTestSlackAgentConnectionRpc);
    assert.isDefined(WsWorkflowUpdateSlackAgentInstanceRpc);
    assert.isDefined(WsWorkflowDisableSlackAgentInstanceRpc);
    assert.isDefined(WsWorkflowEnableSlackAgentInstanceRpc);
    assert.isDefined(WsWorkflowDeleteSlackAgentInstanceRpc);
    assert.isDefined(WsWorkflowSimulateSlackMentionRpc);
    assert.isDefined(WsWorkflowGetSlackAgentRunRpc);
    assert.isDefined(WsWorkflowSubscribeSlackAgentRunRpc);
    assert.isDefined(WsWorkflowRetrySlackAgentDeliveryRpc);
    assert.isDefined(WsWorkflowSubscribeMockSlackThreadRpc);
  });

  it.effect("decodes Slack-agent RPC payloads and results", () =>
    Effect.gen(function* () {
      const decodeCreate = Schema.decodeUnknownEffect(
        WsWorkflowCreateSlackAgentInstanceRpc.payloadSchema,
      );
      const decodeMockCreate = Schema.decodeUnknownEffect(
        WsWorkflowCreateMockSlackAgentInstanceRpc.payloadSchema,
      );
      const decodeList = Schema.decodeUnknownEffect(
        WsWorkflowListSlackAgentInstancesRpc.successSchema,
      );
      const decodeSimulate = Schema.decodeUnknownEffect(
        WsWorkflowSimulateSlackMentionRpc.payloadSchema,
      );
      const decodeRun = Schema.decodeUnknownEffect(WsWorkflowGetSlackAgentRunRpc.successSchema);
      const decodeRetry = Schema.decodeUnknownEffect(
        WsWorkflowRetrySlackAgentDeliveryRpc.successSchema,
      );
      const decodeRunEvent = Schema.decodeUnknownEffect(SlackAgentRunStreamEvent);
      const decodeThreadEvent = Schema.decodeUnknownEffect(MockSlackThreadStreamEvent);

      const create = yield* decodeCreate({
        ownerLabel: "Chris",
        handleSuffix: "chris",
        target: {
          projectId: "project-1",
        },
        appToken: "xapp-valid",
        botToken: "xoxb-valid",
        acknowledged: true,
      });
      assert.equal(create.handleSuffix, "chris");

      const mockCreate = yield* decodeMockCreate({
        ownerLabel: "Chris",
        handleSuffix: "chris",
        target: {
          projectId: "project-1",
        },
        acknowledged: true,
      });
      assert.equal(mockCreate.handleSuffix, "chris");

      const instance = {
        instanceId: "inst-1",
        kind: "mock",
        workspace: {
          workspaceId: "workspace-1",
        },
        handle: "t3_chris",
        ownerLabel: "Chris",
        botUserId: "bot-1",
        target: {
          projectId: "project-1",
        },
        enabled: true,
        state: "enabled",
        validation: { valid: true },
        credentialsConfigured: false,
        connection: {
          state: "connected",
          connectedAt: "2026-08-07T11:00:00.000Z",
        },
        activeRunCount: 0,
        createdAt: "2026-08-07T11:00:00.000Z",
        updatedAt: "2026-08-07T11:00:00.000Z",
      };
      const list = yield* decodeList({ instances: [instance] });
      assert.equal(list.instances[0]?.handle, "t3_chris");

      const thread = {
        workspaceId: "workspace-1",
        channelId: "channel-1",
        channelName: "eng",
        threadTs: "1786123456.000001",
      };
      const messages = [
        {
          messageId: "msg-1",
          ts: "1786123456.000001",
          authorUserId: "user-1",
          authorLabel: "Theo",
          text: "<@bot-1> ship it",
        },
      ];
      const simulate = yield* decodeSimulate({
        instanceId: "inst-1",
        thread,
        messages,
        triggerMessageId: "msg-1",
      });
      assert.equal(simulate.messages[0]?.text, "<@bot-1> ship it");

      const delivery = yield* decodeRetry({
        deliveryId: "delivery-1",
        runId: "run-1",
        workflowSequence: 0,
        state: "pending",
        attempts: 0,
        createdAt: "2026-08-07T11:00:00.000Z",
        updatedAt: "2026-08-07T11:00:00.000Z",
      });
      assert.equal(delivery.workflowSequence, 0);

      const run = {
        runId: "run-1",
        instanceId: "inst-1",
        handle: "t3_chris",
        botUserId: "bot-1",
        mode: "workflow",
        ticketId: "ticket-1",
        thread,
        state: "accepted",
        lastAppliedSequence: -1,
        createdAt: "2026-08-07T11:00:00.000Z",
        updatedAt: "2026-08-07T11:00:00.000Z",
      };
      const snapshot = {
        thread,
        triggerEventId: "evt-1",
        triggerMessageId: "msg-1",
        triggerTs: "1786123456.000001",
        messages,
        canonicalJsonBytes: 512,
      };
      const detail = yield* decodeRun({ run, snapshot, deliveries: [delivery] });
      assert.equal(detail.snapshot.triggerMessageId, "msg-1");

      const runEvent = yield* decodeRunEvent({ type: "snapshot", run: detail });
      assert.equal(runEvent.type, "snapshot");

      const threadEvent = yield* decodeThreadEvent({
        type: "snapshot",
        thread: {
          threadId: "thread-1",
          ref: thread,
          sourceMessages: messages,
          statusReplies: [
            {
              messageId: "status-1",
              botUserId: "bot-1",
              runId: "run-1",
              text: "Accepted by @t3_chris",
              updatedAt: "2026-08-07T11:00:00.000Z",
            },
          ],
          updatedAt: "2026-08-07T11:00:00.000Z",
        },
      });
      assert.equal(threadEvent.type, "snapshot");
    }),
  );

  it("declares create-workflow wizard websocket method names", () => {
    assert.equal(WORKFLOW_WS_METHODS.createWorkflowBoard, "workflow.createWorkflowBoard");
    assert.equal(WORKFLOW_WS_METHODS.generateWorkflowDraft, "workflow.generateWorkflowDraft");
    assert.equal(WORKFLOW_WS_METHODS.listBoardTemplates, "workflow.listBoardTemplates");
  });

  it.effect("decodes BoardTemplateSummary", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(BoardTemplateSummary);
      const result = yield* decode({
        id: "kanban-basic",
        name: "Basic Kanban",
        description: "A simple kanban board with three lanes.",
        requiresAgent: false,
      });
      assert.equal(result.id, "kanban-basic");
      assert.equal(result.name, "Basic Kanban");
      assert.isFalse(result.requiresAgent);
    }),
  );

  it.effect("decodes all three WorkflowCreateChoice variants", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowCreateChoice);

      const empty = yield* decode({ kind: "empty" });
      assert.equal(empty.kind, "empty");

      const template = yield* decode({
        kind: "template",
        templateId: "kanban-basic",
        agent: { instance: "default", model: "claude-opus-4-5" },
      });
      assert.equal(template.kind, "template");
      if (template.kind === "template") {
        assert.equal(template.templateId, "kanban-basic");
        assert.equal(template.agent?.instance, "default");
      }

      const templateNoAgent = yield* decode({
        kind: "template",
        templateId: "sprint-review",
      });
      assert.equal(templateNoAgent.kind, "template");

      const definition = yield* decode({
        kind: "definition",
        definition: {
          name: "Custom Board",
          lanes: [{ key: "backlog", name: "Backlog", entry: "manual" }],
        },
      });
      assert.equal(definition.kind, "definition");
    }),
  );

  it.effect("decodes WorkflowCreateWorkflowBoardInput and result variants", () =>
    Effect.gen(function* () {
      const decodeInput = Schema.decodeUnknownEffect(WorkflowCreateWorkflowBoardInput);
      const decodeResult = Schema.decodeUnknownEffect(WorkflowCreateWorkflowBoardResult);

      const input = yield* decodeInput({
        projectId: "proj-1",
        name: "My Board",
        choice: { kind: "empty" },
      });
      assert.equal(input.projectId, "proj-1");
      assert.equal(input.name, "My Board");
      assert.equal(input.choice.kind, "empty");

      const ok = yield* decodeResult({ ok: true, boardId: "board-new" });
      assert.isTrue(ok.ok);
      if (ok.ok) assert.equal(ok.boardId, "board-new");

      const fail = yield* decodeResult({
        ok: false,
        lintErrors: [{ code: "duplicate_lane_key", message: "dup" }],
      });
      assert.isFalse(fail.ok);
    }),
  );

  it.effect("decodes WorkflowGenerateWorkflowDraftInput and result variants", () =>
    Effect.gen(function* () {
      const decodeInput = Schema.decodeUnknownEffect(WorkflowGenerateWorkflowDraftInput);
      const decodeResult = Schema.decodeUnknownEffect(WorkflowGenerateWorkflowDraftResult);

      const input = yield* decodeInput({
        projectId: "proj-1",
        name: "AI Board",
        description: "A board for managing AI coding tasks.",
        agent: { instance: "default", model: "claude-opus-4-5" },
      });
      assert.equal(input.name, "AI Board");
      assert.equal(input.description, "A board for managing AI coding tasks.");
      assert.equal(input.agent.instance, "default");

      const ok = yield* decodeResult({
        ok: true,
        definition: {
          name: "AI Board",
          lanes: [{ key: "backlog", name: "Backlog", entry: "manual" }],
        },
        rationale: "Generated a simple kanban layout.",
      });
      assert.isTrue(ok.ok);
      if (ok.ok) assert.equal(ok.rationale, "Generated a simple kanban layout.");

      const fail = yield* decodeResult({
        ok: false,
        message: "Model refused to generate.",
      });
      assert.isFalse(fail.ok);
      if (!fail.ok) assert.equal(fail.message, "Model refused to generate.");
    }),
  );

  it("exports create-workflow wizard RPC definitions", () => {
    assert.isDefined(WsWorkflowCreateWorkflowBoardRpc);
    assert.isDefined(WsWorkflowGenerateWorkflowDraftRpc);
    assert.isDefined(WsWorkflowListBoardTemplatesRpc);
  });

  it.effect(
    "decodes create-workflow wizard RPC payloads and results through the group definitions",
    () =>
      Effect.gen(function* () {
        const decodeCreatePayload = Schema.decodeUnknownEffect(
          WsWorkflowCreateWorkflowBoardRpc.payloadSchema,
        );
        const decodeCreateSuccess = Schema.decodeUnknownEffect(
          WsWorkflowCreateWorkflowBoardRpc.successSchema,
        );
        const decodeDraftPayload = Schema.decodeUnknownEffect(
          WsWorkflowGenerateWorkflowDraftRpc.payloadSchema,
        );
        const decodeTemplatesSuccess = Schema.decodeUnknownEffect(
          WsWorkflowListBoardTemplatesRpc.successSchema,
        );

        const createPayload = yield* decodeCreatePayload({
          projectId: "proj-1",
          name: "My Board",
          choice: { kind: "empty" },
        });
        assert.equal(createPayload.choice.kind, "empty");

        const createSuccess = yield* decodeCreateSuccess({
          ok: true,
          boardId: "board-new",
        });
        assert.isTrue(createSuccess.ok);

        const draftPayload = yield* decodeDraftPayload({
          projectId: "proj-1",
          name: "AI Board",
          description: "A board for managing AI coding tasks.",
          agent: { instance: "default", model: "claude-opus-4-5" },
        });
        assert.equal(draftPayload.name, "AI Board");

        const templatesSuccess = yield* decodeTemplatesSuccess({
          templates: [
            {
              id: "kanban-basic",
              name: "Basic Kanban",
              description: "Three-lane kanban.",
              requiresAgent: false,
            },
          ],
        });
        assert.equal(templatesSuccess.templates.length, 1);
      }),
  );

  it.effect("decodes WorkflowListBoardTemplatesResult", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowListBoardTemplatesResult);
      const result = yield* decode({
        templates: [
          {
            id: "kanban-basic",
            name: "Basic Kanban",
            description: "Three-lane kanban.",
            requiresAgent: false,
          },
          {
            id: "agent-sprint",
            name: "Agent Sprint",
            description: "Sprint board with AI steps.",
            requiresAgent: true,
          },
        ],
      });
      assert.equal(result.templates.length, 2);
      assert.equal(result.templates[0]?.id, "kanban-basic");
      assert.isTrue(result.templates[1]?.requiresAgent);
    }),
  );
});
