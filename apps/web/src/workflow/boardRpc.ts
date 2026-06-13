import type {
  BoardId,
  BoardSnapshot,
  BoardStreamItem,
  BoardTicketView,
  EnvironmentApi,
  LaneKey,
  ProjectId,
  StepRunId,
  TicketId,
} from "@t3tools/contracts";

import { useStore } from "../store";

interface SubscriptionOptions {
  readonly onResubscribe?: () => void;
  readonly onSnapshot?: (snapshot: BoardSnapshot) => void;
  readonly onTicketUpdate?: (ticket: BoardTicketView) => void;
}

export const subscribeBoard = (
  api: EnvironmentApi,
  boardId: BoardId,
  options?: SubscriptionOptions,
): (() => void) =>
  api.workflow.subscribeBoard(
    { boardId },
    (item: BoardStreamItem) => {
      useStore.getState().applyBoardStreamItem(boardId, item);
      if (item.kind === "snapshot") {
        options?.onSnapshot?.(item.snapshot);
      }
      if (item.kind === "ticket") {
        options?.onTicketUpdate?.(item.ticket);
      }
    },
    options,
  );

export const createTicket = (
  api: EnvironmentApi,
  input: Parameters<EnvironmentApi["workflow"]["createTicket"]>[0],
) => api.workflow.createTicket(input);

export const listBoards = (api: EnvironmentApi, projectId: ProjectId) =>
  api.workflow.listBoards({ projectId });

export const createBoard = (
  api: EnvironmentApi,
  input: Parameters<EnvironmentApi["workflow"]["createBoard"]>[0],
) => api.workflow.createBoard(input);

export const deleteBoard = (api: EnvironmentApi, boardId: BoardId) =>
  api.workflow.deleteBoard({ boardId });

export const renameBoard = (api: EnvironmentApi, boardId: BoardId, name: string) =>
  api.workflow.renameBoard({ boardId, name });

export const editTicket = (
  api: EnvironmentApi,
  input: Parameters<EnvironmentApi["workflow"]["editTicket"]>[0],
) => api.workflow.editTicket(input);

export const moveTicket = (api: EnvironmentApi, ticketId: TicketId, toLane: LaneKey) =>
  api.workflow.moveTicket({ ticketId, toLane });

export const resolveApproval = (api: EnvironmentApi, stepRunId: StepRunId, approved: boolean) =>
  api.workflow.resolveApproval({ stepRunId, approved });

export const postTicketMessage = (
  api: EnvironmentApi,
  input: Parameters<EnvironmentApi["workflow"]["postTicketMessage"]>[0],
) => api.workflow.postTicketMessage(input);

export const answerTicketStep = (
  api: EnvironmentApi,
  input: Parameters<EnvironmentApi["workflow"]["answerTicketStep"]>[0],
) => api.workflow.answerTicketStep(input);

export const getTicketDiff = (api: EnvironmentApi, ticketId: TicketId) =>
  api.workflow.getTicketDiff({ ticketId });
