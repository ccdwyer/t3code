// @effect-diagnostics globalTimers:off
//
// Task 9 (deliverable B): backwards-compatibility suite for park-in-place.
//
// VERSION-SKEW STANCE (spec "Backwards compatibility — precise claims"):
// the server and every client (web, desktop, mobile, relay) ship together
// from this single repository. There is no supported deployment topology
// where an older client talks to a newer server (or vice versa) — v1
// explicitly puts older-client tolerance OUT OF SCOPE. What this suite pins
// down instead is DATA/DEFINITION compatibility within one server version:
// (1) a legacy (pre-collapse) board definition — bare lane-key routing, no
// park targets anywhere — still validates and executes byte-identically;
// (2) an event stream containing the new TicketParked/TicketExternalEvent-
// Skipped event types rebuilds the same projection whether replayed from
// scratch or applied incrementally; (3) old-style (manual parking lane) and
// new-style (parked-in-place) "stuck" tickets can coexist on one board, each
// behaving per its own idiom; (4) reverting a board definition out from under
// a parked ticket degrades that ticket's actions to "unavailable" rather than
// executing a stale/mismatched action, while a plain move still rescues it.
import { assert, it } from "@effect/vitest";
import { WorkflowDefinition, WorkflowEventId, type StepOutcome } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Stream from "effect/Stream";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { toParkedTicketView } from "../parkActions.ts";
import { BoardRegistry, type BoardRegistryShape } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowProjectionPipeline } from "../Services/WorkflowProjectionPipeline.ts";
import { WorkflowReadModel, type TicketDetail } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowProjectionPipelineLive } from "./WorkflowProjectionPipeline.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

// ── Harness (copied from WorkflowEngine.park.test.ts — a lint-free registry so
//    these engine tests can register raw definitions, including the pinned
//    legacy fixture below, directly). ─────────────────────────────────────────

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

// =============================================================================
// (B.1) LEGACY BOARD: the CURRENT (pre-Task-11-collapse) default board shape,
// pinned as an inline literal fixture. Lifted verbatim from
// apps/server/src/workflow/defaultBoard.ts on 2026-07-22 (commits
// 72cd01596..fe14b01f5 landed; Task 11's lane collapse has not run yet) via:
//
//   defaultBoardDefinition({ name: "...", agent: { instance: "claude_main",
//   model: "sonnet" } })
//
// This is the RAW (pre-schema-decode) shape — the same literal defaultBoard.ts
// passes to Schema.decodeUnknownSync(WorkflowDefinition) — not the decoded
// output (whose `retention` field turns into a Duration object), so it reads
// the same way defaultBoard.ts's own source does. It intentionally contains
// ZERO park targets anywhere (every `on.success`/`on.failure`/`on.blocked`
// and every transition `to` is a bare lane-key string): this is exactly the
// "legacy definitions without park targets execute unchanged" claim. Freezing
// it as an inline literal (rather than importing defaultBoardDefinition) means
// this test keeps validating the OLD 10-lane shape even after Task 11 collapses
// defaultBoard.ts itself down to fewer lanes with park targets.
// =============================================================================

