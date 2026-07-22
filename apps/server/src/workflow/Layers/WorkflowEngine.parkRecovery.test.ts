// @effect-diagnostics globalTimers:off
//
// Task 9 (deliverable A): recovery invariants for a parked ticket. Every
// recovery/admission sweep must treat a parked ticket (current_lane_entry_token
// = NULL, queued_at = NULL) as inert — never restarted, never counted as
// occupying its WIP slot, never released as if it were merely queued.
import { assert, it } from "@effect/vitest";
import { WorkflowDefinition, type StepOutcome } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry, type BoardRegistryShape } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel, type TicketDetail } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

// ── Harness (copied from WorkflowEngine.park.test.ts — a lint-free registry so
//    these engine tests can register park-bearing definitions directly). ──────

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

const decodeDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
const isDefinition = Schema.is(WorkflowDefinition);

const LintFreeBoardRegistry = Layer.effect(
  BoardRegistry,
  Effect.gen(function* () {
    const store = yield* Ref.make<Map<string, WorkflowDefinition>>(new Map());
    return {
      register: (boardId, raw) =>
        Effect.gen(function* () {
          const definition = isDefinition(raw)
            ? raw
            : yield* decodeDefinition(raw).pipe(Effect.orDie);
          yield* Ref.update(store, (current) =>
            new Map(current).set(boardId as string, definition),
          );
          return definition;
        }),
      unregister: (boardId) =>
        Ref.update(store, (current) => {
          const next = new Map(current);
          next.delete(boardId as string);
          return next;
        }),
      getDefinition: (boardId) =>
        Ref.get(store).pipe(Effect.map((current) => current.get(boardId as string) ?? null)),
      listDefinitions: () =>
        Ref.get(store).pipe(
          Effect.map((current) =>
            Array.from(current.entries()).map(([boardId, definition]) => ({
              boardId: boardId as never,
              definition,
            })),
          ),
        ),
      getLane: (boardId, laneKey) =>
        Ref.get(store).pipe(
          Effect.map(
            (current) =>
              current.get(boardId as string)?.lanes.find((lane) => lane.key === laneKey) ?? null,
          ),
        ),
    } satisfies BoardRegistryShape;
  }),
);

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
    Layer.provideMerge(LintFreeBoardRegistry),
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
// (A.3) runLane on a parked ticket is a no-op: no error, no pipeline start.
// runLane reads the ticket's current token; a parked ticket's token is NULL,
// so the `lane && token` guard short-circuits before ever calling
// startPipeline.
// ---------------------------------------------------------------------------

const runLaneExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "boom" }));
const runLaneLayer = it.layer(baseLayer(runLaneExecutor.layer));

runLaneLayer("runLane on a parked ticket", (it) => {
  it.effect("does nothing: no error, no new pipeline start, ticket stays parked", () =>
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

      const exit = yield* engine.runLane(ticketId).pipe(Effect.exit);
      assert.equal(exit._tag, "Success");
      yield* settle;

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
