// @effect-diagnostics globalTimers:off
//
// Task 9 (deliverable A): recovery invariants for a parked ticket. Every
// recovery/admission sweep must treat a parked ticket (current_lane_entry_token
// = NULL, queued_at = NULL) as inert — never restarted, never counted as
// occupying its WIP slot, never released as if it were merely queued.
import { assert, it } from "@effect/vitest";
import type { StepOutcome } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
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

// ── Harness (copied from WorkflowEngine.park.test.ts). ──────────────────────

const makeScriptedExecutor = (
  outcomeForCall: (call: number) => StepOutcome,
): { readonly calls: { count: number }; readonly layer: Layer.Layer<StepExecutor> } => {
  const calls = { count: 0 };
  const layer = Layer.succeed(StepExecutor, {
    execute: () =>
      Effect.sync(() => {
        calls.count += 1;
        return outcomeForCall(calls.count);
      }),
  } satisfies StepExecutorShape);
  return { calls, layer };
};

const baseLayer = (executor: Layer.Layer<StepExecutor>) =>
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

const awaitTicketWhere = (ticketId: string, predicate: (detail: TicketDetail | null) => boolean) =>
  Effect.gen(function* () {
    const read = yield* WorkflowReadModel;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const detail = yield* read.getTicketDetail(ticketId as never);
      if (predicate(detail)) {
        return detail;
      }
      yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 10)));
      yield* Effect.yieldNow;
    }
    return yield* read.getTicketDetail(ticketId as never);
  });

const awaitParked = (ticketId: string) =>
  awaitTicketWhere(ticketId, (detail) => detail?.ticket.status === "parked");

const eventsFor = (ticketId: string) =>
  Effect.gen(function* () {
    const store = yield* WorkflowEventStore;
    return yield* Stream.runCollect(store.readByTicket(ticketId as never)).pipe(
      Effect.map((chunk) => Array.from(chunk)),
    );
  });

// Settle: give any (incorrect) sweep effect a moment to land before asserting
// a negative (no new event / no change).
const settle = Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 60)));

// ---------------------------------------------------------------------------
// (A.1) recoverBoardWip must not restart a parked ticket's pipeline.
// ---------------------------------------------------------------------------

const restartExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "code blew up" }));
const restartLayer = it.layer(baseLayer(restartExecutor.layer));

restartLayer("recoverBoardWip does not restart a parked ticket", (it) => {
  it.effect("no PipelineStarted for the parked ticket; token stays NULL; status stays parked", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-recover-restart" as never,
        {
          name: "recover-restart",
          lanes: [
            {
              key: "impl",
              name: "Impl",
              entry: "auto",
              pipeline: [
                {
                  key: "code",
                  type: "agent",
                  agent: { instance: "claude_main", model: "sonnet" },
                  instruction: "do it",
                  on: {
                    failure: {
                      park: "issue",
                      label: "Hit a snag",
                      actions: [{ label: "Retry", to: "impl" }],
                    },
                  },
                },
              ],
            },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-recover-restart" as never,
        title: "Fails then parks",
        initialLane: "impl" as never,
      });

      yield* awaitParked(ticketId as string);
      const callsBeforeRecover = restartExecutor.calls.count;
      const eventsBefore = yield* eventsFor(ticketId as string);
      const pipelineStartsBefore = eventsBefore.filter(
        (event) => event.type === "PipelineStarted",
      ).length;
      // Sanity: the ticket's single (pre-park) pipeline run already started —
      // otherwise the "no NEW restart" comparison below would be vacuous.
      assert.equal(pipelineStartsBefore, 1);

      yield* engine.recoverBoardWip("b-recover-restart" as never);
      yield* settle;

      // No new step execution — the pipeline was never restarted.
      assert.equal(restartExecutor.calls.count, callsBeforeRecover);

      const eventsAfter = yield* eventsFor(ticketId as string);
      assert.equal(eventsAfter.length, eventsBefore.length);
      const pipelineStartsAfter = eventsAfter.filter(
        (event) => event.type === "PipelineStarted",
      ).length;
      assert.equal(pipelineStartsAfter, pipelineStartsBefore);

      const read = yield* WorkflowReadModel;
      const detail = yield* read.getTicketDetail(ticketId);
      assert.equal(detail?.ticket.status, "parked");
      assert.equal(detail?.ticket.currentLaneEntryToken, null);
    }),
  );
});

