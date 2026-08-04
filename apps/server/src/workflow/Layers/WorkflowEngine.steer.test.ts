// @effect-diagnostics globalTimers:off
/**
 * Engine ladder for live agent steering — frozen rejection messages,
 * CAS reserve + submit, ack→StepSteered e2e, failed-submit zero event, and
 * same-messageId idempotency after pending is cleared.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
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
  type ProviderDispatchOutboxShape,
  type SteerTarget,
} from "../Services/ProviderDispatchOutbox.ts";
import { TurnStateReader } from "../Services/TurnStateReader.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";
import { STEER_REJECTION } from "../steerHelpers.ts";

const encodeJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const idleExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.succeed({ _tag: "completed" as const }),
  continueWithAnswers: () => Effect.die("no question continuations in this test"),
} satisfies StepExecutorShape);

let pending: string | null = null;
let steerCalls: Array<{ messageId: string; text: string }> = [];
let steerShouldFail = false;

const makeOutboxLayer = (target: SteerTarget | null) =>
  Layer.effect(
    ProviderDispatchOutbox,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        confirmStep: () => Effect.void,
        ensureStarted: () => Effect.succeed({ turnId: "turn-1" as never }),
        getDispatchForStep: () =>
          Effect.succeed(
            target === null || target.turnId === null
              ? null
              : { threadId: target.threadId, turnId: target.turnId },
          ),
        getDispatchRequestForStep: () => Effect.succeed(null),
        tombstoneQuestionContinuations: () => Effect.void,
        getSteerTarget: () =>
          Effect.succeed(target === null ? null : { ...target, steerPendingMessageId: pending }),
        markSteerPending: (dispatchId, messageId, text) =>
          Effect.gen(function* () {
            if (pending !== null && pending !== (messageId as string)) {
              return false;
            }
            pending = messageId as string;
            yield* sql`
              UPDATE workflow_dispatch_outbox
              SET steer_pending_message_id = ${messageId as string},
                  steer_pending_text = ${text}
              WHERE dispatch_id = ${dispatchId as string}
                AND steer_pending_message_id IS NULL
            `.pipe(Effect.catch(() => Effect.void));
            return true;
          }),
        clearSteerPending: (dispatchId, messageId) =>
          Effect.gen(function* () {
            if (pending === (messageId as string) || pending === null) {
              pending = null;
            }
            yield* sql`
              UPDATE workflow_dispatch_outbox
              SET steer_pending_message_id = NULL,
                  steer_pending_text = NULL
              WHERE dispatch_id = ${dispatchId as string}
                AND steer_pending_message_id = ${messageId as string}
            `.pipe(Effect.catch(() => Effect.void));
          }),
        ackSteerDelivered: (dispatchId, messageId) =>
          Effect.gen(function* () {
            if (pending !== (messageId as string) && pending !== null) {
              return false;
            }
            pending = null;
            const acceptedAt = "2026-07-24T00:00:05.000Z";
            yield* sql`
              UPDATE workflow_dispatch_outbox
              SET steer_accepted_at = ${acceptedAt},
                  steer_count = COALESCE(steer_count, 0) + 1,
                  steer_delivered_message_id = ${messageId as string},
                  steer_delivered_text = COALESCE(steer_pending_text, ''),
                  steer_pending_message_id = NULL,
                  steer_pending_text = NULL
              WHERE dispatch_id = ${dispatchId as string}
                AND (
                  steer_pending_message_id = ${messageId as string}
                  OR steer_pending_message_id IS NULL
                )
            `.pipe(Effect.catch(() => Effect.void));
            return true;
          }),
        listStagedSteerDeliveries: () => Effect.succeed([]),
        clearStagedSteerDelivery: (dispatchId, messageId) =>
          sql`
            UPDATE workflow_dispatch_outbox
            SET steer_delivered_message_id = NULL,
                steer_delivered_text = NULL
            WHERE dispatch_id = ${dispatchId as string}
              AND steer_delivered_message_id = ${messageId as string}
          `.pipe(
            Effect.catch(() => Effect.void),
            Effect.asVoid,
          ),
        awaitTerminal: () => Effect.succeed({ ok: true, turnId: "turn-1" as never }),
        awaitStepTerminal: () => Effect.succeed({ ok: true, turnId: "turn-1" as never }),
        recoverPending: () => Effect.void,
      } as ProviderDispatchOutboxShape;
    }),
  );

const turnPortLayer = Layer.succeed(ProviderTurnPort, {
  ensureTurnStarted: () => Effect.succeed({ turnId: "turn-1" as never }),
  steerTurn: (input) =>
    Effect.gen(function* () {
      if (steerShouldFail) {
        return yield* Effect.fail(new Error("provider refused steer") as never);
      }
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
    // Outbox Layer.effect needs SqlClient from the foundation stack.
    Layer.provideMerge(makeOutboxLayer(target).pipe(Layer.provide(baseLayer))),
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
        step_run_id, pipeline_run_id, ticket_id, step_key, step_type, status, started_at,
        steer_count
      ) VALUES (
        ${stepRunId}, ${`pipe-steer-${n}`}, ${ticketId}, 'code', 'agent', 'running',
        '2026-07-24T00:00:00.000Z', 0
      )
    `;
    yield* sql`
      UPDATE projection_ticket SET status = 'running' WHERE ticket_id = ${ticketId}
    `;
  } else {
    yield* sql`
      UPDATE projection_step_run
      SET status = 'running', step_type = 'agent', steer_count = 0
      WHERE step_run_id = ${stepRunId}
    `;
    yield* sql`
      UPDATE projection_ticket SET status = 'running' WHERE ticket_id = ${ticketId}
    `;
  }

  // Real outbox row so the ack fiber can update steer_accepted_at / steer_count.
  yield* sql`
    INSERT OR REPLACE INTO workflow_dispatch_outbox (
      dispatch_id, ticket_id, step_run_id, thread_id, provider_instance, model,
      instruction, worktree_path, status, turn_id, created_at, started_at,
      capture_output, panel_size, steer_count
    ) VALUES (
      'dispatch-steer', ${ticketId}, ${stepRunId}, 'thread-steer',
      'codex', 'gpt-5.5', 'do work', '/tmp/wt', 'started', 'turn-steer',
      '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z',
      0, 1, 0
    )
  `;

  return { ticketId, stepRunId: stepRunId as string };
});

const waitUntil = (predicate: () => Effect.Effect<boolean>, attempts = 40) =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      if (yield* predicate()) {
        return;
      }
      // Advance TestClock so the engine's forkDetach ack fiber (250ms polls) runs.
      yield* TestClock.adjust("300 millis");
      yield* Effect.yieldNow;
    }
    return yield* Effect.die("waitUntil timed out");
  });

const target: SteerTarget = {
  dispatchId: "dispatch-steer" as never,
  threadId: "thread-steer" as never,
  turnId: "turn-steer" as never,
  runtimeMode: "full-access",
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
      steerShouldFail = false;
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

  it.effect("on delivered receipt: StepSteered + steering message + accepted_at + steerCount", () =>
    Effect.gen(function* () {
      pending = null;
      steerCalls = [];
      steerShouldFail = false;
      const engine = yield* WorkflowEngine;
      const sql = yield* SqlClient.SqlClient;
      const { ticketId, stepRunId } = yield* seedRunningAgent;
      const messageId = "msg-steer-ack-e2e";

      yield* engine.steerTicketStep({
        ticketId: ticketId as never,
        stepRunId: stepRunId as never,
        messageId: messageId as never,
        text: "fix the wrong package",
      });
      assert.equal(steerCalls.length, 1);

      // Simulate reactor receipt the ack fiber watches.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'act-steer-delivered',
          'thread-steer',
          'turn-steer',
          'info',
          'workflow.steer.delivered',
          'Workflow steer delivered',
          ${encodeJsonString({ messageId, commandId: `workflow-steer-${messageId}` })},
          '2026-07-24T00:00:01.000Z'
        )
      `;

      yield* waitUntil(() =>
        sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM workflow_events
            WHERE event_type = 'StepSteered'
              AND json_extract(payload_json, '$.messageId') = ${messageId}
          `.pipe(
          Effect.map((rows) => (rows[0]?.count ?? 0) >= 1),
          Effect.orElseSucceed(() => false),
        ),
      );

      const events = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM workflow_events
        WHERE event_type = 'StepSteered'
          AND json_extract(payload_json, '$.messageId') = ${messageId}
      `;
      assert.equal(events[0]?.count, 1);

      const messages = yield* sql<{
        readonly kind: string | null;
        readonly body: string;
      }>`
        SELECT kind, body
        FROM projection_ticket_message
        WHERE message_id = ${messageId}
      `;
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.kind, "steering");
      assert.equal(messages[0]?.body, "fix the wrong package");

      const step = yield* sql<{
        readonly steerCount: number;
        readonly lastSteeredAt: string | null;
      }>`
        SELECT steer_count AS "steerCount", last_steered_at AS "lastSteeredAt"
        FROM projection_step_run
        WHERE step_run_id = ${stepRunId}
      `;
      assert.equal(step[0]?.steerCount, 1);
      assert.isTrue(typeof step[0]?.lastSteeredAt === "string");

      const outbox = yield* sql<{
        readonly acceptedAt: string | null;
        readonly pending: string | null;
        readonly steerCount: number;
      }>`
        SELECT
          steer_accepted_at AS "acceptedAt",
          steer_pending_message_id AS "pending",
          steer_count AS "steerCount"
        FROM workflow_dispatch_outbox
        WHERE dispatch_id = 'dispatch-steer'
      `;
      assert.isTrue(typeof outbox[0]?.acceptedAt === "string");
      assert.equal(outbox[0]?.pending, null);
      assert.isTrue((outbox[0]?.steerCount ?? 0) >= 1);
    }),
  );

  it.effect("failed submit leaves no StepSteered and clears pending", () =>
    Effect.gen(function* () {
      pending = null;
      steerCalls = [];
      steerShouldFail = true;
      const engine = yield* WorkflowEngine;
      const sql = yield* SqlClient.SqlClient;
      const { ticketId, stepRunId } = yield* seedRunningAgent;
      const messageId = "msg-steer-fail-submit";

      const exit = yield* Effect.exit(
        engine.steerTicketStep({
          ticketId: ticketId as never,
          stepRunId: stepRunId as never,
          messageId: messageId as never,
          text: "should fail",
        }),
      );
      assert.isTrue(exit._tag === "Failure");
      assert.equal(pending, null);
      assert.equal(steerCalls.length, 0);

      const events = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM workflow_events
        WHERE event_type = 'StepSteered'
          AND json_extract(payload_json, '$.messageId') = ${messageId}
      `;
      assert.equal(events[0]?.count, 0);

      const outbox = yield* sql<{
        readonly acceptedAt: string | null;
        readonly steerCount: number;
      }>`
        SELECT steer_accepted_at AS "acceptedAt", steer_count AS "steerCount"
        FROM workflow_dispatch_outbox
        WHERE dispatch_id = 'dispatch-steer'
      `;
      assert.equal(outbox[0]?.acceptedAt, null);
      assert.equal(outbox[0]?.steerCount, 0);
    }),
  );

  it.effect("failed receipt clears pending without StepSteered or count bump", () =>
    Effect.gen(function* () {
      pending = null;
      steerCalls = [];
      steerShouldFail = false;
      const engine = yield* WorkflowEngine;
      const sql = yield* SqlClient.SqlClient;
      const { ticketId, stepRunId } = yield* seedRunningAgent;
      const messageId = "msg-steer-fail-receipt";

      yield* engine.steerTicketStep({
        ticketId: ticketId as never,
        stepRunId: stepRunId as never,
        messageId: messageId as never,
        text: "will fail at provider",
      });
      assert.equal(pending, messageId);

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'act-steer-failed',
          'thread-steer',
          NULL,
          'error',
          'workflow.steer.failed',
          'Workflow steer failed',
          ${encodeJsonString({ messageId, commandId: `workflow-steer-${messageId}` })},
          '2026-07-24T00:00:02.000Z'
        )
      `;

      yield* waitUntil(() => Effect.succeed(pending === null));

      const events = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM workflow_events
        WHERE event_type = 'StepSteered'
          AND json_extract(payload_json, '$.messageId') = ${messageId}
      `;
      assert.equal(events[0]?.count, 0);

      const outbox = yield* sql<{
        readonly acceptedAt: string | null;
        readonly steerCount: number;
      }>`
        SELECT steer_accepted_at AS "acceptedAt", steer_count AS "steerCount"
        FROM workflow_dispatch_outbox
        WHERE dispatch_id = 'dispatch-steer'
      `;
      assert.equal(outbox[0]?.acceptedAt, null);
      assert.equal(outbox[0]?.steerCount, 0);
    }),
  );

  it.effect("same messageId is no-op success after pending cleared by delivered receipt", () =>
    Effect.gen(function* () {
      pending = null;
      steerCalls = [];
      steerShouldFail = false;
      const engine = yield* WorkflowEngine;
      const sql = yield* SqlClient.SqlClient;
      const { ticketId, stepRunId } = yield* seedRunningAgent;
      const messageId = "msg-steer-idempotent";

      yield* engine.steerTicketStep({
        ticketId: ticketId as never,
        stepRunId: stepRunId as never,
        messageId: messageId as never,
        text: "once",
      });
      assert.equal(steerCalls.length, 1);

      // Delivered receipt + clear pending without waiting for StepSteered.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES (
          'act-steer-idem',
          'thread-steer',
          'turn-steer',
          'info',
          'workflow.steer.delivered',
          'Workflow steer delivered',
          ${encodeJsonString({ messageId })},
          '2026-07-24T00:00:03.000Z'
        )
      `;
      pending = null;

      const again = yield* engine.steerTicketStep({
        ticketId: ticketId as never,
        stepRunId: stepRunId as never,
        messageId: messageId as never,
        text: "once",
      });
      assert.deepEqual(again, { accepted: true });
      // Must not re-dispatch.
      assert.equal(steerCalls.length, 1);
    }),
  );

  it.effect("rejects parked tickets with frozen message", () =>
    Effect.gen(function* () {
      pending = null;
      steerShouldFail = false;
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
        assert.isTrue(String(exit.cause).includes(STEER_REJECTION.parkedTicket));
      }
    }),
  );

  it.effect("rejects concurrent second steer while pending", () =>
    Effect.gen(function* () {
      pending = "msg-first";
      steerShouldFail = false;
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
      steerShouldFail = false;
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
