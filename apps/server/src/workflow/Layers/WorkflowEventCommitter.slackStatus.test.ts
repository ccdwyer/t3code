import { assert, it } from "@effect/vitest";
import type { BoardId, WorkflowEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";

const layer = it.layer(
  WorkflowEventCommitterLive.pipe(
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const decodeStatusPayloadJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.optional(Schema.String),
      prUrl: Schema.optional(Schema.String),
      status: Schema.optional(Schema.String),
    }),
  ),
);

const createSlackTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_agent_run (
      run_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      pr_url TEXT NULL,
      status_message_id TEXT NULL,
      last_applied_sequence INTEGER NOT NULL DEFAULT -1,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_agent_delivery (
      delivery_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workflow_sequence INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NULL,
      created_at TEXT NOT NULL,
      status_message_id TEXT NULL,
      last_error TEXT NULL,
      UNIQUE(run_id, workflow_sequence)
    )
  `;
});

const registerBoard = (boardId: string) =>
  Effect.gen(function* () {
    const registry = yield* BoardRegistry;
    const read = yield* WorkflowReadModel;
    yield* registry.register(boardId as never, {
      name: boardId,
      lanes: [
        { key: "todo", name: "Todo", entry: "manual" },
        { key: "doing", name: "Doing", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ] as never,
    });
    yield* read.registerBoard({
      boardId: boardId as BoardId,
      projectId: "project-slack" as never,
      name: boardId,
      workflowFilePath: `.t3/boards/${boardId}.json`,
      workflowVersionHash: `hash-${boardId}`,
      maxConcurrentTickets: 3,
    });
  });

const insertProjectedTicket = (input: {
  readonly ticketId: string;
  readonly boardId: string;
  readonly status?: string;
  readonly lane?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_ticket (
        ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
      ) VALUES (
        ${input.ticketId}, ${input.boardId}, 'Slack ticket',
        ${input.lane ?? "todo"}, ${input.status ?? "idle"},
        '2026-06-07T00:00:00.000Z', '2026-06-07T00:00:00.000Z'
      )
    `;
  });