// ---------------------------------------------------------------------------
// (A.2) recoverBoardWip's queued-release sweep does not touch a parked ticket
// sitting in an unlimited (no wipLimit) auto lane — queued_at is NULL by the
// park invariant, so the release loop's `queuedAt === null` guard skips it.
// ---------------------------------------------------------------------------

const unlimitedExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "boom" }));
const unlimitedLayer = it.layer(baseLayer(unlimitedExecutor.layer));

unlimitedLayer("recoverBoardWip queued-release sweep ignores a parked ticket", (it) => {
  it.effect("a parked ticket in an unlimited auto lane is left untouched", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-recover-unlimited" as never,
        {
          name: "recover-unlimited",
          lanes: [
            {
              key: "impl",
              name: "Impl",
              entry: "auto",
              // No wipLimit: this lane is the "unlimited auto lane" case the
              // queued-release sweep targets.
              pipeline: [
                {
                  key: "code",
                  type: "agent",
                  agent: { instance: "claude_main", model: "sonnet" },
                  instruction: "do it",
                  on: {
                    failure: {
                      park: "issue",
                      label: "Hit a snag",
                      actions: [{ label: "Retry", to: "impl" }],
                    },
                  },
                },
              ],
            },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-recover-unlimited" as never,
        title: "Fails then parks",
        initialLane: "impl" as never,
      });

      const parkedDetail = yield* awaitParked(ticketId as string);
      // The park invariant: queued_at is always NULL for a parked ticket.
      assert.equal(parkedDetail?.ticket.queuedAt ?? null, null);

      const eventsBefore = yield* eventsFor(ticketId as string);

      yield* engine.recoverBoardWip("b-recover-unlimited" as never);
      yield* settle;

      const eventsAfter = yield* eventsFor(ticketId as string);
      assert.equal(eventsAfter.length, eventsBefore.length);
      assert.isUndefined(eventsAfter.find((event) => event.type === "TicketAdmitted"));

      const read = yield* WorkflowReadModel;
      const detail = yield* read.getTicketDetail(ticketId);
      assert.equal(detail?.ticket.status, "parked");
      assert.equal(detail?.ticket.queuedAt ?? null, null);
      assert.equal(detail?.ticket.currentLaneEntryToken, null);
    }),
  );
});

// ---------------------------------------------------------------------------
// (A.3) runLane on a parked ticket fails typed and starts nothing. A parked
// ticket is non-admitted (its lane entry token is NULL), so runLane refuses
// with a typed error rather than silently succeeding: recovery is the park
// actions or a manual move. The invariant is still "no pipeline start" — a
// typed error starts nothing, and it also stops a client (web/mobile) from
// mistakenly offering a Run lane that resolves successfully yet does nothing.
// ---------------------------------------------------------------------------

const runLaneExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "boom" }));
const runLaneLayer = it.layer(baseLayer(runLaneExecutor.layer));

