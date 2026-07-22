// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import {
  WorkflowDefinition,
  WorkflowEventId,
  type StepOutcome,
  type WorkflowParkActionResult,
} from "@t3tools/contracts";
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
    for (let attempt = 0; attempt < 200; attempt += 1) {
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

const parkedEventFor = (ticketId: string) =>
  eventsFor(ticketId).pipe(
    Effect.map((events) => events.find((event) => event.type === "TicketParked") ?? null),
  );

// ── (a) happy path: "moved" + manual TicketMovedToLane + parked cleared + a
//        proven budget/streak reset. ───────────────────────────────────────

// Single agent step that always asks to revise. Transition 1 loops back to the
// same lane while runCount < 2 (a routed move that does NOT reset the budget);
// transition 2 parks waiting once the budget is spent. So the ticket parks after
// exactly 2 pipeline runs. An unpark "Continue" is a MANUAL move back into the
// lane, which resets the runCount budget — proven by requiring 2 fresh runs
// before the ticket re-parks (a non-reset would re-park on the very first run).
const budgetDefinition = {
  name: "budget-wf",
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
          captureOutput: true,
        },
      ],
      transitions: [
        {
          when: {
            and: [
              { "==": [{ var: "steps.code.output.verdict" }, "revise"] },
              { "<": [{ var: "lane.runCount" }, 2] },
            ],
          },
          to: "impl",
        },
        {
          when: { "==": [{ var: "steps.code.output.verdict" }, "revise"] },
          to: {
            park: "waiting",
            label: "Needs manual review",
            actions: [{ label: "Continue", to: "impl" }],
          },
        },
      ],
    },
  ],
};

const budgetExecutor = makeScriptedExecutor(() => ({
  _tag: "completed",
  output: { verdict: "revise" },
}));
const budgetLayer = it.layer(baseLayer(budgetExecutor.layer));

budgetLayer("invokeParkAction happy path", (it) => {
  it.effect("moves the ticket, clears parked state, and resets the runCount budget", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-budget" as never, budgetDefinition as never);
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-budget" as never,
        title: "Budget work",
        initialLane: "impl" as never,
      });

      // Parks waiting after exactly two pipeline runs (runCount 1 loops, 2 parks).
      yield* awaitParked(ticketId as string);
      assert.equal(budgetExecutor.calls.count, 2);

      const parked = yield* parkedEventFor(ticketId as string);
      assert.ok(parked?.type === "TicketParked");
      const parkedEventId = parked.eventId;

      const result: WorkflowParkActionResult = yield* engine.invokeParkAction(
        ticketId,
        0,
        parkedEventId,
      );
      assert.equal(result, "moved");

      // Parked cleared + a fresh admission token (the unpark is a real move).
      const afterMove = yield* awaitTicketWhere(
        ticketId as string,
        (detail) =>
          detail?.ticket.status !== "parked" && detail?.ticket.currentLaneEntryToken !== null,
      );
      assert.notEqual(afterMove?.ticket.status, "parked");
      assert.equal(afterMove?.ticket.currentLaneKey, "impl");
      assert.equal(afterMove?.ticket.parkedEventId ?? null, null);
      assert.equal(afterMove?.ticket.parkOrigin ?? null, null);

      // Exactly one manual move was emitted by the unpark.
      const events = yield* eventsFor(ticketId as string);
      const manualMoves = events.filter(
        (event) => event.type === "TicketMovedToLane" && event.payload.reason === "manual",
      );
      assert.equal(manualMoves.length, 1);

      // Budget reset proof: the ticket needs TWO fresh pipeline runs after the
      // unpark before it re-parks. Total runs = 2 (pre-unpark) + 2 (post-reset)
      // = 4. A non-reset would have re-parked on the first post-unpark run (3).
      yield* awaitTicketWhere(
        ticketId as string,
        (detail) => detail?.ticket.status === "parked" && budgetExecutor.calls.count >= 4,
      );
      assert.equal(budgetExecutor.calls.count, 4);
      const reparked = yield* parkedEventFor(ticketId as string);
      assert.ok(reparked?.type === "TicketParked");
    }),
  );
});

// ── (b) "stale" on not-parked and on mismatched parkedEventId (no events). ───

const idleExecutor = makeScriptedExecutor(() => ({ _tag: "completed" }));
const idleLayer = it.layer(baseLayer(idleExecutor.layer));

idleLayer("invokeParkAction stale paths", (it) => {
  it.effect("returns stale for a ticket that is not parked and emits nothing", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-idle" as never,
        { name: "idle-wf", lanes: [{ key: "hold", name: "Hold", entry: "manual" }] } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-idle" as never,
        title: "Idle",
        initialLane: "hold" as never,
      });

      const before = yield* eventsFor(ticketId as string);
      const result = yield* engine.invokeParkAction(
        ticketId,
        0,
        WorkflowEventId.make("evt-not-real"),
      );
      assert.equal(result, "stale");
      const after = yield* eventsFor(ticketId as string);
      assert.equal(after.length, before.length);
    }),
  );
});

const mismatchExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "boom" }));
const mismatchLayer = it.layer(baseLayer(mismatchExecutor.layer));