const LEGACY_DEFAULT_BOARD_FIXTURE = {
  name: "Legacy Default",
  settings: { maxConcurrentTickets: 3 },
  lanes: [
    {
      key: "backlog",
      name: "Backlog",
      entry: "manual",
      actions: [
        {
          label: "Start work",
          to: "planning",
          hint: "The agent plans, specs, implements and reviews the ticket.",
        },
      ],
    },
    {
      key: "planning",
      name: "Planning",
      entry: "auto",
      pipeline: [
        {
          key: "plan",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: 'You are planning the ticket "{{ticket.title}}".',
          retry: { maxAttempts: 2 },
        },
      ],
      on: { success: "specifying", failure: "planning_issues", blocked: "planning_issues" },
    },
    {
      key: "specifying",
      name: "Specifying",
      entry: "auto",
      pipeline: [
        {
          key: "spec",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: 'Turn the plan for ticket "{{ticket.title}}" into a concrete spec.',
          retry: { maxAttempts: 2 },
        },
      ],
      on: { success: "implementation", failure: "planning_issues", blocked: "planning_issues" },
    },
    {
      key: "planning_issues",
      name: "Planning Issues",
      entry: "manual",
      actions: [
        {
          label: "Retry planning",
          to: "planning",
          hint: "Run planning and specification again.",
        },
        {
          label: "Back to backlog",
          to: "backlog",
          hint: "Park the ticket; nothing runs until you start it again.",
        },
      ],
    },
    {
      key: "implementation",
      name: "Implementation",
      entry: "auto",
      pipeline: [
        {
          key: "implement",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: 'Implement ticket "{{ticket.title}}".',
          retry: { maxAttempts: 2 },
        },
        {
          key: "review",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "Review the accumulated work.",
          captureOutput: true,
        },
      ],
      transitions: [
        {
          when: {
            and: [
              { "==": [{ var: "steps.review.output.verdict" }, "revise"] },
              { "<": [{ var: "lane.runCount" }, 3] },
            ],
          },
          to: "implementation",
        },
        {
          when: { "==": [{ var: "steps.review.output.verdict" }, "revise"] },
          to: "manual_review",
        },
        {
          when: { "==": [{ var: "steps.review.output.verdict" }, "approve"] },
          to: "owner_review",
        },
      ],
      on: {
        success: "implementation_issues",
        failure: "implementation_issues",
        blocked: "implementation_issues",
      },
    },
    {
      key: "owner_review",
      name: "Owner Review",
      entry: "manual",
      actions: [
        {
          label: "Approve & land",
          to: "land",
          hint: "Merge the ticket's work into the branch checked out in your repo.",
        },
        { label: "Send back", to: "implementation", hint: "Run another implement + review pass." },
      ],
    },
    {
      key: "land",
      name: "Land",
      entry: "manual",
      pipeline: [{ key: "merge", type: "merge", cleanupPaths: [".t3/ticket/{{ticket.id}}"] }],
      on: { success: "done", failure: "implementation_issues", blocked: "implementation_issues" },
    },
    {
      key: "manual_review",
      name: "Manual Review",
      entry: "manual",
      actions: [
        {
          label: "Approve & land",
          to: "land",
          hint: "Merge the ticket's work into the branch checked out in your repo.",
        },
        {
          label: "Send back",
          to: "implementation",
          hint: "Run another implement + review pass with a fresh loop budget.",
        },
      ],
    },
    {
      key: "implementation_issues",
      name: "Implementation Issues",
      entry: "manual",
      actions: [
        {
          label: "Retry implementation",
          to: "implementation",
          hint: "Run the implement + review pipeline again.",
        },
        {
          label: "Re-plan",
          to: "planning",
          hint: "Start over from planning with what you learned.",
        },
        {
          label: "Back to backlog",
          to: "backlog",
          hint: "Park the ticket; nothing runs until you start it again.",
        },
      ],
    },
    { key: "done", name: "Done", entry: "manual", terminal: true, retention: "14 days" },
  ],
};

const legacyExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "boom" }));
const legacyLayer = it.layer(baseLayer(legacyExecutor.layer));

