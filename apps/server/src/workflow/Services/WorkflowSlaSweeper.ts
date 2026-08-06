import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorkflowSlaSweepResult {
  readonly candidateCount: number;
  readonly actionCount: number;
  readonly failedCount: number;
}

export interface WorkflowSlaSweeperShape {
  readonly sweep: () => Effect.Effect<WorkflowSlaSweepResult>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class WorkflowSlaSweeper extends Context.Service<
  WorkflowSlaSweeper,
  WorkflowSlaSweeperShape
>()("t3/workflow/Services/WorkflowSlaSweeper") {}
