import type { CheckpointAnswers, CheckpointOutcome, StepRunId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * What a reviewer decided at a human checkpoint.
 *
 * Replaces the old boolean: a formless approval is `{ outcome: "success" }` or
 * `{ outcome: "failure" }`, while a checkpoint form also carries the chosen
 * decision option and the validated answers, which become routing input.
 */
export interface CheckpointResolution {
  readonly outcome: CheckpointOutcome;
  readonly decision?: string | undefined;
  readonly answers?: CheckpointAnswers | undefined;
}

export interface ApprovalGateShape {
  readonly park: (stepRunId: StepRunId) => Effect.Effect<void>;
  readonly await: (stepRunId: StepRunId) => Effect.Effect<CheckpointResolution>;
  readonly resolve: (
    stepRunId: StepRunId,
    resolution: CheckpointResolution,
  ) => Effect.Effect<boolean>;
}

export class ApprovalGate extends Context.Service<ApprovalGate, ApprovalGateShape>()(
  "t3/workflow/Services/ApprovalGate",
) {}
