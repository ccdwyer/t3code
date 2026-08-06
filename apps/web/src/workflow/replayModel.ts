import type {
  LaneKey,
  TicketId,
  WorkflowTimelineBase,
  WorkflowTimelineItem,
} from "@t3tools/contracts";
import { applyReplayEvent, type ReplayTicketState } from "@t3tools/contracts";

/** One ticket as of a scrub position, plus what the UI needs around it. */
export interface ReplayTicket extends ReplayTicketState {
  readonly ticketId: TicketId;
  /** True when the fold started from a server-computed base, i.e. the client
   *  never saw the head of this stream. The UI says so rather than implying the
   *  displayed history is complete. */
  readonly partialHistory: boolean;
}

export interface ReplayBoardState {
  readonly lanes: ReadonlyMap<LaneKey, ReadonlyArray<ReplayTicket>>;
  /** Lanes referenced by history that the current board definition no longer has. */
  readonly ghostLanes: ReadonlyArray<LaneKey>;
}

/**
 * Fold one ticket's timeline up to and including `uptoIndex`.
 *
 * Ordering is by position in `items`, which the server returns in
 * `streamVersion` order — not by `occurredAt`, which is wall-clock and can go
 * backwards across a clock adjustment.
 */
export const reduceTicketReplay = (
  items: ReadonlyArray<WorkflowTimelineItem>,
  base: WorkflowTimelineBase | undefined,
  uptoIndex: number,
): ReplayTicket | null => {
  const seed: ReplayTicketState | null =
    base === undefined
      ? null
      : {
          laneKey: base.laneKey,
          title: base.title,
          ...(base.description === undefined ? {} : { description: base.description }),
          ...(base.tokenBudget === undefined ? {} : { tokenBudget: base.tokenBudget }),
          status: base.status,
          asOfStreamVersion: base.asOfStreamVersion,
          occurredAt: base.occurredAt,
        };

  let state = seed;
  const last = Math.min(uptoIndex, items.length - 1);
  for (let index = 0; index <= last; index += 1) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }
    state = applyReplayEvent(state, item.event);
  }
  if (state === null) {
    return null;
  }
  const ticketId = items[0]?.event.ticketId;
  if (ticketId === undefined) {
    return null;
  }
  return { ...state, ticketId, partialHistory: base !== undefined };
};

/**
 * Fold a whole board's timeline up to `uptoSequence` and group the result by lane.
 *
 * Orders by the GLOBAL `sequence`, not `occurredAt`: sequence is the store's
 * autoincrement, so it is immune to clock skew between events appended by
 * different fibers.
 */
export const reduceBoardReplay = (
  items: ReadonlyArray<WorkflowTimelineItem>,
  currentLanes: ReadonlyArray<LaneKey>,
  uptoSequence: number,
): ReplayBoardState => {
  const ordered = [...items].sort((left, right) => left.sequence - right.sequence);
  const byTicket = new Map<TicketId, ReplayTicketState | null>();

  for (const item of ordered) {
    if (item.sequence > uptoSequence) {
      break;
    }
    const ticketId = item.event.ticketId;
    byTicket.set(ticketId, applyReplayEvent(byTicket.get(ticketId) ?? null, item.event));
  }

  const known = new Set(currentLanes);
  const lanes = new Map<LaneKey, Array<ReplayTicket>>();
  const ghostLanes = new Set<LaneKey>();

  for (const [ticketId, state] of byTicket) {
    if (state === null) {
      // The window opened after this ticket's TicketCreated, so it cannot be
      // placed on a lane. Dropping it beats inventing a position for it.
      continue;
    }
    if (!known.has(state.laneKey)) {
      ghostLanes.add(state.laneKey);
    }
    const bucket = lanes.get(state.laneKey) ?? [];
    bucket.push({ ...state, ticketId, partialHistory: false });
    lanes.set(state.laneKey, bucket);
  }

  return { lanes, ghostLanes: [...ghostLanes] };
};
