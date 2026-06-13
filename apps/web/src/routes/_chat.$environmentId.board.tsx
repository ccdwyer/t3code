import { createFileRoute } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime";
import {
  type AgentSelection,
  type BoardSnapshot,
  BoardId,
  EnvironmentId,
  type EnvironmentApi,
  LaneKey,
  ProjectId,
  StepRunId,
  type TicketAttachment,
  TicketId,
  type WorkflowTicketDetailView,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BoardHeaderControls } from "../components/board/BoardHeaderControls";
import { BoardView } from "../components/board/BoardView";
import { WorkflowEditor } from "../components/board/editor/WorkflowEditor";
import { WorkflowEditorFullscreen } from "../components/board/editor/WorkflowEditorFullscreen";
import { TicketDrawer } from "../components/board/TicketDrawer";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { Input } from "../components/ui/input";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readEnvironmentApi } from "../environmentApi";
import { useStore } from "../store";
import { countNeedsAttention } from "../workflow/agingFormat";
import { useNowTick } from "../workflow/useNowTick";
import { emptyBoardState, type BoardState } from "../workflow/boardState";
import {
  answerTicketStep,
  createTicket,
  editTicket,
  moveTicket,
  postTicketMessage,
  resolveApproval,
  subscribeBoard,
} from "../workflow/boardRpc";

export interface BoardRouteSearch {
  readonly boardId?: string | undefined;
}

export interface BoardRouteEmptyState {
  readonly title: string;
  readonly description: string | null;
}

export function getBoardRouteEmptyState(input: {
  readonly boardId: BoardId | null;
  readonly boardLoadError: string | null;
}): BoardRouteEmptyState | null {
  if (!input.boardId) {
    return {
      title: "No board selected.",
      description: null,
    };
  }

  if (input.boardLoadError) {
    return {
      title: "Board not found.",
      description: input.boardLoadError,
    };
  }

  return null;
}

const parseBoardRouteSearch = (search: Record<string, unknown>): BoardRouteSearch => {
  const boardId = typeof search.boardId === "string" ? search.boardId.trim() : "";
  return boardId ? { boardId } : {};
};

export interface BoardRouteAnswerInput {
  readonly stepRunId: string;
  readonly text?: string | undefined;
  readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
}

export interface BoardRouteEditInput {
  readonly ticketId: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
}

const environmentApiUnavailable = () => new Error("Environment API unavailable.");

export const submitTicketAnswerFromBoardRoute = (
  api: EnvironmentApi | null | undefined,
  input: BoardRouteAnswerInput,
  reloadTicketDetail: () => void,
): Promise<void> => {
  if (!api) {
    return Promise.reject(environmentApiUnavailable());
  }

  return answerTicketStep(api, {
    stepRunId: StepRunId.make(input.stepRunId),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
  }).then(reloadTicketDetail);
};

export const submitTicketEditFromBoardRoute = (
  api: EnvironmentApi | null | undefined,
  input: BoardRouteEditInput,
  reloadTicketDetail: () => void,
): Promise<void> => {
  if (!api) {
    return Promise.reject(environmentApiUnavailable());
  }

  return editTicket(api, {
    ticketId: TicketId.make(input.ticketId),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
  }).then(reloadTicketDetail);
};

