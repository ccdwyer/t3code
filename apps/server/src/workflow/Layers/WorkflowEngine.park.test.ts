// @effect-diagnostics globalTimers:off
import { assert, describe, it } from "@effect/vitest";
import {
  isParkTarget,
  type StepOutcome,
  type WorkflowLane,
  type WorkflowParkTarget,
  type WorkflowRouteTarget,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ruleReferencesRunCount } from "../jsonLogicRule.ts";
import { parkTargetFingerprint, parseParkOrigin } from "../parkOrigin.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
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
      assert.equal(result.outcome, "parked");

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
      assert.equal(result.outcome, "skipped_parked");

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

// ===========================================================================
// GATE 1 fixes: stale-fiber supersession, inter-step token guard, parked
// projection refusals, lane-bound park guard, in-lock action re-resolution.
// ===========================================================================

const promiseSleep = (ms: number) =>
  Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, ms)));

// A gate the test releases; the held step then COMPLETES (unlike the failing
// gatedExecutorLayer above). Used to hold a pipeline mid-flight so the test can
// externally park / re-token it while it is provably running.
const gatedCompletingExecutorLayer = Layer.effect(
  StepExecutor,
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const shape: GatedExecutor = {
      execute: () =>
        Deferred.await(gate).pipe(Effect.map((): StepOutcome => ({ _tag: "completed" }))),
      releaseGate: () => Deferred.succeed(gate, undefined),
    };
    return shape;
  }),
);

const stepStartedCountFor = (ticketId: string) =>
  Effect.gen(function* () {
    const store = yield* WorkflowEventStore;
    const events = yield* Stream.runCollect(store.readByTicket(ticketId as never)).pipe(
      Effect.map((chunk) => Array.from(chunk)),
    );
    return events.filter((event) => event.type === "StepStarted").length;
  });

// ---------------------------------------------------------------------------
// F1a: external park mid multi-step pipeline supersedes the running fiber —
// no further StepStarted, status stays parked, parked columns not orphaned.
// ---------------------------------------------------------------------------

it.layer(baseLayer(gatedCompletingExecutorLayer))(
  "external park supersedes a running multi-step pipeline",
  (it) => {
    it.effect("interrupts the fiber: no further StepStarted, status stays parked", () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register(
          "b-superpark" as never,
          {
            name: "superpark",
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
                  },
                ],
                onEvent: [
                  {
                    name: "halt",
                    to: {
                      park: "issue",
                      label: "Halted",
                      actions: [{ label: "Retry", to: "impl" }],
                    },
                  },
                ],
              },
            ],
          } as never,
        );
        const engine = yield* WorkflowEngine;
        const read = yield* WorkflowReadModel;
        const executor = (yield* StepExecutor) as GatedExecutor;

        const ticketId = yield* engine.createTicket({
          boardId: "b-superpark" as never,
          title: "Multi-step",
          initialLane: "impl" as never,
        });

        // First step running (blocked on the gate), token live.
        yield* awaitTicketWhere(
          ticketId as string,
          (detail) =>
            (detail?.steps?.length ?? 0) >= 1 && detail?.ticket.currentLaneEntryToken !== null,
        );

        // External park while the pipeline is mid-flight: it must interrupt the
        // fiber so the second step never dispatches.
        const result = yield* engine.ingestExternalEvent({
          boardId: "b-superpark" as never,
          name: "halt",
          ticketId,
          payload: null,
        });
        assert.equal(result.outcome, "parked");

        const parked = yield* awaitParked(ticketId as string);
        assert.equal(parked?.ticket.status, "parked");
        assert.equal(parked?.ticket.currentLaneEntryToken, null);
        assert.equal(parked?.ticket.attentionKind, "parked_issue");

        // Release the (now-interrupted) gate and give any stray continuation a
        // chance to (incorrectly) run the second step.
        yield* executor.releaseGate();
        yield* promiseSleep(60);

        // Only the FIRST step ever started — the fiber was superseded.
        assert.equal(yield* stepStartedCountFor(ticketId as string), 1);

        // Status is still parked with parked columns intact (not orphaned by a
        // late StepStarted / PipelineCompleted / TicketBlocked from a stale fiber).
        const after = yield* read.getTicketDetail(ticketId);
        assert.equal(after?.ticket.status, "parked");
        assert.equal(after?.ticket.parkedSubstate, "issue");
        assert.notEqual(after?.ticket.parkedEventId, null);
      }),
    );
  },
);

