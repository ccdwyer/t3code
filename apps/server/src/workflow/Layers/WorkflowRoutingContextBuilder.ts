import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import {
  WorkflowRoutingContextBuilder,
  type WorkflowRoutingContextBuilderShape,
} from "../Services/WorkflowRoutingContextBuilder.ts";

const make = Effect.gen(function* () {
  const readModel = yield* WorkflowReadModel;

  const build: WorkflowRoutingContextBuilderShape["build"] = (input) =>
    Effect.gen(function* () {
      const detail = yield* readModel.getTicketDetail(input.ticketId);
      if (!detail) {
        return yield* new WorkflowEventStoreError({
          message: `ticket not found while building routing context: ${input.ticketId}`,
        });
      }

      const laneRunCount = yield* readModel.countLanePipelineRuns(input.pipelineRunId);
      const rows = yield* readModel.listStepRunsForPipeline(input.pipelineRunId);
      const steps = Object.fromEntries(
        rows.map((row) => [
          row.stepKey,
          {
            exitCode: row.exitCode,
            status: row.status,
            output: row.output,
          },
        ]),
      );

      return {
        pipeline: { result: input.result },
        lane: { runCount: laneRunCount },
        status: detail.ticket.status,
        steps,
      };
    });

  return { build } satisfies WorkflowRoutingContextBuilderShape;
});

export const WorkflowRoutingContextBuilderLive = Layer.effect(WorkflowRoutingContextBuilder, make);