legacyLayer("legacy 10-lane default board (pre-collapse fixture)", (it) => {
  it.effect(
    "plan-fail round-trip: lands in planning_issues (no park), manual move back resets the runCount streak",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register(
          "b-legacy-default" as never,
          LEGACY_DEFAULT_BOARD_FIXTURE as never,
        );
        const engine = yield* WorkflowEngine;
        const read = yield* WorkflowReadModel;

        const ticketId = yield* engine.createTicket({
          boardId: "b-legacy-default" as never,
          title: "Legacy ticket",
          // Enter directly into the auto "planning" lane — the bare lane-key
          // `on.failure: "planning_issues"` routing is what this test pins.
          initialLane: "planning" as never,
        });

        // retry.maxAttempts: 2 — the always-failing executor is called twice
        // for the "plan" step before on.failure routes (a bare lane key, no
        // park) to planning_issues.
        const afterFail = yield* awaitTicketWhere(
          ticketId as string,
          (detail) => detail?.ticket.currentLaneKey === "planning_issues",
        );
        assert.equal(legacyExecutor.calls.count, 2);
        // Old behavior confirmed: a plain lane move, never a park.
        assert.notEqual(afterFail?.ticket.status, "parked");
        assert.equal(afterFail?.ticket.status, "idle");
        assert.equal(afterFail?.ticket.parkedEventId ?? null, null);

        const eventsAfterFail = yield* eventsFor(ticketId as string);
        assert.isUndefined(eventsAfterFail.find((event) => event.type === "TicketParked"));
        const firstPlanningStart = eventsAfterFail.find(
          (event) => event.type === "PipelineStarted" && event.payload.laneKey === "planning",
        );
        assert.ok(firstPlanningStart?.type === "PipelineStarted");

        // Sanity: the first (only, so far) run into "planning" has a runCount
        // of exactly 1.
        const firstRunCount =
          firstPlanningStart?.type === "PipelineStarted"
            ? yield* read.countLanePipelineRuns(firstPlanningStart.payload.pipelineRunId)
            : -1;
        assert.equal(firstRunCount, 1);

        // Manual move back to planning works (the "Retry planning" action's
        // target, exercised here directly via moveTicket).
        yield* engine.moveTicket(ticketId, "planning" as never);

        const afterSecondFail = yield* awaitTicketWhere(
          ticketId as string,
          (detail) =>
            detail?.ticket.currentLaneKey === "planning_issues" && legacyExecutor.calls.count >= 4,
        );
        assert.equal(legacyExecutor.calls.count, 4);
        assert.notEqual(afterSecondFail?.ticket.status, "parked");

        // runCount streak reset proof: the SECOND run into "planning" (after
        // the manual move) must show a runCount of 1, not 2 — a manual
        // TicketMovedToLane resets the streak counter that budget-guarded
        // transitions consult (countLanePipelineRuns), even though this
        // legacy board's "planning" lane itself never references
        // lane.runCount. If the reset had not fired, this would read 2.
        const eventsAfterSecondFail = yield* eventsFor(ticketId as string);
        const planningStarts = eventsAfterSecondFail.filter(
          (event) => event.type === "PipelineStarted" && event.payload.laneKey === "planning",
        );
        assert.equal(planningStarts.length, 2);
        const secondPlanningStart = planningStarts[1];
        assert.ok(secondPlanningStart?.type === "PipelineStarted");
        const secondRunCount =
          secondPlanningStart?.type === "PipelineStarted"
            ? yield* read.countLanePipelineRuns(secondPlanningStart.payload.pipelineRunId)
            : -1;
        assert.equal(secondRunCount, 1);
      }),
  );
});

// =============================================================================
// (B.2) REPLAY REBUILD: no dedicated "rebuild all workflow_events" entry point
// exists in this codebase (WorkflowEventStore.readAll is defined but has no
// production caller, and grepping for rebuildProjection/reprojectAll/etc.
// turns up nothing) — extending Task 3's replay test's own approach was the
// chosen path per the task brief. This test therefore applies the SAME
// ordered event array — TicketCreated, TicketMovedToLane (admit),
// TicketParked, TicketExternalEventSkipped (onEvent while parked, a no-op
// projection), TicketMovedToLane (manual unpark) — through
// WorkflowProjectionPipeline.projectEvent twice: once "incrementally" (one
// event at a time, as events land live) and once as a "rebuild from scratch"
// (the identical events, in the same order, streamed in one pass into a
// completely separate fresh in-memory database — modeling a rebuild reading
// workflow_events from sequence 0). The two independent projections' final
// projection_ticket rows must be identical.
// =============================================================================

const replayProjectionLayer = WorkflowProjectionPipelineLive.pipe(
  Layer.provideMerge(BoardRegistryLive_forReplay()),
  Layer.provideMerge(MigrationsLive),
  Layer.provideMerge(SqlitePersistenceMemory),
);