runLaneLayer("runLane on a parked ticket", (it) => {
  it.effect("fails typed and starts nothing: no new pipeline start, ticket stays parked", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-recover-runlane" as never,
        {
          name: "recover-runlane",
          lanes: [
            {
              key: "impl",
              name: "Impl",
              entry: "auto",
              pipeline: [
                {
                  key: "code",
                  type: "agent",
                  agent: { instance: "claude_main", model: "sonnet" },
                  instruction: "do it",
                  on: {
                    failure: {
                      park: "issue",
                      label: "Hit a snag",
                      actions: [{ label: "Retry", to: "impl" }],
                    },
                  },
                },
              ],
            },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-recover-runlane" as never,
        title: "Fails then parks",
        initialLane: "impl" as never,
      });

      yield* awaitParked(ticketId as string);
      const callsBeforeRunLane = runLaneExecutor.calls.count;
      const eventsBefore = yield* eventsFor(ticketId as string);

      const error = yield* engine.runLane(ticketId).pipe(Effect.flip);
      assert.equal(error.message, "ticket is parked — recover via park actions or move");
      yield* settle;

      // Typed error ⇒ nothing started: same invariant the old no-op asserted.
      assert.equal(runLaneExecutor.calls.count, callsBeforeRunLane);
      const eventsAfter = yield* eventsFor(ticketId as string);
      assert.equal(eventsAfter.length, eventsBefore.length);

      const read = yield* WorkflowReadModel;
      const detail = yield* read.getTicketDetail(ticketId);
      assert.equal(detail?.ticket.status, "parked");
      assert.equal(detail?.ticket.currentLaneEntryToken, null);
    }),
  );
});

// ---------------------------------------------------------------------------
// (A.4) A parked ticket in a wipLimit lane does not block admitNext — asserted
// via the recoverBoardWip path specifically. Ticket A is parked by directly
// committing TicketParked through WorkflowEventCommitter (bypassing the
// engine's own parkTicket, which would itself immediately sweep admitNext) —
// this simulates the crash window recoverBoardWip exists to close: the park
// landed (and projected) but the live post-park admission sweep never ran.
// Ticket B is manually admitted-or-queued behind A in the same wipLimit-1
// lane; recoverBoardWip's per-lane admitNext sweep must then admit B because
// countAdmittedInLane never counts A (its token is NULL).
// ---------------------------------------------------------------------------

const admitExecutor = makeScriptedExecutor(() => ({ _tag: "completed" }));
const admitLayer = it.layer(baseLayer(admitExecutor.layer));

admitLayer("recoverBoardWip admits a queued ticket behind a parked one", (it) => {
  it.effect("parked A does not block admitNext from admitting queued B", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-recover-admit" as never,
        {
          name: "recover-admit",
          lanes: [
            {
              key: "impl",
              name: "Impl",
              // Manual entry: no pipeline auto-starts on admission, so this
              // test isolates the WIP-accounting question from pipeline
              // execution entirely.
              entry: "manual",
              wipLimit: 1,
            },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;
      const committer = yield* WorkflowEventCommitter;
      const read = yield* WorkflowReadModel;

      const ticketA = yield* engine.createTicket({
        boardId: "b-recover-admit" as never,
        title: "A",
        initialLane: "impl" as never,
      });
      const detailA = yield* awaitTicketWhere(
        ticketA as string,
        (detail) => detail?.ticket.currentLaneEntryToken !== null,
      );
      assert.isNotNull(detailA?.ticket.currentLaneEntryToken);

      const ticketB = yield* engine.createTicket({
        boardId: "b-recover-admit" as never,
        title: "B",
        initialLane: "impl" as never,
      });
      const detailB = yield* awaitTicketWhere(
        ticketB as string,
        (detail) => detail?.ticket.queuedAt !== null,
      );
      assert.isNotNull(detailB?.ticket.queuedAt);
      assert.equal(detailB?.ticket.currentLaneEntryToken, null);

      // Directly commit TicketParked for A — bypassing engine.parkTicket (and
      // therefore its automatic post-park admitNext sweep) to simulate a
      // crash between the park landing and the live sweep running.
      yield* committer.commit({
        type: "TicketParked",
        ticketId: ticketA,
        eventId: "evt-recover-admit-park",
        occurredAt: "2026-07-22T00:00:00.000Z",
        payload: {
          substate: "issue",
          label: "Hit a snag",
          reason: "simulated failure",
          parkOrigin: '{"src":"lane_on","key":"failure","fp":"fp-recover-admit"}',
          actionsSnapshot: [],
        },
      } as never);

      const parkedA = yield* read.getTicketDetail(ticketA);
      assert.equal(parkedA?.ticket.status, "parked");
      assert.equal(parkedA?.ticket.currentLaneEntryToken, null);

      // B is still queued: nothing has admitted it yet.
      const stillQueuedB = yield* read.getTicketDetail(ticketB);
      assert.isNotNull(stillQueuedB?.ticket.queuedAt);
      assert.equal(stillQueuedB?.ticket.currentLaneEntryToken, null);

      yield* engine.recoverBoardWip("b-recover-admit" as never);
      yield* settle;

      const admittedB = yield* awaitTicketWhere(
        ticketB as string,
        (detail) => detail?.ticket.currentLaneEntryToken !== null,
      );
      assert.equal(admittedB?.ticket.queuedAt ?? null, null);
      assert.isNotNull(admittedB?.ticket.currentLaneEntryToken);

      // A remains parked and untouched throughout.
      const finalA = yield* read.getTicketDetail(ticketA);
      assert.equal(finalA?.ticket.status, "parked");
      assert.equal(finalA?.ticket.currentLaneEntryToken, null);
    }),
  );
});

