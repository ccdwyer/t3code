import type { StepRunId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface CapturedStepOutputReadInput {
  readonly stepRunId: StepRunId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

export interface CapturedStepOutputReaderShape {
  readonly read: (
    input: CapturedStepOutputReadInput,
  ) => Effect.Effect<unknown | undefined, WorkflowEventStoreError>;
  /**
   * Like `read`, but ONLY the turn's final assistant message.
   *
   * `read` deliberately falls back to scanning the turn's earlier assistant
   * messages, which is right for agents that emit their result before a closing
   * remark. It is wrong for agent-raised questions: an earlier progress note or
   * a quoted payload could then be read as a question the agent never asked at
   * the end of its turn. Raising a question parks a ticket on a human, so it
   * takes the strict read.
   */
  readonly readFinalMessage: (
    input: CapturedStepOutputReadInput,
  ) => Effect.Effect<unknown | undefined, WorkflowEventStoreError>;
}

export class CapturedStepOutputReader extends Context.Service<
  CapturedStepOutputReader,
  CapturedStepOutputReaderShape
>()("t3/workflow/Services/CapturedStepOutputReader") {}
