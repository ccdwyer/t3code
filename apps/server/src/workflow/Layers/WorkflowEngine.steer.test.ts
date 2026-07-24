// @effect-diagnostics globalTimers:off
/**
 * Engine ladder for live agent steering — frozen rejection messages and
 * CAS reserve + submit happy path (with stubbed outbox/port).
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import {
  ProviderDispatchOutbox,
  ProviderTurnPort,
  type SteerTarget,
} from "../Services/ProviderDispatchOutbox.ts";
import { TurnStateReader } from "../Services/TurnStateReader.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";
import { STEER_REJECTION } from "../steerHelpers.ts";

const idleExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.succeed({ _tag: "completed" as const }),
} satisfies StepExecutorShape);

let pending: string | null = null;
let steerCalls: Array<{ messageId: string; text: string }> = [];

const makeOutboxLayer = (target: SteerTarget | null) =>
  Layer.succeed(ProviderDispatchOutbox, {
    confirmStep: () => Effect.void,
    ensureStarted: () => Effect.succeed({ turnId: "turn-1" as never }),
    getDispatchForStep: () =>
      Effect.succeed(target === null ? null : { threadId: target.threadId, turnId: target.turnId }),
    getSteerTarget: () =>
      Effect.succeed(target === null ? null : { ...target, steerPendingMessageId: pending }),
    markSteerPending: (_dispatchId, messageId) =>
      Effect.sync(() => {
        if (pending !== null && pending !== (messageId as string)) {
          return false;
        }
        pending = messageId as string;
        return true;
      }),
    clearSteerPending: () =>
      Effect.sync(() => {
        pending = null;
      }),
    awaitTerminal: () => Effect.succeed({ ok: true, turnId: "turn-1" as never }),
    awaitStepTerminal: () => Effect.succeed({ ok: true, turnId: "turn-1" as never }),
    recoverPending: () => Effect.void,
  });

const turnPortLayer = Layer.succeed(ProviderTurnPort, {
  ensureTurnStarted: () => Effect.succeed({ turnId: "turn-1" as never }),
  steerTurn: (input) =>
    Effect.sync(() => {
      steerCalls.push({ messageId: input.messageId as string, text: input.text });
    }),
});

const turnStateLayer = Layer.succeed(TurnStateReader, {
  read: () => Effect.succeed({ _tag: "running" as const }),
});

const baseLayer = WorkflowEngineLayer.pipe(
  Layer.provideMerge(WorkflowEventCommitterLive),
  Layer.provideMerge(
    Layer.succeed(ScriptCancelRegistry, {
      register: () => Effect.void,
      unregister: () => Effect.void,
      cancel: () => Effect.void,
    }),
  ),
  Layer.provideMerge(idleExecutor),
  Layer.provideMerge(ApprovalGateLive),
  Layer.provideMerge(BoardRegistryLive),
  Layer.provideMerge(PredicateEvaluatorLive),
  Layer.provideMerge(WorkflowRoutingContextBuilderLive),
  Layer.provideMerge(WorkflowBoardSaveLocksLive),
  Layer.provideMerge(DeterministicWorkflowIds),
  Layer.provideMerge(WorkflowFoundationLive),
  Layer.provideMerge(MigrationsLive),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const makeLayer = (target: SteerTarget | null) =>
  baseLayer.pipe(
    Layer.provideMerge(makeOutboxLayer(target)),
    Layer.provideMerge(turnPortLayer),
    Layer.provideMerge(turnStateLayer),
  );

let seedSeq = 0;
const seedRunningAgent = Effect.gen(function* () {
  seedSeq += 1;
  const n = seedSeq;
  const engine = yield* WorkflowEngine;
  const registry = yield* BoardRegistry;
  const read = yield* WorkflowReadModel;
  const sql = yield* SqlClient.SqlClient;
  const boardId = `b-steer-${n}` as never;
  yield* read.registerBoard({
    boardId,
    projectId: "p-steer" as never,
    name: `Steer ${n}`,
    workflowFilePath: `.t3/boards/steer-${n}.json`,
    workflowVersionHash: `h${n}`,
    maxConcurrentTickets: 3,
  });
  yield* registry.register(boardId, {
    name: "steer",
    lanes: [
      {
        key: "impl",
        name: "Impl",
        entry: "manual",
        pipeline: [
          {
            key: "code",
            type: "agent",
            agent: { instance: "codex", model: "gpt-5.5" },
            instruction: "do work",
          },
        ],
      },
    ],
  } as never);
  const ticketId = yield* engine.createTicket({
    boardId,
    title: `Steer me ${n}`,
    initialLane: "impl" as never,
  });
  // Prefer any step created by admission; otherwise insert a synthetic running step.
  const steps = yield* sql<{ readonly stepRunId: string }>`
    SELECT step_run_id AS "stepRunId"
    FROM projection_step_run
    WHERE ticket_id = ${ticketId}
    ORDER BY rowid DESC
    LIMIT 1
  `;
  let stepRunId = steps[0]?.stepRunId;
  if (stepRunId === undefined) {
    stepRunId = `step-steer-${n}`;
    yield* sql`
      INSERT INTO projection_pipeline_run (
        pipeline_run_id, ticket_id, lane_key, lane_entry_token, status, started_at
      ) VALUES (
        ${`pipe-steer-${n}`}, ${ticketId}, 'impl', ${`tok-${n}`}, 'running',
        '2026-07-24T00:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO projection_step_run (
        step_run_id, pipeline_run_id, ticket_id, step_key, step_type, status, started_at
      ) VALUES (
        ${stepRunId}, ${`pipe-steer-${n}`}, ${ticketId}, 'code', 'agent', 'running',
        '2026-07-24T00:00:00.000Z'
      )
    `;
    yield* sql`
      UPDATE projection_ticket SET status = 'running' WHERE ticket_id = ${ticketId}
    `;
  } else {
    yield* sql`
      UPDATE projection_step_run
      SET status = 'running', step_type = 'agent'
      WHERE step_run_id = ${stepRunId}
    `;
    yield* sql`
      UPDATE projection_ticket SET status = 'running' WHERE ticket_id = ${ticketId}
    `;
  }
  return { ticketId, stepRunId };
});

const target: SteerTarget = {
  dispatchId: "dispatch-steer" as never,
  threadId: "thread-steer" as never,
  turnId: "turn-steer" as never,
  captureOutput: false,
  panelSize: 1,
  steerPendingMessageId: null,
};

const layer = it.layer(makeLayer(target));

layer("WorkflowEngine.steerTicketStep", (it) => {
  it.effect("accepts a steer against a running agent step", () =>
    Effect.gen(function* () {
      pending = null;
      steerCalls = [];
      const engine = yield* WorkflowEngine;
      const { ticketId, stepRunId } = yield* seedRunningAgent;
      const result = yield* engine.steerTicketStep({
        ticketId: ticketId as never,
        stepRunId: stepRunId as never,
        messageId: "msg-steer-ok" as never,
        text: "also update the tests",
      });
      assert.deepEqual(result, { accepted: true });
      assert.equal(steerCalls.length, 1);
      assert.equal(steerCalls[0]?.messageId, "msg-steer-ok");
      assert.isTrue(steerCalls[0]?.text.includes("also update the tests"));
      assert.equal(pending, "msg-steer-ok");
    }),
  );

  it.effect("rejects parked tickets with frozen message", () =>
    Effect.gen(function* () {
      pending = null;
      const engine = yield* WorkflowEngine;
      const { ticketId, stepRunId } = yield* seedRunningAgent;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_ticket SET status = 'parked' WHERE ticket_id = ${ticketId}`;
      const exit = yield* Effect.exit(
        engine.steerTicketStep({
          ticketId: ticketId as never,
          stepRunId: stepRunId as never,
          messageId: "msg-parked" as never,
          text: "nope",
        }),
      );
      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure") {
        const err = exit.cause;
        assert.isTrue(String(err).includes(STEER_REJECTION.parkedTicket));
      }
    }),
  );

  it.effect("rejects concurrent second steer while pending", () =>
    Effect.gen(function* () {
      pending = "msg-first";
      const engine = yield* WorkflowEngine;
      const { ticketId, stepRunId } = yield* seedRunningAgent;
      const exit = yield* Effect.exit(
        engine.steerTicketStep({
          ticketId: ticketId as never,
          stepRunId: stepRunId as never,
          messageId: "msg-second" as never,
          text: "second",
        }),
      );
      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure") {
        assert.isTrue(String(exit.cause).includes(STEER_REJECTION.steerInFlight));
      }
    }),
  );

  it.effect("rejects panel steps", () =>
    Effect.gen(function* () {
      pending = null;
      // Rebuild layer with panelSize 2 via local override is hard; use CAS target
      // by mutating getSteerTarget is already fixed in layer. Swap pending path:
      // call with a dedicated layer.
      const panelLayer = makeLayer({ ...target, panelSize: 2 });
      yield* Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const { ticketId, stepRunId } = yield* seedRunningAgent;
        const exit = yield* Effect.exit(
          engine.steerTicketStep({
            ticketId: ticketId as never,
            stepRunId: stepRunId as never,
            messageId: "msg-panel" as never,
            text: "no panel",
          }),
        );
        assert.isTrue(exit._tag === "Failure");
        if (exit._tag === "Failure") {
          assert.isTrue(String(exit.cause).includes(STEER_REJECTION.panelStep));
        }
      }).pipe(Effect.provide(panelLayer));
    }),
  );
});