// ---------------------------------------------------------------------------
// (A.5 / NEW-1) A recovered pipeline continuation cannot start NEW work after
// an external park. completeRecoveredStep re-checks the lane-entry token before
// EVERY retry dispatch and enters completePipelineFrom non-exempt (its first
// recovered step token-checks too), so a park landing mid-continuation aborts
// it: no further StepStarted, the run closes superseded, the ticket stays
// parked. The recovered continuation is not registered in runningPipelines, so
// these token guards — not fiber interruption — are what stop it.
// ---------------------------------------------------------------------------

interface GatedRetryExecutor extends StepExecutorShape {
  readonly releaseGate: () => Effect.Effect<boolean>;
  readonly calls: { count: number };
}

const gatedRetryExecutorLayer = Layer.effect(
  StepExecutor,
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const calls = { count: 0 };
    const shape: GatedRetryExecutor = {
      // Each dispatched retry attempt records a StepStarted, then blocks here
      // until the test releases the gate; it then "fails" so the retry loop
      // considers dispatching the next attempt.
      execute: () =>
        Effect.gen(function* () {
          calls.count += 1;
          yield* Deferred.await(gate);
          return { _tag: "failed", error: "boom" } satisfies StepOutcome;
        }),
      releaseGate: () => Deferred.succeed(gate, undefined),
      calls,
    };
    return shape;
  }),
);

const recoverGuardLayer = it.layer(baseLayer(gatedRetryExecutorLayer));

const commitRecoveredCodeContext = (boardId: string, ticketId: string, token: string) =>
  Effect.gen(function* () {
    const committer = yield* WorkflowEventCommitter;
    yield* committer.commit({
      type: "TicketCreated",
      eventId: `${ticketId}-created`,
      ticketId,
      occurredAt: "2026-07-22T00:00:00.000Z",
      payload: { boardId, title: "Recovered", laneKey: "impl" },
    } as never);
    yield* committer.commit({
      type: "TicketMovedToLane",
      eventId: `${ticketId}-moved`,
      ticketId,
      occurredAt: "2026-07-22T00:00:01.000Z",
      payload: { toLane: "impl", laneEntryToken: token, reason: "initial" },
    } as never);
    yield* committer.commit({
      type: "PipelineStarted",
      eventId: `${ticketId}-pipeline`,
      ticketId,
      occurredAt: "2026-07-22T00:00:02.000Z",
      payload: { pipelineRunId: `${ticketId}-pipe`, laneKey: "impl", laneEntryToken: token },
    } as never);
    yield* committer.commit({
      type: "StepStarted",
      eventId: `${ticketId}-step`,
      ticketId,
      occurredAt: "2026-07-22T00:00:03.000Z",
      payload: {
        pipelineRunId: `${ticketId}-pipe`,
        stepRunId: `${ticketId}-run`,
        stepKey: "code",
        stepType: "agent",
        attempt: 1,
      },
    } as never);
  });

