// @effect-diagnostics globalTimers:off
import { assert, describe, it } from "@effect/vitest";
import {
  isParkTarget,
  WorkflowDefinition,
  type StepOutcome,
  type WorkflowLane,
  type WorkflowParkTarget,
  type WorkflowRouteTarget,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ruleReferencesRunCount } from "../jsonLogicRule.ts";
import { parkTargetFingerprint, parseParkOrigin } from "../parkOrigin.ts";
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

// A lint-free BoardRegistry: park-target lint tolerance is Task 10's job, so
// these engine tests register park-bearing definitions directly. The engine
// reads the same stored definition the fingerprint assertions read back.
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

const parkedEventsFor = (ticketId: string) =>
  Effect.gen(function* () {
    const store = yield* WorkflowEventStore;
    const events = yield* Stream.runCollect(store.readByTicket(ticketId as never)).pipe(
      Effect.map((chunk) => Array.from(chunk)),
    );
    return events.filter((event) => event.type === "TicketParked");
  });

// Reads the park target the engine actually resolved from the current definition
// so the fingerprint assertion compares like-for-like.
const laneParkTarget = (
  boardId: string,
  laneKey: string,
  pick: (lane: WorkflowLane) => WorkflowRouteTarget | undefined,
) =>
  Effect.gen(function* () {
    const registry = yield* BoardRegistry;
    const lane = yield* registry.getLane(boardId as never, laneKey as never);
    if (lane === null) {
      return yield* Effect.die("lane not found");
    }
    const target = pick(lane);
    if (target === undefined || !isParkTarget(target)) {
      return yield* Effect.die("expected a park target");
    }
    return target satisfies WorkflowParkTarget;
  });

// ---------------------------------------------------------------------------
// (a) step_on failure → parks issue in place
// ---------------------------------------------------------------------------

const stepFailPark = makeScriptedExecutor(() => ({ _tag: "failed", error: "code blew up" }));
const stepFailLayer = it.layer(baseLayer(stepFailPark.layer));