// ---------------------------------------------------------------------------
// F1b: inter-step token guard — a token flip BETWEEN steps (without an
// interrupt) aborts the remaining pipeline silently.
// ---------------------------------------------------------------------------

it.layer(baseLayer(gatedCompletingExecutorLayer))("inter-step token guard", (it) => {
  it.effect("a token flip between steps stops the next step from dispatching", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const committer = yield* WorkflowEventCommitter;
      const read = yield* WorkflowReadModel;
      yield* registry.register(
        "b-interstep" as never,
        {
          name: "interstep",
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
                },
              ],
            },
            { key: "elsewhere", name: "Elsewhere", entry: "manual" },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;
      const executor = (yield* StepExecutor) as GatedExecutor;

      const ticketId = yield* engine.createTicket({
        boardId: "b-interstep" as never,
        title: "Two steps",
        initialLane: "impl" as never,
      });

      // First step running (blocked on the gate) holding token T1.
      yield* awaitTicketWhere(
        ticketId as string,
        (detail) =>
          (detail?.steps?.length ?? 0) >= 1 && detail?.ticket.currentLaneEntryToken !== null,
      );

      // Flip the token WITHOUT interrupting the fiber (commit a move directly,
      // bypassing engine.moveTicket precisely so the loop runs to the inter-step
      // guard). The first step then completes on a stale token.
      yield* committer.commit({
        type: "TicketMovedToLane",
        ticketId,
        payload: {
          toLane: "elsewhere",
          laneEntryToken: "interstep-fresh-token",
          reason: "manual",
        },
        eventId: "evt-interstep-move",
        occurredAt: "2026-07-22T00:00:00.000Z",
      } as never);

      yield* executor.releaseGate();
      yield* promiseSleep(60);

      // Only the FIRST step started; the inter-step guard aborted before the
      // second step's StepStarted, and no PipelineCompleted was emitted.
      assert.equal(yield* stepStartedCountFor(ticketId as string), 1);
      const store = yield* WorkflowEventStore;
      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.isUndefined(events.find((event) => event.type === "PipelineCompleted"));
      const detail = yield* read.getTicketDetail(ticketId);
      assert.equal(detail?.ticket.currentLaneKey, "elsewhere");
    }),
  );
});

// ---------------------------------------------------------------------------
// F1d: answering / approving a parked ticket fails typed and leaves it parked.
// ---------------------------------------------------------------------------

const answerParkExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "boom" }));
const answerParkLayer = it.layer(baseLayer(answerParkExecutor.layer));

answerParkLayer("answer while parked", (it) => {
  it.effect("answerTicketStep on a parked ticket fails typed and does not unpark it", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-answerpark" as never,
        {
          name: "answerpark",
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
      const read = yield* WorkflowReadModel;
      const store = yield* WorkflowEventStore;

      const ticketId = yield* engine.createTicket({
        boardId: "b-answerpark" as never,
        title: "Parks",
        initialLane: "impl" as never,
      });

      yield* awaitParked(ticketId as string);

      // The parked ticket has a StepStarted (the step that failed), so its
      // stepRunId maps back to the ticket — the parked guard fires before any
      // awaiting-state logic.
      const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const stepStarted = events.find((event) => event.type === "StepStarted");
      assert.ok(stepStarted?.type === "StepStarted");
      const stepRunId =
        stepStarted?.type === "StepStarted" ? stepStarted.payload.stepRunId : undefined;
      assert.isDefined(stepRunId);

      const failure = yield* engine
        .answerTicketStep({ stepRunId: stepRunId as never, text: "here you go" })
        .pipe(Effect.flip);
      assert.include(failure.message, "parked");

      // resolveApproval on the same parked ticket is refused too (NEW-3: the
      // parked check guards the approval commit path as well).
      const approvalFailure = yield* engine
        .resolveApproval(stepRunId as never, true)
        .pipe(Effect.flip);
      assert.include(approvalFailure.message, "parked");

      // Still parked, no orphaned parked_* left over a running status.
      const detail = yield* read.getTicketDetail(ticketId);
      assert.equal(detail?.ticket.status, "parked");
      assert.notEqual(detail?.ticket.parkedEventId, null);
    }),
  );
});