mismatchLayer("invokeParkAction stale on parkedEventId mismatch", (it) => {
  it.effect("returns stale when the parkedEventId does not match and emits nothing", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-mismatch" as never,
        {
          name: "mismatch-wf",
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
                      label: "Broke",
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
        boardId: "b-mismatch" as never,
        title: "Fails",
        initialLane: "impl" as never,
      });
      yield* awaitParked(ticketId as string);

      const before = yield* eventsFor(ticketId as string);
      const result = yield* engine.invokeParkAction(ticketId, 0, WorkflowEventId.make("evt-wrong"));
      assert.equal(result, "stale");
      const after = yield* eventsFor(ticketId as string);
      assert.equal(after.length, before.length);
      // Still parked.
      const detail = yield* awaitParked(ticketId as string);
      assert.equal(detail?.ticket.status, "parked");
    }),
  );
});

// ── (c) double-invoke race: exactly one "moved", one "stale". ────────────────

const raceExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "boom" }));
const raceLayer = it.layer(baseLayer(raceExecutor.layer));

raceLayer("invokeParkAction double-invoke race", (it) => {
  it.effect("two concurrent invocations yield exactly one moved and one stale", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-race" as never,
        {
          name: "race-wf",
          lanes: [
            {
              key: "impl",
              name: "Impl",
              entry: "manual",
              pipeline: [
                {
                  key: "code",
                  type: "agent",
                  agent: { instance: "claude_main", model: "sonnet" },
                  instruction: "do it",
                  on: {
                    failure: {
                      park: "issue",
                      label: "Broke",
                      actions: [{ label: "Retry", to: "done" }],
                    },
                  },
                },
              ],
            },
            { key: "done", name: "Done", entry: "manual", terminal: true },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-race" as never,
        title: "Fails",
        initialLane: "impl" as never,
      });
      yield* engine.runLane(ticketId);
      yield* awaitParked(ticketId as string);

      const parked = yield* parkedEventFor(ticketId as string);
      assert.ok(parked?.type === "TicketParked");
      const parkedEventId = parked.eventId;

      const results = yield* Effect.all(
        [
          engine.invokeParkAction(ticketId, 0, parkedEventId),
          engine.invokeParkAction(ticketId, 0, parkedEventId),
        ],
        { concurrency: 2 },
      );
      const moved = results.filter((r) => r === "moved").length;
      const stale = results.filter((r) => r === "stale").length;
      assert.equal(moved, 1);
      assert.equal(stale, 1);
    }),
  );
});

// ── (d) deleted action target lane → typed error, ticket still parked. ───────

const deletedTargetExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "boom" }));
const deletedTargetLayer = it.layer(baseLayer(deletedTargetExecutor.layer));

deletedTargetLayer("invokeParkAction with a deleted action target lane", (it) => {
  it.effect("fails with a typed error and leaves the ticket parked", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-del" as never,
        {
          name: "del-wf",
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
                      label: "Broke",
                      // Target lane "gone" is not present in the definition.
                      actions: [{ label: "Retry", to: "gone" }],
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
        boardId: "b-del" as never,
        title: "Fails",
        initialLane: "impl" as never,
      });
      yield* awaitParked(ticketId as string);

      const parked = yield* parkedEventFor(ticketId as string);
      assert.ok(parked?.type === "TicketParked");

      const exit = yield* engine.invokeParkAction(ticketId, 0, parked.eventId).pipe(Effect.exit);
      assert.equal(exit._tag, "Failure");

      const detail = yield* awaitParked(ticketId as string);
      assert.equal(detail?.ticket.status, "parked");
    }),
  );
});

// ── (e) guard #3: plain moveTicket to a deleted lane errors; a routed move to a
//        deleted lane still emits TicketBlocked (regression). ────────────────

const guardExecutor = makeScriptedExecutor(() => ({ _tag: "completed" }));
const guardLayer = it.layer(baseLayer(guardExecutor.layer));

guardLayer("missing-lane guard for manual vs routed moves", (it) => {
  it.effect("manual moveTicket into a missing lane fails with a typed error", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-manual" as never,
        { name: "manual-wf", lanes: [{ key: "hold", name: "Hold", entry: "manual" }] } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-manual" as never,
        title: "Held",
        initialLane: "hold" as never,
      });

      const exit = yield* engine.moveTicket(ticketId, "ghost" as never).pipe(Effect.exit);
      assert.equal(exit._tag, "Failure");
    }),
  );

  it.effect("routed move into a missing lane still emits TicketBlocked", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-routed" as never,
        {
          name: "routed-wf",
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
              ],
              // Routes success to a lane that does not exist.
              on: { success: "nowhere" },
            },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-routed" as never,
        title: "Routes nowhere",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitTicketWhere(
        ticketId as string,
        (current) => current?.ticket.attentionKind === "blocked",
      );
      assert.equal(detail?.ticket.attentionKind, "blocked");
      const events = yield* eventsFor(ticketId as string);
      assert.ok(events.some((event) => event.type === "TicketBlocked"));
    }),
  );
});