function BoardRegistryLive_forReplay() {
  // A bare-bones BoardRegistry: WorkflowProjectionPipeline does not consult
  // it (projection is pure event->row mapping), but the service must be
  // present to satisfy the layer graph.
  return Layer.succeed(BoardRegistry, {
    register: (_boardId, raw) => Effect.succeed(raw as never),
    unregister: () => Effect.void,
    getDefinition: () => Effect.succeed(null),
    listDefinitions: () => Effect.succeed([]),
    getLane: () => Effect.succeed(null),
  } satisfies BoardRegistryShape);
}

const replayEvents = (ticketId: string) =>
  [
    {
      type: "TicketCreated",
      eventId: `${ticketId}-a`,
      ticketId,
      streamVersion: 0,
      occurredAt: "2026-07-22T00:00:00.000Z",
      payload: {
        boardId: "b-replay-compat",
        title: "Replay compat ticket",
        laneKey: "impl",
      },
    },
    {
      type: "TicketMovedToLane",
      eventId: `${ticketId}-b`,
      ticketId,
      streamVersion: 1,
      occurredAt: "2026-07-22T00:00:01.000Z",
      payload: { toLane: "impl", laneEntryToken: "tok-replay-compat-1", reason: "manual" },
    },
    {
      type: "TicketParked",
      eventId: `${ticketId}-c`,
      ticketId,
      streamVersion: 2,
      occurredAt: "2026-07-22T00:00:02.000Z",
      payload: {
        substate: "issue",
        label: "Hit a snag",
        reason: "code blew up",
        parkOrigin: '{"src":"step","stepKey":"code","key":"failure","fp":"fp-replay-compat"}',
        actionsSnapshot: [{ label: "Retry", to: "impl" }],
      },
    },
    {
      type: "TicketExternalEventSkipped",
      eventId: `${ticketId}-d`,
      ticketId,
      streamVersion: 3,
      occurredAt: "2026-07-22T00:00:03.000Z",
      payload: { eventName: "ci.failed", reason: "parked" },
    },
    {
      type: "TicketMovedToLane",
      eventId: `${ticketId}-e`,
      ticketId,
      streamVersion: 4,
      occurredAt: "2026-07-22T00:00:04.000Z",
      payload: { toLane: "impl", laneEntryToken: "tok-replay-compat-2", reason: "manual" },
    },
  ] as const;

type ReplayTicketRow = {
  readonly status: string;
  readonly currentLaneKey: string;
  readonly currentLaneEntryToken: string | null;
  readonly parkedSubstate: string | null;
  readonly parkedLabel: string | null;
  readonly parkedReason: string | null;
  readonly parkedEventId: string | null;
  readonly parkOrigin: string | null;
  readonly attentionKind: string | null;
  readonly queuedAt: string | null;
};

const readReplayTicketRow = (ticketId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<ReplayTicketRow>`
      SELECT
        status,
        current_lane_key AS "currentLaneKey",
        current_lane_entry_token AS "currentLaneEntryToken",
        parked_substate AS "parkedSubstate",
        parked_label AS "parkedLabel",
        parked_reason AS "parkedReason",
        parked_event_id AS "parkedEventId",
        park_origin AS "parkOrigin",
        attention_kind AS "attentionKind",
        queued_at AS "queuedAt"
      FROM projection_ticket
      WHERE ticket_id = ${ticketId}
    `;
    return rows[0] ?? null;
  });

// Project the replay events and snapshot the projection twice: the INTERMEDIATE
// state right after `TicketParked` (index 2, before the skip + trailing unpark
// move) and the FINAL state. The intermediate snapshot is what proves the
// TicketParked projection actually wrote the parked_* columns — a no-op
// TicketParked projection would still reach the same final (unparked) row.
const PARKED_EVENT_INDEX = 2;

const projectAllAndSnapshot = (ticketId: string) =>
  Effect.gen(function* () {
    const pipeline = yield* WorkflowProjectionPipeline;
    const events = replayEvents(ticketId);
    let afterPark: ReplayTicketRow | null = null;
    for (const [index, event] of events.entries()) {
      yield* pipeline.projectEvent(event as never);
      if (index === PARKED_EVENT_INDEX) {
        afterPark = yield* readReplayTicketRow(ticketId);
      }
    }
    const final = yield* readReplayTicketRow(ticketId);
    return { afterPark, final };
  });