// ---------------------------------------------------------------------------
// F1e (gate-1 round-3 NEW-1): a park landing AFTER answerTicketStep's early
// check is caught by the IN-LOCK precondition on the message append, so no
// phantom user answer is ever durably recorded. The answer's commit takes the
// board save lock; we interpose that lock to drop an external park (a projection
// flip to 'parked') the instant the lock is acquired — i.e. after the early
// check, before the precondition and append. The precondition re-reads under the
// lock, sees parked, and fails the whole commit typed with NO TicketMessagePosted
// appended (so the provider respond that would follow the append never runs).
// ---------------------------------------------------------------------------

const answerRaceControl: { armed: boolean; ticketId: string | null } = {
  armed: false,
  ticketId: null,
};

const answerRaceExecutor = makeScriptedExecutor(
  () =>
    ({
      _tag: "awaiting_user",
      waitingReason: "need input",
      providerResponseKind: "user-input",
      providerThreadId: "thread-answer-race",
      providerRequestId: "req-answer-race",
    }) as StepOutcome,
);

// A save-lock layer that, when armed, simulates an external park committing the
// instant the answer's commit acquires the lock — one-shot, before the locked
// effect (the in-lock precondition + append) runs.
const answerRaceSaveLockLayer = Layer.effect(
  WorkflowBoardSaveLocks,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      withSaveLock: (_boardId, effect) =>
        Effect.gen(function* () {
          if (answerRaceControl.armed && answerRaceControl.ticketId !== null) {
            answerRaceControl.armed = false;
            yield* sql`
              UPDATE projection_ticket
              SET status = 'parked', parked_event_id = 'evt-answer-race-park'
              WHERE ticket_id = ${answerRaceControl.ticketId}
            `.pipe(Effect.orDie);
          }
          return yield* effect;
        }),
    } satisfies WorkflowBoardSaveLocks["Service"];
  }),
);

