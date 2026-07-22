import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cva } from "class-variance-authority";
import { MoreHorizontalIcon } from "lucide-react";
import { type CSSProperties, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { ticketAging } from "~/workflow/agingFormat";
import { useNowTick } from "~/workflow/useNowTick";
import { ticketUsageSummary } from "~/workflow/usageFormat";

interface TicketParkAction {
  readonly label: string;
  readonly to: string;
  readonly hint?: string | undefined;
}

interface TicketParkedView {
  readonly substate: "issue" | "waiting";
  readonly label: string;
  readonly reason: string;
  readonly parkedAt: string;
  readonly parkedEventId: string;
  readonly actions?: ReadonlyArray<TicketParkAction> | undefined;
}

export interface TicketCardView {
  readonly ticketId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly status: string;
  readonly totalTokens?: number | undefined;
  readonly totalDurationMs?: number | undefined;
  readonly unresolvedDependencyCount?: number | undefined;
  readonly tokenBudget?: number | undefined;
  readonly updatedAt?: string | undefined;
  readonly pr?:
    | {
        readonly number: number;
        readonly url: string;
        readonly state: "open" | "merged" | "closed";
        readonly ciState?: "pending" | "success" | "failure" | undefined;
      }
    | undefined;
  readonly attentionKind?: string | undefined;
  readonly currentStepLabel?: string | undefined;
  // Park-in-place details — present while status is "parked". `actions` is
  // re-resolved from the current board definition at read time; absent means
  // the definition changed and inline recovery is unavailable (the drawer
  // stays the escape hatch).
  readonly parked?: TicketParkedView | undefined;
}

interface TicketStatusMeta {
  readonly label: string;
  readonly tone: "destructive" | "muted" | "settled" | "success" | "warning";
  readonly textClassName: string;
  /** Live execution gets a pulsing indicator; nothing else earns a dot. */
  readonly live?: boolean;
}

/**
 * Theo's attention tiers: a card's *color* tells you what it needs at a
 * glance. Parking wins over runtime status (a parked ticket holds no token,
 * so it is neither running nor queued); `waiting_on_user` shares the waiting
 * tier because an agent question is the same "needs you" ask.
 */
export type TicketTier = "issue" | "waiting" | "processing" | "enqueued" | "neutral";

export const ticketTier = (ticket: Pick<TicketCardView, "status" | "parked">): TicketTier => {
  if (ticket.parked?.substate === "issue") {
    return "issue";
  }
  if (ticket.parked?.substate === "waiting" || ticket.status === "waiting_on_user") {
    return "waiting";
  }
  if (ticket.status === "running") {
    return "processing";
  }
  if (ticket.status === "queued") {
    return "enqueued";
  }
  return "neutral";
};

interface IndexedParkAction {
  readonly action: TicketParkAction;
  readonly index: number;
}

/**
 * The first re-resolved action is the primary button; the rest collapse into
 * an overflow menu. Each carries its original index so dispatch stays keyed to
 * the definition order (the server re-resolves by index).
 */
export const splitParkActions = (
  actions: ReadonlyArray<TicketParkAction>,
): {
  readonly primary: IndexedParkAction | undefined;
  readonly overflow: ReadonlyArray<IndexedParkAction>;
} => {
  const [first, ...rest] = actions;
  return {
    primary: first === undefined ? undefined : { action: first, index: 0 },
    overflow: rest.map((action, i) => ({ action, index: i + 1 })),
  };
};

interface ParkActionGuard {
  readonly isInFlight: () => boolean;
  readonly begin: () => void;
  readonly end: () => void;
}

/**
 * Fires a park action once, ignoring re-entry while the RPC is in flight — a
 * local double-click guard layered on top of the route-side pending set, so a
 * doubled click never dispatches two RPCs even before the disabled prop lands.
 */
export const dispatchParkAction = (
  args: {
    readonly onParkAction?:
      | ((ticketId: string, actionIndex: number, parkedEventId: string) => Promise<void>)
      | undefined;
    readonly ticketId: string;
    readonly actionIndex: number;
    readonly parkedEventId: string | undefined;
  },
  guard: ParkActionGuard,
): void => {
  if (args.onParkAction === undefined || args.parkedEventId === undefined || guard.isInFlight()) {
    return;
  }
  guard.begin();
  void args.onParkAction(args.ticketId, args.actionIndex, args.parkedEventId).finally(() => {
    guard.end();
  });
};

const ticketCardVariants = cva(
  "group relative w-full rounded-md border bg-card text-left text-sm text-card-foreground shadow-xs transition-[border-color,box-shadow,background-color]",
  {
    variants: {
      // Color signals, not noise: a subtle border/ring in the tier hue, never a
      // full fill. Issue borrows the amber `warning` family; waiting borrows the
      // blue `info` family (the theme carries no dedicated violet token).
      tier: {
        neutral: "border-border/70",
        issue: "border-warning/50 ring-1 ring-warning/25",
        waiting: "border-info/50 ring-1 ring-info/25",
        processing: "border-border/70",
        enqueued: "border-border/70 opacity-60",
      },
      dragging: {
        false: "",
        true: "opacity-50 shadow-md",
      },
    },
    defaultVariants: {
      tier: "neutral",
      dragging: false,
    },
  },
);

// Status is said once, in words. Idle cards say nothing: an untouched card in
// a lane needs no extra signal beyond its position on the board.
const statusMetaByStatus: Record<string, TicketStatusMeta | undefined> = {
  idle: undefined,
  queued: {
    label: "queued",
    tone: "muted",
    textClassName: "text-muted-foreground",
  },
  running: {
    label: "running",
    tone: "success",
    textClassName: "text-success-foreground",
    live: true,
  },
  waiting_on_user: {
    label: "waiting on you",
    tone: "warning",
    textClassName: "text-warning-foreground",
  },
  blocked: {
    label: "blocked",
    tone: "warning",
    textClassName: "text-warning-foreground",
  },
  failed: {
    label: "failed",
    tone: "destructive",
    textClassName: "text-destructive-foreground",
  },
  done: {
    label: "done",
    tone: "settled",
    textClassName: "text-muted-foreground/80",
  },
};

export function TicketCard({
  ticket,
  onOpen,
  onParkAction,
  parkActionPending = false,
}: {
  readonly ticket: TicketCardView;
  readonly onOpen: (id: string) => void;
  readonly onParkAction?:
    | ((ticketId: string, actionIndex: number, parkedEventId: string) => Promise<void>)
    | undefined;
  // True while a park action for THIS ticket is in flight from any surface
  // (card / strip / drawer). Shared from the route so all of the ticket's
  // recovery controls disable together, not just the one that was clicked.
  readonly parkActionPending?: boolean | undefined;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.ticketId,
  });
  const meta = statusMetaByStatus[ticket.status] ?? null;
  const usageSummary = ticketUsageSummary(ticket);
  const unresolvedDependencies = ticket.unresolvedDependencyCount ?? 0;
  const aging = ticketAging(ticket, useNowTick(60_000));
  const tier = ticketTier(ticket);
  const parked = ticket.parked;
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Status word + tone. Priority: parked label (aging duration appended) →
  // aging nag → runtime status. A parked ticket escalates via aging too, so an
  // aged park flips to the destructive tone while keeping its own label.
  let statusLabel: string | null;
  let statusTone: string | undefined;
  let statusClassName: string | undefined;
  if (parked !== undefined) {
    statusLabel = aging === null ? parked.label : `${parked.label} · ${aging.durationLabel}`;
    const escalated = aging?.level === "alert";
    statusTone = escalated ? "destructive" : tier === "issue" ? "warning" : "info";
    statusClassName = escalated
      ? "text-destructive-foreground"
      : tier === "issue"
        ? "text-warning-foreground"
        : "text-info-foreground";
  } else if (aging !== null) {
    statusLabel = aging.label;
    statusTone = aging.level === "alert" ? "destructive" : "warning";
    statusClassName =
      aging.level === "alert" ? "text-destructive-foreground" : "text-warning-foreground";
  } else if (meta !== null) {
    // A running card names its live step ("running · implement") so the board
    // reads like a status line, not just a spinner.
    statusLabel =
      ticket.status === "running" && ticket.currentStepLabel
        ? `${meta.label} · ${ticket.currentStepLabel}`
        : meta.label;
    statusTone = meta.tone;
    statusClassName = meta.textClassName;
  } else {
    statusLabel = null;
    statusTone = undefined;
    statusClassName = undefined;
  }

  const showLiveDot = meta?.live === true && parked === undefined && aging === null;
  const showFooter = statusLabel !== null || usageSummary !== null || ticket.pr !== undefined;
  // Parked cards surface the reason (the park's explanation); everyone else
  // shows the description. Only ever one secondary line, to keep the card calm.
  const secondaryText = parked?.reason ?? ticket.description;
  const isProcessing = tier === "processing";
  const parkActions = parked?.actions;
  const { primary: primaryAction, overflow: overflowActions } =
    parkActions !== undefined
      ? splitParkActions(parkActions)
      : { primary: undefined, overflow: [] };

  const inFlightRef = useRef(false);
  const [pending, setPending] = useState(false);
  // Local guard OR the shared route-level flag: a click on the strip or drawer
  // for this ticket disables the card's buttons too (belt-and-suspenders on top
  // of the local double-click guard).
  const actionsDisabled = pending || parkActionPending;
  const runAction = (index: number): void => {
    dispatchParkAction(
      {
        onParkAction,
        ticketId: ticket.ticketId,
        actionIndex: index,
        parkedEventId: parked?.parkedEventId,
      },
      {
        isInFlight: () => inFlightRef.current,
        begin: () => {
          inFlightRef.current = true;
          setPending(true);
        },
        end: () => {
          inFlightRef.current = false;
          setPending(false);
        },
      },
    );
  };

  // Keep pointer/click events off the sortable drag listeners and the open
  // target — an action press must never start a drag or open the drawer.
  const stopEvent = (event: { stopPropagation: () => void }): void => {
    event.stopPropagation();
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={ticketCardVariants({ tier, dragging: isDragging })}
      data-status={ticket.status}
      data-tier={tier}
      data-testid="ticket-card"
    >
      {/* Drag region + open target: the whole body is draggable, and a plain
          keyboard-focusable button opens the drawer. dnd-kit's activation
          distance keeps a click a click and a drag a drag.
          INTENTIONAL (Sol gate-3 finding 4, accepted): the sortable drag
          `listeners` are spread onto the SAME element that opens the drawer,
          not a separate drag handle. This is dnd-kit's activation-constraint
          pattern — the PointerSensor's 8px `distance` (BoardView) is what
          disambiguates a tap-to-open from a drag, and it matches the
          pre-feature card's UX exactly (the whole card was drag+click). The
          action buttons live OUTSIDE this button (siblings below), so they
          never inherit the drag activator. */}
      <button
        type="button"
        className="block w-full cursor-grab rounded-md px-3 py-2.5 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/35"
        onClick={() => onOpen(ticket.ticketId)}
        data-testid="ticket-open"
        {...attributes}
        {...listeners}
      >
        <span className="block truncate font-medium leading-5">{ticket.title}</span>
        {secondaryText ? (
          <span
            className="mt-1 block line-clamp-2 text-xs leading-4 text-muted-foreground"
            {...(parked !== undefined ? { title: parked.reason } : {})}
            data-testid={parked !== undefined ? "ticket-parked-reason" : undefined}
          >
            {secondaryText}
          </span>
        ) : null}
        {unresolvedDependencies > 0 ? (
          <span
            className="mt-1.5 block text-[11px] leading-4 text-warning-foreground"
            data-testid="ticket-dependency-badge"
          >
            waiting on {unresolvedDependencies} dependenc
            {unresolvedDependencies === 1 ? "y" : "ies"}
          </span>
        ) : null}
        {showFooter ? (
          <span className="mt-2 flex items-baseline gap-1.5">
            {statusLabel !== null ? (
              <span
                className={cn(
                  "flex min-w-0 items-baseline gap-1.5 truncate text-[11px] font-medium leading-4",
                  statusClassName,
                )}
                data-status-tone={statusTone}
                data-testid="ticket-status"
              >
                {showLiveDot ? (
                  <span aria-hidden="true" className="relative flex size-1.5 self-center">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 motion-safe:animate-ping" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-success" />
                  </span>
                ) : null}
                {statusLabel}
              </span>
            ) : null}
            {usageSummary ? (
              <span
                className="ml-auto shrink-0 font-mono text-[10px] leading-4 tabular-nums text-muted-foreground/90"
                data-testid="ticket-usage-summary"
              >
                {usageSummary}
              </span>
            ) : null}
            {ticket.pr !== undefined ? (
              <span
                className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px] leading-4 tabular-nums text-muted-foreground/90"
                data-testid="ticket-pr-chip"
              >
                <span
                  className={cn(
                    "inline-block size-1.5 rounded-full",
                    ticket.pr.state === "merged"
                      ? "bg-muted-foreground/50"
                      : ticket.pr.state === "closed"
                        ? "bg-muted-foreground/40"
                        : ticket.pr.ciState === "failure"
                          ? "bg-destructive"
                          : ticket.pr.ciState === "success"
                            ? "bg-success"
                            : "bg-muted-foreground/40",
                  )}
                />
                #{ticket.pr.number}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>

      {/* Action zone: a sibling of the open target (never nested), so a click
          here can never bubble into onOpen or the drag listeners. */}
      {parked !== undefined ? (
        parkActions !== undefined && primaryAction !== undefined ? (
          <div
            className="flex items-center gap-1.5 px-3 pb-2.5"
            data-testid="ticket-actions"
            onClick={stopEvent}
            onPointerDown={stopEvent}
          >
            <Button
              size="xs"
              variant="secondary"
              disabled={actionsDisabled}
              onClick={() => runAction(primaryAction.index)}
              {...(primaryAction.action.hint !== undefined
                ? { title: primaryAction.action.hint }
                : {})}
            >
              {primaryAction.action.label}
            </Button>
            {overflowActions.length > 0 ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      disabled={actionsDisabled}
                      aria-label="More recovery actions"
                      data-testid="ticket-actions-overflow"
                    />
                  }
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end">
                  {overflowActions.map(({ action, index }) => (
                    <MenuItem
                      key={action.to + index}
                      onClick={() => runAction(index)}
                      {...(action.hint !== undefined ? { title: action.hint } : {})}
                    >
                      {action.label}
                    </MenuItem>
                  ))}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        ) : (
          <p
            className="px-3 pb-2.5 text-[11px] leading-4 text-muted-foreground"
            data-testid="ticket-actions-unavailable"
          >
            Actions unavailable — board changed. Open the ticket to recover.
          </p>
        )
      ) : null}

      {/* Processing bar: a thin sweeping gradient pinned to the bottom edge.
          Reduced-motion users keep a static gradient (still a "working" cue)
          via motion-safe. */}
      {isProcessing ? (
        <span
          aria-hidden="true"
          data-testid="ticket-processing-bar"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden rounded-b-md motion-safe:animate-skeleton [background:linear-gradient(90deg,transparent_0%,var(--color-success)_50%,transparent_100%)_0_0/200%_100%]"
        />
      ) : null}
    </div>
  );
}
