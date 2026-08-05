import type { WorkflowNeedsAttentionTicketView } from "@t3tools/contracts";
import { BellIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { ageFrom } from "~/components/board/views/boardModel";
import { useNowTick } from "~/workflow/useNowTick";
import { attentionKindToneClass } from "~/workflow/workflowSidebarStatus";

/** Keep the sidebar bounded — everything is one click away on its board. */
const MAX_VISIBLE_TICKETS = 12;

/**
 * The cross-board Needs You inbox at the top of the Workflows sidebar.
 *
 * Board rows already carry per-board attention pills; this is the aggregate:
 * one place that answers "what, across every board, is waiting on me right
 * now" without visiting each board. Collapsed by default — the count is the
 * signal; the list is on demand.
 */
export function WorkflowSidebarNeedsYou({
  tickets,
  onOpenTicket,
}: {
  /** Inbox-sorted (urgency, then longest-waiting) — see sortNeedsAttentionTickets. */
  readonly tickets: ReadonlyArray<WorkflowNeedsAttentionTicketView>;
  readonly onOpenTicket: (ticket: WorkflowNeedsAttentionTicketView) => void;
}) {
  const [open, setOpen] = useState(false);

  if (tickets.length === 0) {
    return null;
  }

  const visible = tickets.slice(0, MAX_VISIBLE_TICKETS);
  const hiddenCount = tickets.length - visible.length;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

  return (
    <section data-testid="sidebar-v2-needs-you" className="mb-1">
      <button
        type="button"
        data-testid="sidebar-v2-needs-you-toggle"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sidebar-foreground outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring/35"
      >
        <BellIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Needs you</span>
        <span
          data-testid="sidebar-v2-needs-you-count"
          className="shrink-0 rounded-full bg-sidebar-row-active px-1.5 text-[11px] font-semibold tabular-nums"
        >
          {tickets.length}
        </span>
        <Chevron className="size-3.5 shrink-0 text-sidebar-muted-foreground/70" />
      </button>

      {open ? (
        <NeedsYouTicketList
          visible={visible}
          hiddenCount={hiddenCount}
          onOpenTicket={onOpenTicket}
        />
      ) : null}
    </section>
  );
}

/**
 * Split out so the minute tick only exists while the list is actually open —
 * the collapsed header renders no ages and should not re-render on a timer.
 */
function NeedsYouTicketList({
  visible,
  hiddenCount,
  onOpenTicket,
}: {
  readonly visible: ReadonlyArray<WorkflowNeedsAttentionTicketView>;
  readonly hiddenCount: number;
  readonly onOpenTicket: (ticket: WorkflowNeedsAttentionTicketView) => void;
}) {
  const now = useNowTick(60_000);
  return (
    <ul role="list" data-testid="sidebar-v2-needs-you-list" className="mt-0.5 flex flex-col">
      {visible.map((ticket) => (
        <li key={`${ticket.boardId}:${ticket.ticketId}`}>
          <button
            type="button"
            data-testid={`sidebar-v2-needs-you-ticket-${ticket.ticketId}`}
            onClick={() => {
              onOpenTicket(ticket);
            }}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md py-1 pr-2.5 pl-4 text-left outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring/35"
            title={ticket.attentionReason ?? undefined}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-2 shrink-0 rounded-full border-2",
                attentionKindToneClass(ticket.attentionKind),
              )}
            />
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-[13px] text-sidebar-foreground/90">
                {ticket.title}
              </span>
              <span className="truncate text-[11px] text-sidebar-muted-foreground/70">
                {ticket.boardName}
              </span>
            </span>
            <span className="shrink-0 font-mono text-[10px] text-sidebar-muted-foreground/70">
              {ageFrom(ticket.parkedAt ?? ticket.updatedAt, now)}
            </span>
          </button>
        </li>
      ))}
      {hiddenCount > 0 ? (
        <li
          className="py-1 pr-2.5 pl-8 text-[11px] text-sidebar-muted-foreground/70"
          data-testid="sidebar-v2-needs-you-overflow"
        >
          …and {hiddenCount} more on their boards
        </li>
      ) : null}
    </ul>
  );
}
