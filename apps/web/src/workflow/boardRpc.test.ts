import {
  BoardId,
  type AgentSelection,
  type BoardListEntry,
  type BoardSnapshot,
  type EnvironmentApi,
  type ProjectId,
  StepRunId,
  TicketId,
  WorkflowEventId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  answerTicketStep,
  createBoard,
  deleteBoard,
  deleteTicket,
  editTicket,
  invokeParkAction,
  listBoards,
  renameBoard,
  steerTicketStep,
} from "./boardRpc";

describe("boardRpc", () => {
  it("delegates listBoards and createBoard through the workflow EnvironmentApi", async () => {
    const projectId = "project-web" as ProjectId;
    const boardId = BoardId.make("project-web__delivery");
    const agent = { instance: "codex_main", model: "gpt-5.5" } satisfies AgentSelection;
    const entries = [
      {
        boardId,
        name: "Delivery",
        filePath: ".t3/boards/delivery.json",
        error: null,
      },
    ] satisfies BoardListEntry[];
    const snapshot = {
      projectId,
      board: { boardId, name: "Delivery", lanes: [] },
      tickets: [],
    } satisfies BoardSnapshot;
    const api = {
      workflow: {
        listBoards: vi.fn(async () => entries),
        createBoard: vi.fn(async () => ({
          boardId,
          snapshot,
        })),
        deleteBoard: vi.fn(async () => undefined),
        deleteTicket: vi.fn(async () => undefined),
        renameBoard: vi.fn(async () => undefined),
        answerTicketStep: vi.fn(async () => undefined),
        steerTicketStep: vi.fn(async () => ({ accepted: true as const })),
        editTicket: vi.fn(async () => undefined),
        invokeParkAction: vi.fn(async () => "moved" as const),
      },
    } as unknown as EnvironmentApi;

    await expect(listBoards(api, projectId)).resolves.toBe(entries);
    await expect(createBoard(api, { projectId, name: "Delivery", agent })).resolves.toEqual({
      boardId,
      snapshot,
    });
    await expect(deleteBoard(api, boardId)).resolves.toBeUndefined();
    await expect(renameBoard(api, boardId, "Renamed Delivery")).resolves.toBeUndefined();
    await expect(
      answerTicketStep(api, {
        stepRunId: StepRunId.make("step-1"),
        text: "Use sandbox.",
        attachments: [],
      }),
    ).resolves.toBeUndefined();
    await expect(
      steerTicketStep(api, {
        ticketId: TicketId.make("ticket-1"),
        stepRunId: StepRunId.make("step-1"),
        messageId: "msg-steer-1" as never,
        text: "Also update the tests",
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      editTicket(api, {
        ticketId: TicketId.make("ticket-1"),
        title: "Updated",
        description: "",
      }),
    ).resolves.toBeUndefined();
    await expect(deleteTicket(api, TicketId.make("ticket-1"))).resolves.toBeUndefined();
    await expect(
      invokeParkAction(api, TicketId.make("ticket-1"), 0, WorkflowEventId.make("event-1")),
    ).resolves.toBe("moved");

    expect(api.workflow.listBoards).toHaveBeenCalledWith({ projectId });
    expect(api.workflow.createBoard).toHaveBeenCalledWith({ projectId, name: "Delivery", agent });
    expect(api.workflow.deleteBoard).toHaveBeenCalledWith({ boardId });
    expect(api.workflow.renameBoard).toHaveBeenCalledWith({ boardId, name: "Renamed Delivery" });
    expect(api.workflow.answerTicketStep).toHaveBeenCalledWith({
      stepRunId: StepRunId.make("step-1"),
      text: "Use sandbox.",
      attachments: [],
    });
    expect(api.workflow.steerTicketStep).toHaveBeenCalledWith({
      ticketId: TicketId.make("ticket-1"),
      stepRunId: StepRunId.make("step-1"),
      messageId: "msg-steer-1",
      text: "Also update the tests",
    });
    expect(api.workflow.deleteTicket).toHaveBeenCalledWith({ ticketId: TicketId.make("ticket-1") });
    expect(api.workflow.editTicket).toHaveBeenCalledWith({
      ticketId: TicketId.make("ticket-1"),
      title: "Updated",
      description: "",
    });
    expect(api.workflow.invokeParkAction).toHaveBeenCalledWith({
      ticketId: TicketId.make("ticket-1"),
      actionIndex: 0,
      parkedEventId: WorkflowEventId.make("event-1"),
    });
  });
});
