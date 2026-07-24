// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

const idleExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.succeed({ _tag: "completed" as const }),
} satisfies StepExecutorShape);

const workflowLayer = WorkflowEngineLayer.pipe(
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

const layer = it.layer(workflowLayer);

const slaDefinition = {
  name: "sla board",
  lanes: [
    {
      key: "review",
      name: "Review",
      entry: "manual",
      sla: { budget: "1 hour", escalateTo: "escalation" },
    },
    {
      key: "escalation",
      name: "Escalation",
      entry: "manual",
      wipLimit: 1,
    },
    {
      key: "done",
      name: "Done",
      entry: "manual",
      terminal: true,
    },
  ],
};

const notifyOnlyDefinition = {
  name: "notify only",
  lanes: [
    {
      key: "review",
      name: "Review",
      entry: "manual",
      sla: { budget: "1 hour" },
    },
  ],
};

layer("WorkflowEngine SLA escalateTicketSla", (it) => {
  it.effect(
    "escalates over-budget ticket atomically with TicketSlaBreached + move reason sla",
    () =>
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine;
        const registry = yield* BoardRegistry;
        const read = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;
        const boardId = "b-sla-esc" as never;

        yield* read.registerBoard({
          boardId,
          projectId: "p-sla" as never,
          name: "SLA",
          workflowFilePath: ".t3/boards/sla.json",
          workflowVersionHash: "h1",
          maxConcurrentTickets: 3,
        });
        yield* registry.register(boardId, slaDefinition as never);

        const ticketId = yield* engine.createTicket({
          boardId,
          title: "Slow review",
          initialLane: "review" as never,
        });
        const detail = yield* read.getTicketDetail(ticketId);
        const token = detail?.ticket.currentLaneEntryToken;
        assert.isTrue(typeof token === "string" && token.length > 0);

        // Backdate entry so the budget is exceeded.
        yield* sql`
        UPDATE projection_ticket
        SET current_lane_entered_at = '2026-07-24T00:00:00.000Z'
        WHERE ticket_id = ${ticketId}
      `;

        const result = yield* engine.escalateTicketSla({
          ticketId,
          expectedLaneKey: "review" as never,
          expectedEntryToken: token!,
          nowMs: Effect.succeed(Date.parse("2026-07-24T02:00:00.000Z")),
        });
        assert.equal(result, "escalated");

        const after = yield* read.getTicketDetail(ticketId);
        assert.equal(after?.ticket.currentLaneKey, "escalation");
        // Move clears breach columns on the destination entry.
        assert.equal(after?.ticket.slaBreachedAt, null);

        const events = yield* sql<{
          readonly eventType: string;
          readonly payloadJson: string;
        }>`
        SELECT event_type AS "eventType", payload_json AS "payloadJson"
        FROM workflow_events
        WHERE ticket_id = ${ticketId}
        ORDER BY sequence ASC
      `;
        const types = events.map((e) => e.eventType);
        assert.isTrue(types.includes("TicketSlaBreached"));
        const slaMoves = events.filter((e) => {
          if (e.eventType !== "TicketMovedToLane") {
            return false;
          }
          try {
            return (JSON.parse(e.payloadJson) as { reason?: string }).reason === "sla";
          } catch {
            return false;
          }
        });
        assert.equal(slaMoves.length, 1);
        // Breach must precede the sla move in the event stream.
        assert.isTrue(types.indexOf("TicketSlaBreached") < types.lastIndexOf("TicketMovedToLane"));
      }),
  );

  it.effect("returns stale when entry token mismatches and does not emit", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const registry = yield* BoardRegistry;
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const boardId = "b-sla-stale" as never;

      yield* read.registerBoard({
        boardId,
        projectId: "p-sla" as never,
        name: "SLA",
        workflowFilePath: ".t3/boards/sla-stale.json",
        workflowVersionHash: "h1",
        maxConcurrentTickets: 3,
      });
      yield* registry.register(boardId, slaDefinition as never);

      const ticketId = yield* engine.createTicket({
        boardId,
        title: "Stale",
        initialLane: "review" as never,
      });

      const result = yield* engine.escalateTicketSla({
        ticketId,
        expectedLaneKey: "review" as never,
        expectedEntryToken: "not-the-token",
        nowMs: Effect.succeed(Date.parse("2026-07-24T02:00:00.000Z")),
      });
      assert.equal(result, "stale");

      const breaches = yield* sql<{ readonly c: number }>`
        SELECT COUNT(*) AS c FROM workflow_events
        WHERE ticket_id = ${ticketId} AND event_type = 'TicketSlaBreached'
      `;
      assert.equal(breaches[0]?.c, 0);
    }),
  );

  it.effect("notify-only when escalateTo is absent", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const registry = yield* BoardRegistry;
      const read = yield* WorkflowReadModel;
      const boardId = "b-sla-notify" as never;

      yield* read.registerBoard({
        boardId,
        projectId: "p-sla" as never,
        name: "Notify",
        workflowFilePath: ".t3/boards/sla-notify.json",
        workflowVersionHash: "h1",
        maxConcurrentTickets: 3,
      });
      yield* registry.register(boardId, notifyOnlyDefinition as never);

      const ticketId = yield* engine.createTicket({
        boardId,
        title: "Notify me",
        initialLane: "review" as never,
      });
      const detail = yield* read.getTicketDetail(ticketId);
      const token = detail!.ticket.currentLaneEntryToken!;

      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE projection_ticket
        SET current_lane_entered_at = '2026-07-24T00:00:00.000Z'
        WHERE ticket_id = ${ticketId}
      `;

      const result = yield* engine.escalateTicketSla({
        ticketId,
        expectedLaneKey: "review" as never,
        expectedEntryToken: token,
        nowMs: Effect.succeed(Date.parse("2026-07-24T02:00:00.000Z")),
      });
      assert.equal(result, "notified");

      const after = yield* read.getTicketDetail(ticketId);
      assert.equal(after?.ticket.currentLaneKey, "review");
      assert.isTrue(
        typeof after?.ticket.slaBreachedAt === "string" && after.ticket.slaBreachedAt.length > 0,
        `expected slaBreachedAt, got ${after?.ticket.slaBreachedAt}`,
      );
      assert.isTrue((after?.ticket.slaBreachedReason ?? "").includes("1 hour"));
    }),
  );

  it.effect("queues when target WIP is full", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const registry = yield* BoardRegistry;
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const boardId = "b-sla-wip" as never;

      yield* read.registerBoard({
        boardId,
        projectId: "p-sla" as never,
        name: "WIP SLA",
        workflowFilePath: ".t3/boards/sla-wip.json",
        workflowVersionHash: "h1",
        maxConcurrentTickets: 3,
      });
      yield* registry.register(boardId, slaDefinition as never);

      // Fill escalation lane (wipLimit 1).
      const holder = yield* engine.createTicket({
        boardId,
        title: "Holder",
        initialLane: "escalation" as never,
      });
      void holder;

      const ticketId = yield* engine.createTicket({
        boardId,
        title: "Will queue",
        initialLane: "review" as never,
      });
      const detail = yield* read.getTicketDetail(ticketId);
      const token = detail!.ticket.currentLaneEntryToken!;
      yield* sql`
        UPDATE projection_ticket
        SET current_lane_entered_at = '2026-07-24T00:00:00.000Z'
        WHERE ticket_id = ${ticketId}
      `;

      const result = yield* engine.escalateTicketSla({
        ticketId,
        expectedLaneKey: "review" as never,
        expectedEntryToken: token,
        nowMs: Effect.succeed(Date.parse("2026-07-24T02:00:00.000Z")),
      });
      assert.equal(result, "queued");

      const after = yield* read.getTicketDetail(ticketId);
      assert.equal(after?.ticket.status, "queued");
      assert.equal(after?.ticket.currentLaneKey, "escalation");
    }),
  );
});
