// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel, type TicketDetail } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

const unusedExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.die("no agent steps in these boards"),
  continueWithAnswers: () => Effect.die("no question continuations in this test"),
} satisfies StepExecutorShape);

const layer = it.layer(
  WorkflowEngineLayer.pipe(
    Layer.provideMerge(WorkflowEventCommitterLive),
    Layer.provideMerge(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(unusedExecutor),
    Layer.provideMerge(ApprovalGateLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(WorkflowRoutingContextBuilderLive),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const checkpointForm = {
  fields: [
    {
      kind: "decision",
      key: "verdict",
      options: [
        { value: "ship", label: "Ship it", outcome: "success" },
        { value: "changes", label: "Needs changes", outcome: "failure" },
        { value: "hold", label: "Hold", outcome: "blocked" },
      ],
    },
    { kind: "text", key: "why", label: "Why?" },
  ],
};

const boardWith = (form: unknown) => ({
  name: "checkpoints",
  lanes: [
    {
      key: "review",
      name: "Review",
      entry: "auto",
      pipeline: [
        {
          key: "gate",
          type: "approval",
          prompt: "Review it",
          ...(form ? { form } : {}),
        },
      ],
      on: { success: "shipped", failure: "rework", blocked: "stuck" },
    },
    { key: "shipped", name: "Shipped", entry: "manual", terminal: true },
    { key: "rework", name: "Rework", entry: "manual" },
    { key: "stuck", name: "Stuck", entry: "manual" },
  ],
});

const awaitTicketWhere = (ticketId: string, predicate: (detail: TicketDetail | null) => boolean) =>
  Effect.gen(function* () {
    const read = yield* WorkflowReadModel;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const detail = yield* read.getTicketDetail(ticketId as never);
      if (predicate(detail)) {
        return detail;
      }
      yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 10)));
      yield* Effect.yieldNow;
    }
    return yield* read.getTicketDetail(ticketId as never);
  });

const startWaiting = (boardId: string, form: unknown) =>
  Effect.gen(function* () {
    const registry = yield* BoardRegistry;
    yield* registry.register(boardId as never, boardWith(form) as never);
    const engine = yield* WorkflowEngine;
    const ticketId = yield* engine.createTicket({
      boardId: boardId as never,
      title: "Needs a human",
      initialLane: "review" as never,
    });
    const waiting = yield* awaitTicketWhere(
      ticketId as string,
      (detail) => detail?.ticket.status === "waiting_on_user",
    );
    return { ticketId, stepRunId: waiting?.steps[0]?.stepRunId };
  });

layer("WorkflowEngine checkpoint forms", (it) => {
  it.effect("routes by the outcome the chosen decision maps to, for all three outcomes", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;

      for (const [board, decision, lane] of [
        ["b-ship", "ship", "shipped"],
        ["b-changes", "changes", "rework"],
        ["b-hold", "hold", "stuck"],
      ] as const) {
        const { ticketId, stepRunId } = yield* startWaiting(board, checkpointForm);
        assert.isDefined(stepRunId);

        // `approved: false` throughout: the DECISION decides the outcome, not
        // the legacy boolean, or a client could pick its own routing.
        yield* engine.resolveApproval(stepRunId as never, {
          approved: false,
          decision,
        });

        const detail = yield* awaitTicketWhere(
          ticketId as string,
          (candidate) => candidate?.ticket.currentLaneKey === lane,
        );
        assert.equal(detail?.ticket.currentLaneKey, lane, `${decision} should route to ${lane}`);
      }
    }),
  );

  it.effect("persists the decision and answers on StepUserResolved", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const store = yield* WorkflowEventStore;
      const { ticketId, stepRunId } = yield* startWaiting("b-persist", checkpointForm);

      yield* engine.resolveApproval(stepRunId as never, {
        approved: true,
        decision: "changes",
        answers: { why: "  tests missing  " } as never,
      });
      yield* awaitTicketWhere(
        ticketId as string,
        (detail) => detail?.ticket.currentLaneKey === "rework",
      );

      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const resolved = events.find((event) => event.type === "StepUserResolved");
      assert.isDefined(resolved);
      if (resolved?.type === "StepUserResolved") {
        assert.equal(resolved.payload.outcome, "failure");
        assert.equal(resolved.payload.decision, "changes");
        // Trimmed by validation before it reached the log.
        assert.equal(resolved.payload.answers?.["why" as never], "tests missing");
      }
    }),
  );

  it.effect("snapshots the form on the wait so a later board edit cannot change it", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const store = yield* WorkflowEventStore;
      const { ticketId, stepRunId } = yield* startWaiting("b-snapshot", checkpointForm);

      // Edit the board out from under the waiting reviewer.
      yield* registry.register("b-snapshot" as never, boardWith(undefined) as never);

      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const awaiting = events.find((event) => event.type === "StepAwaitingUser");
      if (awaiting?.type === "StepAwaitingUser") {
        assert.isDefined(awaiting.payload.formSnapshot);
      }

      // The snapshot still governs: a decision from the ORIGINAL form is valid
      // even though the board no longer has a form at all.
      const engine = yield* WorkflowEngine;
      yield* engine.resolveApproval(stepRunId as never, {
        approved: false,
        decision: "ship",
      });
      const detail = yield* awaitTicketWhere(
        ticketId as string,
        (candidate) => candidate?.ticket.currentLaneKey === "shipped",
      );
      assert.equal(detail?.ticket.currentLaneKey, "shipped");
    }),
  );

  it.effect("surfaces the form on the step view while waiting, and the answers after", () =>
    Effect.gen(function* () {
      // Goes through the PROJECTION and the read model, not just the engine:
      // without this the drawer has no form to render and the feature is
      // unreachable however correct the engine is.
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const { ticketId, stepRunId } = yield* startWaiting("b-view", checkpointForm);

      const waiting = yield* read.getTicketDetail(ticketId);
      const waitingStep = waiting?.steps.find((step) => step.stepRunId === stepRunId);
      assert.isDefined(waitingStep?.checkpointFormJson);

      yield* engine.resolveApproval(stepRunId as never, {
        approved: true,
        decision: "changes",
        answers: { why: "needs tests" } as never,
      });
      yield* awaitTicketWhere(
        ticketId as string,
        (detail) => detail?.ticket.currentLaneKey === "rework",
      );

      const resolved = yield* read.getTicketDetail(ticketId);
      const resolvedStep = resolved?.steps.find((step) => step.stepRunId === stepRunId);
      assert.equal(resolvedStep?.checkpointDecision, "changes");
      assert.include(resolvedStep?.checkpointAnswersJson ?? "", "needs tests");
    }),
  );

  it.effect("rejects a decision that is not on the snapshot", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const { stepRunId } = yield* startWaiting("b-bad-decision", checkpointForm);

      const failure = yield* engine
        .resolveApproval(stepRunId as never, {
          approved: true,
          decision: "merge-anyway",
        })
        .pipe(Effect.flip);
      assert.include(failure.message, "not an option");
    }),
  );

  it.effect("still supports a formless approval through the legacy boolean", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const { ticketId, stepRunId } = yield* startWaiting("b-formless", undefined);

      yield* engine.resolveApproval(stepRunId as never, { approved: false });
      const detail = yield* awaitTicketWhere(
        ticketId as string,
        (candidate) => candidate?.ticket.currentLaneKey === "rework",
      );
      assert.equal(detail?.ticket.currentLaneKey, "rework");
    }),
  );
});