const answerRaceLayer = it.layer(
  WorkflowEngineLayer.pipe(
    Layer.provideMerge(WorkflowEventCommitterLive),
    Layer.provideMerge(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(answerRaceExecutor.layer),
    Layer.provideMerge(ApprovalGateLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(WorkflowRoutingContextBuilderLive),
    Layer.provideMerge(answerRaceSaveLockLayer),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

answerRaceLayer("answer race: park after early check", (it) => {
  it.effect(
    "a park landing after the early check is caught by the in-lock precondition; no TicketMessagePosted, typed failure",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register(
          "b-answerrace" as never,
          {
            name: "answerrace",
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
              },
            ],
          } as never,
        );
        const engine = yield* WorkflowEngine;
        const store = yield* WorkflowEventStore;

        const ticketId = yield* engine.createTicket({
          boardId: "b-answerrace" as never,
          title: "Race",
          initialLane: "impl" as never,
        });

        // The step awaits user input → ticket is waiting_on_user (NOT parked), so
        // the answer's early check passes.
        yield* awaitTicketWhere(
          ticketId as string,
          (detail) => detail?.ticket.status === "waiting_on_user",
        );

        const events = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        const awaiting = events.find((event) => event.type === "StepAwaitingUser");
        assert.ok(awaiting?.type === "StepAwaitingUser");
        const stepRunId =
          awaiting.type === "StepAwaitingUser" ? awaiting.payload.stepRunId : undefined;
        assert.isDefined(stepRunId);

        // Arm the interposition: the NEXT save-lock acquisition (the answer's
        // TicketMessagePosted commit) parks the ticket after the early check but
        // before the in-lock precondition + append.
        answerRaceControl.ticketId = ticketId as string;
        answerRaceControl.armed = true;

        const failure = yield* engine
          .answerTicketStep({ stepRunId: stepRunId as never, text: "here you go" })
          .pipe(Effect.flip);
        assert.include(failure.message, "parked");
        // The one-shot fired exactly once (the commit did reach the save lock).
        assert.isFalse(answerRaceControl.armed);

        // No phantom answer was durably recorded: the stream has no USER-authored
        // TicketMessagePosted despite the API call reaching the commit point. (The
        // agent-authored user-input PROMPT message is expected and unrelated.)
        const after = yield* Stream.runCollect(store.readByTicket(ticketId)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        assert.isUndefined(
          after.find(
            (event) => event.type === "TicketMessagePosted" && event.payload.author === "user",
          ),
        );
      }),
  );
});

// ---------------------------------------------------------------------------
// F1a (semaphore): parking a running ticket via external event frees the global
// concurrency permit so a waiting ticket is admitted promptly.
// ---------------------------------------------------------------------------

it.layer(baseLayer(gatedCompletingExecutorLayer))("park frees the concurrency permit", (it) => {
  it.effect("maxConcurrentTickets=1: external park of A lets B acquire the permit", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register(
        "b-permit" as never,
        {
          name: "permit",
          settings: { maxConcurrentTickets: 1 },
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
              onEvent: [
                {
                  name: "halt",
                  to: { park: "issue", label: "Halted", actions: [{ label: "Retry", to: "impl" }] },
                },
              ],
            },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketA = yield* engine.createTicket({
        boardId: "b-permit" as never,
        title: "A",
        initialLane: "impl" as never,
      });
      // A holds the single permit and is blocked in its step.
      yield* awaitTicketWhere(ticketA as string, (detail) => (detail?.steps?.length ?? 0) >= 1);

      const ticketB = yield* engine.createTicket({
        boardId: "b-permit" as never,
        title: "B",
        initialLane: "impl" as never,
      });
      // B is admitted to the lane but cannot start its step — A holds the permit.
      yield* promiseSleep(40);
      assert.equal(yield* stepStartedCountFor(ticketB as string), 0);

      // Externally park A: supersede interrupts A's fiber, releasing the permit.
      yield* engine.ingestExternalEvent({
        boardId: "b-permit" as never,
        name: "halt",
        ticketId: ticketA,
        payload: null,
      });

      // B now acquires the permit and starts its step — WITHOUT A's gate ever
      // being released (A's fiber ended by interruption, not natural completion).
      for (let attempt = 0; attempt < 150; attempt += 1) {
        if ((yield* stepStartedCountFor(ticketB as string)) >= 1) {
          break;
        }
        yield* promiseSleep(10);
        yield* Effect.yieldNow;
      }
      assert.equal(yield* stepStartedCountFor(ticketB as string), 1);
    }),
  );
});

// ---------------------------------------------------------------------------
// F2: lane-bound park guard — a queued ticket (NULL token) re-queued into a
// different lane is NOT parked by a delayed external park bound to its old lane.
// ---------------------------------------------------------------------------

