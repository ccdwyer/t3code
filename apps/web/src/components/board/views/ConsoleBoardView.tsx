import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { visibleStuckDiagnosis, type CardUnstickAction } from "~/workflow/stuckDiagnosisView";
import type { BoardViewState, BoardViewTicket } from "../BoardView";
import {
  TIER_COLOR,
  TIER_LABEL,
  TIER_RANK,
  ageFrom,
  formatTokens,
  laneColor,
  optionsFor,
  tierOf,
} from "./boardModel";
import { KeyLegend, useBoardKeys, useScrollIntoView, useStableOrder } from "./keys";

/**
 * CONSOLE — the board as a triage inbox: one ranked queue of everything, and a
 * subject pane for whatever the cursor is on.
 *
 * The queue you see is a FROZEN snapshot. The live urgency ranking keeps
 * churning underneath — agents park, SLAs breach, work finishes — but the
 * visible order never rearranges itself while your cursor is in it. New
 * arrivals append at the bottom rather than displacing anything above,
 * departures vanish in place, and a banner reports how far the frozen view has
 * drifted from the live ranking. `u` re-sorts, once, deliberately.
 *
 * Rows are dense on purpose: lane, state, age, step and CI are all readable
 * without opening anything.
 */
export function ConsoleBoardView({
  state,
  onOpen,
  onParkAction,
  onUnstickAction,
  pendingParkActionTicketIds,
  renderTicketDetail,
}: {
  readonly state: BoardViewState;
  readonly onOpen: (id: string) => void;
  readonly onParkAction?:
    | ((ticketId: string, actionIndex: number, parkedEventId: string) => Promise<void>)
    | undefined;
  readonly onUnstickAction?: ((ticketId: string, action: CardUnstickAction) => void) | undefined;
  readonly pendingParkActionTicketIds?: ReadonlySet<string> | undefined;
  readonly renderTicketDetail?: ((ticketId: string) => ReactNode) | undefined;
}) {
  const now = Date.now();
  const laneName = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const lane of state.lanes) byKey.set(lane.key, lane.name);
    return byKey;
  }, [state.lanes]);

  /** The live ranking — recomputed constantly, and deliberately not rendered. */
  const liveOrder = useMemo(
    () =>
      state.ticketIds
        .map((id) => state.ticketById[id])
        .filter((ticket): ticket is BoardViewTicket => ticket !== undefined)
        .sort(
          (a, b) =>
            TIER_RANK[tierOf(a)] - TIER_RANK[tierOf(b)] ||
            Number(b.slaBreachedAt !== undefined) - Number(a.slaBreachedAt !== undefined) ||
            (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""),
        )
        .map((ticket) => ticket.ticketId),
    [state.ticketById, state.ticketIds],
  );

  const { order, drift, resync } = useStableOrder(liveOrder);
  const rows = useMemo(
    () =>
      order
        .map((id) => state.ticketById[id])
        .filter((ticket): ticket is BoardViewTicket => ticket !== undefined),
    [order, state.ticketById],
  );

  /**
   * Selection follows the TICKET, not the row number.
   *
   * The subject pane is always showing the selected row, so a positional cursor
   * would swap the pane's subject whenever the selected ticket left the queue or
   * changed rank — most visibly when you advance a ticket from the pane itself.
   */
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [index, setIndex] = useState(0);
  const trackedIndex =
    selectedId === undefined ? -1 : rows.findIndex((t) => t.ticketId === selectedId);
  const safeIndex =
    trackedIndex >= 0 ? trackedIndex : Math.min(index, Math.max(0, rows.length - 1));
  const selected = rows[safeIndex];

  const selectRow = useCallback(
    (next: number) => {
      setIndex(next);
      setSelectedId(rows[next]?.ticketId);
    },
    [rows],
  );

  const runParkAction = useCallback(
    (ticketId: string, actionIndex: number, parkedEventId: string) => {
      void onParkAction?.(ticketId, actionIndex, parkedEventId);
    },
    [onParkAction],
  );
  // openDependency travels the VIEW's own selection path — the subject pane
  // follows selectedId, so only moving the route's selection would leave the
  // pane on its old subject.
  const runUnstickAction = useCallback(
    (ticketId: string, action: CardUnstickAction) => {
      if (action.type === "openDependency") {
        setSelectedId(action.ticketId);
        onOpen(action.ticketId);
        return;
      }
      onUnstickAction?.(ticketId, action);
    },
    [onOpen, onUnstickAction],
  );
  const options = useMemo(
    () =>
      optionsFor(
        selected,
        onParkAction === undefined ? undefined : runParkAction,
        onUnstickAction === undefined ? undefined : { now, run: runUnstickAction },
      ),
    [now, onParkAction, onUnstickAction, runParkAction, runUnstickAction, selected],
  );

  /**
   * The subject pane shows the SELECTED row's full detail, so moving the cursor
   * has to tell the host which ticket to load. Debounced because holding `j`
   * would otherwise fire a request per row; 120ms is below the point the pane
   * feels laggy but above a fast key repeat.
   */
  const visibleId = selected?.ticketId;
  useEffect(() => {
    if (visibleId === undefined) return;
    const timer = window.setTimeout(() => {
      onOpen(visibleId);
    }, 120);
    return () => {
      window.clearTimeout(timer);
    };
  }, [onOpen, visibleId]);

  useBoardKeys({
    onMove: (_dCol, dRow) => {
      if (dRow !== 0)
        selectRow(Math.min(Math.max(0, safeIndex + dRow), Math.max(0, rows.length - 1)));
    },
    onOpen: () => {
      if (selected !== undefined) onOpen(selected.ticketId);
    },
    onOption: (i) => options[i]?.run(),
    onRefresh: resync,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-4 pt-2 pb-1">
        <KeyLegend
          items={[
            { keys: ["j", "k"], label: "move" },
            { keys: ["1-5"], label: "act" },
            { keys: ["↵"], label: "open" },
            { keys: ["u"], label: "re-sort" },
          ]}
        />
        {drift > 0 ? (
          <button
            type="button"
            onClick={resync}
            className="ml-auto rounded border border-warning/50 bg-warning/10 px-2 py-0.5 text-2xs text-warning"
            title="The live ranking has moved on; press u to re-sort"
          >
            {drift} {drift === 1 ? "row" : "rows"} out of order — re-sort
          </button>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 gap-3 px-4 pb-3">
        <div className="min-h-0 w-[26rem] shrink-0 divide-y divide-border/40 overflow-y-auto rounded-md border border-border/60 bg-muted/20">
          {rows.length === 0 ? (
            <p className="px-3 py-4 text-2xs text-muted-foreground">Nothing on this board yet.</p>
          ) : (
            rows.map((ticket, rowIndex) => (
              <ConsoleRow
                key={ticket.ticketId}
                ticket={ticket}
                now={now}
                laneName={laneName.get(ticket.currentLaneKey) ?? ticket.currentLaneKey}
                selected={rowIndex === safeIndex}
                onSelect={() => {
                  selectRow(rowIndex);
                }}
                onOpen={() => {
                  onOpen(ticket.ticketId);
                }}
              />
            ))
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border/60">
          {selected === undefined ? (
            <p className="text-2xs text-muted-foreground">Nothing selected.</p>
          ) : (
            <ConsoleSubject
              ticket={selected}
              options={options}
              pending={pendingParkActionTicketIds?.has(selected.ticketId) === true}
              renderTicketDetail={renderTicketDetail}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ConsoleRow({
  ticket,
  now,
  laneName,
  selected,
  onSelect,
  onOpen,
}: {
  readonly ticket: BoardViewTicket;
  readonly now: number;
  readonly laneName: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
}) {
  const tier = tierOf(ticket);
  const ref = useScrollIntoView(selected);
  // Parked rows already carry their park state through the tier chip (even
  // when re-resolved actions are absent), so gate on STATUS, matching
  // cardUnstickActions.
  const diagnosis =
    ticket.status === "parked" ? null : visibleStuckDiagnosis(ticket.diagnosis, now);

  return (
    <article
      ref={ref}
      onMouseEnter={onSelect}
      onClick={onOpen}
      data-selected={selected}
      data-ticket-id={ticket.ticketId}
      style={selected ? { borderLeftColor: TIER_COLOR[tier] } : undefined}
      className={cn(
        "cursor-pointer border-l-2 px-2.5 py-1.5 transition-colors",
        // A queue row is a surface too: the left edge carries the tier so a row
        // is placeable at a glance, and selection lifts rather than being the
        // only thing that makes the row visible.
        selected
          ? "bg-accent"
          : "border-l-transparent bg-card hover:border-l-border hover:bg-muted/50",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "shrink-0 rounded-[2px] px-1 font-mono text-[9px] tracking-[0.08em] uppercase",
            selected ? "font-semibold text-background" : "",
          )}
          style={selected ? { background: TIER_COLOR[tier] } : { color: TIER_COLOR[tier] }}
        >
          {TIER_LABEL[tier]}
        </span>
        <p
          className={cn(
            "min-w-0 flex-1 truncate text-xs text-foreground",
            selected ? "font-medium" : "",
          )}
        >
          {ticket.title}
        </p>
        {ticket.slaBreachedAt !== undefined ? (
          <span className="shrink-0 font-mono text-[9px]" style={{ color: TIER_COLOR.issue }}>
            SLA
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-[9px] text-muted-foreground/70">
          {ageFrom(ticket.updatedAt, now)}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-1 text-[10px] text-muted-foreground/70">
        <span
          className="inline-block size-1.5 shrink-0 rounded-full"
          style={{ background: laneColor(ticket.currentLaneKey) }}
        />
        <span className="truncate">{laneName}</span>
        {ticket.currentStepLabel !== undefined ? (
          <span className="truncate">· {ticket.currentStepLabel}</span>
        ) : null}
        {ticket.pr !== undefined ? (
          <span
            className={cn(
              "ml-auto shrink-0 font-mono",
              ticket.pr.ciState === "failure"
                ? "text-destructive"
                : ticket.pr.ciState === "success"
                  ? "text-success"
                  : "",
            )}
          >
            #{ticket.pr.number}
          </span>
        ) : null}
      </div>
      {diagnosis !== null ? (
        <p
          className="mt-0.5 truncate pl-1 text-[10px]"
          style={{ color: TIER_COLOR[tier] }}
          title={diagnosis.detail ?? diagnosis.summary}
          data-testid="console-diagnosis"
        >
          {diagnosis.summary} · {ageFrom(diagnosis.since, now)}
        </p>
      ) : null}
    </article>
  );
}

/**
 * The subject pane.
 *
 * It HOSTS the real ticket drawer rather than summarising it, so everything the
 * ticket has is here — discussion, steps, history, checkpoint forms. The strip
 * above it carries only what the pane adds: the numbered recovery actions the
 * keyboard fires, which the drawer has no notion of.
 */
function ConsoleSubject({
  ticket,
  options,
  pending,
  renderTicketDetail,
}: {
  readonly ticket: BoardViewTicket;
  readonly options: ReadonlyArray<{ readonly label: string; readonly run: () => void }>;
  readonly pending: boolean;
  readonly renderTicketDetail?: ((ticketId: string) => ReactNode) | undefined;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {options.length > 0 ? (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-border/60 bg-muted/20 px-3 py-1.5">
          {options.map((option, index) => (
            <button
              key={option.label}
              type="button"
              disabled={pending}
              onClick={option.run}
              className="rounded border border-border/70 px-2 py-0.5 text-2xs hover:bg-muted disabled:opacity-50"
            >
              <span className="mr-1 font-mono text-muted-foreground">{index + 1}</span>
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {renderTicketDetail === undefined ? (
          <p className="p-3 text-2xs text-muted-foreground">
            Ticket detail is unavailable in this context.
          </p>
        ) : (
          renderTicketDetail(ticket.ticketId)
        )}
      </div>
    </div>
  );
}
