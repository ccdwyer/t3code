import type {
  TicketId,
  WorkflowGetBoardTimelineInput,
  WorkflowGetBoardTimelineResult,
  WorkflowGetTicketTimelineResult,
} from "@t3tools/contracts";
import { reduceReplayEvents, type ReplayTicketState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { WorkflowRpcError } from "@t3tools/contracts";
import type { WorkflowEventStoreShape } from "../Services/WorkflowEventStore.ts";
/** Local copy of the handlers' mapper — this module must not import them back. */
const toWorkflowRpcError = (message: string) => (cause: unknown) =>
  new WorkflowRpcError({ message, ...(cause === undefined ? {} : { cause }) });

/** The slice of the event store the timeline reads need. */
export type TimelineStore = Partial<
  Pick<
    WorkflowEventStoreShape,
    "readByBoard" | "readTicketTail" | "readTicketRange" | "maxSequenceForBoard"
  >
>;

/** Newest window of a ticket's stream, per the timeline contract. */
const TICKET_TIMELINE_LIMIT = 5_000;
/** Keyset page size for the unbounded head fold behind a truncated timeline. */
const TIMELINE_FOLD_BATCH = 500;
/** Server clamp on a board-timeline page. */
const BOARD_TIMELINE_MAX_LIMIT = 200;

export const buildTicketTimeline = (
  store: TimelineStore,
  ticketId: TicketId,
  // Injectable so the truncation path can be exercised without seeding 5,000
  // events; production always takes the default.
  windowLimit: number = TICKET_TIMELINE_LIMIT,
): Effect.Effect<typeof WorkflowGetTicketTimelineResult.Type, WorkflowRpcError> =>
  Effect.gen(function* () {
    if (store.readTicketTail === undefined || store.readTicketRange === undefined) {
      return { events: [], truncated: false };
    }
    const tailDesc = yield* Stream.runCollect(store.readTicketTail(ticketId, windowLimit)).pipe(
      Effect.map((chunk) => Array.from(chunk)),
      Effect.mapError(toWorkflowRpcError("Failed to read workflow ticket timeline")),
    );
    // The store returns DESC with one peek row past the limit.
    const truncated = tailDesc.length > windowLimit;
    const windowDesc = truncated ? tailDesc.slice(0, windowLimit) : tailDesc;
    const events = [...windowDesc].reverse();

    if (!truncated || events.length === 0) {
      return {
        events: events.map((event) => ({ sequence: event.sequence, event })),
        truncated: false,
      };
    }

    // Fold everything below the window so the client has somewhere to start.
    // Paged rather than read whole: a long-lived ticket's head can be large, and
    // this runs on a read path.
    const windowStart = events[0]?.streamVersion ?? 0;
    let base: ReplayTicketState | null = null;
    let cursor = 0;
    while (cursor < windowStart) {
      const page = yield* Stream.runCollect(
        store.readTicketRange(ticketId, cursor, windowStart, TIMELINE_FOLD_BATCH),
      ).pipe(
        Effect.map((chunk) => Array.from(chunk)),
        Effect.mapError(toWorkflowRpcError("Failed to read workflow ticket timeline")),
      );
      if (page.length === 0) {
        break;
      }
      base = reduceReplayEvents(page, base);
      cursor = (page[page.length - 1]?.streamVersion ?? cursor) + 1;
    }

    return {
      events: events.map((event) => ({ sequence: event.sequence, event })),
      truncated: true,
      ...(base === null ? {} : { base }),
    };
  });

export const buildBoardTimeline = (
  store: TimelineStore,
  input: typeof WorkflowGetBoardTimelineInput.Type,
): Effect.Effect<typeof WorkflowGetBoardTimelineResult.Type, WorkflowRpcError> =>
  Effect.gen(function* () {
    if (store.readByBoard === undefined || store.maxSequenceForBoard === undefined) {
      return { events: [], nextAfterSequence: null, latestSequence: 0 };
    }
    const after = Math.max(0, Math.floor(input.afterSequence ?? 0));
    const limit = Math.min(
      BOARD_TIMELINE_MAX_LIMIT,
      Math.max(1, Math.floor(input.limit ?? BOARD_TIMELINE_MAX_LIMIT)),
    );
    // Pin FIRST, then read bounded by the pin: computing it after the page would
    // let an append between the two make `latestSequence` unreachable by the
    // cursor, which reads to the user as permanently missing events.
    const pin =
      input.throughSequence ??
      (yield* store
        .maxSequenceForBoard(input.boardId)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to read workflow board timeline"))));

    const page = yield* Stream.runCollect(
      store.readByBoard(input.boardId, after, pin, limit + 1),
    ).pipe(
      Effect.map((chunk) => Array.from(chunk)),
      Effect.mapError(toWorkflowRpcError("Failed to read workflow board timeline")),
    );
    // The peek row decides whether another page exists; without it a full final
    // page would advertise a next cursor that returns nothing.
    const hasMore = page.length > limit;
    const events = hasMore ? page.slice(0, limit) : page;
    const last = events[events.length - 1];
    return {
      events: events.map((event) => ({ sequence: event.sequence, event })),
      nextAfterSequence: hasMore && last !== undefined ? last.sequence : null,
      latestSequence: pin,
    };
  });