it.layer(baseLayer(gatedCompletingExecutorLayer))("lane-bound park guard (queued ABA)", (it) => {
  it.effect("a delayed park bound to lane A does not park a ticket re-queued into lane B", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const committer = yield* WorkflowEventCommitter;
      const read = yield* WorkflowReadModel;
      const store = yield* WorkflowEventStore;
      yield* registry.register(
        "b-laneaba" as never,
        {
          name: "laneaba",
          lanes: [
            {
              key: "a",
              name: "A",
              entry: "auto",
              wipLimit: 1,
              pipeline: [
                {
                  key: "code",
                  type: "agent",
                  agent: { instance: "claude_main", model: "sonnet" },
                  instruction: "do it",
                },
              ],
              onEvent: [
                {
                  name: "halt",
                  to: { park: "issue", label: "Halted", actions: [{ label: "Retry", to: "a" }] },
                },
              ],
            },
            { key: "b", name: "B", entry: "manual" },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      // Occupy lane A's single WIP slot so the second ticket queues (NULL token).
      const holder = yield* engine.createTicket({
        boardId: "b-laneaba" as never,
        title: "Holder",
        initialLane: "a" as never,
      });
      yield* awaitTicketWhere(holder as string, (detail) => (detail?.steps?.length ?? 0) >= 1);

      const queued = yield* engine.createTicket({
        boardId: "b-laneaba" as never,
        title: "Queued",
        initialLane: "a" as never,
      });
      yield* awaitTicketWhere(
        queued as string,
        (detail) =>
          detail?.ticket.status === "queued" && detail.ticket.currentLaneEntryToken === null,
      );

      // A holder fiber grabs the admission lock and keeps it until released.
      const lockHeld = yield* Deferred.make<void>();
      const releaseLock = yield* Deferred.make<void>();
      const holderFiber = yield* engine
        .withBoardAdmissionLock(
          "b-laneaba" as never,
          Effect.gen(function* () {
            yield* Deferred.succeed(lockHeld, undefined);
            yield* Deferred.await(releaseLock);
            // While STILL holding the lock, re-queue the ticket into lane B (NULL
            // token again — the ABA a token-only guard could not catch).
            yield* committer.commit({
              type: "TicketQueued",
              ticketId: queued,
              payload: { lane: "b" },
              eventId: "evt-laneaba-requeue",
              occurredAt: "2026-07-22T00:00:00.000Z",
            } as never);
          }),
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(lockHeld);
      // Fork the external park: it reads the ticket (lane A, NULL token) then
      // blocks on parkTicket's admission lock (held by the holder). The sleep
      // ensures its pre-lock read of lane A completes before the holder flips to
      // lane B. On release, the park's IN-LOCK read sees lane B; its lane binding
      // refuses the park.
      const parkFiber = yield* engine
        .ingestExternalEvent({
          boardId: "b-laneaba" as never,
          name: "halt",
          ticketId: queued,
          payload: null,
        })
        .pipe(Effect.forkChild);
      yield* promiseSleep(40);
      yield* Deferred.succeed(releaseLock, undefined);
      yield* Fiber.join(holderFiber);
      yield* Fiber.join(parkFiber);

      const detail = yield* read.getTicketDetail(queued);
      assert.equal(detail?.ticket.currentLaneKey, "b");
      assert.notEqual(detail?.ticket.status, "parked");

      const events = yield* Stream.runCollect(store.readByTicket(queued)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.isUndefined(events.find((event) => event.type === "TicketParked"));
    }),
  );
});

// ---------------------------------------------------------------------------
// F3: in-lock action re-resolution — a board save landing between the pre-lock
// resolution and the admission lock makes invokeParkAction fail typed, no move.
// ---------------------------------------------------------------------------

const f3ActionParkExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "boom" }));
const f3Layer = it.layer(baseLayer(f3ActionParkExecutor.layer));

const f3DefinitionWith = (actionLabel: string) =>
  ({
    name: "f3",
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
                label: "Snag",
                actions: [{ label: actionLabel, to: "land" }],
              },
            },
          },
        ],
      },
      { key: "land", name: "Land", entry: "manual" },
    ],
  }) as never;

