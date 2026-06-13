import type { BoardId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface WorkflowBoardSaveLocksShape {
  readonly withSaveLock: <A, E, R>(
    boardId: BoardId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class WorkflowBoardSaveLocks extends Context.Service<
  WorkflowBoardSaveLocks,
  WorkflowBoardSaveLocksShape
>()("t3/workflow/Services/WorkflowBoardSaveLocks") {}