recoverGuardLayer("recovered continuation aborts on external park", (it) => {
  it.effect("no StepStarted after the park; retry loop stops; ticket stays parked", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-recover-guard" as never,
        {
          name: "recover-guard",
          lanes: [
            {
              key: "impl",
              name: "Impl",
              entry: "auto",
              pipeline: [
                {
                  key: "code",
                  type: "agent",
                  agent: { instance: "claude_main", model: "sonnet" },
                  instruction: "do it",
                  // Three attempts: attempt 1 is the recovered (pre-committed) one,
                  // attempt 2 gates in the executor, and the guard must stop
                  // attempt 3 once the park lands.
                  retry: { maxAttempts: 3 },
                  on: {
                    failure: {
                      park: "issue",
                      label: "Hit a snag",
                      actions: [{ label: "Retry", to: "impl" }],
                    },
                  },
                },
              ],
            },
          ],
        } as never,
      );

      const engine = yield* WorkflowEngine;
      const committer = yield* WorkflowEventCommitter;
      const read = yield* WorkflowReadModel;
      yield* commitRecoveredCodeContext("b-recover-guard", "ticket-rg", "tok-rg");

      const executor = (yield* StepExecutor) as GatedRetryExecutor;

      // Drive the recovered continuation on a child fiber: it records StepFailed
      // for attempt 1, then dispatches retry attempt 2 (which gates).
      const fiber = yield* engine
        .completeRecoveredStep(
          "ticket-rg-run" as never,
          { _tag: "failed", error: "attempt-1" },
          undefined,
        )
        .pipe(Effect.forkChild);

      // Wait until attempt 2 has been dispatched (its StepStarted committed, now
      // gated inside the executor).
      yield* awaitTicketWhere("ticket-rg", () => executor.calls.count >= 1);
      const startsAtGate = (yield* eventsFor("ticket-rg")).filter(
        (event) => event.type === "StepStarted",
      ).length;
      assert.equal(startsAtGate, 2);

      // Land an external park mid-continuation: nulls the token, status=parked.
      yield* committer.commit({
        type: "TicketParked",
        eventId: "evt-rg-park",
        ticketId: "ticket-rg",
        occurredAt: "2026-07-22T00:00:04.000Z",
        payload: {
          substate: "issue",
          label: "Externally parked",
          reason: "external park",
          parkOrigin: '{"src":"event","fp":"fp-rg"}',
          actionsSnapshot: [],
        },
      } as never);

      // Release: attempt 2 fails, then the retry loop's pre-dispatch token guard
      // sees the nulled token and abandons — attempt 3 never starts.
      yield* executor.releaseGate();
      yield* Fiber.join(fiber).pipe(Effect.exit);
      yield* settle;

      const events = yield* eventsFor("ticket-rg");
      const startsAfter = events.filter((event) => event.type === "StepStarted").length;
      assert.equal(startsAfter, 2);
      assert.isDefined(
        events.find(
          (event) => event.type === "PipelineCompleted" && event.payload.result === "superseded",
        ),
      );

      const detail = yield* read.getTicketDetail("ticket-rg" as never);
      assert.equal(detail?.ticket.status, "parked");
      assert.equal(detail?.ticket.currentLaneEntryToken, null);
    }),
  );
});

// Regression: with NO park, a recovered continuation still runs its retries to
// completion — the non-exempt first-step guard must not spuriously abort a
// still-current recovered run.
const recoverNormalLayer = it.layer(
  baseLayer(makeScriptedExecutor(() => ({ _tag: "failed", error: "boom" })).layer),
);

