import type {
  BoardId,
  CheckpointAnswers,
  CheckpointForm,
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
  /**
   * Resume a step that parked on an agent-raised question, by running a fresh
   * turn carrying the operator's answers.
   *
   * Lives on the executor because the continuation must obey the SAME capture,
   * output-contract and repair rules as the original turn, and those rules
   * exist only here — a caller that re-implemented them would drift.
   *
   * The returned outcome is an ordinary one: it may complete, fail, ask AGAIN
   * (bounded by the continuation budget), or park on a native provider prompt
   * the continuation turn happened to hit.
   */
  readonly continueWithAnswers: (input: {
    readonly ctx: StepExecutionContext;
    readonly form: CheckpointForm;
    readonly answers: CheckpointAnswers;
  }) => Effect.Effect<StepOutcome>;
}

export class StepExecutor extends Context.Service<StepExecutor, StepExecutorShape>()(
  "t3/workflow/Services/StepExecutor",
) {}
