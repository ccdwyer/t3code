import { createFileRoute } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type AgentSelection,
  type BoardSnapshot,
  BoardId,
  EnvironmentId,
  type EnvironmentApi,
  LaneKey,
  MessageId,
  PARK_ACTION_DRIFT_MESSAGES,
  ProjectId,
  StepRunId,
  type TicketAttachment,
  TicketId,
  WorkflowEventId,
  type WorkflowDefinitionEncoded,
  type WorkflowTicketDetailView,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { DatabaseIcon } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { BoardHeaderControls } from "../components/board/BoardHeaderControls";
import { BoardView } from "../components/board/BoardView";
import { WorkflowEditor } from "../components/board/editor/WorkflowEditor";
import { WorkflowEditorFullscreen } from "../components/board/editor/WorkflowEditorFullscreen";
import { NeedsYouStrip } from "../components/board/NeedsYouStrip";
import { TicketDrawer } from "../components/board/TicketDrawer";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { countNeedsAttention } from "../workflow/agingFormat";
import { useNowTick } from "../workflow/useNowTick";
import { emptyBoardState, type BoardState } from "../workflow/boardState";
import type { CardUnstickAction } from "../workflow/stuckDiagnosisView";
import {
  answerTicketStep,
  createTicket,
  deleteTicket,
  editTicketContextPack,
  getTicketTimeline,
  editTicket,
  editTicketMessage,
  invokeParkAction,
  moveTicket,
  postTicketMessage,
  resolveApproval,
  subscribeBoard,
} from "../workflow/boardRpc";
import { useEnvironmentQuery } from "../state/query";
import { workflowEnvironment } from "../state/workflow";
import { useBoardApi } from "../workflow/useBoardApi";
import { useProject } from "../state/entities";