const insertRun = (runId: string, ticketId: string, prUrl: string | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO slack_agent_run (
        run_id, instance_id, external_event_id, workspace_id, channel_id,
        channel_name, thread_key, thread_ts, trigger_ts, snapshot_json,
        snapshot_sha256, snapshot_bytes, ticket_id, status, pr_url,
        last_applied_sequence, created_at, updated_at
      ) VALUES (
        ${runId}, ${`instance-${runId}`}, ${`event-${runId}`}, 'T123', 'C123',
        'eng', ${`T123:C123:${runId}`}, ${`1000.${runId}`}, ${`1000.${runId}`}, '[]',
        'sha', 2, ${ticketId}, 'accepted', ${prUrl},
        -1, '2026-06-07T00:00:00.000Z', '2026-06-07T00:00:00.000Z'
      )
    `;
  });

const readDeliveries = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      readonly workflowSequence: number;
      readonly deliveryState: string;
      readonly payloadJson: string;
    }>`
      SELECT
        workflow_sequence AS "workflowSequence",
        delivery_state AS "deliveryState",
        payload_json AS "payloadJson"
      FROM slack_agent_delivery
      WHERE run_id = ${runId}
      ORDER BY workflow_sequence ASC
    `;
  });

const eventBase = (ticketId: string, eventId: string) =>
  ({
    eventId,
    ticketId,
    occurredAt: "2026-06-07T00:00:01.000Z",
  }) as const;

layer("WorkflowEventCommitter Slack status bridge", (it) => {
  it.effect("writes no Slack delivery when no Slack run exists for the ticket", () =>
    Effect.gen(function* () {
      const boardId = "b-slack-absent";
      const ticketId = "t-slack-absent";
      yield* registerBoard(boardId);
      yield* insertProjectedTicket({ ticketId, boardId });

      const committer = yield* WorkflowEventCommitter;
      yield* committer.commit({
        ...eventBase(ticketId, "e-slack-absent"),
        type: "StepRetryScheduled",
        payload: {
          pipelineRunId: "pipe-absent",
          stepRunId: "step-absent",
          stepKey: "build",
          failureClass: "agent_error",
          nextAttempt: 2,
          maxAttempts: 3,
          delayMs: 1000,
        },
      } as never);

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM slack_agent_delivery
      `;
      assert.equal(rows[0]?.count, 0);
    }),
  );

  it.effect("writes one pending delivery for each gated event and supersedes stale progress", () =>
    Effect.gen(function* () {
      const boardId = "b-slack-gated";
      const ticketId = "t-slack-gated";
      const runId = "run-slack-gated";
      yield* createSlackTables;
      yield* registerBoard(boardId);
      yield* insertProjectedTicket({ ticketId, boardId });
      yield* insertRun(runId, ticketId);

      const committer = yield* WorkflowEventCommitter;
      const events: ReadonlyArray<WorkflowEvent> = [
        {
          ...eventBase(ticketId, "e-queued"),
          streamVersion: 1,
          type: "TicketQueued",
          payload: { lane: "todo" },
        } as never,
        {
          ...eventBase(ticketId, "e-admitted"),
          streamVersion: 2,
          type: "TicketAdmitted",
          payload: { lane: "todo", laneEntryToken: "tok-admitted" },
        } as never,
        {
          ...eventBase(ticketId, "e-moved"),
          streamVersion: 3,
          type: "TicketMovedToLane",
          payload: { toLane: "doing", laneEntryToken: "tok-moved", reason: "manual" },
        } as never,
        {
          ...eventBase(ticketId, "e-pipe"),
          streamVersion: 4,
          type: "PipelineStarted",
          payload: { pipelineRunId: "pipe-1", laneKey: "doing", laneEntryToken: "tok-moved" },
        } as never,
        {
          ...eventBase(ticketId, "e-step"),
          streamVersion: 5,
          type: "StepStarted",
          payload: {
            pipelineRunId: "pipe-1",
            stepRunId: "step-1",
            stepKey: "build",
            stepType: "agent",
          },
        } as never,
        {
          ...eventBase(ticketId, "e-retry"),
          streamVersion: 6,
          type: "StepRetryScheduled",
          payload: {
            pipelineRunId: "pipe-1",
            stepRunId: "step-1",
            stepKey: "build",
            failureClass: "agent_error",
            nextAttempt: 2,
            maxAttempts: 3,
            delayMs: 1000,
          },
        } as never,
        {
          ...eventBase(ticketId, "e-await"),
          streamVersion: 7,
          type: "StepAwaitingUser",
          payload: { stepRunId: "step-1", waitingReason: "approve" },
        } as never,
        {
          ...eventBase(ticketId, "e-step-blocked"),
          streamVersion: 8,
          type: "StepBlocked",
          payload: { stepRunId: "step-1", reason: "tool failed" },
        } as never,
        {
          ...eventBase(ticketId, "e-ticket-blocked"),
          streamVersion: 9,
          type: "TicketBlocked",
          payload: { reason: "missing dependency" },
        } as never,
        {
          ...eventBase(ticketId, "e-parked"),
          streamVersion: 10,
          type: "TicketParked",
          payload: {
            substate: "issue",
            label: "Issue",
            reason: "blocked externally",
            parkOrigin: "{}",
            actionsSnapshot: [],
          },
        } as never,
        {
          ...eventBase(ticketId, "e-pr"),
          streamVersion: 11,
          type: "TicketPrOpened",
          payload: {
            stepRunId: "step-1",
            prNumber: 12,
            url: "https://github.com/acme/repo/pull/12",
            branch: "feature",
            remoteName: "origin",
            repo: "acme/repo",
          },
        } as never,
      ];

      for (const event of events) {
        yield* committer.commit(event as never);
      }

      const rows = yield* readDeliveries(runId);
      assert.equal(rows.length, events.length);
      assert.equal(
        rows.slice(0, -1).every((row) => row.deliveryState === "superseded"),
        true,
      );
      assert.equal(rows.at(-1)?.deliveryState, "pending");
      const latestPayload = decodeStatusPayloadJson(rows.at(-1)!.payloadJson);
      assert.equal(latestPayload.status, "pr_ready");
      assert.equal(latestPayload.prUrl, "https://github.com/acme/repo/pull/12");
    }),
  );

  it.effect("carries stored PR URL into later payloads", () =>
    Effect.gen(function* () {
      const boardId = "b-slack-pr-carry";
      const ticketId = "t-slack-pr-carry";
      const runId = "run-slack-pr-carry";
      yield* createSlackTables;
      yield* registerBoard(boardId);
      yield* insertProjectedTicket({ ticketId, boardId, status: "running" });
      yield* insertRun(runId, ticketId, "https://github.com/acme/repo/pull/7");

      const committer = yield* WorkflowEventCommitter;
      yield* committer.commit({
        ...eventBase(ticketId, "e-pr-carry"),
        type: "StepStarted",
        payload: {
          pipelineRunId: "pipe-pr-carry",
          stepRunId: "step-pr-carry",
          stepKey: "verify",
          stepType: "agent",
        },
      } as never);

      const rows = yield* readDeliveries(runId);
      const payload = decodeStatusPayloadJson(rows[0]!.payloadJson);
      assert.equal(payload.prUrl, "https://github.com/acme/repo/pull/7");
    }),
  );

  it.effect("keeps a pending PR-opened delivery visible ahead of later progress", () =>
    Effect.gen(function* () {
      const boardId = "b-slack-pr-visible";
      const ticketId = "t-slack-pr-visible";
      const runId = "run-slack-pr-visible";
      yield* createSlackTables;
      yield* registerBoard(boardId);
      yield* insertProjectedTicket({ ticketId, boardId, status: "running" });
      yield* insertRun(runId, ticketId);

      const committer = yield* WorkflowEventCommitter;
      yield* committer.commit({
        ...eventBase(ticketId, "e-pr-visible"),
        type: "TicketPrOpened",
        payload: {
          stepRunId: "step-pr-visible",
          prNumber: 77,
          url: "https://github.com/acme/repo/pull/77",
          branch: "feature",
          remoteName: "origin",
          repo: "acme/repo",
        },
      } as never);
      yield* committer.commit({
        ...eventBase(ticketId, "e-after-pr-visible"),
        type: "StepStarted",
        payload: {
          pipelineRunId: "pipe-after-pr",
          stepRunId: "step-after-pr",
          stepKey: "review",
          stepType: "agent",
        },
      } as never);

      const rows = yield* readDeliveries(runId);
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((row) => row.deliveryState),
        ["pending", "pending"],
      );
      assert.equal(decodeStatusPayloadJson(rows[0]!.payloadJson).kind, "pr_opened");
      assert.equal(
        decodeStatusPayloadJson(rows[1]!.payloadJson).prUrl,
        "https://github.com/acme/repo/pull/77",
      );
    }),
  );

  it.effect("marks a Slack run done when its ticket enters a terminal lane", () =>
    Effect.gen(function* () {
      const boardId = "b-slack-terminal";
      const ticketId = "t-slack-terminal";
      const runId = "run-slack-terminal";
      const prUrl = "https://github.com/acme/repo/pull/99";
      yield* createSlackTables;
      yield* registerBoard(boardId);
      yield* insertProjectedTicket({ ticketId, boardId, status: "running", lane: "doing" });
      yield* insertRun(runId, ticketId, prUrl);

      const committer = yield* WorkflowEventCommitter;
      yield* committer.commit({
        ...eventBase(ticketId, "e-terminal"),
        type: "TicketMovedToLane",
        payload: { toLane: "done", laneEntryToken: "tok-done", reason: "routed" },
      } as never);

      const rows = yield* readDeliveries(runId);
      const payload = decodeStatusPayloadJson(rows[0]!.payloadJson);
      assert.equal(payload.status, "done");
      assert.equal(payload.kind, "done");
      assert.equal(payload.prUrl, prUrl);

      const sql = yield* SqlClient.SqlClient;
      const runRows = yield* sql<{ readonly status: string }>`
        SELECT status FROM slack_agent_run WHERE run_id = ${runId}
      `;
      assert.equal(runRows[0]?.status, "done");
    }),
  );
});
