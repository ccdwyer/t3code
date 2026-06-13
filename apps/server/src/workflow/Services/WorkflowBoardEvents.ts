import type { BoardId, BoardTicketView } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface WorkflowBoardEventsShape {
  readonly publish: (ticket: BoardTicketView) => Effect.Effect<void>;
  readonly stream: (boardId: BoardId) => Stream.Stream<BoardTicketView>;
}

export class WorkflowBoardEvents extends Context.Service<
  WorkflowBoardEvents,
  WorkflowBoardEventsShape
>()("t3/workflow/Services/WorkflowBoardEvents") {}
