// @effect-diagnostics globalTimers:off
/**
 * Integration: admit → clock past budget → escalateTicketSla (engine path used
 * by the sweeper) → atomic breach + move / notify-only outbox.
 */
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
import { WorkflowSlaSweeperLive } from "./WorkflowSlaSweeper.ts";
import { WorkflowSlaSweeper } from "../Services/WorkflowSlaSweeper.ts";

const idleExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.succeed({ _tag: "completed" as const }),
} satisfies StepExecutorShape);

const fixedNow = Date.parse("2026-07-24T12:00:00.000Z");

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

const layer = it.layer(
  WorkflowSlaSweeperLive({ nowMs: Effect.succeed(fixedNow), maxActionsPerSweep: 10 }).pipe(
    Layer.provideMerge(workflowLayer),
  ),
);

const escalationDefinition = {
  name: "sla integration",
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

const notifyDefinition = {
  name: "notify integration",
  lanes: [
    {
      key: "review",
      name: "Review",
      entry: "manual",
      sla: { budget: "1 hour" },
    },
  ],
};

layer("WorkflowSla integration", (it) => {
  it.effect("sweeper escalates over-budget admitted ticket", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const registry = yield* BoardRegistry;
      const read = yield* WorkflowReadModel;
      const sweeper = yield* WorkflowSlaSweeper;
      const sql = yield* SqlClient.SqlClient;
      const boardId = "b-int-esc" as never;

      yield* read.registerBoard({
        boardId,
        projectId: "p-int" as never,
        name: "Integration",
        workflowFilePath: ".t3/boards/int.json",
        workflowVersionHash: "h1",
        maxConcurrentTickets: 3,
      });
      yield* registry.register(boardId, escalationDefinition as never);

      const ticketId = yield* engine.createTicket({
        boardId,
        title: "Over budget",
        initialLane: "review" as never,
      });
      yield* sql`
        UPDATE projection_ticket
        SET current_lane_entered_at = '2026-07-24T00:00:00.000Z'
        WHERE ticket_id = ${ticketId}
      `;

      const result = yield* sweeper.sweep();
      assert.isTrue(result.actionCount >= 1);

      const after = yield* read.getTicketDetail(ticketId);
      assert.equal(after?.ticket.currentLaneKey, "escalation");

      const events = yield* sql<{ readonly eventType: string }>`
        SELECT event_type AS "eventType"
        FROM workflow_events
        WHERE ticket_id = ${ticketId}
        ORDER BY sequence ASC
      `;
      const types = events.map((e) => e.eventType);
      assert.isTrue(types.includes("TicketSlaBreached"));
      assert.isTrue(types.includes("TicketMovedToLane"));
      assert.isTrue(types.indexOf("TicketSlaBreached") < types.lastIndexOf("TicketMovedToLane"));
    }),
  );

  it.effect("notify-only breach inserts one SLA outbox row", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const registry = yield* BoardRegistry;
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const boardId = "b-int-notify" as never;

      yield* read.registerBoard({
        boardId,
        projectId: "p-int" as never,
        name: "Notify",
        workflowFilePath: ".t3/boards/notify.json",
        workflowVersionHash: "h1",
        maxConcurrentTickets: 3,
      });
      yield* registry.register(boardId, notifyDefinition as never);

      const ticketId = yield* engine.createTicket({
        boardId,
        title: "Notify only",
        initialLane: "review" as never,
      });
      const detail = yield* read.getTicketDetail(ticketId);
      const token = detail!.ticket.currentLaneEntryToken!;
      yield* sql`
        UPDATE projection_ticket
        SET current_lane_entered_at = '2026-07-24T00:00:00.000Z'
        WHERE ticket_id = ${ticketId}
      `;

      const outcome = yield* engine.escalateTicketSla({
        ticketId,
        expectedLaneKey: "review" as never,
        expectedEntryToken: token,
        nowMs: Effect.succeed(fixedNow),
      });
      assert.equal(outcome, "notified");

      const after = yield* read.getTicketDetail(ticketId);
      assert.equal(after?.ticket.currentLaneKey, "review");
      assert.isTrue(typeof after?.ticket.slaBreachedAt === "string");

      const outbox = yield* sql<{
        readonly attentionKind: string | null;
        readonly attentionReason: string | null;
        readonly deliveryState: string;
      }>`
        SELECT attention_kind AS "attentionKind",
               attention_reason AS "attentionReason",
               delivery_state AS "deliveryState"
        FROM workflow_notification_outbox
        WHERE ticket_id = ${ticketId}
      `;
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0]?.attentionKind, "sla_breached");
      assert.equal(outbox[0]?.deliveryState, "pending");
      assert.isTrue((outbox[0]?.attentionReason ?? "").includes("SLA breached"));

      const needs = yield* read.listNeedsAttentionTickets();
      const row = needs.find((n) => n.ticketId === (ticketId as string));
      assert.isDefined(row);
      assert.equal(row?.attentionKind, null);
      assert.isTrue(typeof row?.slaBreachedAt === "string");
      assert.isTrue((row?.slaBreachedReason ?? "").length > 0);
    }),
  );
});