function WorkflowBoardRouteView() {
  const { environmentId: rawEnvironmentId } = Route.useParams();
  const { boardId: rawBoardId } = Route.useSearch();
  const [selectedTicketId, setSelectedTicketId] = useState<TicketId | null>(null);
  const [ticketDetail, setTicketDetail] = useState<WorkflowTicketDetailView | null>(null);
  const [ticketDetailError, setTicketDetailError] = useState<string | null>(null);
  const [ticketDetailReloadKey, setTicketDetailReloadKey] = useState(0);
  const [boardLoadError, setBoardLoadError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const ticketStatusRef = useRef(new Map<string, string>());
  const selectedTicketIdRef = useRef<TicketId | null>(null);
  selectedTicketIdRef.current = selectedTicketId;
  const lastDetailTicketIdRef = useRef<string | null>(null);
  const environmentId = useMemo(() => EnvironmentId.make(rawEnvironmentId), [rawEnvironmentId]);
  const boardId = useMemo(() => (rawBoardId ? BoardId.make(rawBoardId) : null), [rawBoardId]);
  const routeApi = readEnvironmentApi(environmentId);
  const state = useStore((store) =>
    boardId ? (store.boardStateById[boardId] ?? emptyBoardState) : emptyBoardState,
  );
  const emptyState = getBoardRouteEmptyState({ boardId, boardLoadError });

  useEffect(() => {
    setBoardLoadError(null);
    if (!boardId) {
      setEditorOpen(false);
      return;
    }

    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setBoardLoadError("Environment API unavailable.");
      return;
    }

    let cancelled = false;
    void api.workflow.getBoard({ boardId }).then(
      () => {
        if (!cancelled) {
          setBoardLoadError(null);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setBoardLoadError(errorMessage(error));
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [boardId, environmentId]);

  useEffect(() => {
    if (!boardId) {
      return;
    }

    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    return subscribeBoard(api, boardId, {
      onSnapshot: (snapshot) => {
        // Seed synchronously so the first ticket-stream update after a
        // snapshot reads as a transition (or not) against fresh statuses.
        for (const ticket of snapshot.tickets) {
          ticketStatusRef.current.set(ticket.ticketId, ticket.status);
        }
      },
      onTicketUpdate: (ticket) => {
        if (ticket.ticketId === selectedTicketIdRef.current) {
          setTicketDetailReloadKey((key) => key + 1);
        }
        const previousStatus = ticketStatusRef.current.get(ticket.ticketId);
        ticketStatusRef.current.set(ticket.ticketId, ticket.status);
        notifyTicketStatusChange(ticket, previousStatus, selectedTicketIdRef.current);
      },
    });
  }, [boardId, environmentId]);

  useEffect(() => {
    // A running agent step gets its dispatch thread shortly after StepStarted
    // is broadcast; poll the detail briefly so the live activity feed appears
    // without waiting for the next workflow event.
    if (!ticketDetail) {
      return;
    }
    const needsThread = ticketDetail.steps.some(
      (step) =>
        step.stepType === "agent" &&
        (step.status === "running" || step.status === "dispatch_requested") &&
        step.providerThreadId === undefined,
    );
    if (!needsThread) {
      return;
    }
    const timer = setTimeout(() => setTicketDetailReloadKey((key) => key + 1), 2_000);
    return () => clearTimeout(timer);
  }, [ticketDetail]);

  const visibleState = useMemo(
    () => filterBoardStateByQuery(state, searchQuery),
    [state, searchQuery],
  );

  useEffect(() => {
    if (!selectedTicketId) {
      lastDetailTicketIdRef.current = null;
      setTicketDetail(null);
      setTicketDetailError(null);
      return;
    }

    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setTicketDetail(null);
      setTicketDetailError("Environment API unavailable.");
      return;
    }

    let cancelled = false;
    // Only clear the rendered detail when the selection actually changed
    // (scoped to the environment/board so stale detail never survives a
    // navigation); same-ticket revalidation keeps the previous detail (and
    // the drawer's in-progress state) while the refresh is in flight.
    const detailKey = `${environmentId}:${boardId ?? ""}:${selectedTicketId}`;
    if (lastDetailTicketIdRef.current !== detailKey) {
      lastDetailTicketIdRef.current = detailKey;
      setTicketDetail(null);
    }
    setTicketDetailError(null);

    void api.workflow.getTicketDetail({ ticketId: selectedTicketId }).then(
      (detail) => {
        if (!cancelled) {
          setTicketDetail(detail);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setTicketDetailError(errorMessage(error));
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [environmentId, boardId, selectedTicketId, ticketDetailReloadKey]);

  const handleMove = useCallback(
    (ticketId: string, toLane: string) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }

      void moveTicket(api, TicketId.make(ticketId), LaneKey.make(toLane));
    },
    [environmentId],
  );
  const handleOpenTicket = useCallback((ticketId: string) => {
    setEditorOpen(false);
    setSelectedTicketId(TicketId.make(ticketId));
  }, []);
  const closeTicketDrawer = useCallback(() => {
    setSelectedTicketId(null);
  }, []);
  const reloadTicketDetail = useCallback(() => {
    setTicketDetailReloadKey((key) => key + 1);
  }, []);
  const handleApprove = useCallback(
    (stepRunId: string, approved: boolean): Promise<void> => {
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return Promise.reject(environmentApiUnavailable());
      }

      return resolveApproval(api, StepRunId.make(stepRunId), approved).then(reloadTicketDetail);
    },
    [environmentId, reloadTicketDetail],
  );
  const handleAnswerStep = useCallback(
    (input: BoardRouteAnswerInput): Promise<void> => {
      const api = readEnvironmentApi(environmentId);
      return submitTicketAnswerFromBoardRoute(api, input, reloadTicketDetail);
    },
    [environmentId, reloadTicketDetail],
  );
  const handlePostComment = useCallback(
    (input: {
      readonly ticketId: string;
      readonly text?: string | undefined;
      readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
    }): Promise<void> => {
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return Promise.reject(environmentApiUnavailable());
      }
      return postTicketMessage(api, {
        ticketId: TicketId.make(input.ticketId),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      }).then(reloadTicketDetail);
    },
    [environmentId, reloadTicketDetail],
  );
  const handleEditTicket = useCallback(
    (input: BoardRouteEditInput): Promise<void> => {
      const api = readEnvironmentApi(environmentId);
      return submitTicketEditFromBoardRoute(api, input, reloadTicketDetail);
    },
    [environmentId, reloadTicketDetail],
  );
  const handleRunLane = useCallback(() => {
    if (!selectedTicketId) {
      return;
    }

    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    void api.workflow.runLane({ ticketId: selectedTicketId }).then(reloadTicketDetail);
  }, [environmentId, reloadTicketDetail, selectedTicketId]);
  const handleDrawerMove = useCallback(
    (toLane: string) => {
      if (!selectedTicketId) {
        return;
      }

      handleMove(selectedTicketId, toLane);
      reloadTicketDetail();
    },
    [handleMove, reloadTicketDetail, selectedTicketId],
  );
  const handleCreateTicket = useCallback(
    (input: {
      readonly title: string;
      readonly description?: string | undefined;
      readonly initialLane: string;
      readonly dependsOn?: ReadonlyArray<string> | undefined;
      readonly tokenBudget?: number | undefined;
    }) => {
      if (!boardId) {
        return;
      }

      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }

      void createTicket(api, {
        boardId,
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        initialLane: LaneKey.make(input.initialLane),
        ...(input.dependsOn === undefined || input.dependsOn.length === 0
          ? {}
          : { dependsOn: input.dependsOn.map((ticketId) => TicketId.make(ticketId)) }),
        ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
      });
    },
    [boardId, environmentId],
  );
  const handleCreateTicketAsync = useCallback(
    async (input: {
      readonly title: string;
      readonly description?: string | undefined;
      readonly initialLane: string;
      readonly dependsOn?: ReadonlyArray<string> | undefined;
    }) => {
      if (!boardId) {
        throw new Error("No board selected.");
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        throw new Error("Environment API unavailable.");
      }
      const created = await createTicket(api, {
        boardId,
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        initialLane: LaneKey.make(input.initialLane),
        ...(input.dependsOn === undefined || input.dependsOn.length === 0
          ? {}
          : { dependsOn: input.dependsOn.map((ticketId) => TicketId.make(ticketId)) }),
      });
      return created.ticketId as string;
    },
    [boardId, environmentId],
  );
  const handleProposeTickets = useCallback(
    async (braindump: string, agent: AgentSelection) => {
      if (!boardId) {
        throw new Error("No board selected.");
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        throw new Error("Environment API unavailable.");
      }
      const result = await api.workflow.intakeTickets({ boardId, braindump, agent });
      return result.proposals;
    },
    [boardId, environmentId],
  );
  const handleFetchDigest = useCallback(async () => {
    if (!boardId) {
      throw new Error("No board selected.");
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      throw new Error("Environment API unavailable.");
    }
    return await api.workflow.getBoardDigest({ boardId });
  }, [boardId, environmentId]);
  const handleFetchWebhookConfig = useCallback(
    async (rotate: boolean) => {
      if (!boardId) {
        throw new Error("No board selected.");
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        throw new Error("Environment API unavailable.");
      }
      return await api.workflow.getWebhookConfig({ boardId, ...(rotate ? { rotate } : {}) });
    },
    [boardId, environmentId],
  );
  const attentionNow = useNowTick(60_000);
  const needsAttentionCount = useMemo(
    () =>
      countNeedsAttention(
        state.ticketIds
          .map((ticketId) => state.ticketById[ticketId])
          .filter((ticket) => ticket !== undefined),
        attentionNow,
      ),
    [state.ticketIds, state.ticketById, attentionNow],
  );
  const handleToggleWorkflowEditor = useCallback(() => {
    setEditorOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setSelectedTicketId(null);
      }
      return nextOpen;
    });
  }, []);
  const handleWorkflowSaved = useCallback(
    (snapshot: BoardSnapshot) => {
      useStore.getState().applyBoardStreamItem(snapshot.board.boardId, {
        kind: "snapshot",
        snapshot,
      });
      void routeApi?.workflow
        .listBoards({ projectId: snapshot.projectId })
        .then((entries) =>
          useStore
            .getState()
            .setProjectBoards(scopeProjectRef(environmentId, snapshot.projectId), entries),
        );
    },
    [environmentId, routeApi],
  );
  const closeWorkflowEditor = useCallback(() => {
    setEditorOpen(false);
  }, []);

  return (
    <>
      <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <div className="min-w-0">
              <h1 className="truncate text-sm font-medium text-foreground">
                {state.boardName || "Workflow Board"}
              </h1>
            </div>
            {boardId ? (
              <Input
                aria-label="Search tickets"
                className="ml-auto h-7 w-44 max-w-[40vw] md:w-56"
                placeholder="Search tickets…"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
              />
            ) : null}
            <BoardHeaderControls
              boardId={boardId}
              lanes={state.lanes}
              tickets={state.ticketIds.map((ticketId) => ({
                ticketId,
                title: state.ticketById[ticketId]?.title ?? ticketId,
              }))}
              workflowEditorOpen={editorOpen}
              onCreateTicket={handleCreateTicket}
              onProposeTickets={handleProposeTickets}
              onCreateTicketAsync={handleCreateTicketAsync}
              onToggleWorkflowEditor={handleToggleWorkflowEditor}
              needsAttentionCount={needsAttentionCount}
              onFetchDigest={handleFetchDigest}
              onFetchWebhookConfig={handleFetchWebhookConfig}
            />
          </header>
          {emptyState ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground">
              <div className="max-w-md space-y-1">
                <div>{emptyState.title}</div>
                {emptyState.description ? (
                  <div className="text-xs text-muted-foreground/80">{emptyState.description}</div>
                ) : null}
              </div>
            </div>
          ) : (
            <BoardView state={visibleState} onMove={handleMove} onOpen={handleOpenTicket} />
          )}
        </div>
      </SidebarInset>
      <WorkflowEditorFullscreen open={editorOpen && boardId !== null} onClose={closeWorkflowEditor}>
        {boardId && routeApi ? (
          <WorkflowEditor
            key={boardId}
            api={routeApi}
            boardId={boardId}
            onClose={closeWorkflowEditor}
            onSaved={handleWorkflowSaved}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
            Environment API unavailable.
          </div>
        )}
      </WorkflowEditorFullscreen>
      <RightPanelSheet open={selectedTicketId !== null} onClose={closeTicketDrawer}>
        {ticketDetail ? (
          <TicketDrawer
            api={routeApi}
            detail={ticketDetail}
            lanes={state.lanes}
            onAnswerStep={handleAnswerStep}
            onPostComment={handlePostComment}
            onApprove={handleApprove}
            onEditTicket={handleEditTicket}
            onMove={handleDrawerMove}
            onRunLane={handleRunLane}
            projectId={state.projectId ? ProjectId.make(state.projectId) : undefined}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
            {ticketDetailError ?? "Loading ticket..."}
          </div>
        )}
      </RightPanelSheet>
    </>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to load ticket detail.";
}