const projectAllAndReadTicket = (ticketId: string) =>
  projectAllAndSnapshot(ticketId).pipe(Effect.map((snapshot) => snapshot.final));

it.layer(replayProjectionLayer)("replay rebuild parity (TicketParked + skip + unpark)", (it) => {
  it.effect(
    "sequential projectEvent over a fresh DB reaches the same final row as an incremental apply",
    () =>
      Effect.gen(function* () {
        // "Incremental": events applied one at a time as they would land live,
        // yielding between each (this test's own DB instance). Snapshot both the
        // intermediate post-park row and the final row.
        const incrementalSnapshot = yield* Effect.gen(function* () {
          const pipeline = yield* WorkflowProjectionPipeline;
          const events = replayEvents("ticket-replay-incremental");
          let afterPark: ReplayTicketRow | null = null;
          for (const [index, event] of events.entries()) {
            yield* pipeline.projectEvent(event as never);
            yield* Effect.yieldNow;
            if (index === PARKED_EVENT_INDEX) {
              afterPark = yield* readReplayTicketRow("ticket-replay-incremental");
            }
          }
          const final = yield* readReplayTicketRow("ticket-replay-incremental");
          return { afterPark, final };
        });
        const incremental = incrementalSnapshot.final;

        // "Rebuild from scratch": the identical event list, in the same
        // order, projected in one uninterrupted pass into a BRAND NEW
        // in-memory database (a fresh Layer build below) — modeling a
        // startup rebuild reading workflow_events from sequence 0.
        const rebuiltSnapshot = yield* projectAllAndSnapshot("ticket-replay-rebuild").pipe(
          Effect.provide(replayProjectionLayer),
        );
        const rebuilt = rebuiltSnapshot.final;

        assert.isNotNull(incremental);
        assert.isNotNull(rebuilt);
        // Compare everything except the ticket id itself (the two runs used
        // different ids only so a shared DB — if one were ever introduced —
        // couldn't collide them).
        assert.deepEqual(rebuilt, incremental);

        // INTERMEDIATE PARKED PROJECTION (the CODEX-5 gap): assert the row state
        // right AFTER TicketParked (before the skip + trailing unpark move) in
        // BOTH the incremental and rebuild paths. A no-op TicketParked projection
        // would leave these columns unset and fail here, even though the final
        // (unparked) rows above would still match.
        for (const afterPark of [incrementalSnapshot.afterPark, rebuiltSnapshot.afterPark]) {
          assert.isNotNull(afterPark);
          assert.equal(afterPark?.status, "parked");
          assert.equal(afterPark?.currentLaneKey, "impl");
          assert.equal(afterPark?.currentLaneEntryToken, null);
          assert.equal(afterPark?.parkedSubstate, "issue");
          assert.equal(afterPark?.parkedLabel, "Hit a snag");
          assert.equal(afterPark?.parkedReason, "code blew up");
          // parked_event_id is the TicketParked event's own id (per-ticket).
          assert.isNotNull(afterPark?.parkedEventId ?? null);
          assert.equal(afterPark?.attentionKind, "parked_issue");
        }
        assert.equal(incrementalSnapshot.afterPark?.parkedEventId, "ticket-replay-incremental-c");
        assert.equal(rebuiltSnapshot.afterPark?.parkedEventId, "ticket-replay-rebuild-c");
        // The two intermediate snapshots must also agree structurally, save for
        // the ticket-scoped parked_event_id (different ticket ids per run).
        assert.deepEqual(
          { ...incrementalSnapshot.afterPark, parkedEventId: null },
          { ...rebuiltSnapshot.afterPark, parkedEventId: null },
        );

        // Pin the actual expected final shape too, not just "the two agree":
        // parked, in "impl", token NULL, substate/label/reason/origin from
        // the TicketParked event, attention_kind derived from substate
        // "issue" -> "parked_issue" — then unparked (all parked_* columns
        // cleared, a fresh non-null token) by the trailing manual move.
        // (Both the sequential-park-then-unpark path and TicketExternalEvent-
        // Skipped's no-op are exercised in between and must not perturb this.)
        assert.equal(incremental?.status, "idle");
        assert.equal(incremental?.currentLaneKey, "impl");
        assert.equal(incremental?.currentLaneEntryToken, "tok-replay-compat-2");
        assert.equal(incremental?.parkedSubstate, null);
        assert.equal(incremental?.parkedLabel, null);
        assert.equal(incremental?.parkedReason, null);
        assert.equal(incremental?.parkedEventId, null);
        assert.equal(incremental?.parkOrigin, null);
      }),
  );
});