recoverNormalLayer("recovered continuation runs retries normally when not parked", (it) => {
  it.effect("retry attempt 2 dispatches and the ticket parks via the normal failure route", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-recover-normal" as never,
        {
          name: "recover-normal",
          lanes: [
            {
              key: "impl",
              name: "Impl",
              entry: "auto",
              pipeline: [
                {
                  key: "code",
                  type: "agent",
                  agent: { instance: "claude_main", model: "sonnet" },
                  instruction: "do it",
                  retry: { maxAttempts: 2 },
                  on: {
                    failure: {
                      park: "issue",
                      label: "Hit a snag",
                      actions: [{ label: "Retry", to: "impl" }],
                    },
                  },
                },
              ],
            },
          ],
        } as never,
      );

      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      yield* commitRecoveredCodeContext("b-recover-normal", "ticket-rn", "tok-rn");

      yield* engine.completeRecoveredStep(
        "ticket-rn-run" as never,
        { _tag: "failed", error: "attempt-1" },
        undefined,
      );
      yield* settle;

      const events = yield* eventsFor("ticket-rn");
      // Attempt 1 (pre-committed) + attempt 2 (retry dispatched) = 2 StepStarted.
      const starts = events.filter((event) => event.type === "StepStarted").length;
      assert.equal(starts, 2);

      const detail = yield* read.getTicketDetail("ticket-rn" as never);
      assert.equal(detail?.ticket.status, "parked");
      assert.equal(detail?.ticket.currentLaneEntryToken, null);
      // Parked via the normal failure route (not superseded): a TicketParked with
      // the lane_on failure origin exists.
      assert.isDefined(events.find((event) => event.type === "TicketParked"));
    }),
  );
});

// ---------------------------------------------------------------------------
// (A.5b / round-3 NEW-1) A recovered continuation that HANDS OFF to
// completePipelineFrom for a SUBSEQUENT multi-attempt step must also stop
// dispatching new retry attempts once an external park lands. This exercises the
// INTRA-step retry loop's per-dispatch token guard in completePipelineFrom —
// distinct from the recovered-step retry loop in continueRecoveredPipeline
// (A.5). The recovered "code" step COMPLETES, handing off to completePipelineFrom
// for "test" (maxAttempts 3); "test" attempt 1 gates, a park lands, the gate
// releases → the intra-step guard trips before attempt 2: no further StepStarted,
// the run closes superseded, the ticket stays parked.
// ---------------------------------------------------------------------------

const completeFromGuardLayer = it.layer(baseLayer(gatedRetryExecutorLayer));

completeFromGuardLayer(
  "completePipelineFrom retry loop aborts on external park (recovery handoff)",
  (it) => {
    it.effect(
      "no second StepStarted for the subsequent step; run closes superseded; ticket stays parked",
      () =>
        Effect.gen(function* () {
          const registry = yield* BoardRegistry;
          yield* registry.register(
            "b-cpf-guard" as never,
            {
              name: "cpf-guard",
              lanes: [
                {
                  key: "impl",
                  name: "Impl",
                  entry: "auto",
                  pipeline: [
                    {
                      key: "code",
                      type: "agent",
                      agent: { instance: "claude_main", model: "sonnet" },
                      instruction: "do it",
                    },
                    {
                      key: "test",
                      type: "agent",
                      agent: { instance: "claude_main", model: "sonnet" },
                      instruction: "test it",
                      // 3 attempts: attempt 1 gates in the executor; the intra-step
                      // guard must stop attempt 2 once the park lands.
                      retry: { maxAttempts: 3 },
                      on: {
                        failure: {
                          park: "issue",
                          label: "Hit a snag",
                          actions: [{ label: "Retry", to: "impl" }],
                        },
                      },
                    },
                  ],
                },
              ],
            } as never,
          );

          const engine = yield* WorkflowEngine;
          const committer = yield* WorkflowEventCommitter;
          const read = yield* WorkflowReadModel;
          yield* commitRecoveredCodeContext("b-cpf-guard", "ticket-cpf", "tok-cpf");

          const executor = (yield* StepExecutor) as GatedRetryExecutor;

          // Recovered "code" COMPLETES → hands off to completePipelineFrom for
          // "test" at the next index. Drive on a child fiber: test attempt 1
          // dispatches (StepStarted) and gates in the executor.
          const fiber = yield* engine
            .completeRecoveredStep("ticket-cpf-run" as never, { _tag: "completed" }, undefined)
            .pipe(Effect.forkChild);

          yield* awaitTicketWhere("ticket-cpf", () => executor.calls.count >= 1);
          const startsAtGate = (yield* eventsFor("ticket-cpf")).filter(
            (event) => event.type === "StepStarted",
          ).length;
          // code (pre-committed) + test attempt 1 = 2.
          assert.equal(startsAtGate, 2);

          // Land an external park mid-continuation: nulls the token, status=parked.
          yield* committer.commit({
            type: "TicketParked",
            eventId: "evt-cpf-park",
            ticketId: "ticket-cpf",
            occurredAt: "2026-07-22T00:00:05.000Z",
            payload: {
              substate: "issue",
              label: "Externally parked",
              reason: "external park",
              parkOrigin: '{"src":"event","fp":"fp-cpf"}',
              actionsSnapshot: [],
            },
          } as never);

          // Release: attempt 1 fails, then the intra-step retry guard sees the
          // nulled token and abandons — attempt 2 never starts.
          yield* executor.releaseGate();
          yield* Fiber.join(fiber).pipe(Effect.exit);
          yield* settle;

          const events = yield* eventsFor("ticket-cpf");
          const startsAfter = events.filter((event) => event.type === "StepStarted").length;
          assert.equal(startsAfter, 2);
          assert.isDefined(
            events.find(
              (event) =>
                event.type === "PipelineCompleted" && event.payload.result === "superseded",
            ),
          );

          const detail = yield* read.getTicketDetail("ticket-cpf" as never);
          assert.equal(detail?.ticket.status, "parked");
          assert.equal(detail?.ticket.currentLaneEntryToken, null);
        }),
    );
  },
);

