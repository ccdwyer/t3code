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
  WORKFLOW_WS_METHODS,
  WorkflowRpcError,
  WsWorkflowAnswerTicketStepRpc,
  WsWorkflowCreateTicketRpc,
  WsWorkflowDeleteBoardRpc,
  WsWorkflowEditTicketRpc,
  WsWorkflowGetBoardDefinitionRpc,
  WsWorkflowGetBoardVersionRpc,
  WsWorkflowListBoardVersionsRpc,
  WsWorkflowGetTicketDiffRpc,
  WsWorkflowRenameBoardRpc,
  WsWorkflowSaveBoardDefinitionRpc,
  WsWorkflowSubscribeBoardRpc,
} from "./index.ts";

const decodeAuthScope = Schema.decodeUnknownEffect(AuthEnvironmentScope);
const decodeBoardStreamItem = Schema.decodeUnknownEffect(BoardStreamItem);
const decodeAnswerTicketStepPayload = Schema.decodeUnknownEffect(
  WsWorkflowAnswerTicketStepRpc.payloadSchema,
);
const decodeEditTicketPayload = Schema.decodeUnknownEffect(WsWorkflowEditTicketRpc.payloadSchema);
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
    assert.equal(WORKFLOW_WS_METHODS.editTicket, "workflow.editTicket");
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
            lanes: [{ key: "backlog", name: "Backlog", entry: "manual", pipelineStepCount: 0 }],
          },
          tickets: [
            {
              ticketId: "ticket-1",
              boardId: "board-1",
              title: "Ship workflow UI",
              currentLaneKey: "backlog",
              status: "idle",
            },
          ],
        },
      });

      assert.equal(item.kind, "snapshot");
      if (item.kind === "snapshot") {
        assert.equal(item.snapshot.tickets[0]?.title, "Ship workflow UI");
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
      const edit = yield* decodeEditTicketPayload({
        ticketId: "ticket-1",
        title: "Clarify provider routing",
        description: "",
      });

      assert.equal(answer.text, "Use the sandbox account.");
      assert.equal(answer.attachments?.[0]?.kind, "image");
      assert.equal(edit.description, "");
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
});