export interface BoardRouteSearch {
  readonly boardId?: string | undefined;
  /** Deep-link target: opens this ticket's drawer on load (notifications/webhooks). */
  readonly ticket?: string | undefined;
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
  const ticket = typeof search.ticket === "string" ? search.ticket.trim() : "";
  return { ...(boardId ? { boardId } : {}), ...(ticket ? { ticket } : {}) };
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

export interface BoardRouteMessageEditInput {
  readonly ticketId: string;
  readonly messageId: string;
  readonly body: string;
}

const environmentApiUnavailable = () => new Error("Environment API unavailable.");

// Max consecutive 2s polls while waiting for a running agent step's dispatch
// thread to appear (~30s). Bounds the self-re-arming detail poll so a stalled
// dispatch can't refetch getTicketDetail forever for every open drawer.
const MAX_THREAD_POLL_ATTEMPTS = 15;

export const submitTicketAnswerFromBoardRoute = (
  api: Pick<EnvironmentApi, "workflow"> | null | undefined,
  input: BoardRouteAnswerInput,
  reloadTicketDetail: () => void,
): Promise<void> => {
  if (!api) {
    return Promise.reject(environmentApiUnavailable());
  }

  return answerTicketStep(api as EnvironmentApi, {
    stepRunId: StepRunId.make(input.stepRunId),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
  }).then(reloadTicketDetail);
};

export const submitTicketEditFromBoardRoute = (
  api: Pick<EnvironmentApi, "workflow"> | null | undefined,
  input: BoardRouteEditInput,
  reloadTicketDetail: () => void,
): Promise<void> => {
  if (!api) {
    return Promise.reject(environmentApiUnavailable());
  }

  return editTicket(api as EnvironmentApi, {
    ticketId: TicketId.make(input.ticketId),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
  }).then(reloadTicketDetail);
};

export const submitTicketMessageEditFromBoardRoute = (
  api: Pick<EnvironmentApi, "workflow"> | null | undefined,
  input: BoardRouteMessageEditInput,
  reloadTicketDetail: () => void,
): Promise<void> => {
  if (!api) {
    return Promise.reject(environmentApiUnavailable());
  }

  return editTicketMessage(api as EnvironmentApi, {
    ticketId: TicketId.make(input.ticketId),
    messageId: MessageId.make(input.messageId),
    body: input.body,
  }).then(reloadTicketDetail);
};

export interface BoardRouteParkActionInput {
  readonly ticketId: string;
  readonly actionIndex: number;
  readonly parkedEventId: string;
}

/**
 * Unpark a ticket via one of its re-resolved park actions. Compare-and-act on
 * `parkedEventId` server-side: a `"stale"` result means the ticket already
 * moved on (superseded by another action, a manual move, or a re-park) — we
 * surface an informational toast rather than an error, since nothing actually
 * failed. A rejected RPC (e.g. the board definition changed underneath the
 * action, or the index no longer resolves) surfaces the RPC's message as an
 * error toast instead.
 *
 * `pendingTicketIds` is the in-flight guard: a ticket already mid-invocation
 * is a no-op (resolves immediately, RPC not re-sent) until the prior call
 * settles, so a doubled click/tap can't race two park actions for the same
 * ticket. It is also the source of truth for the shared DISABLE: the route
 * mirrors it into reactive state so the card, the needs-you strip, and the
 * drawer banner all disable that ticket's recovery controls while any one
 * surface's invoke is in flight (a plain `Set` satisfies the guard shape).
 */
export interface PendingParkActionGuard {
  has(ticketId: string): boolean;
  add(ticketId: string): unknown;
  delete(ticketId: string): unknown;
}

/**
 * A park-action rejection that means the board definition drifted out from
 * under the rendered actions: the server re-resolves the action index against
 * the CURRENT definition and fails with one of these typed messages when it no
 * longer maps. On any of them the client must refresh the board so the stale
 * inline buttons repair to the "actions unavailable" fallback instead of
 * letting the user re-click into the same error. Matched via the shared
 * PARK_ACTION_DRIFT_MESSAGES fragments (contracts) — never hand-copied strings.
 * The RPC squashes an engine rejection to a plain Error at the client edge, and
 * the invokeParkAction handler surfaces the engine's cause message into that
 * Error, so a substring match against these fragments still fires over the wire.
 * (indexOutOfRange is a stale-client bug server-side, not true definition drift,
 * but the web still treats it as refresh-worthy — see the constant's docs.)
 */
export function isParkActionDriftError(message: string): boolean {
  return (
    message.includes(PARK_ACTION_DRIFT_MESSAGES.definitionChanged) ||
    message.includes(PARK_ACTION_DRIFT_MESSAGES.indexOutOfRange) ||
    message.includes(PARK_ACTION_DRIFT_MESSAGES.targetLaneMissing)
  );
}

export function submitParkActionFromBoardRoute(
  api: Pick<EnvironmentApi, "workflow"> | null | undefined,
  input: BoardRouteParkActionInput,
  callbacks: {
    readonly reloadTicketDetailIfOpen: () => void;
    readonly pendingTicketIds: PendingParkActionGuard;
    readonly onDefinitionDrift?: (() => void) | undefined;
  },
): Promise<void> {
  if (callbacks.pendingTicketIds.has(input.ticketId)) {
    return Promise.resolve();
  }
  if (!api) {
    return Promise.reject(environmentApiUnavailable());
  }

  callbacks.pendingTicketIds.add(input.ticketId);
  return invokeParkAction(
    api as EnvironmentApi,
    TicketId.make(input.ticketId),
    input.actionIndex,
    WorkflowEventId.make(input.parkedEventId),
  )
    .then(
      (result) => {
        if (result === "stale") {
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Already handled — the board moved on.",
            }),
          );
        }
        callbacks.reloadTicketDetailIfOpen();
      },
      (error: unknown) => {
        const description = actionErrorMessage(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Couldn't update ticket",
            description,
          }),
        );
        // Definition drift: the actions the user clicked no longer resolve.
        // Refresh the board so the stale buttons repair to "actions
        // unavailable" rather than re-toasting the same error on the next tap.
        // Also refresh the OPEN drawer's detail: the board subscription repairs
        // card/strip, but the drawer holds a cached getTicketDetail payload with
        // the pre-drift `parked.actions` and would keep offering dead buttons
        // until a manual reload.
        if (isParkActionDriftError(description)) {
          callbacks.onDefinitionDrift?.();
          callbacks.reloadTicketDetailIfOpen();
        }
      },
    )
    .finally(() => {
      callbacks.pendingTicketIds.delete(input.ticketId);
    });
}

/**
 * What `notifyTicketStatusChange`'s dedup guard compares against. Status
 * alone collapses a re-park into a no-op (both are "parked"), so the guard
 * also tracks `attentionKind` (issue vs waiting) and the park's own event id
 * — a fresh `parkedEventId` means a new park happened even when the status
 * and substate both stayed the same (e.g. retry fails again into the same
 * "issue" substate).
 */
interface TicketNotifyState {
  readonly status: string;
  readonly attentionKind?: string | undefined;
  readonly parkedEventId?: string | undefined;
}

const ticketNotifyState = (ticket: {
  readonly status: string;
  readonly attentionKind?: string | undefined;
  readonly parked?: { readonly parkedEventId: string } | undefined;
}): TicketNotifyState => ({
  status: ticket.status,
  ...(ticket.attentionKind === undefined ? {} : { attentionKind: ticket.attentionKind }),
  ...(ticket.parked === undefined ? {} : { parkedEventId: ticket.parked.parkedEventId }),
});