// =============================================================================
// (B.3) MIXED TICKETS: one board with an old-style manual "parking lane"
// ticket (idle, never attention-flagged) alongside a new-style parked-in-place
// ticket. Both coexist and render; only the parked one is surfaced as needing
// attention; invoking a park action on the old-style ticket is a harmless
// "stale" (it was never parked to begin with).
// =============================================================================

const mixedExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "code blew up" }));
const mixedLayer = it.layer(baseLayer(mixedExecutor.layer));

mixedLayer("mixed old-style and new-style stuck tickets on one board", (it) => {
  it.effect(
    "listNeedsAttentionTickets includes the parked ticket but not the idle parking-lane one; both render; invokeParkAction on the idle one is stale",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register(
          "b-mixed" as never,
          {
            name: "mixed",
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
              // Old-style manual "parking lane": a ticket dropped here just
              // sits idle. No pipeline, no attention flag — pre-existing
              // behavior this suite must not disturb.
              {
                key: "parking_lot",
                name: "Parking Lot",
                entry: "manual",
                actions: [{ label: "Resume", to: "impl" }],
              },
            ],
          } as never,
        );
        const engine = yield* WorkflowEngine;
        const read = yield* WorkflowReadModel;
        // listNeedsAttentionTickets joins projection_board — the registry
        // (in-memory definitions only) doesn't populate that table, so
        // register the board's projection row too.
        yield* read.registerBoard({
          boardId: "b-mixed" as never,
          projectId: "project-mixed" as never,
          name: "mixed",
          workflowFilePath: ".t3/boards/mixed.json",
          workflowVersionHash: "hash-mixed",
          maxConcurrentTickets: 3,
        });

        const ticketX = yield* engine.createTicket({
          boardId: "b-mixed" as never,
          title: "New-style parked",
          initialLane: "impl" as never,
        });
        const ticketY = yield* engine.createTicket({
          boardId: "b-mixed" as never,
          title: "Old-style parking-lot",
          initialLane: "parking_lot" as never,
        });

        const detailX = yield* awaitParked(ticketX as string);
        assert.equal(detailX?.ticket.status, "parked");
        assert.equal(detailX?.ticket.attentionKind, "parked_issue");

        const detailY = yield* read.getTicketDetail(ticketY);
        assert.equal(detailY?.ticket.status, "idle");
        assert.equal(detailY?.ticket.attentionKind ?? null, null);

        // Needs-attention includes X, excludes Y.
        const needsAttention = yield* read.listNeedsAttentionTickets();
        const needsAttentionIds = needsAttention.map((row) => row.ticketId as string);
        assert.include(needsAttentionIds, ticketX as string);
        assert.notInclude(needsAttentionIds, ticketY as string);

        // Both render in a board snapshot (listTickets).
        const boardTickets = yield* read.listTickets("b-mixed" as never);
        const boardTicketIds = boardTickets.map((row) => row.ticketId);
        assert.include(boardTicketIds, ticketX as string);
        assert.include(boardTicketIds, ticketY as string);

        // invokeParkAction on the old-style (never-parked) ticket is a
        // harmless "stale" — it was never parked, so there is nothing to
        // compare-and-act against.
        const result = yield* engine.invokeParkAction(
          ticketY,
          0,
          WorkflowEventId.make("evt-not-real"),
        );
        assert.equal(result, "stale");
        // No side effects: Y is untouched.
        const detailYAfter = yield* read.getTicketDetail(ticketY);
        assert.equal(detailYAfter?.ticket.status, "idle");
        assert.equal(detailYAfter?.ticket.currentLaneKey, "parking_lot");
      }),
  );
});