export function filterBoardStateByQuery(state: BoardState, query: string): BoardState {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return state;
  }
  const matches = (ticketId: string): boolean => {
    const ticket = state.ticketById[ticketId];
    if (!ticket) {
      return false;
    }
    return (
      ticket.title.toLowerCase().includes(needle) ||
      (ticket.description?.toLowerCase().includes(needle) ?? false)
    );
  };
  return {
    ...state,
    ticketIds: state.ticketIds.filter(matches),
    lanes: state.lanes.map((lane) => ({
      ...lane,
      admittedTicketIds: lane.admittedTicketIds.filter(matches),
      queuedTicketIds: lane.queuedTicketIds.filter(matches),
    })),
  };
}

function notifyTicketStatusChange(
  ticket: { readonly ticketId: string; readonly title: string; readonly status: string },
  previousStatus: string | undefined,
  openTicketId: TicketId | null,
): void {
  if (
    previousStatus === undefined ||
    previousStatus === ticket.status ||
    openTicketId === ticket.ticketId
  ) {
    return;
  }
  if (ticket.status === "waiting_on_user") {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: `"${ticket.title}" is waiting on you`,
        description: "Open the ticket to answer or approve.",
      }),
    );
    return;
  }
  if (ticket.status === "failed" || ticket.status === "blocked") {
    // Pipeline failures with no route project as "blocked", so both statuses
    // mean the same thing to the user: this ticket needs attention.
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `"${ticket.title}" needs attention`,
        description: "Open the ticket to see what went wrong.",
      }),
    );
  }
}

export const Route = createFileRoute("/_chat/$environmentId/board")({
  validateSearch: parseBoardRouteSearch,
  component: WorkflowBoardRouteView,
});
