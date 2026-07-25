// @effect-diagnostics globalTimers:off
/**
 * Engine-level fork-join path: spawn → children terminal → parent on.success move.
 * Must exercise enterLane with routedOptions (not a silent no-op).
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel, type TicketDetail } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { ForkJoinCoordinatorLive } from "./ForkJoinCoordinator.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { makeStubStepExecutor } from "./StubStepExecutor.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

const forkDefinition = {
  name: "fork-join-engine",
  lanes: [
    {
      key: "parent",
      name: "Parent",
      entry: "auto",
      pipeline: [
        {
          key: "fanout",
          type: "fork",
          children: [
            { key: "a", lane: "child", titleTemplate: "Child A {{child.key}}" },
            { key: "b", lane: "child", titleTemplate: "Child B {{child.key}}" },
          ],
          join: { require: 2, onBranchFailure: "waitImpossible" },
          on: { success: "done", failure: "needs" },
        },
      ],
      on: { success: "done" },
    },
    {
      key: "child",
      name: "Child",
      entry: "auto",
      pipeline: [
        {
          key: "work",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "work",
        },
      ],
      on: { success: "done" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
    { key: "needs", name: "Needs", entry: "manual" },
  ],
};

const awaitDetail = (
  ticketId: string,
  predicate: (detail: TicketDetail | null) => boolean,
  attempts = 200,
) =>
  Effect.gen(function* () {
    const read = yield* WorkflowReadModel;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const detail = yield* read.getTicketDetail(ticketId as never);
      if (predicate(detail)) {
        return detail;
      }
      yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 15)));
      yield* Effect.yieldNow;
    }
    return yield* read.getTicketDetail(ticketId as never);
  });

const awaitParentEvent = (ticketId: string, type: string, attempts = 200) =>
  Effect.gen(function* () {
    const store = yield* WorkflowEventStore;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const events = yield* Stream.runCollect(store.readByTicket(ticketId as never)).pipe(
        Effect.map((chunk) => [...chunk]),
      );
      const match = events.find((e) => e.type === type);
      if (match !== undefined) {
        return { events, match };
      }
      yield* Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, 15)));
      yield* Effect.yieldNow;
    }
    const events = yield* Stream.runCollect(store.readByTicket(ticketId as never)).pipe(
      Effect.map((chunk) => [...chunk]),
    );
    return { events, match: events.find((e) => e.type === type) };
  });

const eventTypes = (events: ReadonlyArray<{ readonly type: string }>) =>
  events.map((e) => e.type).join(",");

const baseLayer = (executor: ReturnType<typeof makeStubStepExecutor>) =>
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
    Layer.provideMerge(ForkJoinCoordinatorLive),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(WorkflowRoutingContextBuilderLive),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

const successLayer = it.layer(baseLayer(makeStubStepExecutor({ default: { _tag: "completed" } })));

successLayer("WorkflowEngine fork-join parent route", (it) => {
  it.effect("join success with on.success moves parent to done (not silent routed no-op)", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const store = yield* WorkflowEventStore;

      yield* registry.register("b-fork" as never, forkDefinition);

      const parentId = yield* engine.createTicket({
        boardId: "b-fork" as never,
        title: "Parent ticket",
        initialLane: "parent" as never,
      });

      // Wait for spawn specifically — status "running" is true before TicketForkSpawned.
      const { events: afterSpawn, match: spawned } = yield* awaitParentEvent(
        parentId as string,
        "TicketForkSpawned",
      );
      assert.isDefined(spawned, `expected TicketForkSpawned; got [${eventTypes(afterSpawn)}]`);
      if (spawned?.type !== "TicketForkSpawned") {
        return;
      }
      const childIds = spawned.payload.children.map((c) => c.ticketId as string);
      assert.equal(childIds.length, 2);

      // Wait for both children to land in terminal "done".
      for (const childId of childIds) {
        const childDone = yield* awaitDetail(childId, (d) => d?.ticket.currentLaneKey === "done");
        assert.equal(
          childDone?.ticket.currentLaneKey,
          "done",
          `child ${childId} should reach done (status=${childDone?.ticket.status})`,
        );
      }

      // Parent must actually move to done via on.success — not stay parked in parent lane.
      const parentFinal = yield* awaitDetail(
        parentId as string,
        (d) => d?.ticket.currentLaneKey === "done",
      );
      const parentEvents = yield* Stream.runCollect(store.readByTicket(parentId)).pipe(
        Effect.map((chunk) => [...chunk]),
      );
      assert.equal(
        parentFinal?.ticket.currentLaneKey,
        "done",
        `parent must enterLane to done after join success; lane=${parentFinal?.ticket.currentLaneKey} status=${parentFinal?.ticket.status} events=[${eventTypes(parentEvents)}]`,
      );

      assert.isTrue(
        parentEvents.some((e) => e.type === "TicketForkResolved"),
        `TicketForkResolved should be committed; events=[${eventTypes(parentEvents)}]`,
      );
      const resolved = parentEvents.find((e) => e.type === "TicketForkResolved");
      if (resolved?.type === "TicketForkResolved") {
        assert.equal(resolved.payload.result, "success");
        assert.equal(resolved.payload.succeeded, 2);
      }
    }),
  );
});

const failLayer = it.layer(
  baseLayer(
    makeStubStepExecutor({
      default: { _tag: "completed" },
      byStepKey: {
        // child_fail lane uses this step key — force pipeline failure so settle
        // path is TicketBlocked → settleForkChildIfAny("failure").
        fail_work: { _tag: "failed", error: "child boom" },
      },
    }),
  ),
);

failLayer("WorkflowEngine fork-join failure route", (it) => {
  it.effect("join failure with on.failure routes parent to needs", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      const engine = yield* WorkflowEngine;
      const store = yield* WorkflowEventStore;

      // failFast: first child failure resolves join immediately.
      const failFastDef = {
        name: "fork-fail",
        lanes: [
          {
            key: "parent",
            name: "Parent",
            entry: "auto",
            pipeline: [
              {
                key: "fanout",
                type: "fork",
                children: [
                  { key: "a", lane: "child_fail", titleTemplate: "A" },
                  { key: "b", lane: "child_ok", titleTemplate: "B" },
                ],
                join: { require: 2, onBranchFailure: "failFast" },
                on: { success: "done", failure: "needs" },
              },
            ],
            on: { success: "done" },
          },
          {
            key: "child_fail",
            name: "ChildFail",
            entry: "auto",
            pipeline: [
              {
                key: "fail_work",
                type: "agent",
                agent: { instance: "claude_main", model: "sonnet" },
                instruction: "fail",
              },
            ],
            // No on.failure → pipeline failure with no route → TicketBlocked + settle failure.
            on: {},
          },
          {
            key: "child_ok",
            name: "ChildOk",
            entry: "auto",
            pipeline: [
              {
                key: "ok_work",
                type: "agent",
                agent: { instance: "claude_main", model: "sonnet" },
                instruction: "ok",
              },
            ],
            on: { success: "done" },
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
          { key: "needs", name: "Needs", entry: "manual" },
        ],
      };

      yield* registry.register("b-fork-fail" as never, failFastDef);
      const parentId = yield* engine.createTicket({
        boardId: "b-fork-fail" as never,
        title: "Parent fail",
        initialLane: "parent" as never,
      });

      const { match: spawned, events: spawnEvents } = yield* awaitParentEvent(
        parentId as string,
        "TicketForkSpawned",
      );
      assert.isDefined(spawned, `expected TicketForkSpawned; got [${eventTypes(spawnEvents)}]`);
      if (spawned?.type !== "TicketForkSpawned") return;

      // Wait for join failure → on.failure must move parent to needs (not merely blocked).
      // Asserting only status===blocked would pass a silent routed no-op.
      const parentFinal = yield* awaitDetail(
        parentId as string,
        (d) => d?.ticket.currentLaneKey === "needs",
      );
      const parentEvents = yield* Stream.runCollect(store.readByTicket(parentId)).pipe(
        Effect.map((chunk) => [...chunk]),
      );
      assert.equal(
        parentFinal?.ticket.currentLaneKey,
        "needs",
        `parent must enterLane to needs after failFast join; lane=${parentFinal?.ticket.currentLaneKey} status=${parentFinal?.ticket.status} events=[${eventTypes(parentEvents)}]`,
      );
      assert.isTrue(
        parentEvents.some((e) => e.type === "TicketForkResolved"),
        `TicketForkResolved should be committed on failFast; events=[${eventTypes(parentEvents)}]`,
      );
      const resolved = parentEvents.find((e) => e.type === "TicketForkResolved");
      if (resolved?.type === "TicketForkResolved") {
        assert.equal(resolved.payload.result, "failure");
      }
    }),
  );
});
