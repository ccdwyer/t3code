import type { BoardId, TicketId, WorkflowEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { WorkflowEventStoreError } from "./Errors.ts";

export type PersistedWorkflowEvent = WorkflowEvent & {
  readonly sequence: number;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type WorkflowEventInput = DistributiveOmit<WorkflowEvent, "streamVersion">;

export interface WorkflowEventStoreShape {
  readonly append: (
    event: WorkflowEventInput,
  ) => Effect.Effect<PersistedWorkflowEvent, WorkflowEventStoreError>;
  readonly readByTicket: (
    ticketId: TicketId,
  ) => Stream.Stream<PersistedWorkflowEvent, WorkflowEventStoreError>;
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<PersistedWorkflowEvent, WorkflowEventStoreError>;
  /**
   * Board-wide events in global `sequence` order, for the board timeline.
   *
   * Joins through `projection_ticket` exactly as `deleteForBoard` does, so
   * events belonging to deleted or retention-swept tickets are invisible —
   * intended: those tickets no longer exist on the board.
   */
  readonly readByBoard: (
    boardId: BoardId,
    afterSequence: number,
    throughSequence: number | null,
    limit: number,
  ) => Stream.Stream<PersistedWorkflowEvent, WorkflowEventStoreError>;
  /**
   * Newest `limit + 1` events of one ticket. The extra row is a peek that tells
   * the caller the stream was truncated; the SQL-level DESC LIMIT is what keeps
   * this from buffering a whole stream the way `readByTicket` does.
   */
  readonly readTicketTail: (
    ticketId: TicketId,
    limit: number,
  ) => Stream.Stream<PersistedWorkflowEvent, WorkflowEventStoreError>;
  /**
   * One keyset page of a ticket's stream, ascending. Unbounded folds (the
   * timeline `base`, the fork's as-of state) page through this instead of
   * `readByTicket`, which materializes every row before streaming.
   */
  readonly readTicketRange: (
    ticketId: TicketId,
    fromVersionInclusive: number,
    toVersionExclusive: number,
    batch: number,
  ) => Stream.Stream<PersistedWorkflowEvent, WorkflowEventStoreError>;
  /** MAX(sequence) across a board's surviving tickets; 0 when there are none. */
  readonly maxSequenceForBoard: (
    boardId: BoardId,
  ) => Effect.Effect<number, WorkflowEventStoreError>;
  readonly readAll: () => Stream.Stream<PersistedWorkflowEvent, WorkflowEventStoreError>;
  readonly deleteForBoard: (boardId: BoardId) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly deleteForTicket: (ticketId: TicketId) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class WorkflowEventStore extends Context.Service<
  WorkflowEventStore,
  WorkflowEventStoreShape
>()("t3/workflow/Services/WorkflowEventStore") {}