f3Layer("in-lock action re-resolution", (it) => {
  it.effect("a concurrent board save before the lock makes invoke fail typed with no move", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const read = yield* WorkflowReadModel;
      yield* registry.register("b-f3" as never, f3DefinitionWith("Approve & land"));
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-f3" as never,
        title: "Parks",
        initialLane: "impl" as never,
      });
      const parked = yield* awaitParked(ticketId as string);
      const parkedEventId = parked?.ticket.parkedEventId;
      assert.isDefined(parkedEventId);

      // A holder fiber grabs the admission lock and keeps it until released.
      const lockHeld = yield* Deferred.make<void>();
      const releaseLock = yield* Deferred.make<void>();
      const holderFiber = yield* engine
        .withBoardAdmissionLock(
          "b-f3" as never,
          Effect.gen(function* () {
            yield* Deferred.succeed(lockHeld, undefined);
            yield* Deferred.await(releaseLock);
            // Board save while STILL holding the lock: same origin site, different
            // action → its fingerprint no longer matches the parked origin.
            yield* registry.register("b-f3" as never, f3DefinitionWith("Send back"));
          }),
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(lockHeld);
      // Fork the invoke: its pre-lock resolution reads the CURRENT (pre-save)
      // definition and resolves the action, then it blocks on the admission lock.
      // The sleep ensures that pre-lock resolution completes before the save. On
      // release, the IN-LOCK re-resolution reads the saved definition and fails
      // typed. `Effect.flip` turns the expected typed failure into the joined
      // value (if invoke wrongly succeeded, the fiber would fail and error here).
      const invokeFiber = yield* engine
        .invokeParkAction(ticketId, 0, parkedEventId as never)
        .pipe(Effect.flip, Effect.forkChild);
      yield* promiseSleep(40);
      yield* Deferred.succeed(releaseLock, undefined);
      yield* Fiber.join(holderFiber);

      const error = yield* Fiber.join(invokeFiber);
      assert.include(error.message, "board definition changed");

      // No move happened — the ticket is still parked in impl.
      const detail = yield* read.getTicketDetail(ticketId);
      assert.equal(detail?.ticket.status, "parked");
      assert.equal(detail?.ticket.currentLaneKey, "impl");
    }),
  );
});

// ---------------------------------------------------------------------------
// F3b (NEW-2): a board save that lands AFTER the admission-lock pre-check but
// BEFORE the move is appended must still make invokeParkAction fail typed. The
// move's emit re-runs the action re-resolution as a precondition INSIDE the
// board save lock, so a `register` cannot slip a changed action past the
// append (both hold the save lock). Barrier: a holder keeps the SAVE lock so
// invoke's commit blocks on it; V2 is registered during the block (after the
// pre-check has already read V1); on release the in-lock precondition reads V2
// and fails.
// ---------------------------------------------------------------------------

const f3bActionParkExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "boom" }));
const f3bLayer = it.layer(baseLayer(f3bActionParkExecutor.layer));

