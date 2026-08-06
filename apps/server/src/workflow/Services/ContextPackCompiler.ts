import type {
  LaneEntryToken,
  PipelineRunId,
  TicketId,
  WorkflowContextPackSection,
  WorkflowStep,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ContextPackCompileInput {
  readonly ticketId: TicketId;
  /** The pipeline run whose outputs the destination lane inherits. */
  readonly pipelineRunId: PipelineRunId;
  /** Bounds `failed_attempts` to the source lane's CURRENT visit. */
  readonly laneEntryToken: LaneEntryToken;
  /** Source-lane steps, in declaration order — the order prior outputs render in. */
  readonly steps: ReadonlyArray<WorkflowStep>;
}

export interface ContextPackCompilerShape {
  /**
   * Compile the handoff sections for one route.
   *
   * The error channel is `never` by construction: a pack is optional enrichment,
   * so every failure and defect degrades to an empty result with a warning, and
   * an empty result means the caller emits no event. Interrupts still propagate
   * — see the implementation.
   */
  readonly compile: (
    input: ContextPackCompileInput,
  ) => Effect.Effect<ReadonlyArray<WorkflowContextPackSection>, never>;
}

export class ContextPackCompiler extends Context.Service<
  ContextPackCompiler,
  ContextPackCompilerShape
>()("t3/workflow/Services/ContextPackCompiler") {}
