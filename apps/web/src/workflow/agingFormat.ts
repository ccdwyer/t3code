import { formatDuration } from "~/session-logic";

const WARN_AFTER_MS = 30 * 60 * 1000;
const ALERT_AFTER_MS = 2 * 60 * 60 * 1000;

export interface TicketAging {
  readonly level: "warn" | "alert";
  /** Full nag ("needs you · 45m") — verb plus elapsed time. */
  readonly label: string;
  /** Just the elapsed-time portion, so a parked card can pair it with its own
   *  park label instead of the generic verb. */
  readonly durationLabel: string;
}

/**
 * "The board nags you": tickets stuck waiting on a human (or blocked, or
 * parked) for long enough get a visible age. Warn after 30 minutes, alert
 * after 2 hours. Parked tickets escalate here too — a park is a human-facing
 * pause, so its clock runs the same way, keyed off the parked substate.
 */
export const ticketAging = (
  ticket: {
    readonly status: string;
    readonly updatedAt?: string | undefined;
    readonly parked?: { readonly substate: "issue" | "waiting" } | undefined;
  },
  nowMs: number,
): TicketAging | null => {
  if (
    ticket.status !== "waiting_on_user" &&
    ticket.status !== "blocked" &&
    ticket.status !== "parked"
  ) {
    return null;
  }
  if (ticket.updatedAt === undefined) {
    return null;
  }
  const since = Date.parse(ticket.updatedAt);
  if (!Number.isFinite(since)) {
    return null;
  }
  const ageMs = nowMs - since;
  if (ageMs < WARN_AFTER_MS) {
    return null;
  }
  const verb =
    ticket.status === "blocked"
      ? "blocked"
      : ticket.status === "parked" && ticket.parked?.substate === "issue"
        ? "issue"
        : "needs you";
  const durationLabel = formatDuration(ageMs);
  return {
    level: ageMs >= ALERT_AFTER_MS ? "alert" : "warn",
    label: `${verb} · ${durationLabel}`,
    durationLabel,
  };
};

export const countNeedsAttention = (
  tickets: ReadonlyArray<{ readonly status: string; readonly updatedAt?: string | undefined }>,
  nowMs: number,
): number => tickets.filter((ticket) => ticketAging(ticket, nowMs) !== null).length;