stepFailLayer("step.on.failure park", (it) => {
  it.effect("parks in place with a step origin and the step's error as the reason", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-step" as never,
        {
          name: "step-park",
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
        boardId: "b-step" as never,
        title: "Fails",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitParked(ticketId as string);
      assert.equal(detail?.ticket.status, "parked");
      assert.equal(detail?.ticket.currentLaneKey, "impl"); // lane unchanged
      assert.equal(detail?.ticket.currentLaneEntryToken, null); // token nulled by projection
      assert.equal(detail?.ticket.attentionKind, "parked_issue");
      assert.equal(detail?.ticket.parkedSubstate, "issue");

      const parked = yield* parkedEventsFor(ticketId as string);
      assert.equal(parked.length, 1);
      const event = parked[0];
      assert.ok(event?.type === "TicketParked");
      if (event?.type === "TicketParked") {
        assert.equal(event.payload.substate, "issue");
        assert.equal(event.payload.label, "Hit a snag");
        assert.equal(event.payload.reason, "code blew up");
        const origin = parseParkOrigin(event.payload.parkOrigin);
        assert.equal(origin?.src, "step");
        assert.equal(origin?.stepKey, "code");
        assert.equal(origin?.key, "failure");
        const target = yield* laneParkTarget(
          "b-step",
          "impl",
          (lane) => lane.pipeline?.[0]?.on?.failure,
        );
        assert.equal(origin?.fp, parkTargetFingerprint(target));
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// (b) lane transition (runCount-guarded) → parks waiting; budget reason
// ---------------------------------------------------------------------------

const transitionPark = makeScriptedExecutor(() => ({ _tag: "completed" }));
const transitionLayer = it.layer(baseLayer(transitionPark.layer));

transitionLayer("transition park", (it) => {
  it.effect("parks waiting with a transition origin and a budget-exhausted reason", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-trans" as never,
        {
          name: "transition-park",
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
              transitions: [
                {
                  when: { "<": [{ var: "lane.runCount" }, 3] },
                  to: {
                    park: "waiting",
                    label: "Take a look",
                    actions: [{ label: "Continue", to: "impl" }],
                  },
                },
              ],
            },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-trans" as never,
        title: "Loops",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitParked(ticketId as string);
      assert.equal(detail?.ticket.attentionKind, "parked_waiting");
      assert.equal(detail?.ticket.currentLaneKey, "impl");

      const parked = yield* parkedEventsFor(ticketId as string);
      const event = parked[0];
      assert.ok(event?.type === "TicketParked");
      if (event?.type === "TicketParked") {
        assert.equal(event.payload.substate, "waiting");
        assert.equal(event.payload.reason, "review budget exhausted after 1 passes");
        const origin = parseParkOrigin(event.payload.parkOrigin);
        assert.equal(origin?.src, "transition");
        assert.equal(origin?.key, undefined);
        const target = yield* laneParkTarget(
          "b-trans",
          "impl",
          (lane) => lane.transitions?.[0]?.to,
        );
        assert.equal(origin?.fp, parkTargetFingerprint(target));
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// (c) lane.on.failure park → parks issue; lane_on origin; error reason
// ---------------------------------------------------------------------------

const laneOnFail = makeScriptedExecutor(() => ({ _tag: "failed", error: "kaboom" }));
const laneOnFailLayer = it.layer(baseLayer(laneOnFail.layer));

laneOnFailLayer("lane.on.failure park", (it) => {
  it.effect("parks issue via a lane_on origin", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-laneon" as never,
        {
          name: "lane-on-park",
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
              on: { failure: { park: "issue", actions: [{ label: "Retry", to: "impl" }] } },
            },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-laneon" as never,
        title: "Fails",
        initialLane: "impl" as never,
      });

      const detail = yield* awaitParked(ticketId as string);
      assert.equal(detail?.ticket.attentionKind, "parked_issue");

      const parked = yield* parkedEventsFor(ticketId as string);
      const event = parked[0];
      assert.ok(event?.type === "TicketParked");
      if (event?.type === "TicketParked") {
        assert.equal(event.payload.reason, "kaboom");
        assert.equal(event.payload.label, "Issue encountered"); // default issue label
        const origin = parseParkOrigin(event.payload.parkOrigin);
        assert.equal(origin?.src, "lane_on");
        assert.equal(origin?.key, "failure");
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// (d) on.success malformed verdict → parks waiting; freed WIP admits queued B
// ---------------------------------------------------------------------------

const successParkExecutor = makeScriptedExecutor((call) =>
  // impl steps (odd calls) complete; review steps (even) complete with a
  // verdict that matches no transition.
  call % 2 === 1 ? { _tag: "completed" } : { _tag: "completed", output: { verdict: "???" } },
);
const successParkLayer = it.layer(baseLayer(successParkExecutor.layer));

successParkLayer("on.success malformed-verdict park", (it) => {
  it.effect("parks waiting (status, payload, attention kind) and frees the WIP slot", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-success" as never,
        {
          name: "success-park",
          lanes: [
            {
              key: "impl",
              name: "Impl",
              entry: "auto",
              wipLimit: 1,
              pipeline: [
                {
                  key: "build",
                  type: "agent",
                  agent: { instance: "claude_main", model: "sonnet" },
                  instruction: "build",
                },
                {
                  key: "review",
                  type: "agent",
                  agent: { instance: "claude_main", model: "sonnet" },
                  instruction: "review",
                  captureOutput: true,
                },
              ],
              transitions: [
                { when: { "==": [{ var: "steps.review.output.verdict" }, "approve"] }, to: "done" },
              ],
              on: {
                success: {
                  park: "waiting",
                  label: "Needs a look",
                  actions: [{ label: "Review", to: "impl" }],
                },
              },
            },
            { key: "done", name: "Done", entry: "manual", terminal: true },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketA = yield* engine.createTicket({
        boardId: "b-success" as never,
        title: "A",
        initialLane: "impl" as never,
      });
      const ticketB = yield* engine.createTicket({
        boardId: "b-success" as never,
        title: "B",
        initialLane: "impl" as never,
      });

      // (1) status parked, (2) payload, (3) attention kind
      const detailA = yield* awaitParked(ticketA as string);
      assert.equal(detailA?.ticket.status, "parked");
      assert.equal(detailA?.ticket.attentionKind, "parked_waiting");
      const parkedA = yield* parkedEventsFor(ticketA as string);
      const eventA = parkedA[0];
      assert.ok(eventA?.type === "TicketParked");
      if (eventA?.type === "TicketParked") {
        assert.equal(eventA.payload.substate, "waiting");
        assert.equal(eventA.payload.label, "Needs a look");
        assert.equal(eventA.payload.reason, "pipeline succeeded with no matching transition");
      }

      // (4) freed WIP: B was queued behind A (wipLimit 1); once A parks, B is
      // admitted, runs the same pipeline, and parks too.
      const detailB = yield* awaitParked(ticketB as string);
      assert.equal(detailB?.ticket.status, "parked");
      assert.equal(detailB?.ticket.attentionKind, "parked_waiting");
    }),
  );
});

// ---------------------------------------------------------------------------
// (e) external onEvent park → parks issue via an event origin
// ---------------------------------------------------------------------------

const eventParkExecutor = makeScriptedExecutor(() => ({ _tag: "completed" }));
const eventParkLayer = it.layer(baseLayer(eventParkExecutor.layer));

eventParkLayer("onEvent park", (it) => {
  it.effect("an external event whose target is a park parks in place", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-event" as never,
        {
          name: "event-park",
          lanes: [
            {
              key: "review",
              name: "Review",
              entry: "manual",
              onEvent: [
                {
                  name: "ci.failed",
                  to: {
                    park: "issue",
                    label: "CI broke",
                    actions: [{ label: "Retry", to: "review" }],
                  },
                },
              ],
            },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-event" as never,
        title: "PR",
        initialLane: "review" as never,
      });

      const result = yield* engine.ingestExternalEvent({
        boardId: "b-event" as never,
        name: "ci.failed",
        ticketId,
        payload: null,
      });
      assert.equal(result.outcome, "noop");

      const detail = yield* awaitParked(ticketId as string);
      assert.equal(detail?.ticket.status, "parked");
      assert.equal(detail?.ticket.currentLaneKey, "review"); // unchanged
      assert.equal(detail?.ticket.currentLaneEntryToken, null);
      assert.equal(detail?.ticket.attentionKind, "parked_issue");

      const parked = yield* parkedEventsFor(ticketId as string);
      const event = parked[0];
      assert.ok(event?.type === "TicketParked");
      if (event?.type === "TicketParked") {
        assert.equal(event.payload.reason, "external event 'ci.failed'");
        const origin = parseParkOrigin(event.payload.parkOrigin);
        assert.equal(origin?.src, "event");
        assert.equal(origin?.name, "ci.failed");
        const target = yield* laneParkTarget("b-event", "review", (lane) => lane.onEvent?.[0]?.to);
        assert.equal(origin?.fp, parkTargetFingerprint(target));
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// External event while parked → skipped (history only), no move
// ---------------------------------------------------------------------------

const skipExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "boom" }));
const skipLayer = it.layer(baseLayer(skipExecutor.layer));

skipLayer("external event while parked", (it) => {
  it.effect("records TicketExternalEventSkipped and does not move the ticket", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-skip" as never,
        {
          name: "skip",
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
              on: { failure: { park: "issue", actions: [{ label: "Retry", to: "impl" }] } },
              onEvent: [{ name: "nudge", to: "done" }],
            },
            { key: "done", name: "Done", entry: "manual", terminal: true },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;
      const store = yield* WorkflowEventStore;

      const ticketId = yield* engine.createTicket({
        boardId: "b-skip" as never,
        title: "Fails then parks",
        initialLane: "impl" as never,
      });

      yield* awaitParked(ticketId as string);

      const result = yield* engine.ingestExternalEvent({
        boardId: "b-skip" as never,
        name: "nudge",
        ticketId,
        payload: null,
      });
      assert.equal(result.outcome, "noop");

      const read = yield* WorkflowReadModel;
      const detail = yield* read.getTicketDetail(ticketId);
      assert.equal(detail?.ticket.status, "parked");
      assert.equal(detail?.ticket.currentLaneKey, "impl"); // did not move to done

      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const skipped = events.find((event) => event.type === "TicketExternalEventSkipped");
      assert.ok(skipped?.type === "TicketExternalEventSkipped");
      if (skipped?.type === "TicketExternalEventSkipped") {
        assert.equal(skipped.payload.eventName, "nudge");
        assert.equal(skipped.payload.reason, "parked");
      }
      // No move event to `done`.
      const moved = events.find(
        (event) =>
          event.type === "TicketMovedToLane" && event.payload.toLane === ("done" as string),
      );
      assert.isUndefined(moved);
    }),
  );
});

// ---------------------------------------------------------------------------
// RACE: a concurrent manual move lands before completion parks → no park
// ---------------------------------------------------------------------------

// A gate the test releases after landing a manual move. Shared between the
// executor layer and the test via a module-scoped deferred created per run.
interface GatedExecutor extends StepExecutorShape {
  readonly releaseGate: () => Effect.Effect<boolean>;
}

const gatedExecutorLayer = Layer.effect(
  StepExecutor,
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const shape: GatedExecutor = {
      execute: () =>
        // Hold the step until the test releases the gate. The step then
        // "fails" — but by then the ticket has been manually moved.
        Deferred.await(gate).pipe(
          Effect.map((): StepOutcome => ({ _tag: "failed", error: "late" })),
        ),
      releaseGate: () => Deferred.succeed(gate, undefined),
    };
    return shape;
  }),
);

it.layer(baseLayer(gatedExecutorLayer))("park vs concurrent move race", (it) => {
  it.effect("a manual move that lands first wins; park does not fire", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const store = yield* WorkflowEventStore;
      yield* registry.register(
        "b-race" as never,
        {
          name: "race",
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
              on: { failure: { park: "issue", actions: [{ label: "Retry", to: "impl" }] } },
            },
            { key: "elsewhere", name: "Elsewhere", entry: "manual" },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;
      const executor = (yield* StepExecutor) as GatedExecutor;

      const ticketId = yield* engine.createTicket({
        boardId: "b-race" as never,
        title: "Racing",
        initialLane: "impl" as never,
      });

      // Wait until the pipeline step is running (blocked on the gate).
      yield* awaitTicketWhere(ticketId as string, (detail) => (detail?.steps?.length ?? 0) >= 1);

      // Manual move supersedes the running pipeline and relocates the ticket.
      yield* engine.moveTicket(ticketId, "elsewhere" as never);

      // Release the gate — the (now superseded) step completes but the token
      // guard means the park must not fire.
      yield* executor.releaseGate();

      // Give any (incorrect) park a chance to land.
      yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 60)));

      const detail = yield* (yield* WorkflowReadModel).getTicketDetail(ticketId);
      assert.equal(detail?.ticket.currentLaneKey, "elsewhere");
      assert.notEqual(detail?.ticket.status, "parked");

      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.isUndefined(events.find((event) => event.type === "TicketParked"));
    }),
  );
});

// ---------------------------------------------------------------------------
// Reason strings: failure error truncation and blocked reason
// ---------------------------------------------------------------------------

const longError = "x".repeat(250);
const longFailExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: longError }));
const longFailLayer = it.layer(baseLayer(longFailExecutor.layer));

longFailLayer("park reason truncation", (it) => {
  it.effect("truncates the failing step error to 200 chars", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-long" as never,
        {
          name: "long",
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
              on: { failure: { park: "issue", actions: [{ label: "Retry", to: "impl" }] } },
            },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-long" as never,
        title: "Long error",
        initialLane: "impl" as never,
      });

      yield* awaitParked(ticketId as string);
      const parked = yield* parkedEventsFor(ticketId as string);
      const event = parked[0];
      assert.ok(event?.type === "TicketParked");
      if (event?.type === "TicketParked") {
        assert.equal(event.payload.reason.length, 200);
        assert.equal(event.payload.reason, longError.slice(0, 200));
      }
    }),
  );
});

