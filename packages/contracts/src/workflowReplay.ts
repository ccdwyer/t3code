import type { LaneKey, TicketStatus, WorkflowEvent } from "./workflow.ts";

/**
 * Ticket state reduced from an event prefix — "what did this ticket look like as
 * of event N?".
 *
 * ONE implementation shared by the server (the truncated-timeline `base`, and
 * the fork path's as-of lane) and the web replay model. Two reducers would drift,
 * and the drift would show up as a fork entering a different lane than the
 * replay UI just told the user it would.
 */
export interface ReplayTicketState {
  readonly laneKey: LaneKey;
  readonly title: string;
  readonly description?: string | undefined;
  readonly tokenBudget?: number | undefined;
  readonly status: TicketStatus;
  /**
   * When the ticket entered a terminal lane, separate from `status`.
   *
   * The projection does NOT move a ticket to a terminal status on terminal-lane
   * entry — it keeps `idle` and stamps `terminal_at`. Exposing this as its own
   * field is what lets the reducer avoid an `isTerminalLane` predicate (which
   * would need the board definition) and still agree with the live board.
   */
  readonly terminalAt?: string | undefined;
  /** The state reflects every event at or below this per-ticket version. */
  readonly asOfStreamVersion: number;
  readonly occurredAt: string;
}

/**
 * Statuses the projection treats as "parked", where later lifecycle events are
 * ignored until an explicit unpark. Mirrors the projection's parked guards.
 */
const isParked = (status: TicketStatus): boolean => status === "parked";

/**
 * Fold one event into the state.
 *
 * The status transitions below are copied from
 * `apps/server/src/workflow/Layers/WorkflowProjectionPipeline.ts`, taking the
 * projection as the authority. Three cases differ from an intuitive reading and
 * are deliberate, because the projection does not touch `projection_ticket.status`
 * for them:
 *
 *  - `StepStarted` sets only `current_step_label`. The ticket is already
 *    `running` from `PipelineStarted`.
 *  - `StepFailed` / `StepCompleted` / `StepBlocked` write to
 *    `projection_step_run`, not the ticket. A failed step leaves the ticket
 *    `running` until the engine emits `TicketBlocked` or routes it.
 *  - `TicketRouted` (legacy) moves the lane and stamps `terminal_at` but leaves
 *    status alone.
 *
 * Getting any of these wrong would make a replayed card disagree with the live
 * board for the same event.
 */
export const applyReplayEvent = (
  state: ReplayTicketState | null,
  event: WorkflowEvent,
): ReplayTicketState | null => {
  if (event.type === "TicketCreated") {
    return {
      laneKey: event.payload.laneKey,
      title: event.payload.title,
      ...(event.payload.description === undefined
        ? {}
        : { description: event.payload.description }),
      ...(event.payload.tokenBudget === undefined
        ? {}
        : { tokenBudget: event.payload.tokenBudget }),
      status: "idle" as TicketStatus,
      asOfStreamVersion: event.streamVersion,
      occurredAt: event.occurredAt,
    };
  }
  if (state === null) {
    // An event before TicketCreated cannot be folded. Callers always start from
    // a ticket's stream head or a server-computed base, so this means a partial
    // stream rather than a bug worth throwing over.
    return null;
  }

  const advance = (next: Partial<ReplayTicketState>): ReplayTicketState => ({
    ...state,
    ...next,
    asOfStreamVersion: event.streamVersion,
    occurredAt: event.occurredAt,
  });

  switch (event.type) {
    case "TicketMovedToLane":
      return advance({ laneKey: event.payload.toLane, status: "idle" });
    case "TicketRouted":
      // Legacy event: lane only, status untouched (see the doc comment).
      return advance({ laneKey: event.payload.toLane });
    case "TicketQueued":
      return advance({ laneKey: event.payload.lane, status: "queued" });
    case "TicketAdmitted":
      return advance({ laneKey: event.payload.lane, status: "idle" });
    case "TicketEdited":
      return advance({
        ...(event.payload.title === undefined ? {} : { title: event.payload.title }),
        ...(event.payload.description === undefined
          ? {}
          : { description: event.payload.description }),
        // null clears the budget; the field is dropped rather than kept as null.
        ...(event.payload.tokenBudget === undefined
          ? {}
          : { tokenBudget: event.payload.tokenBudget ?? undefined }),
      });
    case "TicketBlocked":
      return isParked(state.status) ? advance({}) : advance({ status: "blocked" });
    case "PipelineStarted":
      return isParked(state.status) ? advance({}) : advance({ status: "running" });
    case "StepAwaitingUser":
      return isParked(state.status) ? advance({}) : advance({ status: "waiting_on_user" });
    case "StepUserResolved":
      return isParked(state.status) ? advance({}) : advance({ status: "running" });
    case "TicketParked":
      return advance({ status: "parked" });
    case "TicketForkSpawned":
      return advance({ status: "forked" });
    case "TicketForkResolved":
      return advance({ status: "running" });
    default:
      // Everything else — messages, edits to messages, refs, PRs, route
      // decisions, skips, steering, SLA breaches, step lifecycle — leaves ticket
      // status and lane untouched in the projection, so it does here too. The
      // version and timestamp still advance: the scrubber positions by them.
      return advance({});
  }
};

/** Fold an ordered event prefix. Returns null when the prefix has no TicketCreated. */
export const reduceReplayEvents = (
  events: ReadonlyArray<WorkflowEvent>,
  seed: ReplayTicketState | null = null,
): ReplayTicketState | null => {
  let state = seed;
  for (const event of events) {
    state = applyReplayEvent(state, event);
  }
  return state;
};