f3bLayer("emit-time in-save-lock action re-resolution", (it) => {
  it.effect(
    "a board save landing after the pre-check but before the append fails typed, no move",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        const read = yield* WorkflowReadModel;
        const saveLocks = yield* WorkflowBoardSaveLocks;
        yield* registry.register("b-f3b" as never, f3DefinitionWith("Approve & land"));
        const engine = yield* WorkflowEngine;

        const ticketId = yield* engine.createTicket({
          boardId: "b-f3b" as never,
          title: "Parks",
          initialLane: "impl" as never,
        });
        const parked = yield* awaitParked(ticketId as string);
        const parkedEventId = parked?.ticket.parkedEventId;
        assert.isDefined(parkedEventId);

        // Holder grabs the SAVE lock (the same lock the move's append acquires) and
        // holds it, so invoke will pass its admission-lock pre-check on V1 and then
        // block at the commit's save-lock acquisition.
        const saveLockHeld = yield* Deferred.make<void>();
        const releaseSaveLock = yield* Deferred.make<void>();
        const holderFiber = yield* saveLocks
          .withSaveLock(
            "b-f3b" as never,
            Effect.gen(function* () {
              yield* Deferred.succeed(saveLockHeld, undefined);
              yield* Deferred.await(releaseSaveLock);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(saveLockHeld);

        // Invoke: pre-lock + admission-lock pre-check resolve against V1 (still
        // registered), then the commit blocks on the held save lock.
        const invokeFiber = yield* engine
          .invokeParkAction(ticketId, 0, parkedEventId as never)
          .pipe(Effect.flip, Effect.forkChild);

        // By now invoke has passed the pre-check (read V1) and is parked on the
        // save-lock wait. Install V2 (same origin, different action) and release
        // the save lock: invoke's in-lock precondition now reads V2 and fails.
        yield* promiseSleep(40);
        yield* registry.register("b-f3b" as never, f3DefinitionWith("Send back"));
        yield* Deferred.succeed(releaseSaveLock, undefined);
        yield* Fiber.join(holderFiber);

        const error = yield* Fiber.join(invokeFiber);
        assert.include(error.message, "board definition changed");

        const detail = yield* read.getTicketDetail(ticketId);
        assert.equal(detail?.ticket.status, "parked");
        assert.equal(detail?.ticket.currentLaneKey, "impl");
      }),
  );
});

// ---------------------------------------------------------------------------
// F4 (NEW-4): when an external park's in-lock token/lane guard loses its race
// to a concurrent move, parkTicket emits nothing — ingestExternalEvent must
// then report "noop", NOT "parked" (there is no TicketParked event / parked
// projection to back the claim). Barrier: a holder keeps the admission lock and
// re-tokens the ticket while ingest is blocked; parkTicket's guard then sees a
// drifted token and no-ops.
// ---------------------------------------------------------------------------

const f4Executor = makeScriptedExecutor(() => ({ _tag: "completed" }));
const f4Layer = it.layer(baseLayer(f4Executor.layer));

f4Layer("external park lost-race outcome", (it) => {
  it.effect("a concurrent move superseding the park makes ingest return noop, not parked", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const read = yield* WorkflowReadModel;
      const committer = yield* WorkflowEventCommitter;
      yield* registry.register(
        "b-f4" as never,
        {
          name: "f4",
          lanes: [
            {
              key: "impl",
              name: "Impl",
              entry: "manual",
              onEvent: [
                {
                  name: "e",
                  to: {
                    park: "issue",
                    label: "Parked by event",
                    actions: [{ label: "Retry", to: "impl" }],
                  },
                },
              ],
            },
            { key: "elsewhere", name: "Elsewhere", entry: "manual" },
          ],
        } as never,
      );
      const engine = yield* WorkflowEngine;

      const ticketId = yield* engine.createTicket({
        boardId: "b-f4" as never,
        title: "Racing park",
        initialLane: "impl" as never,
      });
      const admitted = yield* awaitTicketWhere(
        ticketId as string,
        (detail) => detail?.ticket.currentLaneEntryToken !== null,
      );
      assert.isNotNull(admitted?.ticket.currentLaneEntryToken);

      // Holder keeps the admission lock and, on signal, re-tokens the ticket
      // (direct move to "elsewhere") so parkTicket's in-lock guard drifts.
      const admHeld = yield* Deferred.make<void>();
      const doMove = yield* Deferred.make<void>();
      const holderFiber = yield* engine
        .withBoardAdmissionLock(
          "b-f4" as never,
          Effect.gen(function* () {
            yield* Deferred.succeed(admHeld, undefined);
            yield* Deferred.await(doMove);
            yield* committer.commit({
              type: "TicketMovedToLane",
              eventId: "evt-f4-move",
              ticketId,
              occurredAt: "2026-07-22T00:10:00.000Z",
              payload: { toLane: "elsewhere", laneEntryToken: "tok-f4-moved", reason: "manual" },
            } as never);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(admHeld);

      // Ingest reads the current (pre-move) token, then blocks on the admission
      // lock inside parkTicket.
      const resultFiber = yield* engine
        .ingestExternalEvent({ boardId: "b-f4" as never, name: "e", ticketId, payload: null })
        .pipe(Effect.forkChild);

      // Ingest has now read the pre-move token and is parked on the lock. Trigger
      // the move + release the lock.
      yield* promiseSleep(40);
      yield* Deferred.succeed(doMove, undefined);
      yield* Fiber.join(holderFiber);

      const result = yield* Fiber.join(resultFiber);
      // The park lost the race: nothing parked, so the honest outcome is "noop".
      assert.equal(result.outcome, "noop");

      const detail = yield* read.getTicketDetail(ticketId);
      assert.notEqual(detail?.ticket.status, "parked");
      assert.equal(detail?.ticket.currentLaneKey, "elsewhere");
      const events = yield* Stream.runCollect(
        (yield* WorkflowEventStore).readByTicket(ticketId),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      assert.isUndefined(events.find((event) => event.type === "TicketParked"));
    }),
  );
});