const blockedParkExecutor = makeScriptedExecutor(() => ({
  _tag: "blocked",
  reason: "needs a human",
}));
const blockedParkLayer = it.layer(baseLayer(blockedParkExecutor.layer));

blockedParkLayer("blocked park reason", (it) => {
  it.effect("uses the blocked reason as the park reason", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-blockpark" as never,
        {
          name: "block-park",
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
              on: { blocked: { park: "issue", actions: [{ label: "Retry", to: "impl" }] } },
            },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-blockpark" as never,
        title: "Blocked",
        initialLane: "impl" as never,
      });

      yield* awaitParked(ticketId as string);
      const parked = yield* parkedEventsFor(ticketId as string);
      const event = parked[0];
      assert.ok(event?.type === "TicketParked");
      if (event?.type === "TicketParked") {
        assert.equal(event.payload.reason, "needs a human");
        const origin = parseParkOrigin(event.payload.parkOrigin);
        assert.equal(origin?.src, "lane_on");
        assert.equal(origin?.key, "blocked");
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// Budget-reason detection walks the JsonLogic tree for an EXACT var match
// ---------------------------------------------------------------------------

describe("ruleReferencesRunCount", () => {
  it("matches an exact { var: 'lane.runCount' } reference", () => {
    assert.isTrue(ruleReferencesRunCount({ "<": [{ var: "lane.runCount" }, 3] }));
  });

  it("matches the array var form { var: ['lane.runCount', default] }", () => {
    assert.isTrue(ruleReferencesRunCount({ "==": [{ var: ["lane.runCount", 0] }, 2] }));
  });

  it("matches a deeply nested reference", () => {
    assert.isTrue(
      ruleReferencesRunCount({
        and: [
          { "==": [{ var: "steps.review.output.verdict" }, "revise"] },
          { "<": [{ var: "lane.runCount" }, 2] },
        ],
      }),
    );
  });

  it("does NOT match a similarly-named var (no substring false-positive)", () => {
    assert.isFalse(ruleReferencesRunCount({ "<": [{ var: "lane.runCountish" }, 3] }));
  });

  it("returns false for undefined / non-runCount rules", () => {
    assert.isFalse(ruleReferencesRunCount(undefined));
    assert.isFalse(ruleReferencesRunCount({ "==": [{ var: "status" }, "done"] }));
  });
});

// ---------------------------------------------------------------------------
// RACE (token guard EXECUTES): completion reaches parkTicket AFTER a manual
// move flipped the token; the in-lock guard bails without emitting TicketParked
// ---------------------------------------------------------------------------

it.layer(baseLayer(gatedExecutorLayer))("park token guard executes under a real race", (it) => {
  it.effect("pipeline completes on a stale token after a move landed; guard bails, no park", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const store = yield* WorkflowEventStore;
      const committer = yield* WorkflowEventCommitter;
      const read = yield* WorkflowReadModel;
      yield* registry.register(
        "b-guard" as never,
        {
          name: "guard",
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
              // on.failure park would fire — unless the token was superseded.
              on: { failure: { park: "issue", actions: [{ label: "Retry", to: "impl" }] } },
            },
            { key: "elsewhere", name: "Elsewhere", entry: "manual" },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;
      const executor = (yield* StepExecutor) as GatedExecutor;

      const ticketId = yield* engine.createTicket({
        boardId: "b-guard" as never,
        title: "Stale token",
        initialLane: "impl" as never,
      });

      // Pipeline started; the step is blocked on the gate holding token T1.
      const running = yield* awaitTicketWhere(
        ticketId as string,
        (detail) =>
          (detail?.steps?.length ?? 0) >= 1 && detail?.ticket.currentLaneEntryToken !== null,
      );
      const staleToken = running?.ticket.currentLaneEntryToken;
      assert.ok(staleToken !== null && staleToken !== undefined);

      // A concurrent manual move already committed: it flips the ticket's
      // lane-entry token WITHOUT interrupting the still-running pipeline fiber
      // (we bypass engine.moveTicket precisely so the completion path runs to
      // parkTicket and the in-lock token re-read actually executes).
      yield* committer.commit({
        type: "TicketMovedToLane",
        ticketId,
        payload: {
          toLane: "elsewhere",
          laneEntryToken: "fresh-token-after-move",
          reason: "manual",
        },
        eventId: "evt-guard-move",
        occurredAt: "2026-07-22T00:00:00.000Z",
      } as never);

      // Release the gate — the step fails, the pipeline computes the park
      // decision, commits PipelineCompleted, then parkTicket re-reads the token.
      yield* executor.releaseGate();

      // Wait until the pipeline actually completes (proves the code path ran
      // all the way to the routing/park section, not an early interrupt).
      const readEvents = Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const current = yield* readEvents;
        if (current.some((event) => event.type === "PipelineCompleted")) {
          break;
        }
        yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 10)));
        yield* Effect.yieldNow;
      }

      const events = yield* readEvents;
      // Contract: completion was reached (PipelineCompleted present)...
      assert.isDefined(events.find((event) => event.type === "PipelineCompleted"));
      // ...the prior move flipped the token...
      const detail = yield* read.getTicketDetail(ticketId);
      assert.equal(detail?.ticket.currentLaneKey, "elsewhere");
      assert.equal(detail?.ticket.currentLaneEntryToken, "fresh-token-after-move");
      assert.notEqual(detail?.ticket.currentLaneEntryToken, staleToken);
      // ...and the in-lock guard bailed: NO park was emitted.
      assert.isUndefined(events.find((event) => event.type === "TicketParked"));
      assert.notEqual(detail?.ticket.status, "parked");
    }),
  );
});
