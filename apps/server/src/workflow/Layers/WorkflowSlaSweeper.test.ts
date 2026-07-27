// @effect-diagnostics globalTimers:off
/**
 * Layer tests for WorkflowSlaSweeper candidate selection: parked/queued skip,
 * null-token skip, already-breached-same-token skip, action cap, and cursor
 * rotation across sweeps.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEngine, type WorkflowEngineShape } from "../Services/WorkflowEngine.ts";
import { WorkflowSlaSweeper } from "../Services/WorkflowSlaSweeper.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { WorkflowSlaSweeperLive } from "./WorkflowSlaSweeper.ts";

const unsupported = () => Effect.die("unsupported workflow engine call") as never;

interface EscalateCall {
  readonly ticketId: string;
  readonly expectedLaneKey: string;
  readonly expectedEntryToken: string;
}

const makeEngineLayer = (calls: Array<EscalateCall>, outcome: "notified" | "stale" = "notified") =>
  Layer.succeed(WorkflowEngine, {
    createTicket: () => unsupported(),
    editTicket: () => unsupported(),
    moveTicket: () => unsupported(),
    escalateTicketSla: (input) =>
      Effect.sync(() => {
        calls.push({
          ticketId: input.ticketId as string,
          expectedLaneKey: input.expectedLaneKey as string,
          expectedEntryToken: input.expectedEntryToken,
        });
        return outcome;
      }),
    invokeParkAction: () => unsupported(),
    createTicketAndEnterUnlocked: () => unsupported(),
    closeTicketFromSourceUnlocked: () => unsupported(),
    reopenTicketFromSourceUnlocked: () => unsupported(),
    cancellableProviderTurnsForTicket: () => unsupported(),
    supersedeProviderWorkForTicket: () => unsupported(),
    terminalAgentSessionThreadsForTicket: () => unsupported(),
    stopAgentSessionsForTicket: () => unsupported(),
    editTicketFieldsUnlocked: () => unsupported(),
    withBoardAdmissionLock: (_boardId, effect) => effect,
    runLane: () => unsupported(),
    ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
    resolveApproval: () => unsupported(),
    answerTicketStep: () => unsupported(),
    steerTicketStep: () => Effect.succeed({ accepted: true as const }),
    postTicketMessage: () => unsupported(),
    editTicketMessage: () => unsupported(),
    cancelStep: () => unsupported(),
    cancelBoardPipelines: () => Effect.void,
    cancelTicketPipelines: () => Effect.void,
    recoverBoardWip: () => Effect.void,
    completeRecoveredStep: () => unsupported(),
    resumeAnsweredQuestions: () => Effect.void,
    editTicketContextPack: () => Effect.die("unused"),
  } satisfies WorkflowEngineShape);

const fixedNow = Date.parse("2026-07-24T12:00:00.000Z");
// Over budget when entered_at is 4 hours before fixedNow with a 1 hour SLA.
const overBudgetEnteredAt = "2026-07-24T08:00:00.000Z";
const underBudgetEnteredAt = "2026-07-24T11:30:00.000Z";

const makeLayer = (calls: Array<EscalateCall>, maxActionsPerSweep = 50) =>
  WorkflowSlaSweeperLive({
    nowMs: Effect.succeed(fixedNow),
    maxActionsPerSweep,
    sweepIntervalMs: 60_000,
  }).pipe(
    Layer.provideMerge(makeEngineLayer(calls)),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

const slaDefinition = {
  name: "sla sweeper",
  lanes: [
    {
      key: "review",
      name: "Review",
      entry: "manual",
      sla: { budget: "1 hour", escalateTo: "escalation" },
    },
    { key: "escalation", name: "Escalation", entry: "manual" },
  ],
};

const multiLaneDefinition = {
  name: "multi sla",
  lanes: [
    { key: "a", name: "A", entry: "manual", sla: { budget: "1 hour" } },
    { key: "b", name: "B", entry: "manual", sla: { budget: "1 hour" } },
  ],
};

const seedCandidate = (input: {
  readonly ticketId: string;
  readonly boardId: string;
  readonly lane: string;
  readonly status?: string;
  readonly token?: string | null;
  readonly enteredAt?: string | null;
  readonly terminalAt?: string | null;
  readonly slaBreachedEntryToken?: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-07-24T00:00:00.000Z";
    yield* sql`
      INSERT INTO projection_ticket (
        ticket_id,
        board_id,
        title,
        current_lane_key,
        status,
        current_lane_entry_token,
        current_lane_entered_at,
        terminal_at,
        sla_breached_entry_token,
        created_at,
        updated_at
      )
      VALUES (
        ${input.ticketId},
        ${input.boardId},
        ${input.ticketId},
        ${input.lane},
        ${input.status ?? "idle"},
        ${input.token === undefined ? `tok-${input.ticketId}` : input.token},
        ${input.enteredAt === undefined ? overBudgetEnteredAt : input.enteredAt},
        ${input.terminalAt ?? null},
        ${input.slaBreachedEntryToken ?? null},
        ${now},
        ${now}
      )
    `;
  });

const registerBoard = (boardId: string, definition: unknown = slaDefinition) =>
  Effect.gen(function* () {
    const registry = yield* BoardRegistry;
    yield* registry.register(boardId as never, definition as never);
  });

it.effect("escalates an over-budget idle ticket via the engine", () => {
  const calls: Array<EscalateCall> = [];
  return Effect.gen(function* () {
    yield* registerBoard("b-sla-idle");
    yield* seedCandidate({
      ticketId: "t-sla-idle",
      boardId: "b-sla-idle",
      lane: "review",
      status: "idle",
    });
    const sweeper = yield* WorkflowSlaSweeper;
    const result = yield* sweeper.sweep();
    assert.equal(result.candidateCount, 1);
    assert.equal(result.actionCount, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.ticketId, "t-sla-idle");
    assert.equal(calls[0]?.expectedLaneKey, "review");
    assert.equal(calls[0]?.expectedEntryToken, "tok-t-sla-idle");
  }).pipe(Effect.provide(makeLayer(calls)));
});

it.effect("skips parked and queued tickets even when over budget", () => {
  const calls: Array<EscalateCall> = [];
  return Effect.gen(function* () {
    yield* registerBoard("b-sla-skip-status");
    yield* seedCandidate({
      ticketId: "t-parked",
      boardId: "b-sla-skip-status",
      lane: "review",
      status: "parked",
    });
    yield* seedCandidate({
      ticketId: "t-queued",
      boardId: "b-sla-skip-status",
      lane: "review",
      status: "queued",
    });
    const sweeper = yield* WorkflowSlaSweeper;
    const result = yield* sweeper.sweep();
    assert.equal(result.candidateCount, 0);
    assert.equal(result.actionCount, 0);
    assert.equal(calls.length, 0);
  }).pipe(Effect.provide(makeLayer(calls)));
});

it.effect("skips tickets with a null lane entry token", () => {
  const calls: Array<EscalateCall> = [];
  return Effect.gen(function* () {
    yield* registerBoard("b-sla-null-token");
    yield* seedCandidate({
      ticketId: "t-null-token",
      boardId: "b-sla-null-token",
      lane: "review",
      token: null,
    });
    const sweeper = yield* WorkflowSlaSweeper;
    const result = yield* sweeper.sweep();
    assert.equal(result.candidateCount, 0);
    assert.equal(calls.length, 0);
  }).pipe(Effect.provide(makeLayer(calls)));
});

it.effect("skips tickets already breached for the same entry token", () => {
  const calls: Array<EscalateCall> = [];
  return Effect.gen(function* () {
    yield* registerBoard("b-sla-already");
    yield* seedCandidate({
      ticketId: "t-already",
      boardId: "b-sla-already",
      lane: "review",
      token: "tok-same",
      slaBreachedEntryToken: "tok-same",
    });
    // Re-admission with a new token must still be a candidate.
    yield* seedCandidate({
      ticketId: "t-rearmit",
      boardId: "b-sla-already",
      lane: "review",
      token: "tok-new",
      slaBreachedEntryToken: "tok-old",
    });
    const sweeper = yield* WorkflowSlaSweeper;
    const result = yield* sweeper.sweep();
    assert.equal(result.candidateCount, 1);
    assert.equal(result.actionCount, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.ticketId, "t-rearmit");
  }).pipe(Effect.provide(makeLayer(calls)));
});

it.effect("does not select under-budget tickets", () => {
  const calls: Array<EscalateCall> = [];
  return Effect.gen(function* () {
    yield* registerBoard("b-sla-under");
    yield* seedCandidate({
      ticketId: "t-under",
      boardId: "b-sla-under",
      lane: "review",
      enteredAt: underBudgetEnteredAt,
    });
    const sweeper = yield* WorkflowSlaSweeper;
    const result = yield* sweeper.sweep();
    assert.equal(result.candidateCount, 0);
    assert.equal(calls.length, 0);
  }).pipe(Effect.provide(makeLayer(calls)));
});

it.effect("respects maxActionsPerSweep cap across candidates", () => {
  const calls: Array<EscalateCall> = [];
  return Effect.gen(function* () {
    yield* registerBoard("b-sla-cap");
    for (let i = 0; i < 5; i++) {
      yield* seedCandidate({
        ticketId: `t-cap-${i}`,
        boardId: "b-sla-cap",
        lane: "review",
        // Distinct entered_at so ORDER BY is stable.
        enteredAt: `2026-07-24T0${i}:00:00.000Z`,
      });
    }
    const sweeper = yield* WorkflowSlaSweeper;
    const result = yield* sweeper.sweep();
    assert.equal(result.actionCount, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.ticketId, "t-cap-0");
    assert.equal(calls[1]?.ticketId, "t-cap-1");
  }).pipe(Effect.provide(makeLayer(calls, 2)));
});

it.effect("rotates the lane cursor across successive sweeps", () => {
  const calls: Array<EscalateCall> = [];
  return Effect.gen(function* () {
    yield* registerBoard("b-sla-cursor", multiLaneDefinition);
    yield* seedCandidate({
      ticketId: "t-lane-a",
      boardId: "b-sla-cursor",
      lane: "a",
    });
    yield* seedCandidate({
      ticketId: "t-lane-b",
      boardId: "b-sla-cursor",
      lane: "b",
    });
    const sweeper = yield* WorkflowSlaSweeper;
    // Cap 1 so only one lane/ticket acts per sweep; cursor should advance.
    const first = yield* sweeper.sweep();
    assert.equal(first.actionCount, 1);
    assert.equal(calls.length, 1);
    const firstTicket = calls[0]!.ticketId;

    // Mark the acted ticket as already-breached so the next sweep must pick the other lane.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE projection_ticket
      SET sla_breached_entry_token = current_lane_entry_token
      WHERE ticket_id = ${firstTicket}
    `;

    const second = yield* sweeper.sweep();
    assert.equal(second.actionCount, 1);
    assert.equal(calls.length, 2);
    const secondTicket = calls[1]!.ticketId;
    assert.notEqual(secondTicket, firstTicket);
  }).pipe(Effect.provide(makeLayer(calls, 1)));
});

it.effect("treats engine stale outcomes as non-actions", () => {
  const calls: Array<EscalateCall> = [];
  return Effect.gen(function* () {
    yield* registerBoard("b-sla-stale-eng");
    yield* seedCandidate({
      ticketId: "t-stale-eng",
      boardId: "b-sla-stale-eng",
      lane: "review",
    });
    const sweeper = yield* WorkflowSlaSweeper;
    // Override engine to always return stale via a dedicated layer.
    const result = yield* sweeper.sweep();
    assert.equal(result.candidateCount, 1);
    // Stale is not counted as an action (cap not consumed for failures).
    // Note: remaining still decrements only on non-stale in implementation —
    // actionCount stays 0 when outcome === "stale".
    assert.equal(result.actionCount, 0);
    assert.equal(calls.length, 1);
  }).pipe(
    Effect.provide(
      WorkflowSlaSweeperLive({
        nowMs: Effect.succeed(fixedNow),
        maxActionsPerSweep: 10,
      }).pipe(
        Layer.provideMerge(makeEngineLayer(calls, "stale")),
        Layer.provideMerge(BoardRegistryLive),
        Layer.provideMerge(MigrationsLive),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
  );
});
