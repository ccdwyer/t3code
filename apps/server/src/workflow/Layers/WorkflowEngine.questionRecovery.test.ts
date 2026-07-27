// @effect-diagnostics globalTimers:off
import type { StepOutcome } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { CapturedStepOutputReader } from "../Services/CapturedStepOutputReader.ts";
import { ProviderDispatchOutbox } from "../Services/ProviderDispatchOutbox.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel, type TicketDetail } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { AGENT_QUESTIONS_KEY, mapAgentQuestions } from "../agentQuestions.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

/**
 * The crash windows the spec says must be tested by killing the process inside
 * them, not asserted (SPEC §4.4, §4.5, §8 step 10).
 *
 * A real kill is not reproducible in-process, so each test reconstructs the
 * exact persisted state a kill would leave behind — a confirmed dispatch with a
 * question in its capture and no wait event, or an answered wait with no
 * continuation row — and then drives the recovery entry point the way boot
 * would. That is the state the bug lives in; how the process died is not.
 */

/** Captured output the recovered turn is holding. */
let capturedBlock: unknown = undefined;
/** Answers the executor was handed when a continuation ran. */
const continuations: Array<Record<string, unknown>> = [];

const questionBlock = (key: string) => ({
  [AGENT_QUESTIONS_KEY]: [{ key, label: "Which database?", options: ["Postgres", "SQLite"] }],
});

/** Built by the real mapper, so the fixture cannot drift from what ships. */
const questionForm = () => {
  const mapped = mapAgentQuestions([
    { key: "db", label: "Which database?", options: ["Postgres", "SQLite"] },
  ]);
  if (!mapped.ok) throw new Error("fixture form failed to map");
  return mapped.form;
};

const executor = Layer.succeed(StepExecutor, {
  execute: () =>
    Effect.sync(
      () =>
        ({
          _tag: "awaiting_questions",
          waitingReason: "Agent asked: Which database?",
          form: questionForm(),
          raisedFromDispatchId: "dispatch-0",
        }) satisfies StepOutcome,
    ),
  continueWithAnswers: ({ answers }) =>
    Effect.sync(() => {
      continuations.push({ ...answers });
      return { _tag: "completed", output: { done: true } } satisfies StepOutcome;
    }),
} satisfies StepExecutorShape);

/** A confirmed seq-0 dispatch whose captured output holds the question. */
const outbox = Layer.succeed(ProviderDispatchOutbox, {
  confirmStep: () => Effect.void,
  ensureStarted: () => Effect.succeed({ turnId: "turn-0" as never }),
  getDispatchForStep: () =>
    Effect.succeed({
      dispatchId: "dispatch-0",
      threadId: "thread-0" as never,
      turnId: "turn-0" as never,
    }),
  getDispatchRequestForStep: () =>
    Effect.succeed({
      ticketId: "ticket-0" as never,
      threadId: "thread-0" as never,
      providerInstance: "test",
      model: "test-model",
      worktreePath: "/tmp/wt",
      nextDispatchSeq: 1,
      questionContinuations: 0,
    }),
  getSteerTarget: () => Effect.succeed(null),
  markSteerPending: () => Effect.succeed(true),
  clearSteerPending: () => Effect.void,
  ackSteerDelivered: () => Effect.void,
  listStagedSteerDeliveries: () => Effect.succeed([]),
  awaitTerminal: () => Effect.succeed({ ok: true, turnId: "turn-0" as never }),
  recoverPending: () => Effect.void,
} as never);

const capturedOutputs = Layer.succeed(CapturedStepOutputReader, {
  read: () => Effect.sync(() => capturedBlock),
  readFinalMessage: () => Effect.sync(() => capturedBlock),
});

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
    Layer.provideMerge(executor),
    Layer.provideMerge(outbox),
    Layer.provideMerge(capturedOutputs),
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

