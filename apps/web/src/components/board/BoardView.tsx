import type { WorkflowStuckDiagnosis } from "@t3tools/contracts";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import type { CardUnstickAction } from "~/workflow/stuckDiagnosisView";
import type { LaneColumnView } from "./LaneColumn";
import { ConsoleBoardView } from "./views/ConsoleBoardView";
import { SpineBoardView } from "./views/SpineBoardView";

export interface BoardViewTicket {
  readonly ticketId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly currentLaneKey: string;
  readonly status: string;
  readonly queuedAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly totalTokens?: number | undefined;
  readonly totalDurationMs?: number | undefined;
  readonly pr?:
    | {
        readonly number: number;
        readonly url: string;
        readonly state: "open" | "merged" | "closed";
        readonly ciState?: "pending" | "success" | "failure" | undefined;
      }
    | undefined;
  readonly attentionKind?: string | undefined;
  /** Server-derived "why is this ticket stuck" — see stuckDiagnosisView. */
  readonly diagnosis?: WorkflowStuckDiagnosis | undefined;
  readonly currentStepLabel?: string | undefined;
  readonly slaBreachedAt?: string | undefined;
  // Park-in-place details — present while status is "parked". `actions` is
  // re-resolved from the current board definition at read time; absent
  // means the definition changed and actions are unavailable.
  readonly parked?:
    | {
        readonly substate: "issue" | "waiting";
        readonly label: string;
        readonly reason: string;
        readonly parkedAt: string;
        readonly parkedEventId: string;
        readonly actions?:
          | ReadonlyArray<{
              readonly label: string;
              readonly to: string;
              readonly hint?: string | undefined;
            }>
          | undefined;
      }
    | undefined;
}

export interface BoardViewState {
  readonly lanes: ReadonlyArray<LaneColumnView>;
  readonly ticketIds: ReadonlyArray<string>;
  readonly ticketById: Record<string, BoardViewTicket>;
}

/** Which redesigned board surface is showing. */
export type BoardViewMode = "spine" | "console";

const MODE_KEY = "t3.board.viewMode";

const MODES: ReadonlyArray<{
  readonly mode: BoardViewMode;
  readonly label: string;
  readonly hint: string;
}> = [
  { mode: "spine", label: "Spine", hint: "Lanes as foldable columns" },
  { mode: "console", label: "Console", hint: "One ranked triage queue" },
];

const readMode = (): BoardViewMode => {
  if (typeof window === "undefined") return "spine";
  return window.localStorage.getItem(MODE_KEY) === "console" ? "console" : "spine";
};

/**
 * Drop-target resolution for the previous drag-and-drop board.
 *
 * Kept because it is pure, tested, and the obvious place to put this logic if
 * dragging returns; neither redesigned view uses it today — both move tickets
 * through the lane actions the server declares rather than by dragging.
 */
export function resolveBoardDropLaneKey(
  state: BoardViewState,
  ticketId: string,
  overId: string | null,
): string | null {
  if (!overId) {
    return null;
  }

  const targetLaneKey = overId.startsWith("lane:")
    ? overId.slice("lane:".length)
    : state.ticketById[overId]?.currentLaneKey;
  const currentLaneKey = state.ticketById[ticketId]?.currentLaneKey;

  if (!targetLaneKey || targetLaneKey === currentLaneKey) {
    return null;
  }

  return targetLaneKey;
}

/**
 * The board surface, in one of two redesigned views.
 *
 * Both are driven from the same `BoardViewState` and expose the same actions,
 * so switching between them never changes what is possible — only how the work
 * is laid out. The choice persists per browser, because it is a working
 * preference rather than board state.
 */
export function BoardView({
  state,
  onOpen,
  onParkAction,
  onUnstickAction,
  pendingParkActionTicketIds,
  mode,
  onModeChange,
  renderTicketDetail,
  onCloseDetail,
}: {
  readonly state: BoardViewState;
  /**
   * Retained so the route keeps one board contract. Neither redesigned view
   * drags today — tickets move through the lane actions the server declares —
   * so it is deliberately not destructured.
   */
  readonly onMove?: ((ticketId: string, toLane: string) => void) | undefined;
  readonly onOpen: (id: string) => void;
  readonly onParkAction?:
    | ((ticketId: string, actionIndex: number, parkedEventId: string) => Promise<void>)
    | undefined;
  /** Dispatch one of the diagnosis's card-safe unstick actions. */
  readonly onUnstickAction?: ((ticketId: string, action: CardUnstickAction) => void) | undefined;
  // Tickets with a park action in flight (from any surface); threaded to each
  // card so the whole ticket's recovery controls share one disable.
  readonly pendingParkActionTicketIds?: ReadonlySet<string> | undefined;
  /** Controlled mode; omit to let the board manage and persist its own. */
  readonly mode?: BoardViewMode | undefined;
  readonly onModeChange?: ((mode: BoardViewMode) => void) | undefined;
  /**
   * The full ticket detail, rendered INSIDE whichever surface the active view
   * opens. Both views host it rather than linking out to a separate panel, so
   * there is one detail implementation and one place it can appear.
   */
  readonly renderTicketDetail?: ((ticketId: string) => ReactNode) | undefined;
  /** Called when the hosted detail is dismissed, so the host can deselect. */
  readonly onCloseDetail?: (() => void) | undefined;
}) {
  const [internalMode, setInternalMode] = useState<BoardViewMode>(readMode);
  const active = mode ?? internalMode;

  const setMode = useCallback(
    (next: BoardViewMode) => {
      setInternalMode(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );

  useEffect(() => {
    if (mode !== undefined || typeof window === "undefined") return;
    window.localStorage.setItem(MODE_KEY, internalMode);
  }, [internalMode, mode]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-4 pt-2">
        <div className="flex overflow-hidden rounded-md border border-border/70">
          {MODES.map((entry) => (
            <button
              key={entry.mode}
              type="button"
              title={entry.hint}
              aria-pressed={active === entry.mode}
              onClick={() => {
                setMode(entry.mode);
              }}
              className={cn(
                "px-2 py-0.5 text-2xs transition-colors",
                active === entry.mode
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {active === "spine" ? (
        <SpineBoardView
          state={state}
          onOpen={onOpen}
          renderTicketDetail={renderTicketDetail}
          onCloseDetail={onCloseDetail}
          onParkAction={onParkAction}
          onUnstickAction={onUnstickAction}
          pendingParkActionTicketIds={pendingParkActionTicketIds}
        />
      ) : (
        <ConsoleBoardView
          state={state}
          onOpen={onOpen}
          renderTicketDetail={renderTicketDetail}
          onParkAction={onParkAction}
          onUnstickAction={onUnstickAction}
          pendingParkActionTicketIds={pendingParkActionTicketIds}
        />
      )}
    </div>
  );
}
