import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { cn } from "~/lib/utils";

import { TicketCard, type TicketCardView } from "./TicketCard";

export interface LaneColumnView {
  readonly key: string;
  readonly name: string;
  readonly entry: string;
  readonly pipelineStepCount: number;
  readonly wipLimit?: number | undefined;
  readonly terminal?: boolean | undefined;
  // Rendered in-lane, in stable order — includes parked tickets (a parked
  // ticket holds no admission token server-side, so it must not count
  // toward WIP; see `parkedTicketIds`, a subset of this array).
  readonly admittedTicketIds: ReadonlyArray<string>;
  readonly queuedTicketIds: ReadonlyArray<string>;
  readonly parkedTicketIds: ReadonlyArray<string>;
}

export function LaneColumn({
  lane,
  admittedTickets,
  queuedTickets,
  onOpen,
  onParkAction,
  pendingParkActionTicketIds,
}: {
  readonly lane: LaneColumnView;
  readonly admittedTickets: ReadonlyArray<TicketCardView>;
  readonly queuedTickets: ReadonlyArray<TicketCardView>;
  readonly onOpen: (id: string) => void;
  readonly onParkAction?:
    | ((ticketId: string, actionIndex: number, parkedEventId: string) => Promise<void>)
    | undefined;
  // Tickets whose park action is in flight (from any surface) — each card
  // derives its own shared-disable flag from this set.
  readonly pendingParkActionTicketIds?: ReadonlySet<string> | undefined;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `lane:${lane.key}` });
  const tickets = [...admittedTickets, ...queuedTickets];
  // Parked tickets render inline with the admitted list (no admission token
  // to lose), but hold no WIP slot — subtract them from the header count.
  const admittedCountForWip = admittedTickets.length - lane.parkedTicketIds.length;
  const headerCount =
    lane.wipLimit === undefined
      ? String(tickets.length)
      : `${admittedCountForWip}/${lane.wipLimit}`;

  return (
    <section ref={setNodeRef} className="flex w-72 shrink-0 flex-col" aria-label={lane.name}>
      <header className="flex min-h-6 items-baseline gap-1.5 px-1.5 pb-1.5">
        <h2 className="truncate text-[13px] font-semibold text-foreground">{lane.name}</h2>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{headerCount}</span>
        {lane.wipLimit !== undefined && queuedTickets.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground/80">
            +{queuedTickets.length} queued
          </span>
        ) : null}
        {lane.entry === "auto" ? (
          <span className="ml-auto shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            auto
          </span>
        ) : null}
      </header>
      <SortableContext
        items={tickets.map((ticket) => ticket.ticketId)}
        strategy={verticalListSortingStrategy}
      >
        <div
          className={cn(
            "flex min-h-16 flex-1 flex-col gap-2 rounded-lg p-1.5 transition-colors",
            isOver ? "bg-primary/4 ring-1 ring-primary/35" : "bg-muted/75",
          )}
        >
          {admittedTickets.map((ticket) => (
            <TicketCard
              key={ticket.ticketId}
              ticket={ticket}
              onOpen={onOpen}
              onParkAction={onParkAction}
              parkActionPending={pendingParkActionTicketIds?.has(ticket.ticketId) ?? false}
            />
          ))}
          {queuedTickets.length > 0 ? (
            <div className="mt-1 border-t border-border/70 pt-2">
              <div className="px-1.5 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Queued
              </div>
              <div className="flex flex-col gap-2">
                {queuedTickets.map((ticket) => (
                  <TicketCard
                    key={ticket.ticketId}
                    ticket={ticket}
                    onOpen={onOpen}
                    onParkAction={onParkAction}
                    parkActionPending={pendingParkActionTicketIds?.has(ticket.ticketId) ?? false}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </SortableContext>
    </section>
  );
}
