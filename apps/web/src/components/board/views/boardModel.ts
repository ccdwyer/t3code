import type { BoardViewState, BoardViewTicket } from "../BoardView";
import type { LaneColumnView } from "../LaneColumn";

/**
 * The vocabulary both redesigned board views sort and colour by.
 *
 * Derived from what the server already sends. The design prototypes these views
 * came from ran on a richer fixture (agent monograms, per-step progress, token
 * budgets, activity feeds); anything the real `BoardTicketView` does not carry
 * is omitted rather than approximated, so nothing on screen is invented.
 */
export type Tier = "issue" | "waiting" | "running" | "queued" | "settled";

export const tierOf = (ticket: BoardViewTicket): Tier => {
  if (ticket.parked?.substate === "issue") return "issue";
  if (ticket.parked?.substate === "waiting" || ticket.status === "waiting_on_user")
    return "waiting";
  if (ticket.status === "running") return "running";
  if (ticket.status === "queued" || ticket.status === "idle") return "queued";
  if (ticket.status === "blocked" || ticket.status === "failed") return "issue";
  return "settled";
};

/**
 * Mapped onto the app's existing semantic colours rather than a parallel
 * palette, so both views inherit light/dark theming with no new tokens.
 */
export const TIER_COLOR: Record<Tier, string> = {
  issue: "var(--color-destructive)",
  waiting: "var(--color-warning)",
  running: "var(--color-success)",
  queued: "var(--color-muted-foreground)",
  settled: "var(--color-muted-foreground)",
};

export const TIER_LABEL: Record<Tier, string> = {
  issue: "blocked",
  waiting: "needs you",
  running: "working",
  queued: "queued",
  settled: "done",
};

/** Worst first — the order a triage list wants. */
export const TIER_RANK: Record<Tier, number> = {
  issue: 0,
  waiting: 1,
  running: 2,
  queued: 3,
  settled: 4,
};

/** A compact age from an ISO timestamp, e.g. "4m", "2h", "3d". */
export const ageFrom = (iso: string | undefined, now: number): string => {
  if (iso === undefined) return "—";
  const started = Date.parse(iso);
  if (Number.isNaN(started)) return "—";
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.round(hours / 24))}d`;
};

export const formatTokens = (n: number | undefined): string | undefined => {
  if (n === undefined || n <= 0) return undefined;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${String(Math.round(n / 1_000))}k`;
  return String(n);
};

/**
 * A stable hue per lane, derived from its key.
 *
 * The prototypes carried an authored hue on every lane; real lanes have no
 * colour, so it is hashed from the key instead — stable across reloads and
 * across clients, which is what matters for using colour to find a column.
 */
export const laneHue = (laneKey: string): number => {
  let hash = 0;
  for (let i = 0; i < laneKey.length; i += 1) {
    hash = (hash * 31 + laneKey.charCodeAt(i)) % 360;
  }
  return hash;
};

export const laneColor = (laneKey: string, l = 62, c = 0.14): string =>
  `oklch(${String(l)}% ${String(c)} ${String(laneHue(laneKey))})`;

export interface LaneModel {
  readonly lane: LaneColumnView;
  readonly tickets: ReadonlyArray<BoardViewTicket>;
  readonly admitted: number;
  readonly needsYou: number;
  /** Blocked (issue tier) count — the red half of the collapsed spine's dots. */
  readonly issues: number;
  /** "Needs you" (waiting tier) count — the amber half of those dots. */
  readonly waiting: number;
  /**
   * This lane's share of the busiest lane's ticket count, 0–1.
   *
   * Relative rather than absolute, because the only question a folded lane has
   * to answer is "is the work piling up *here*" — and a bar that filled against
   * some fixed ceiling would read as empty on every real board.
   */
  readonly density: number;
}

const ticketsFor = (
  state: BoardViewState,
  ids: ReadonlyArray<string>,
): ReadonlyArray<BoardViewTicket> =>
  ids
    .map((id) => state.ticketById[id])
    .filter((ticket): ticket is BoardViewTicket => ticket !== undefined);

/**
 * Lanes with their tickets in a stable order.
 *
 * Ordered by ticket id within a lane rather than by urgency: re-ranking a
 * column under a moving cursor is the thing that made the original prototypes
 * hard to use. Cross-lane movement still shows, because that reflects a real
 * state change rather than a re-sort.
 */
export const laneModels = (state: BoardViewState): ReadonlyArray<LaneModel> => {
  const counted = state.lanes.map((lane) => {
    const tickets = [
      ...ticketsFor(state, lane.admittedTicketIds),
      ...ticketsFor(state, lane.queuedTicketIds),
    ].sort((a, b) => a.ticketId.localeCompare(b.ticketId));
    const countOf = (tier: Tier): number => tickets.filter((t) => tierOf(t) === tier).length;
    const issues = countOf("issue");
    const waiting = countOf("waiting");
    return {
      lane,
      tickets,
      admitted: lane.admittedTicketIds.length,
      needsYou: issues + waiting,
      issues,
      waiting,
    };
  });
  // Divide by the busiest lane, never by zero: an all-empty board leaves every
  // bar at 0 rather than filling them all to 100%.
  const busiest = Math.max(1, ...counted.map((c) => c.tickets.length));
  return counted.map((c) => ({ ...c, density: c.tickets.length / busiest }));
};

export interface TicketOption {
  readonly label: string;
  readonly run: () => void;
}

/**
 * The numbered actions a selected ticket offers.
 *
 * Only ever park-recovery actions the server actually resolved: when `actions`
 * is absent the board definition changed under the park and there is nothing
 * safe to offer, so the list is empty rather than guessed.
 */
export const optionsFor = (
  ticket: BoardViewTicket | undefined,
  onParkAction: ((ticketId: string, index: number, parkedEventId: string) => void) | undefined,
): ReadonlyArray<TicketOption> => {
  // Park actions only bind while the ticket is ACTUALLY parked.
  //
  // A park and an open agent-question wait can coexist — the projection handles
  // a StepAwaitingUser landing on a parked row explicitly — so "has parked
  // details" is not enough on its own. Requiring the live status keeps the
  // digits owned by exactly one of the two: parked tickets get park actions,
  // and everything else leaves the digits free for a question form.
  if (ticket?.status !== "parked") return [];
  if (ticket.parked === undefined || onParkAction === undefined) return [];
  const parked = ticket.parked;
  return (parked.actions ?? []).map((action, index) => ({
    label: action.label,
    run: () => {
      onParkAction(ticket.ticketId, index, parked.parkedEventId);
    },
  }));
};