// Regression control: with NO park, completePipelineFrom's retry loop dispatches
// every attempt of the subsequent step — the added per-dispatch token guard must
// not spuriously abort a still-current run.
const completeFromNormalLayer = it.layer(
  baseLayer(makeScriptedExecutor(() => ({ _tag: "failed", error: "boom" })).layer),
);

completeFromNormalLayer(
  "completePipelineFrom retry loop runs every attempt when not parked (recovery handoff)",
  (it) => {
    it.effect(
      "the subsequent step dispatches all 3 attempts and parks via the normal failure route",
      () =>
        Effect.gen(function* () {
          const registry = yield* BoardRegistry;
          yield* registry.register(
            "b-cpf-normal" as never,
            {
              name: "cpf-normal",
              lanes: [
                {
                  key: "impl",
                  name: "Impl",
                  entry: "auto",
                  pipeline: [
                    {
                      key: "code",
                      type: "agent",
                      agent: { instance: "claude_main", model: "sonnet" },
                      instruction: "do it",
                    },
                    {
                      key: "test",
                      type: "agent",
                      agent: { instance: "claude_main", model: "sonnet" },
                      instruction: "test it",
                      retry: { maxAttempts: 3 },
                      on: {
                        failure: {
                          park: "issue",
                          label: "Hit a snag",
                          actions: [{ label: "Retry", to: "impl" }],
                        },
                      },
                    },
                  ],
                },
              ],
            } as never,
          );

          const engine = yield* WorkflowEngine;
          const read = yield* WorkflowReadModel;
          yield* commitRecoveredCodeContext("b-cpf-normal", "ticket-cpfn", "tok-cpfn");

          yield* engine.completeRecoveredStep(
            "ticket-cpfn-run" as never,
            { _tag: "completed" },
            undefined,
          );
          yield* settle;

          const events = yield* eventsFor("ticket-cpfn");
          const starts = events.filter((event) => event.type === "StepStarted").length;
          // code (pre-committed) + test attempts 1, 2, 3 = 4.
          assert.equal(starts, 4);

          const detail = yield* read.getTicketDetail("ticket-cpfn" as never);
          assert.equal(detail?.ticket.status, "parked");
          assert.equal(detail?.ticket.currentLaneEntryToken, null);
          // Parked via the normal failure route (retries exhausted), not superseded.
          assert.isDefined(events.find((event) => event.type === "TicketParked"));
        }),
    );
  },
);