/**
 * Force the open ticket's detail to REFETCH, not serve SWR cache. `getTicketDetail`
 * is an SWR query (30s freshness): a bare reload key-bump remounts the memoized
 * atom, which within the stale window returns the pre-action detail with no RPC.
 * So we first invalidate that atom (`refreshTicketDetail`) and then bump the
 * reload key so the route's detail effect re-runs and reads the fresh value.
 * Pure/injected so the sequencing is unit-testable without a live registry.
 */
export function requestFreshTicketDetail(
  ticketId: TicketId | null,
  deps: {
    readonly refreshTicketDetail: (ticketId: TicketId) => void;
    readonly bumpReloadKey: () => void;
  },
): void {
  if (ticketId !== null) {
    deps.refreshTicketDetail(ticketId);
  }
  deps.bumpReloadKey();
}

function WorkflowBoardRouteView() {
  const { environmentId: rawEnvironmentId } = Route.useParams();
  const { boardId: rawBoardId, ticket: rawTicket } = Route.useSearch();
  const [selectedTicketId, setSelectedTicketId] = useState<TicketId | null>(null);
  const [ticketDetail, setTicketDetail] = useState<WorkflowTicketDetailView | null>(null);
  const [ticketDetailError, setTicketDetailError] = useState<string | null>(null);
  const [ticketDetailReloadKey, setTicketDetailReloadKey] = useState(0);
  const [boardLoadError, setBoardLoadError] = useState<string | null>(null);
  const [boardHasSources, setBoardHasSources] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // Incremented each time the board-level "Set up a source" CTA is clicked.
  // Passed to WorkflowEditor so it can open the Sources wizard on mount.
  const [editorSourcesTrigger, setEditorSourcesTrigger] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const ticketStatusRef = useRef(new Map<string, TicketNotifyState>());
  // In-flight guard for handleParkAction: tickets currently mid-invocation, so
  // a doubled click can't fire a second invokeParkAction RPC for the same
  // ticket while the first is still pending. The ref is the SYNCHRONOUS source
  // of truth (two rapid clicks in one tick must see the add immediately); the
  // reactive `pendingParkActionTicketIds` mirror below drives the shared disable
  // across card / strip / drawer.
  const pendingParkActionTicketIdsRef = useRef(new Set<string>());
  const [pendingParkActionTicketIds, setPendingParkActionTicketIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const registry = useContext(RegistryContext);
  const selectedTicketIdRef = useRef<TicketId | null>(null);
  selectedTicketIdRef.current = selectedTicketId;
  const lastDetailTicketIdRef = useRef<string | null>(null);
  // Bounds the "wait for the dispatch thread" poll below so a step that never
  // gets a providerThreadId (stalled dispatch) can't re-poll getTicketDetail
  // every 2s for the lifetime of the open drawer.
  const threadPollAttemptsRef = useRef(0);
  const environmentId = useMemo(() => EnvironmentId.make(rawEnvironmentId), [rawEnvironmentId]);
  const boardId = useMemo(() => (rawBoardId ? BoardId.make(rawBoardId) : null), [rawBoardId]);

  // Board API facade — the `workflow.*` bridge plus the real `orchestration`
  // (subscribeThread) and `terminal` (attachHistory) subscription clients the
  // drawer panels need. Passed to child components as the wide `EnvironmentApi`.
  const routeApi = useBoardApi(environmentId);
  // Workflow slice for the route's own callbacks below (same object useBoardApi
  // built from useWorkflowApi — stable identity, no extra hook call).
  const api = routeApi.workflow;

  // Board state from the folded subscription atom.
  const boardQuery = useEnvironmentQuery(
    boardId ? workflowEnvironment.board({ environmentId, input: { boardId } }) : null,
  );
  const state = boardQuery.data ?? emptyBoardState;

  // ticketCwd: derive from the board's projectId via the environmentProjects atom.
  // EnvironmentProject extends OrchestrationProjectShell which has `workspaceRoot`
  // (the equivalent of the old `cwd` field). Falls back to undefined when the
  // board's projectId isn't yet populated or the project isn't in the catalog.
  const projectRef = useMemo(
    () =>
      state.projectId ? scopeProjectRef(environmentId, ProjectId.make(state.projectId)) : null,
    [environmentId, state.projectId],
  );
  const projectData = useProject(projectRef);
  const ticketCwd = projectData?.workspaceRoot ?? undefined;

  const emptyState = getBoardRouteEmptyState({ boardId, boardLoadError });

  useEffect(() => {
    setBoardLoadError(null);
    if (!boardId) {
      setEditorOpen(false);
      return;
    }

    let cancelled = false;
    void api.getBoard({ boardId }).then(
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
  }, [boardId, environmentId, api]);

  useEffect(() => {
    setBoardHasSources(false);
    if (!boardId) {
      return;
    }

    let cancelled = false;
    void api.getBoardDefinition({ boardId }).then(
      ({ definition }: { definition: WorkflowDefinitionEncoded }) => {
        if (!cancelled) {
          setBoardHasSources((definition.sources?.length ?? 0) > 0);
        }
      },
      () => {
        // Silently ignore: the button simply won't appear if the definition
        // can't be loaded (e.g. network error, board not found).
        if (!cancelled) {
          setBoardHasSources(false);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [boardId, environmentId, api]);

  useEffect(() => {
    // The ticket drawer selection (and its detail/error state) is scoped to a
    // single board/environment. When either changes, close the drawer so it
    // can't linger open on a ticket that isn't part of the current board.
    setSelectedTicketId(null);
    setTicketDetail(null);
    setTicketDetailError(null);
  }, [boardId, environmentId]);

  useEffect(() => {
    // Deep link: a notification/webhook URL targets a specific ticket via the
    // `ticket` search param. Seed the drawer selection from it — declared AFTER
    // the board-switch reset above so it isn't immediately cleared on load.
    if (rawTicket) {
      setSelectedTicketId(TicketId.make(rawTicket));
    } else {
      // The `ticket` param is absent (e.g. back/forward navigation away from a
      // deep link) — treat its removal as authoritative and close the drawer so
      // stale detail can't linger. This effect re-runs only when rawTicket/board/
      // env change, so an in-app manual selection (which doesn't touch the param)
      // is never clobbered.
      setSelectedTicketId(null);
    }
  }, [rawTicket, boardId, environmentId]);

  useEffect(() => {
    if (!boardId) {
      return;
    }

    // Drop any ticket statuses carried over from a previously-viewed board so
    // stale ticket IDs can't fire spurious status-change toasts after a switch.
    ticketStatusRef.current.clear();

    return subscribeBoard(routeApi, environmentId, boardId, {
      onSnapshot: (snapshot) => {
        // Re-seed from scratch so the first ticket-stream update after a
        // snapshot reads as a transition (or not) against fresh statuses, and
        // so a re-snapshot for a new board never leaves stale entries behind.
        ticketStatusRef.current.clear();
        for (const ticket of snapshot.tickets) {
          ticketStatusRef.current.set(ticket.ticketId, ticketNotifyState(ticket));
        }
      },
      onTicketUpdate: (ticket) => {
        if (ticket.ticketId === selectedTicketIdRef.current) {
          // Atom invalidation, not a bare reload-key bump: the bump can be
          // served from the 30s SWR cache, so a viewer who did not make the
          // change would keep seeing stale detail until the cache expired.
          reloadTicketDetailRef.current();
        }
        const previous = ticketStatusRef.current.get(ticket.ticketId);
        ticketStatusRef.current.set(ticket.ticketId, ticketNotifyState(ticket));
        notifyTicketStatusChange(ticket, previous, selectedTicketIdRef.current);
      },
    });
  }, [boardId, environmentId, routeApi]);

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
      // Thread arrived (or the step left the running/dispatch state): reset the
      // budget so a later step in the same ticket gets a fresh window.
      threadPollAttemptsRef.current = 0;
      return;
    }
    // Cap the poll. The thread normally appears within a couple of seconds; if a
    // dispatch stalls and never projects a providerThreadId, stop after ~30s
    // (workflow-event broadcasts still refresh the detail) instead of polling
    // getTicketDetail forever for every open drawer.
    if (threadPollAttemptsRef.current >= MAX_THREAD_POLL_ATTEMPTS) {
      return;
    }
    const timer = setTimeout(() => {
      threadPollAttemptsRef.current += 1;
      setTicketDetailReloadKey((key) => key + 1);
    }, 2_000);
    return () => clearTimeout(timer);
  }, [ticketDetail]);

  const visibleState = useMemo(
    () => filterBoardStateByQuery(state, searchQuery),
    [state, searchQuery],
  );
  // All lanes, flattened — the strip pins parked/waiting tickets regardless
  // of which lane they currently sit in.
  const needsYouTickets = useMemo(
    () =>
      visibleState.ticketIds
        .map((ticketId) => visibleState.ticketById[ticketId])
        .filter((ticket) => ticket !== undefined),
    [visibleState],
  );

  useEffect(() => {
    if (!selectedTicketId) {
      lastDetailTicketIdRef.current = null;
      setTicketDetail(null);
      setTicketDetailError(null);
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
      // New ticket selected: restart the thread-poll budget.
      threadPollAttemptsRef.current = 0;
      setTicketDetail(null);
    }
    setTicketDetailError(null);

    void api.getTicketDetail({ ticketId: selectedTicketId }).then(
      (detail: WorkflowTicketDetailView) => {
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
  }, [environmentId, boardId, selectedTicketId, ticketDetailReloadKey, api]);

  const handleMove = useCallback(
    (ticketId: string, toLane: string): Promise<void> => {
      // moveTicket fails on a not-found ticket (e.g. it was deleted, or already
      // moved by another client between render and drop). The drag/drop onMove
      // contract is fire-and-forget, so catch here: surface a brief toast and
      // refresh the board snapshot (the ticket may be gone or in a new lane)
      // instead of leaking an unhandled rejection or showing a scary error.
      return moveTicket(routeApi, TicketId.make(ticketId), LaneKey.make(toLane)).then(
        undefined,
        () => {
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Couldn't move ticket",
              description: "It may have already moved or been deleted. Refreshing the board.",
            }),
          );
          if (boardId) {
            void api.getBoard({ boardId }).then(undefined, () => undefined);
          }
        },
      );
    },
    [environmentId, boardId, api, routeApi],
  );
  const handleOpenTicket = useCallback((ticketId: string) => {
    setEditorOpen(false);
    setSelectedTicketId(TicketId.make(ticketId));
  }, []);
  // Card-safe unstick actions from the server's stuck diagnosis. Every arm
  // dispatches an EXISTING RPC; failures surface as toasts and the live board
  // subscription carries the state change back. runLane carries a per-ticket
  // in-flight guard so a doubled digit-press can't fire two RPCs (the second
  // of which would reject into a spurious error toast).
  const unstickRunLaneInFlightRef = useRef<Set<string>>(new Set());
  const handleUnstickAction = useCallback(
    (ticketId: string, action: CardUnstickAction) => {
      switch (action.type) {
        case "runLane": {
          if (unstickRunLaneInFlightRef.current.has(ticketId)) {
            return;
          }
          unstickRunLaneInFlightRef.current.add(ticketId);
          void api
            .runLane({ ticketId: TicketId.make(ticketId) })
            .then(undefined, (error: unknown) => {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Couldn't run the lane",
                  description: actionErrorMessage(error),
                }),
              );
            })
            .finally(() => {
              unstickRunLaneInFlightRef.current.delete(ticketId);
            });
          return;
        }
        case "moveToLane":
          void handleMove(ticketId, action.toLane);
          return;
        case "openDependency":
          // The dependency may be excluded by the active search filter, in
          // which case no view can show it — clear the filter so the target
          // is present before (and after) the views' local open paths run.
          setSearchQuery("");
          handleOpenTicket(action.ticketId);
          return;
      }
    },
    [api, handleMove, handleOpenTicket],
  );
  const closeTicketDrawer = useCallback(() => {
    setSelectedTicketId(null);
  }, []);
  // Held in a ref so the board subscription effect can call the latest version
  // without listing it as a dependency and re-subscribing on every render.
  const reloadTicketDetailRef = useRef<() => void>(() => {});
  const reloadTicketDetail = useCallback(() => {
    requestFreshTicketDetail(selectedTicketIdRef.current, {
      refreshTicketDetail: (ticketId) =>
        registry.refresh(
          workflowEnvironment.getTicketDetail({
            environmentId,
            input: { ticketId },
          }),
        ),
      bumpReloadKey: () => setTicketDetailReloadKey((key) => key + 1),
    });
  }, [registry, environmentId]);
  reloadTicketDetailRef.current = reloadTicketDetail;

  const handleLoadTimeline = useCallback(
    async (ticketId: string) => {
      if (!routeApi) {
        throw environmentApiUnavailable();
      }
      return await getTicketTimeline(routeApi, ticketId as never);
    },
    [routeApi],
  );

  const handleEditContextPack = useCallback(
    async (input: {
      readonly ticketId: string;
      readonly forLane: string;
      readonly sections: ReadonlyArray<{
        readonly key: string;
        readonly body: string;
      }>;
    }) => {
      if (!routeApi) {
        throw environmentApiUnavailable();
      }
      const result = await editTicketContextPack(routeApi, input as never);
      reloadTicketDetail();
      return result.sections;
    },
    [routeApi, reloadTicketDetail],
  );

  const handleDeleteTicket = useCallback(async () => {
    const ticketId = selectedTicketIdRef.current;
    if (!ticketId || !routeApi) {
      throw environmentApiUnavailable();
    }
    await deleteTicket(routeApi, ticketId);
    setSelectedTicketId(null);
    setTicketDetail(null);
    // Board stream has no ticket-removed delta; re-subscribe for a fresh snapshot.
    if (boardId) {
      registry.refresh(workflowEnvironment.board({ environmentId, input: { boardId } }));
    }
    toastManager.add({
      type: "success",
      title: "Ticket deleted",
    });
  }, [boardId, environmentId, registry, routeApi]);
  // Re-subscribe the folded board atom, which replays a fresh server snapshot.
  // Used after a definition save (park config changes emit no ticket event, so
  // the live stream never repairs the rendered actions) and on a park-action
  // definition-drift rejection (repairs stale inline buttons to "unavailable").
  const refreshBoardSnapshot = useCallback(() => {
    if (!boardId) {
      return;
    }
    registry.refresh(workflowEnvironment.board({ environmentId, input: { boardId } }));
  }, [registry, environmentId, boardId]);
  // Mirror the in-flight ref into reactive state so every surface re-renders
  // with the shared disable. The ref stays the synchronous re-entry guard.
  const syncPendingParkActions = useCallback(() => {
    setPendingParkActionTicketIds(new Set(pendingParkActionTicketIdsRef.current));
  }, []);
  const handleParkAction = useCallback(
    (ticketId: string, actionIndex: number, parkedEventId: string): Promise<void> =>
      submitParkActionFromBoardRoute(
        routeApi,
        { ticketId, actionIndex, parkedEventId },
        {
          pendingTicketIds: {
            has: (id) => pendingParkActionTicketIdsRef.current.has(id),
            add: (id) => {
              pendingParkActionTicketIdsRef.current.add(id);
              syncPendingParkActions();
            },
            delete: (id) => {
              pendingParkActionTicketIdsRef.current.delete(id);
              syncPendingParkActions();
            },
          },
          // Board/strip surfaces update via the live board subscription; this
          // reload only refreshes the open drawer's detail.
          reloadTicketDetailIfOpen: () => {
            if (selectedTicketIdRef.current === TicketId.make(ticketId)) {
              reloadTicketDetail();
            }
          },
          onDefinitionDrift: refreshBoardSnapshot,
        },
      ),
    [routeApi, reloadTicketDetail, refreshBoardSnapshot, syncPendingParkActions],
  );
  const handleApprove = useCallback(
    (
      stepRunId: string,
      approved: boolean,
      submission?: {
        readonly decision?: string | undefined;
        readonly answers?: Record<string, string | ReadonlyArray<string>> | undefined;
      },
    ): Promise<void> => {
      return resolveApproval(routeApi, StepRunId.make(stepRunId), approved, submission).then(
        reloadTicketDetail,
      );
    },
    [routeApi, reloadTicketDetail],
  );
  const handleAnswerStep = useCallback(
    (input: BoardRouteAnswerInput): Promise<void> => {
      return submitTicketAnswerFromBoardRoute(routeApi, input, reloadTicketDetail);
    },
    [routeApi, reloadTicketDetail],
  );
  const handlePostComment = useCallback(
    (input: {
      readonly ticketId: string;
      readonly text?: string | undefined;
      readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
    }): Promise<void> => {
      return postTicketMessage(routeApi, {
        ticketId: TicketId.make(input.ticketId),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      }).then(reloadTicketDetail);
    },
    [routeApi, reloadTicketDetail],
  );
  const handleEditTicket = useCallback(
    (input: BoardRouteEditInput): Promise<void> => {
      return submitTicketEditFromBoardRoute(routeApi, input, reloadTicketDetail);
    },
    [routeApi, reloadTicketDetail],
  );
  const handleEditMessage = useCallback(
    (messageId: string, body: string): Promise<void> => {
      if (!selectedTicketId) {
        return Promise.reject(environmentApiUnavailable());
      }
      return submitTicketMessageEditFromBoardRoute(
        routeApi,
        { ticketId: selectedTicketId, messageId, body },
        reloadTicketDetail,
      );
    },
    [routeApi, reloadTicketDetail, selectedTicketId],
  );
  const handleRunLane = useCallback(() => {
    if (!selectedTicketId) {
      return;
    }

    // Mirror handleMove: a runLane RPC can reject (lane not runnable, script
    // trust revoked between render and click, server error). Surface a toast
    // and still reload the detail so the drawer reflects current state, instead
    // of leaking an unhandled rejection with no user feedback.
    void api.runLane({ ticketId: selectedTicketId }).then(reloadTicketDetail, (error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't run the lane",
          description: actionErrorMessage(error),
        }),
      );
      reloadTicketDetail();
    });
  }, [environmentId, reloadTicketDetail, selectedTicketId, api]);
  const handleDrawerMove = useCallback(
    (toLane: string): Promise<void> => {
      if (!selectedTicketId) {
        return Promise.resolve();
      }

      // Await the move RPC before reloading the detail so the drawer doesn't
      // briefly render the stale lane/actions while the move commits.
      return handleMove(selectedTicketId, toLane).then(reloadTicketDetail);
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

      // The New-ticket form closes its dialog synchronously after calling this,
      // so a rejected create (validation, duplicate, budget, server error) would
      // otherwise be fully silent. Surface a toast on failure instead of leaking
      // an unhandled rejection.
      void createTicket(routeApi, {
        boardId,
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        initialLane: LaneKey.make(input.initialLane),
        ...(input.dependsOn === undefined || input.dependsOn.length === 0
          ? {}
          : {
              dependsOn: input.dependsOn.map((ticketId) => TicketId.make(ticketId)),
            }),
        ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
      }).then(undefined, (error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Couldn't create "${input.title}"`,
            description: actionErrorMessage(error),
          }),
        );
      });
    },
    [boardId, routeApi],
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
      const created = await createTicket(routeApi, {
        boardId,
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        initialLane: LaneKey.make(input.initialLane),
        ...(input.dependsOn === undefined || input.dependsOn.length === 0
          ? {}
          : {
              dependsOn: input.dependsOn.map((ticketId) => TicketId.make(ticketId)),
            }),
      });
      return created.ticketId as string;
    },
    [boardId, routeApi],
  );
  const handleProposeTickets = useCallback(
    async (braindump: string, agent: AgentSelection) => {
      if (!boardId) {
        throw new Error("No board selected.");
      }
      const result = await api.intakeTickets({ boardId, braindump, agent });
      return result.proposals;
    },
    [boardId, api],
  );
  const handleFetchDigest = useCallback(async () => {
    if (!boardId) {
      throw new Error("No board selected.");
    }
    return await api.getBoardDigest({ boardId });
  }, [boardId, api]);
  const handleFetchMetrics = useCallback(
    async (windowDays: 1 | 7 | 30) => {
      if (!boardId) {
        throw new Error("No board selected.");
      }
      return await api.getBoardMetrics({ boardId, windowDays });
    },
    [boardId, api],
  );
  const handleFetchWebhookConfig = useCallback(
    async (rotate: boolean) => {
      if (!boardId) {
        throw new Error("No board selected.");
      }
      return await api.getWebhookConfig({
        boardId,
        ...(rotate ? { rotate } : {}),
      });
    },
    [boardId, api],
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
  const handleRefresh = useCallback(() => {
    if (!boardId) {
      return;
    }
    void api.getBoard({ boardId }).then(undefined, () => undefined);
  }, [boardId, api]);

  const handleToggleWorkflowEditor = useCallback(() => {
    setEditorOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setSelectedTicketId(null);
      }
      return nextOpen;
    });
  }, []);

  /** Opens the editor directly to the Sources wizard (board empty-state CTA). */
  const handleOpenEditorToSources = useCallback(() => {
    setSelectedTicketId(null);
    setEditorOpen(true);
    setEditorSourcesTrigger((n) => n + 1);
  }, []);
  const handleWorkflowSaved = useCallback(
    (_snapshot: BoardSnapshot, definition: WorkflowDefinitionEncoded) => {
      // A definition-only change (e.g. a park target added/edited/removed) emits
      // NO ticket event, so the folded board subscription never repairs the
      // rendered park actions on its own. Re-subscribe the board atom to replay
      // a fresh server snapshot resolved against the just-saved definition — the
      // idiomatic equivalent of applying the save's returned snapshot.
      refreshBoardSnapshot();
      // Derive whether the board now has sources from the saved definition
      // rather than assuming any save implies sources exist — a lane rename or
      // settings change triggers onSaved too, and must not dismiss the CTA.
      setBoardHasSources((definition.sources?.length ?? 0) > 0);
    },
    [refreshBoardSnapshot],
  );
  const closeWorkflowEditor = useCallback(() => {
    setEditorOpen(false);
  }, []);

  /**
   * The full ticket detail, handed to the board so it can host it inside
   * whichever surface it opens. There is one drawer implementation; the board
   * decides where it appears.
   */
  const renderTicketDetail = useCallback(
    (ticketId: string) => {
      if (ticketDetail === null || ticketDetail.ticket.ticketId !== ticketId) {
        return (
          <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
            {ticketDetailError ?? "Loading ticket..."}
          </div>
        );
      }
      return (
        <TicketDrawer
          api={routeApi}
          detail={ticketDetail}
          lanes={state.lanes}
          onAnswerStep={handleAnswerStep}
          onPostComment={handlePostComment}
          onEditMessage={handleEditMessage}
          onEditContextPack={handleEditContextPack}
          onLoadTimeline={handleLoadTimeline}
          onApprove={handleApprove}
          onEditTicket={handleEditTicket}
          onDeleteTicket={handleDeleteTicket}
          onMove={handleDrawerMove}
          onRunLane={handleRunLane}
          onSteered={reloadTicketDetail}
          onParkAction={handleParkAction}
          parkActionPending={pendingParkActionTicketIds.has(ticketDetail.ticket.ticketId)}
          projectId={state.projectId ? ProjectId.make(state.projectId) : undefined}
          cwd={ticketCwd}
        />
      );
    },
    [
      handleAnswerStep,
      handleApprove,
      handleDeleteTicket,
      handleDrawerMove,
      handleEditContextPack,
      handleEditMessage,
      handleEditTicket,
      handleLoadTimeline,
      handleParkAction,
      handlePostComment,
      handleRunLane,
      pendingParkActionTicketIds,
      reloadTicketDetail,
      routeApi,
      state.lanes,
      state.projectId,
      ticketCwd,
      ticketDetail,
      ticketDetailError,
    ],
  );

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
              api={routeApi}
              onCreateTicket={handleCreateTicket}
              onProposeTickets={handleProposeTickets}
              onCreateTicketAsync={handleCreateTicketAsync}
              onToggleWorkflowEditor={handleToggleWorkflowEditor}
              needsAttentionCount={needsAttentionCount}
              onFetchDigest={handleFetchDigest}
              onFetchMetrics={handleFetchMetrics}
              onFetchWebhookConfig={handleFetchWebhookConfig}
              boardHasSources={boardHasSources}
              onRefresh={handleRefresh}
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
            <div className="flex min-h-0 flex-1 flex-col">
              <NeedsYouStrip
                tickets={needsYouTickets}
                onOpen={handleOpenTicket}
                onParkAction={handleParkAction}
                pendingParkActionTicketIds={pendingParkActionTicketIds}
              />
              <BoardView
                state={visibleState}
                renderTicketDetail={renderTicketDetail}
                onCloseDetail={closeTicketDrawer}
                onMove={handleMove}
                onOpen={handleOpenTicket}
                onParkAction={handleParkAction}
                onUnstickAction={handleUnstickAction}
                pendingParkActionTicketIds={pendingParkActionTicketIds}
              />
              {boardId && !boardHasSources ? (
                <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/20 px-4 py-2">
                  <p className="text-xs text-muted-foreground">
                    No sources configured. Tickets from GitHub Issues or Asana can be pulled in
                    automatically.
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    className="shrink-0"
                    onClick={handleOpenEditorToSources}
                  >
                    <DatabaseIcon className="size-3.5" />
                    Set up a source
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </SidebarInset>
      <WorkflowEditorFullscreen open={editorOpen && boardId !== null} onClose={closeWorkflowEditor}>
        {boardId ? (
          <WorkflowEditor
            key={boardId}
            api={routeApi}
            boardId={boardId}
            onClose={closeWorkflowEditor}
            onSaved={handleWorkflowSaved}
            openSourcesWizardOnMount={editorSourcesTrigger}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 text-sm text-muted-foreground">
            Environment API unavailable.
          </div>
        )}
      </WorkflowEditorFullscreen>
    </>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to load ticket detail.";
}

/** Error text for a failed action (create/run) toast, with a neutral fallback. */
function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
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
      parkedTicketIds: lane.parkedTicketIds.filter(matches),
    })),
  };
}

export function notifyTicketStatusChange(
  ticket: {
    readonly ticketId: string;
    readonly title: string;
    readonly status: string;
    readonly attentionKind?: string | undefined;
    readonly parked?: { readonly parkedEventId: string } | undefined;
  },
  previous: TicketNotifyState | undefined,
  openTicketId: TicketId | null,
): void {
  if (openTicketId === ticket.ticketId) {
    return;
  }
  const next = ticketNotifyState(ticket);
  if (
    previous === undefined ||
    (previous.status === next.status &&
      previous.attentionKind === next.attentionKind &&
      previous.parkedEventId === next.parkedEventId)
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
  if (ticket.status === "parked" && ticket.attentionKind === "parked_issue") {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `"${ticket.title}" hit an issue`,
        description: "Open the ticket to see what went wrong.",
      }),
    );
    return;
  }
  if (ticket.status === "parked" && ticket.attentionKind === "parked_waiting") {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: `"${ticket.title}" is waiting on you`,
        description: "Open the ticket to review and choose an action.",
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