// =============================================================================
// (B.4) REVERT-WHILE-PARKED: a ticket parks under definition v1 (whose
// lane_on.failure origin is a park target); the board is then re-registered
// (same board id — mirroring a version revert) with v2, which routes the same
// lane_on.failure origin to a bare lane-key move instead of a park. The parked
// ticket's origin therefore no longer resolves to a park target under v2:
// BoardTicketView.parked.actions degrades to undefined ("actions
// unavailable"), invokeParkAction fails with the typed
// "board definition changed" error, and — critically — a PLAIN moveTicket
// still rescues the ticket (unparking does not depend on action resolution).
// =============================================================================

const revertExecutor = makeScriptedExecutor(() => ({ _tag: "failed", error: "code blew up" }));
const revertLayer = it.layer(baseLayer(revertExecutor.layer));

revertLayer("revert-while-parked", (it) => {
  it.effect(
    "actions degrade to unavailable, invokeParkAction fails typed, plain moveTicket still rescues",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        const v1 = {
          name: "revert-v1",
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
        };
        yield* registry.register("b-revert" as never, v1 as never);
        const engine = yield* WorkflowEngine;
        const read = yield* WorkflowReadModel;

        const ticketId = yield* engine.createTicket({
          boardId: "b-revert" as never,
          title: "Parks then gets reverted out from under",
          initialLane: "impl" as never,
        });

        const parkedDetail = yield* awaitParked(ticketId as string);
        assert.equal(parkedDetail?.ticket.status, "parked");
        const parkedEventId = parkedDetail?.ticket.parkedEventId;
        assert.ok(parkedEventId !== null && parkedEventId !== undefined);

        // Revert: re-register the SAME board id with a definition whose
        // lane_on.failure is now a bare lane-key move, not a park target.
        // (Same origin src="lane_on", key="failure" — but resolveParkActions
        // fails closed to null because the routing site no longer holds a
        // park target at all.)
        const v2 = {
          name: "revert-v2",
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
                  on: { failure: "impl" },
                },
              ],
            },
          ],
        };
        yield* registry.register("b-revert" as never, v2 as never);

        // (1) BoardTicketView.parked.actions is undefined.
        const ticketRowAfterRevert = (yield* read.getTicketDetail(ticketId))?.ticket;
        assert.ok(ticketRowAfterRevert !== undefined && ticketRowAfterRevert !== null);
        const v2Definition = yield* registry.getDefinition("b-revert" as never);
        assert.ok(v2Definition !== null);
        const parkedView =
          ticketRowAfterRevert !== undefined && ticketRowAfterRevert !== null
            ? toParkedTicketView(ticketRowAfterRevert, v2Definition)
            : undefined;
        assert.ok(parkedView !== undefined); // the ticket is still parked, so a view exists...
        assert.isUndefined(parkedView?.actions); // ...but with no invokable actions.

        // (2) invokeParkAction fails with the typed "actions unavailable"
        // error; the ticket remains parked and untouched.
        const exit = yield* engine
          .invokeParkAction(ticketId, 0, parkedEventId as never)
          .pipe(Effect.exit);
        assert.equal(exit._tag, "Failure");
        if (exit._tag === "Failure") {
          const message = String(exit.cause);
          assert.include(message, "park actions unavailable");
        }
        const stillParked = yield* read.getTicketDetail(ticketId);
        assert.equal(stillParked?.ticket.status, "parked");
        assert.equal(stillParked?.ticket.parkedEventId, parkedEventId);

        // (3) A plain moveTicket still rescues the ticket — unparking via a
        // manual move never depended on action resolution.
        yield* engine.moveTicket(ticketId, "impl" as never);
        const rescued = yield* awaitTicketWhere(
          ticketId as string,
          (detail) =>
            detail?.ticket.status !== "parked" && detail?.ticket.currentLaneEntryToken !== null,
        );
        assert.notEqual(rescued?.ticket.status, "parked");
        assert.equal(rescued?.ticket.currentLaneKey, "impl");
        assert.equal(rescued?.ticket.parkedEventId ?? null, null);
        assert.equal(rescued?.ticket.parkOrigin ?? null, null);
      }),
  );
});
