// @effect-diagnostics globalTimers:off
import type { StepOutcome } from "@t3tools/contracts";
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
import { mapAgentQuestions } from "../agentQuestions.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

const questionForm = () => {
  const mapped = mapAgentQuestions([
    { key: "db", label: "Which database?", options: ["Postgres", "SQLite"] },
  ]);
  if (!mapped.ok) throw new Error("fixture form failed to map");
  return mapped.form;
};

/** Answers the executor was handed when the step resumed. */
const answersSeen: Array<Record<string, unknown>> = [];
/** How many times the agent has been asked to run from the top. */
const runs = { count: 0 };

const resetSpies = () => {
  answersSeen.length = 0;
  runs.count = 0;
};

/**
 * An agent that asks once, then completes using whatever it was told.
 *
 * The point of the test is that the SECOND call happens at all and carries the
 * operator's answers — the failure mode every earlier design hit was the step
 * completing with the question itself as its output and no second turn.
 */
const askingExecutor = Layer.succeed(StepExecutor, {
  execute: () =>
    Effect.sync(() => {
      runs.count += 1;
      return {
        _tag: "awaiting_questions",
        waitingReason: "Agent asked: Which database?",
        form: questionForm(),
        raisedFromDispatchId: "dispatch-0",
      } satisfies StepOutcome;
    }),
  continueWithAnswers: ({ answers }) =>
    Effect.sync(() => {
      answersSeen.push({ ...answers });
      return { _tag: "completed", output: { picked: "recorded" } } satisfies StepOutcome;
    }),
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
    Layer.provideMerge(askingExecutor),
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

const board = {
  name: "questions",
  lanes: [
    {
      key: "build",
      name: "Build",
      entry: "auto",
      pipeline: [
        {
          key: "work",
          type: "agent",
          agent: { instance: "test", model: "test-model" },
          instruction: "do the thing",
          captureOutput: true,
          allowQuestions: true,
        },
      ],
      on: { success: "done", failure: "failed" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
    { key: "failed", name: "Failed", entry: "manual" },
  ],
};

const awaitTicketWhere = (ticketId: string, predicate: (detail: TicketDetail | null) => boolean) =>
  Effect.gen(function* () {
    const read = yield* WorkflowReadModel;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const detail = yield* read.getTicketDetail(ticketId as never);
      if (predicate(detail)) return detail;
      yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 10)));
      yield* Effect.yieldNow;
    }
    return yield* read.getTicketDetail(ticketId as never);
  });

const startAndAwaitQuestion = (boardId: string) =>
  Effect.gen(function* () {
    const registry = yield* BoardRegistry;
    yield* registry.register(boardId as never, board as never);
    const engine = yield* WorkflowEngine;
    const ticketId = yield* engine.createTicket({
      boardId: boardId as never,
      title: "Asks a question",
      initialLane: "build" as never,
    });
    const waiting = yield* awaitTicketWhere(
      ticketId as string,
      (detail) => detail?.ticket.status === "waiting_on_user",
    );
    return { ticketId, waiting };
  });

layer("WorkflowEngine agent questions", (it) => {
  it.effect("parks with the form, then resumes the agent with the answers", () =>
    Effect.gen(function* () {
      resetSpies();
      const engine = yield* WorkflowEngine;
      const { ticketId, waiting } = yield* startAndAwaitQuestion("b-questions");

      const step = waiting?.steps[0];
      assert.isDefined(step);
      // Answering goes through the ordinary approval resolve RPC.
      yield* engine.resolveApproval(step?.stepRunId as never, {
        approved: true,
        decision: "continue",
        answers: { db: "Postgres", __continue: "continue" } as never,
      });

      const done = yield* awaitTicketWhere(
        ticketId as string,
        (detail) => detail?.ticket.currentLaneKey === "done",
      );
      assert.strictEqual(done?.ticket.currentLaneKey, "done");

      // The whole point: a SECOND turn ran and it was given the answers.
      assert.strictEqual(answersSeen.length, 1);
      assert.strictEqual(answersSeen[0]?.db, "Postgres");

      // And the step did not silently re-run from the top.
      assert.strictEqual(runs.count, 1);
    }),
  );

  it.effect("records the wait as a question phase so recovery can tell them apart", () =>
    Effect.gen(function* () {
      resetSpies();
      const { ticketId } = yield* startAndAwaitQuestion("b-questions-events");
      const store = yield* WorkflowEventStore;
      const events = yield* Stream.runCollect(store.readByTicket(ticketId as never)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const awaiting = events.find((event) => event.type === "StepAwaitingUser");
      assert.isDefined(awaiting);
      if (awaiting?.type !== "StepAwaitingUser") throw new Error("unreachable");
      assert.strictEqual(awaiting.payload.questionPhase, true);
      assert.strictEqual(awaiting.payload.raisedFromDispatchId, "dispatch-0");
      // The form reaches the client through the SAME snapshot field a
      // board-authored checkpoint uses — no new transport for the drawer.
      const labels = (awaiting.payload.formSnapshot?.fields ?? [])
        .filter((field) => field.kind !== "decision")
        .map((field) => ("label" in field ? field.label : ""));
      assert.deepStrictEqual(labels, ["Which database?"]);
      // Deliberately NOT a provider wait: leaving these unset is what lets
      // resolveApproval accept it and DurableApprovalResume re-park it.
      assert.isUndefined(awaiting.payload.providerResponseKind);
      assert.isUndefined(awaiting.payload.providerThreadId);
    }),
  );

  it.effect("cancelling fails the step instead of resuming the agent", () =>
    Effect.gen(function* () {
      resetSpies();
      const engine = yield* WorkflowEngine;
      const { ticketId, waiting } = yield* startAndAwaitQuestion("b-questions-cancel");
      const stepRunId = waiting?.steps[0]?.stepRunId;
      assert.isDefined(stepRunId);

      yield* engine.resolveApproval(stepRunId as never, {
        approved: false,
        decision: "cancel",
        answers: { db: "Postgres", __continue: "cancel" } as never,
      });

      const failed = yield* awaitTicketWhere(
        ticketId as string,
        (detail) => detail?.ticket.currentLaneKey === "failed",
      );
      assert.strictEqual(failed?.ticket.currentLaneKey, "failed");
      // No continuation turn: cancel means the operator declined to answer.
      assert.strictEqual(answersSeen.length, 0);
    }),
  );
});
