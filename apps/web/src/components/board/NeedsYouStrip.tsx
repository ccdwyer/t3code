import { MoreHorizontalIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";
import { ticketAging } from "~/workflow/agingFormat";
import { useNowTick } from "~/workflow/useNowTick";

import { dispatchParkAction, splitParkActions, ticketTier } from "./TicketCard";

import type { BoardViewTicket } from "./BoardView";

type NeedsYouTicket = Pick<
  BoardViewTicket,
  "ticketId" | "title" | "status" | "updatedAt" | "parked"
>;

export interface NeedsYouStripProps {
  readonly tickets: ReadonlyArray<BoardViewTicket>;
  readonly onOpen: (id: string) => void;
  readonly onParkAction: (
    ticketId: string,
    actionIndex: number,
    parkedEventId: string,
  ) => Promise<void>;
}

/** Oldest-first sort key: a parked ticket's own park timestamp, a
 *  `waiting_on_user` ticket's last update. Missing/unparseable timestamps
 *  sort last within their tier rather than falsely claiming to be oldest. */
const attentionTimestamp = (ticket: NeedsYouTicket): number => {
  const raw = ticket.parked?.parkedAt ?? ticket.updatedAt;
  const parsed = raw === undefined ? NaN : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

const tierOrder: Record<"issue" | "waiting", number> = { issue: 0, waiting: 1 };

/**
 * Selects and orders the tickets the strip pins: issue-tier parks first,
 * then waiting (parked-waiting and agent questions), oldest first within
 * each tier. Exported so ordering can be unit-tested without a render.
 */
export function selectNeedsYouTickets(
  tickets: ReadonlyArray<NeedsYouTicket>,
): ReadonlyArray<NeedsYouTicket> {
  return tickets
    .filter((ticket) => ticket.status === "parked" || ticket.status === "waiting_on_user")
    .slice()
    .sort((a, b) => {
      const tierDelta =
        tierOrder[ticketTier(a) as "issue" | "waiting"] -
        tierOrder[ticketTier(b) as "issue" | "waiting"];
      if (tierDelta !== 0) {
        return tierDelta;
      }
      return attentionTimestamp(a) - attentionTimestamp(b);
    });
}

/**
 * Theo's "attention tiers" rail: parked and waiting tickets pinned above the
 * board so they're never lost in a lane. Pure presentation — no data
 * fetching; the caller feeds it the current board state and wires
 * open/park-action callbacks through to the same RPCs as the card and
 * drawer. Renders nothing when no ticket needs attention (v1 has no
 * collapse toggle — empty means absent).
 */
export function NeedsYouStrip({ tickets, onOpen, onParkAction }: NeedsYouStripProps) {
  const now = useNowTick(60_000);
  const entries = selectNeedsYouTickets(tickets);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div
      className="shrink-0 border-b border-border bg-muted/10 px-4 pb-2 pt-2"
      data-testid="needs-you-strip"
    >
      <div className="flex items-center gap-1.5 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        <span>Needs you</span>
        <span data-testid="needs-you-count">· {entries.length}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {entries.map((ticket) => (
          <NeedsYouEntry
            key={ticket.ticketId}
            ticket={ticket}
            now={now}
            onOpen={onOpen}
            onParkAction={onParkAction}
          />
        ))}
      </ul>
    </div>
  );
}

function NeedsYouEntry({
  ticket,
  now,
  onOpen,
  onParkAction,
}: {
  readonly ticket: NeedsYouTicket;
  readonly now: number;
  readonly onOpen: (id: string) => void;
  readonly onParkAction: (
    ticketId: string,
    actionIndex: number,
    parkedEventId: string,
  ) => Promise<void>;
}) {
  const tier = ticketTier(ticket);
  const aging = ticketAging(ticket, now);
  const parked = ticket.parked;
  const parkActions = parked?.actions;
  const { primary, overflow } =
    parkActions !== undefined
      ? splitParkActions(parkActions)
      : { primary: undefined, overflow: [] };

  const inFlightRef = useRef(false);
  const [pending, setPending] = useState(false);
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

  // Keeps an action click from also opening the drawer — the action zone
  // sits inline with (not nested in) the open target.
  const stopEvent = (event: { stopPropagation: () => void }): void => {
    event.stopPropagation();
  };

  const label = parked !== undefined ? parked.label : "waiting on you";
  const reason = parked !== undefined ? parked.reason : null;

  return (
    <li
      className="flex items-center gap-2 rounded-md border border-border/70 bg-card px-2 py-1.5 text-xs"
      data-testid="needs-you-entry"
      data-tier={tier}
    >
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full", tier === "issue" ? "bg-warning" : "bg-info")}
      />
      <button
        type="button"
        className="shrink-0 truncate text-left font-medium hover:underline"
        onClick={() => onOpen(ticket.ticketId)}
        data-testid="needs-you-open"
      >
        {ticket.title}
      </button>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" data-testid="needs-you-label">
        {label}
        {reason ? ` — ${reason}` : ""}
      </span>
      {aging !== null ? (
        <span
          className="shrink-0 tabular-nums text-muted-foreground/80"
          data-testid="needs-you-age"
        >
          {aging.durationLabel}
        </span>
      ) : null}
      {parked !== undefined ? (
        parkActions !== undefined && primary !== undefined ? (
          <div
            className="flex shrink-0 items-center gap-1"
            data-testid="needs-you-actions"
            onClick={stopEvent}
            onPointerDown={stopEvent}
          >
            <Button
              size="xs"
              variant="secondary"
              disabled={pending}
              onClick={() => runAction(primary.index)}
              {...(primary.action.hint !== undefined ? { title: primary.action.hint } : {})}
            >
              {primary.action.label}
            </Button>
            {overflow.length > 0 ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      disabled={pending}
                      aria-label="More recovery actions"
                      data-testid="needs-you-actions-overflow"
                    />
                  }
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end">
                  {overflow.map(({ action, index }) => (
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
          <span
            className="shrink-0 text-[11px] text-muted-foreground"
            data-testid="needs-you-actions-unavailable"
          >
            Actions unavailable — board changed. Open the ticket to recover.
          </span>
        )
      ) : null}
    </li>
  );
}