// ---------------------------------------------------------------------------
// (A.6 / NEW-1 residual) The recovered continuation's token guard covers SCRIPT
// steps too, not just agent steps. A recovered agent "code" step whose lane has
// a SCRIPT "deploy" next-step: when the ticket is parked before the continuation
// dispatches, the token guard trips and the script NEVER executes (the reachable
// side of the post-guard window). Scripts get no provider-turn cancellation, so
// this guard is the sole protection against a recovered script starting on a
// parked row. A no-park control proves the script would otherwise run — i.e. the
// guard is load-bearing.
// ---------------------------------------------------------------------------

const scriptDeployLane = {
  name: "recover-script",
  lanes: [
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      pipeline: [
        {
          key: "code",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "do it",
        },
        { key: "deploy", type: "script", run: "echo deploy" },
      ],
    },
  ],
} as never;

const scriptParkedExecutor = makeScriptedExecutor(() => ({ _tag: "completed" }));
const scriptParkedLayer = it.layer(baseLayer(scriptParkedExecutor.layer));

scriptParkedLayer("recovered script next-step does not run when parked", (it) => {
  it.effect("the token guard blocks the script dispatch; run superseded; ticket parked", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-recover-script" as never, scriptDeployLane);

      const engine = yield* WorkflowEngine;
      const committer = yield* WorkflowEventCommitter;
      const read = yield* WorkflowReadModel;
      yield* commitRecoveredCodeContext("b-recover-script", "ticket-rsp", "tok-rsp");

      // Park BEFORE the continuation runs: the next step ("deploy", a script) must
      // never be dispatched.
      yield* committer.commit({
        type: "TicketParked",
        eventId: "evt-rsp-park",
        ticketId: "ticket-rsp",
        occurredAt: "2026-07-22T00:00:04.000Z",
        payload: {
          substate: "issue",
          label: "Externally parked",
          reason: "external park",
          parkOrigin: '{"src":"event","fp":"fp-rsp"}',
          actionsSnapshot: [],
        },
      } as never);

      const callsBefore = scriptParkedExecutor.calls.count;
      // "code" recovered as completed → completePipelineFrom would dispatch the
      // script "deploy", but the token guard (token now NULL) aborts first.
      yield* engine.completeRecoveredStep(
        "ticket-rsp-run" as never,
        { _tag: "completed" },
        undefined,
      );
      yield* settle;

      // The script step never executed (executor never called for "deploy").
      assert.equal(scriptParkedExecutor.calls.count, callsBefore);
      const events = yield* eventsFor("ticket-rsp");
      assert.isUndefined(
        events.find((event) => event.type === "StepStarted" && event.payload.stepKey === "deploy"),
      );
      assert.isDefined(
        events.find(
          (event) => event.type === "PipelineCompleted" && event.payload.result === "superseded",
        ),
      );

      const detail = yield* read.getTicketDetail("ticket-rsp" as never);
      assert.equal(detail?.ticket.status, "parked");
      assert.equal(detail?.ticket.currentLaneEntryToken, null);
    }),
  );
});

// Load-bearing control: with NO park, the same recovered continuation DOES
// dispatch and run the script next-step.
const scriptRunsExecutor = makeScriptedExecutor(() => ({ _tag: "completed" }));
const scriptRunsLayer = it.layer(baseLayer(scriptRunsExecutor.layer));

scriptRunsLayer("recovered script next-step runs when not parked", (it) => {
  it.effect("the script step dispatches and executes", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-recover-script-run" as never, scriptDeployLane);

      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      yield* commitRecoveredCodeContext("b-recover-script-run", "ticket-rsr", "tok-rsr");

      const callsBefore = scriptRunsExecutor.calls.count;
      yield* engine.completeRecoveredStep(
        "ticket-rsr-run" as never,
        { _tag: "completed" },
        undefined,
      );
      yield* settle;

      // The script "deploy" was dispatched and executed exactly once.
      assert.equal(scriptRunsExecutor.calls.count, callsBefore + 1);
      const events = yield* eventsFor("ticket-rsr");
      assert.isDefined(
        events.find((event) => event.type === "StepStarted" && event.payload.stepKey === "deploy"),
      );

      const detail = yield* read.getTicketDetail("ticket-rsr" as never);
      assert.notEqual(detail?.ticket.status, "parked");
    }),
  );
});
