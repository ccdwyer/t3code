import type {
  BoardId,
  LaneEntryToken,
  LaneKey,
  PipelineRunId,
  StepKey,
  StepOutcome,
  StepRunId,
  TicketId,
  WorkflowStep,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface StepExecutionContext {
  readonly ticketId: TicketId;
  readonly boardId: BoardId;
  readonly pipelineRunId: PipelineRunId;
  readonly stepRunId: StepRunId;
  readonly laneEntryToken: LaneEntryToken;
  readonly laneKey: LaneKey;
  readonly laneStepKeys: ReadonlyArray<StepKey>;
  readonly step: WorkflowStep;
  /**
   * True only for the lane pipeline's FIRST agent step. The executor cannot
   * compute it — `laneStepKeys` carries keys, not types — and it gates the
   * default (placeholder-free) handoff-pack injection so a pack is not repeated
   * on every agent step in the lane. Attempt-agnostic: a retry of that step is
   * still the first agent step.
   */
  readonly isFirstAgentStep?: boolean | undefined;
}

export interface StepExecutorShape {
  readonly execute: (ctx: StepExecutionContext) => Effect.Effect<StepOutcome>;
}

export class StepExecutor extends Context.Service<StepExecutor, StepExecutorShape>()(
  "t3/workflow/Services/StepExecutor",
) {}