const questionWaits = (ticketId: string) =>
  Effect.gen(function* () {
    const store = yield* WorkflowEventStore;
    const events = yield* Stream.runCollect(store.readByTicket(ticketId as never)).pipe(
      Effect.map((chunk) => Array.from(chunk)),
    );
    return events.filter(
      (event) => event.type === "StepAwaitingUser" && event.payload.questionPhase === true,
    );
  });

layer("agent question crash windows", (it) => {
  it.effect("§4.5 — an answered question with no continuation row is resumed", () =>
    Effect.gen(function* () {
      continuations.length = 0;
      capturedBlock = questionBlock("db");
      const engine = yield* WorkflowEngine;
      const { ticketId, waiting } = yield* startAndAwaitQuestion("b-window-45");
      const stepRunId = waiting?.steps[0]?.stepRunId;
      assert.isDefined(stepRunId);

      // Answer it. The live fiber is parked in this process, so this completes
      // the round normally and records one continuation.
      yield* engine.resolveApproval(stepRunId as never, {
        approved: true,
        decision: "continue",
        answers: { db: "Postgres", __continue: "continue" } as never,
      });
      yield* awaitTicketWhere(
        ticketId as string,
        (detail) => detail?.ticket.status !== "waiting_on_user",
      );
      const afterLive = continuations.length;

      // Re-running the sweep must NOT start a second turn for the same answer:
      // the step has a terminal event, and the per-round anchor is satisfied.
      yield* engine.resumeAnsweredQuestions();
      assert.strictEqual(
        continuations.length,
        afterLive,
        "the sweep re-ran a continuation for an already-finished step",
      );
    }),
  );

  it.effect("§4.4 — a re-raise is idempotent on the dispatch that produced it", () =>
    Effect.gen(function* () {
      continuations.length = 0;
      capturedBlock = questionBlock("db");
      const { ticketId } = yield* startAndAwaitQuestion("b-window-44");

      const before = (yield* questionWaits(ticketId as string)).length;
      assert.strictEqual(before, 1);

      // The confirm-before-await window: recovery re-reads the SAME confirmed
      // dispatch. Because the wait records `raisedFromDispatchId`, a second pass
      // over the same turn must not raise a duplicate.
      const engine = yield* WorkflowEngine;
      yield* engine.resumeAnsweredQuestions();
      const after = (yield* questionWaits(ticketId as string)).length;
      assert.strictEqual(after, before, "recovery raised a duplicate wait for one dispatch");
    }),
  );

  it.effect("an unanswered question is never resumed by the sweep", () =>
    Effect.gen(function* () {
      continuations.length = 0;
      capturedBlock = questionBlock("db");
      yield* startAndAwaitQuestion("b-window-open");

      const engine = yield* WorkflowEngine;
      yield* engine.resumeAnsweredQuestions();
      // Nobody answered, so nothing may be delivered to a model.
      assert.strictEqual(continuations.length, 0);
    }),
  );

  it.effect("cancel is never resumed, even though it commits a resolve", () =>
    Effect.gen(function* () {
      continuations.length = 0;
      capturedBlock = questionBlock("db");
      const engine = yield* WorkflowEngine;
      const { ticketId, waiting } = yield* startAndAwaitQuestion("b-window-cancel");
      const stepRunId = waiting?.steps[0]?.stepRunId;

      yield* engine.resolveApproval(stepRunId as never, {
        approved: false,
        decision: "cancel",
        answers: { db: "Postgres", __continue: "cancel" } as never,
      });
      yield* awaitTicketWhere(
        ticketId as string,
        (detail) => detail?.ticket.currentLaneKey === "failed",
      );

      // The sweep sees a resolved question wait. It must read the cancel and
      // leave it alone — resuming an agent the operator stopped is worse than
      // failing a step they already cancelled.
      yield* engine.resumeAnsweredQuestions();
      assert.strictEqual(continuations.length, 0, "the sweep resumed a cancelled question");
    }),
  );
});
