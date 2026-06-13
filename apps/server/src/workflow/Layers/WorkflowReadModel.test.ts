import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowProjectionPipeline } from "../Services/WorkflowProjectionPipeline.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { WorkflowProjectionPipelineLive } from "./WorkflowProjectionPipeline.ts";
import { WorkflowReadModelLive } from "./WorkflowReadModel.ts";

const layer = it.layer(
  Layer.mergeAll(WorkflowReadModelLive, WorkflowProjectionPipelineLive).pipe(
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorkflowReadModel", (it) => {
  it.effect("registers a board and lists its tickets", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const pipeline = yield* WorkflowProjectionPipeline;

      yield* read.registerBoard({
        boardId: "b-1" as never,
        projectId: "p-1" as never,
        name: "Delivery",
        workflowFilePath: ".t3/boards/delivery.json",
        workflowVersionHash: "hash1",
        maxConcurrentTickets: 3,
      });
      yield* pipeline.projectEvent({
        type: "TicketCreated",
        eventId: "e1" as never,
        ticketId: "t-1" as never,
        streamVersion: 0,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "b-1" as never,
          title: "Export" as never,
          description: "Export the current list",
          laneKey: "backlog" as never,
        },
      });

      const board = yield* read.getBoard("b-1" as never);
      assert.equal(board?.name, "Delivery");
      const tickets = yield* read.listTickets("b-1" as never);
      assert.equal(tickets.length, 1);
      assert.equal(tickets[0]?.title, "Export");
      assert.equal(tickets[0]?.description, "Export the current list");
    }),
  );

  it.effect("counts token-admitted tickets and returns the oldest queued ticket", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const pipeline = yield* WorkflowProjectionPipeline;
      const base = {
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "queue-read-a" as never,
        ticketId: "t-admitted" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-queue-read" as never,
          title: "Admitted" as never,
          laneKey: "implement" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketMovedToLane",
        eventId: "queue-read-b" as never,
        ticketId: "t-admitted" as never,
        streamVersion: 1,
        payload: {
          toLane: "implement" as never,
          laneEntryToken: "tok-admitted" as never,
          reason: "initial",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "queue-read-c" as never,
        ticketId: "t-created-no-token" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-queue-read" as never,
          title: "Created but not admitted" as never,
          laneKey: "implement" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "queue-read-d" as never,
        ticketId: "t-queued-newer" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-queue-read" as never,
          title: "Queued newer" as never,
          laneKey: "backlog" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketQueued",
        eventId: "queue-read-e" as never,
        ticketId: "t-queued-newer" as never,
        streamVersion: 1,
        occurredAt: "2026-06-07T00:00:05.000Z" as never,
        payload: { lane: "implement" as never },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "queue-read-f" as never,
        ticketId: "t-queued-older" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-queue-read" as never,
          title: "Queued older" as never,
          laneKey: "backlog" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketQueued",
        eventId: "queue-read-g" as never,
        ticketId: "t-queued-older" as never,
        streamVersion: 1,
        occurredAt: "2026-06-07T00:00:04.000Z" as never,
        payload: { lane: "implement" as never },
      });

      const admittedCount = yield* read.countAdmittedInLane(
        "b-queue-read" as never,
        "implement" as never,
      );
      const oldestQueued = yield* read.oldestQueuedForLane(
        "b-queue-read" as never,
        "implement" as never,
      );
      const tickets = yield* read.listTickets("b-queue-read" as never);
      const queuedDetail = yield* read.getTicketDetail("t-queued-older" as never);

      assert.equal(admittedCount, 1);
      assert.equal(oldestQueued?.ticketId, "t-queued-older");
      assert.equal(oldestQueued?.queuedAt, "2026-06-07T00:00:04.000Z");
      assert.equal(oldestQueued?.currentLaneEntryToken, null);
      assert.equal(tickets.find((ticket) => ticket.ticketId === "t-admitted")?.queuedAt, null);
      assert.equal(
        tickets.find((ticket) => ticket.ticketId === "t-queued-newer")?.queuedAt,
        "2026-06-07T00:00:05.000Z",
      );
      assert.equal(queuedDetail?.ticket.queuedAt, "2026-06-07T00:00:04.000Z");
    }),
  );

  it.effect("returns ticket detail with step runs", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const pipeline = yield* WorkflowProjectionPipeline;
      const base = { ticketId: "t-9" as never, occurredAt: "2026-06-07T00:00:00.000Z" as never };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-1" as never,
          title: "Z" as never,
          description: "Ticket detail context",
          laneKey: "implement" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "PipelineStarted",
        eventId: "b" as never,
        streamVersion: 1,
        payload: {
          pipelineRunId: "pr" as never,
          laneKey: "implement" as never,
          laneEntryToken: "tok" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepStarted",
        eventId: "c" as never,
        streamVersion: 2,
        payload: {
          pipelineRunId: "pr" as never,
          stepRunId: "sr" as never,
          stepKey: "code" as never,
          stepType: "agent",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketMessagePosted",
        eventId: "d" as never,
        streamVersion: 3,
        payload: {
          messageId: "message-agent" as never,
          stepRunId: "sr" as never,
          author: "agent",
          body: "Which API should I use?",
          attachments: [],
          createdAt: "2026-06-07T00:00:01.000Z" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "TicketMessagePosted",
        eventId: "e" as never,
        streamVersion: 4,
        occurredAt: "2026-06-07T00:00:02.000Z" as never,
        payload: {
          messageId: "message-user" as never,
          stepRunId: "sr" as never,
          author: "user",
          body: "Use the sandbox endpoint.",
          attachments: [
            {
              kind: "image",
              id: "image-detail",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 1200,
              dataUrl: "data:image/png;base64,AAAA",
            },
          ],
          createdAt: "2026-06-07T00:00:02.000Z" as never,
        },
      });

      const detail = yield* read.getTicketDetail("t-9" as never);
      const messages = yield* read.listTicketMessages("t-9" as never);
      assert.equal(detail?.ticket.title, "Z");
      assert.equal(detail?.ticket.description, "Ticket detail context");
      assert.equal(detail?.steps.length, 1);
      assert.equal(detail?.steps[0]?.stepKey, "code");
      assert.deepEqual(
        detail?.messages.map((message) => message.body),
        ["Which API should I use?", "Use the sandbox endpoint."],
      );
      assert.deepEqual(
        messages.map((message) => message.messageId),
        ["message-agent", "message-user"],
      );
      assert.equal(messages[1]?.attachments[0]?.kind, "image");
    }),
  );

  it.effect(
    "skips queued tickets with unresolved dependencies and releases them when resolved",
    () =>
      Effect.gen(function* () {
        const read = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;
        const insertTicket = (input: {
          readonly ticketId: string;
          readonly queuedAt: string | null;
          readonly terminalAt?: string | null;
        }) => sql`
        INSERT INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status,
          queued_at, terminal_at, created_at, updated_at
        )
        VALUES (
          ${input.ticketId}, 'board-deps', ${input.ticketId}, 'work', 'queued',
          ${input.queuedAt}, ${input.terminalAt ?? null},
          '2026-06-07T00:00:00.000Z', '2026-06-07T00:00:00.000Z'
        )
      `;
        yield* insertTicket({ ticketId: "ticket-dep-a", queuedAt: null });
        yield* insertTicket({ ticketId: "ticket-dep-b", queuedAt: "2026-06-07T00:00:01.000Z" });
        yield* insertTicket({ ticketId: "ticket-dep-c", queuedAt: "2026-06-07T00:00:02.000Z" });
        yield* sql`
        INSERT INTO projection_ticket_dependency (ticket_id, depends_on_ticket_id)
        VALUES ('ticket-dep-b', 'ticket-dep-a')
      `;

        // B is older but blocked by A; admission picks C.
        const eligible = yield* read.oldestQueuedForLane("board-deps" as never, "work" as never);
        assert.equal(eligible?.ticketId, "ticket-dep-c");

        const tickets = yield* read.listTickets("board-deps" as never);
        const blocked = tickets.find((ticket) => ticket.ticketId === "ticket-dep-b");
        assert.deepEqual(blocked?.dependsOn, ["ticket-dep-a"]);
        assert.equal(blocked?.unresolvedDependencyCount, 1);

        // Nothing releasable while A is not terminal.
        assert.deepEqual(yield* read.listReleasableDependents("ticket-dep-a" as never), []);

        yield* sql`
        UPDATE projection_ticket
        SET terminal_at = '2026-06-07T00:01:00.000Z'
        WHERE ticket_id = 'ticket-dep-a'
      `;

        const releasable = yield* read.listReleasableDependents("ticket-dep-a" as never);
        assert.deepEqual(
          releasable.map((row) => [row.ticketId, row.boardId, row.laneKey]),
          [["ticket-dep-b", "board-deps", "work"]],
        );
        const nowEligible = yield* read.oldestQueuedForLane("board-deps" as never, "work" as never);
        assert.equal(nowEligible?.ticketId, "ticket-dep-b");
        assert.equal(nowEligible?.unresolvedDependencyCount, 0);

        // A dependency on a deleted/unknown ticket never blocks.
        yield* sql`
        INSERT INTO projection_ticket_dependency (ticket_id, depends_on_ticket_id)
        VALUES ('ticket-dep-c', 'ticket-gone')
      `;
        const stillEligible = yield* read.oldestQueuedForLane(
          "board-deps" as never,
          "work" as never,
        );
        assert.equal(stillEligible?.ticketId, "ticket-dep-b");
      }),
  );

  it.effect("lists a capped ticket discussion newest-last without decoding attachments", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_ticket_message (
          message_id,
          ticket_id,
          step_run_id,
          author,
          body,
          attachments_json,
          created_at
        )
        VALUES
          ('message-d-1', 'ticket-discussion', NULL, 'user', 'first', '[]', '2026-06-07T00:00:00.000Z'),
          ('message-d-2', 'ticket-discussion', NULL, 'agent', 'second', '[{"kind":"image"},{"kind":"image"}]', '2026-06-07T00:01:00.000Z'),
          ('message-d-3', 'ticket-discussion', NULL, 'user', 'third', '[]', '2026-06-07T00:02:00.000Z')
      `;

      const all = yield* read.listTicketDiscussion("ticket-discussion" as never, 10);
      assert.deepEqual(
        all.map((row) => [row.author, row.body, row.attachmentCount]),
        [
          ["user", "first", 0],
          ["agent", "second", 2],
          ["user", "third", 0],
        ],
      );
      assert.equal(all[0]?.createdAt, "2026-06-07T00:00:00.000Z");

      const capped = yield* read.listTicketDiscussion("ticket-discussion" as never, 2);
      assert.deepEqual(
        capped.map((row) => row.body),
        ["second", "third"],
      );
    }),
  );

  it.effect("lists route decisions with snapshot highlights and manual moves", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const insertEvent = (input: {
        readonly eventId: string;
        readonly streamVersion: number;
        readonly eventType: string;
        readonly occurredAt: string;
        readonly payload: unknown;
      }) => sql`
        INSERT INTO workflow_events (
          event_id, ticket_id, stream_version, event_type, occurred_at, payload_json
        )
        VALUES (
          ${input.eventId},
          'ticket-route-history',
          ${input.streamVersion},
          ${input.eventType},
          ${input.occurredAt},
          ${JSON.stringify(input.payload)}
        )
      `;
      yield* insertEvent({
        eventId: "event-route-1",
        streamVersion: 0,
        eventType: "TicketRouteDecided",
        occurredAt: "2026-06-07T00:00:01.000Z",
        payload: {
          pipelineRunId: "pipeline-1",
          fromLane: "implement",
          toLane: "review",
          source: "lane_transition",
          matchedTransitionIndex: 1,
          contextSnapshot: {
            pipeline: { result: "success" },
            lane: { runCount: 2 },
            status: "idle",
            steps: {
              verdict: { status: "completed", exitCode: 0, output: { verdict: "approve" } },
            },
          },
        },
      });
      // The routed TicketMovedToLane twin of the decision above must NOT
      // produce a duplicate history entry.
      yield* insertEvent({
        eventId: "event-route-2",
        streamVersion: 1,
        eventType: "TicketMovedToLane",
        occurredAt: "2026-06-07T00:00:01.000Z",
        payload: { toLane: "review", laneEntryToken: "token-1", reason: "routed" },
      });
      yield* insertEvent({
        eventId: "event-route-3",
        streamVersion: 2,
        eventType: "TicketMovedToLane",
        occurredAt: "2026-06-07T00:00:02.000Z",
        payload: { toLane: "implement", laneEntryToken: "token-2", reason: "manual" },
      });
      // Malformed snapshot degrades to just the lanes instead of failing.
      yield* insertEvent({
        eventId: "event-route-4",
        streamVersion: 3,
        eventType: "TicketRouteDecided",
        occurredAt: "2026-06-07T00:00:03.000Z",
        payload: {
          pipelineRunId: "pipeline-2",
          fromLane: "implement",
          toLane: "stuck",
          source: "lane_on",
          contextSnapshot: "not an object",
        },
      });

      const decisions = yield* read.listTicketRouteDecisions("ticket-route-history" as never);

      assert.deepEqual(
        decisions.map((row) => [row.source, row.fromLane, row.toLane]),
        [
          ["lane_transition", "implement", "review"],
          ["manual", null, "implement"],
          ["lane_on", "implement", "stuck"],
        ],
      );
      const first = decisions[0];
      assert.equal(first?.matchedTransitionIndex, 1);
      assert.equal(first?.pipelineResult, "success");
      assert.equal(first?.laneRunCount, 2);
      assert.deepEqual(first?.steps, {
        verdict: { status: "completed", exitCode: 0, verdict: "approve" },
      });
      const malformed = decisions[2];
      assert.equal(malformed?.pipelineResult, null);
      assert.equal(malformed?.laneRunCount, null);
      assert.equal(malformed?.steps, null);
    }),
  );

  it.effect("parses a work_source route decision into history", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const insertRouteDecision = (payload: unknown) => sql`
        INSERT INTO workflow_events (
          event_id, ticket_id, stream_version, event_type, occurred_at, payload_json
        )
        VALUES (
          'event-work-source-1',
          'ticket-work-source',
          0,
          'TicketRouteDecided',
          '2026-06-13T00:00:01.000Z',
          ${JSON.stringify(payload)}
        )
      `;
      yield* insertRouteDecision({
        fromLane: "implement",
        toLane: "done",
        source: "work_source",
      });

      const decisions = yield* read.listTicketRouteDecisions("ticket-work-source" as never);

      assert.deepEqual(
        decisions.map((row) => [row.source, row.fromLane, row.toLane]),
        [["work_source", "implement", "done"]],
      );
    }),
  );

  it.effect("caps route decisions to the newest events", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.forEach(
        Array.from({ length: 105 }, (_, index) => index),
        (index) => sql`
          INSERT INTO workflow_events (
            event_id, ticket_id, stream_version, event_type, occurred_at, payload_json
          )
          VALUES (
            ${`event-route-cap-${index}`},
            'ticket-route-cap',
            ${index},
            'TicketMovedToLane',
            ${`2026-06-07T00:00:${String(index % 60).padStart(2, "0")}.000Z`},
            ${JSON.stringify({ toLane: `lane-${index}`, laneEntryToken: `token-${index}`, reason: "manual" })}
          )
        `,
      );

      const decisions = yield* read.listTicketRouteDecisions("ticket-route-cap" as never);

      assert.equal(decisions.length, 100);
      assert.equal(decisions[0]?.toLane, "lane-5");
      assert.equal(decisions.at(-1)?.toLane, "lane-104");
    }),
  );

  it.effect("returns blockedReason for blocked step runs", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const pipeline = yield* WorkflowProjectionPipeline;
      const base = {
        ticketId: "t-blocked-detail" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "blocked-detail-a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-1" as never,
          title: "Blocked detail" as never,
          laneKey: "implement" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "PipelineStarted",
        eventId: "blocked-detail-b" as never,
        streamVersion: 1,
        payload: {
          pipelineRunId: "pr-blocked-detail" as never,
          laneKey: "implement" as never,
          laneEntryToken: "tok-blocked-detail" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepStarted",
        eventId: "blocked-detail-c" as never,
        streamVersion: 2,
        payload: {
          pipelineRunId: "pr-blocked-detail" as never,
          stepRunId: "sr-blocked-detail" as never,
          stepKey: "code" as never,
          stepType: "agent",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepBlocked",
        eventId: "blocked-detail-d" as never,
        streamVersion: 3,
        payload: {
          stepRunId: "sr-blocked-detail" as never,
          reason: "Project not trusted to run scripts",
        },
      } as never);

      const detail = yield* read.getTicketDetail("t-blocked-detail" as never);
      assert.equal(detail?.steps[0]?.status, "blocked");
      assert.equal(detail?.steps[0]?.blockedReason, "Project not trusted to run scripts");
      assert.equal(detail?.steps[0]?.waitingReason, null);
    }),
  );

  it.effect("returns script terminal metadata in ticket detail", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const pipeline = yield* WorkflowProjectionPipeline;
      const base = {
        ticketId: "t-script-detail" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "script-detail-a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-1" as never,
          title: "Script detail" as never,
          laneKey: "implement" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "PipelineStarted",
        eventId: "script-detail-b" as never,
        streamVersion: 1,
        payload: {
          pipelineRunId: "pr-script-detail" as never,
          laneKey: "implement" as never,
          laneEntryToken: "tok-script-detail" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepStarted",
        eventId: "script-detail-c" as never,
        streamVersion: 2,
        payload: {
          pipelineRunId: "pr-script-detail" as never,
          stepRunId: "sr-script-detail" as never,
          stepKey: "tests" as never,
          stepType: "script",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "ScriptStepStarted",
        eventId: "script-detail-d" as never,
        streamVersion: 3,
        payload: {
          scriptRunId: "script-run-detail" as never,
          stepRunId: "sr-script-detail" as never,
          scriptThreadId: "workflow-script:script-run-detail" as never,
          terminalId: "script-script-run-detail" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "ScriptStepExited",
        eventId: "script-detail-e" as never,
        streamVersion: 4,
        payload: {
          scriptRunId: "script-run-detail" as never,
          exitCode: 0,
          signal: null,
          outcome: "exited",
        },
      });

      const detail = yield* read.getTicketDetail("t-script-detail" as never);
      const step = detail?.steps[0] as any;

      assert.equal(step?.scriptThreadId, "workflow-script:script-run-detail");
      assert.equal(step?.terminalId, "script-script-run-detail");
      assert.equal(step?.scriptStatus, "exited");
      assert.equal(step?.exitCode, 0);
      assert.equal(step?.signal, null);
    }),
  );

  it.effect("returns completed step output in ticket detail", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const pipeline = yield* WorkflowProjectionPipeline;
      const base = {
        ticketId: "t-output-detail" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "output-detail-a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-1" as never,
          title: "Output detail" as never,
          laneKey: "implement" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "PipelineStarted",
        eventId: "output-detail-b" as never,
        streamVersion: 1,
        payload: {
          pipelineRunId: "pr-output-detail" as never,
          laneKey: "implement" as never,
          laneEntryToken: "tok-output-detail" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepStarted",
        eventId: "output-detail-c" as never,
        streamVersion: 2,
        payload: {
          pipelineRunId: "pr-output-detail" as never,
          stepRunId: "sr-output-detail" as never,
          stepKey: "review" as never,
          stepType: "agent",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepCompleted",
        eventId: "output-detail-d" as never,
        streamVersion: 3,
        payload: {
          stepRunId: "sr-output-detail" as never,
          output: { verdict: "pass", score: 0.98 },
        },
      } as never);

      const detail = yield* read.getTicketDetail("t-output-detail" as never);
      assert.deepEqual((detail?.steps[0] as any)?.output, { verdict: "pass", score: 0.98 });
    }),
  );

  it.effect("lists step runs scoped to one pipeline run with script exit codes and output", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const pipeline = yield* WorkflowProjectionPipeline;
      const base = {
        ticketId: "t-pipeline-steps" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "pipeline-steps-a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-1" as never,
          title: "Pipeline scoped steps" as never,
          laneKey: "implement" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "PipelineStarted",
        eventId: "pipeline-steps-b" as never,
        streamVersion: 1,
        payload: {
          pipelineRunId: "pr-target" as never,
          laneKey: "implement" as never,
          laneEntryToken: "tok-target" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepStarted",
        eventId: "pipeline-steps-c" as never,
        streamVersion: 2,
        payload: {
          pipelineRunId: "pr-target" as never,
          stepRunId: "sr-tests" as never,
          stepKey: "tests" as never,
          stepType: "script",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "ScriptStepStarted",
        eventId: "pipeline-steps-d" as never,
        streamVersion: 3,
        payload: {
          scriptRunId: "script-run-target" as never,
          stepRunId: "sr-tests" as never,
          scriptThreadId: "workflow-script:script-run-target" as never,
          terminalId: "script-target" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "ScriptStepExited",
        eventId: "pipeline-steps-e" as never,
        streamVersion: 4,
        payload: {
          scriptRunId: "script-run-target" as never,
          exitCode: 2,
          signal: null,
          outcome: "exited",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepCompleted",
        eventId: "pipeline-steps-f" as never,
        streamVersion: 5,
        payload: { stepRunId: "sr-tests" as never },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepStarted",
        eventId: "pipeline-steps-g" as never,
        streamVersion: 6,
        payload: {
          pipelineRunId: "pr-target" as never,
          stepRunId: "sr-review" as never,
          stepKey: "review" as never,
          stepType: "agent",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepCompleted",
        eventId: "pipeline-steps-h" as never,
        streamVersion: 7,
        payload: {
          stepRunId: "sr-review" as never,
          output: { verdict: "needs_attention" },
        },
      } as never);
      yield* pipeline.projectEvent({
        ...base,
        type: "PipelineStarted",
        eventId: "pipeline-steps-i" as never,
        streamVersion: 8,
        payload: {
          pipelineRunId: "pr-other" as never,
          laneKey: "implement" as never,
          laneEntryToken: "tok-other" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepStarted",
        eventId: "pipeline-steps-j" as never,
        streamVersion: 9,
        payload: {
          pipelineRunId: "pr-other" as never,
          stepRunId: "sr-other" as never,
          stepKey: "other" as never,
          stepType: "agent",
        },
      });

      const rows = yield* read.listStepRunsForPipeline("pr-target" as never);

      assert.deepEqual(rows, [
        {
          stepKey: "tests",
          stepType: "script",
          status: "completed",
          exitCode: 2,
          output: null,
        },
        {
          stepKey: "review",
          stepType: "agent",
          status: "completed",
          exitCode: null,
          output: { verdict: "needs_attention" },
        },
      ]);
    }),
  );

  it.effect("returns provider response kind in ticket step detail", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const pipeline = yield* WorkflowProjectionPipeline;
      const base = {
        ticketId: "t-provider-kind-detail" as never,
        occurredAt: "2026-06-08T00:00:00.000Z" as never,
      };

      yield* pipeline.projectEvent({
        ...base,
        type: "TicketCreated",
        eventId: "provider-kind-detail-a" as never,
        streamVersion: 0,
        payload: {
          boardId: "b-provider-kind-detail" as never,
          title: "Provider kind detail" as never,
          laneKey: "review" as never,
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepStarted",
        eventId: "provider-kind-detail-b" as never,
        streamVersion: 1,
        payload: {
          pipelineRunId: "pr-provider-kind-detail" as never,
          stepRunId: "sr-provider-kind-detail" as never,
          stepKey: "review" as never,
          stepType: "agent",
        },
      });
      yield* pipeline.projectEvent({
        ...base,
        type: "StepAwaitingUser",
        eventId: "provider-kind-detail-c" as never,
        streamVersion: 2,
        payload: {
          stepRunId: "sr-provider-kind-detail" as never,
          waitingReason: "Approve this command?",
          providerResponseKind: "request",
        },
      });

      const detail = yield* read.getTicketDetail("t-provider-kind-detail" as never);
      assert.equal((detail?.steps[0] as any)?.providerResponseKind, "request");
    }),
  );

  it.effect("lists boards for a project and deletes one", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      yield* read.registerBoard({
        boardId: "p1__a" as never,
        projectId: "p1" as never,
        name: "A",
        workflowFilePath: ".t3/boards/a.json",
        workflowVersionHash: "h",
        maxConcurrentTickets: 3,
      });

      const before = yield* read.listBoardsForProject("p1" as never);
      assert.equal(before.length, 1);
      assert.equal(before[0]?.filePath, ".t3/boards/a.json");

      yield* read.deleteBoard("p1__a" as never);
      assert.deepEqual(yield* read.listBoardsForProject("p1" as never), []);
    }),
  );

  it.effect("deletes ticket-scoped projections for a board without deleting other boards", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-06-07T00:00:00.000Z";

      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id,
          board_id,
          title,
          current_lane_key,
          status,
          created_at,
          updated_at
        )
        VALUES
          ('ticket-cascade', 'board-cascade', 'Cascade', 'backlog', 'idle', ${now}, ${now}),
          ('ticket-keep', 'board-keep', 'Keep', 'backlog', 'idle', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_pipeline_run (
          pipeline_run_id,
          ticket_id,
          lane_key,
          lane_entry_token,
          status,
          started_at
        )
        VALUES
          ('pipeline-cascade', 'ticket-cascade', 'backlog', 'token-cascade', 'running', ${now}),
          ('pipeline-keep', 'ticket-keep', 'backlog', 'token-keep', 'running', ${now})
      `;
      yield* sql`
        INSERT INTO projection_step_run (
          step_run_id,
          pipeline_run_id,
          ticket_id,
          step_key,
          step_type,
          status,
          started_at
        )
        VALUES
          ('step-cascade', 'pipeline-cascade', 'ticket-cascade', 'build', 'script', 'running', ${now}),
          ('step-keep', 'pipeline-keep', 'ticket-keep', 'build', 'script', 'running', ${now})
      `;
      yield* sql`
        INSERT INTO workflow_script_run (
          script_run_id,
          step_run_id,
          ticket_id,
          script_thread_id,
          terminal_id,
          status,
          started_at
        )
        VALUES
          ('script-cascade', 'step-cascade', 'ticket-cascade', 'thread-cascade', 'terminal-cascade', 'running', ${now}),
          ('script-keep', 'step-keep', 'ticket-keep', 'thread-keep', 'terminal-keep', 'running', ${now})
      `;
      yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
          provider_instance,
          model,
          instruction,
          worktree_path,
          status,
          created_at
        )
        VALUES
          ('dispatch-cascade', 'ticket-cascade', 'step-cascade', 'thread-cascade', 'codex', 'gpt-5.5', 'Do cascade', '/tmp/cascade', 'pending', ${now}),
          ('dispatch-keep', 'ticket-keep', 'step-keep', 'thread-keep', 'codex', 'gpt-5.5', 'Keep going', '/tmp/keep', 'pending', ${now})
      `;
      yield* sql`
        INSERT INTO workflow_setup_run (
          setup_run_id,
          ticket_id,
          worktree_ref,
          status,
          started_at
        )
        VALUES
          ('setup-cascade', 'ticket-cascade', 'worktree-cascade', 'running', ${now}),
          ('setup-keep', 'ticket-keep', 'worktree-keep', 'running', ${now})
      `;
      yield* sql`
        INSERT INTO projection_ticket_message (
          message_id,
          ticket_id,
          step_run_id,
          author,
          body,
          attachments_json,
          created_at
        )
        VALUES
          ('message-cascade', 'ticket-cascade', 'step-cascade', 'user', 'Delete me', '[]', ${now}),
          ('message-keep', 'ticket-keep', 'step-keep', 'user', 'Keep me', '[]', ${now})
      `;

      yield* read.deleteBoardTicketState("board-cascade" as never);

      const remaining = yield* sql<{ readonly tableName: string; readonly count: number }>`
        SELECT 'projection_ticket' AS tableName, COUNT(*) AS count
        FROM projection_ticket
        WHERE ticket_id = 'ticket-cascade'
        UNION ALL
        SELECT 'projection_pipeline_run' AS tableName, COUNT(*) AS count
        FROM projection_pipeline_run
        WHERE ticket_id = 'ticket-cascade'
        UNION ALL
        SELECT 'projection_step_run' AS tableName, COUNT(*) AS count
        FROM projection_step_run
        WHERE ticket_id = 'ticket-cascade'
        UNION ALL
        SELECT 'workflow_script_run' AS tableName, COUNT(*) AS count
        FROM workflow_script_run
        WHERE ticket_id = 'ticket-cascade'
        UNION ALL
        SELECT 'workflow_dispatch_outbox' AS tableName, COUNT(*) AS count
        FROM workflow_dispatch_outbox
        WHERE ticket_id = 'ticket-cascade'
        UNION ALL
        SELECT 'workflow_setup_run' AS tableName, COUNT(*) AS count
        FROM workflow_setup_run
        WHERE ticket_id = 'ticket-cascade'
        UNION ALL
        SELECT 'projection_ticket_message' AS tableName, COUNT(*) AS count
        FROM projection_ticket_message
        WHERE ticket_id = 'ticket-cascade'
      `;
      assert.deepEqual(
        remaining.map((row) => [row.tableName, row.count]),
        [
          ["projection_ticket", 0],
          ["projection_pipeline_run", 0],
          ["projection_step_run", 0],
          ["workflow_script_run", 0],
          ["workflow_dispatch_outbox", 0],
          ["workflow_setup_run", 0],
          ["projection_ticket_message", 0],
        ],
      );

      const kept = yield* sql<{ readonly tableName: string; readonly count: number }>`
        SELECT 'projection_ticket' AS tableName, COUNT(*) AS count
        FROM projection_ticket
        WHERE ticket_id = 'ticket-keep'
        UNION ALL
        SELECT 'projection_pipeline_run' AS tableName, COUNT(*) AS count
        FROM projection_pipeline_run
        WHERE ticket_id = 'ticket-keep'
        UNION ALL
        SELECT 'projection_step_run' AS tableName, COUNT(*) AS count
        FROM projection_step_run
        WHERE ticket_id = 'ticket-keep'
        UNION ALL
        SELECT 'workflow_script_run' AS tableName, COUNT(*) AS count
        FROM workflow_script_run
        WHERE ticket_id = 'ticket-keep'
        UNION ALL
        SELECT 'workflow_dispatch_outbox' AS tableName, COUNT(*) AS count
        FROM workflow_dispatch_outbox
        WHERE ticket_id = 'ticket-keep'
        UNION ALL
        SELECT 'workflow_setup_run' AS tableName, COUNT(*) AS count
        FROM workflow_setup_run
        WHERE ticket_id = 'ticket-keep'
        UNION ALL
        SELECT 'projection_ticket_message' AS tableName, COUNT(*) AS count
        FROM projection_ticket_message
        WHERE ticket_id = 'ticket-keep'
      `;
      assert.deepEqual(
        kept.map((row) => [row.tableName, row.count]),
        [
          ["projection_ticket", 1],
          ["projection_pipeline_run", 1],
          ["projection_step_run", 1],
          ["workflow_script_run", 1],
          ["workflow_dispatch_outbox", 1],
          ["workflow_setup_run", 1],
          ["projection_ticket_message", 1],
        ],
      );
    }),
  );

  it.effect(
    "deletes ticket-scoped projections for one ticket without deleting sibling tickets",
    () =>
      Effect.gen(function* () {
        const read = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-06-07T00:00:00.000Z";

        yield* sql`
        INSERT INTO projection_ticket (
          ticket_id,
          board_id,
          title,
          current_lane_key,
          status,
          created_at,
          updated_at
        )
        VALUES
          ('ticket-delete-one', 'board-ticket-delete', 'Delete one', 'done', 'done', ${now}, ${now}),
          ('ticket-keep-one', 'board-ticket-delete', 'Keep one', 'done', 'done', ${now}, ${now})
      `;
        yield* sql`
        INSERT INTO projection_pipeline_run (
          pipeline_run_id,
          ticket_id,
          lane_key,
          lane_entry_token,
          status,
          started_at
        )
        VALUES
          ('pipeline-delete-one', 'ticket-delete-one', 'done', 'token-delete-one', 'completed', ${now}),
          ('pipeline-keep-one', 'ticket-keep-one', 'done', 'token-keep-one', 'completed', ${now})
      `;
        yield* sql`
        INSERT INTO projection_step_run (
          step_run_id,
          pipeline_run_id,
          ticket_id,
          step_key,
          step_type,
          status,
          started_at
        )
        VALUES
          ('step-delete-one', 'pipeline-delete-one', 'ticket-delete-one', 'cleanup', 'script', 'completed', ${now}),
          ('step-keep-one', 'pipeline-keep-one', 'ticket-keep-one', 'cleanup', 'script', 'completed', ${now})
      `;
        yield* sql`
        INSERT INTO workflow_script_run (
          script_run_id,
          step_run_id,
          ticket_id,
          script_thread_id,
          terminal_id,
          status,
          started_at
        )
        VALUES
          ('script-delete-one', 'step-delete-one', 'ticket-delete-one', 'thread-delete-one', 'terminal-delete-one', 'completed', ${now}),
          ('script-keep-one', 'step-keep-one', 'ticket-keep-one', 'thread-keep-one', 'terminal-keep-one', 'completed', ${now})
      `;
        yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
          provider_instance,
          model,
          instruction,
          worktree_path,
          status,
          created_at
        )
        VALUES
          ('dispatch-delete-one', 'ticket-delete-one', 'step-delete-one', 'thread-delete-one', 'codex', 'gpt-5.5', 'Delete one', '/tmp/delete-one', 'completed', ${now}),
          ('dispatch-keep-one', 'ticket-keep-one', 'step-keep-one', 'thread-keep-one', 'codex', 'gpt-5.5', 'Keep one', '/tmp/keep-one', 'completed', ${now})
      `;
        yield* sql`
        INSERT INTO workflow_setup_run (
          setup_run_id,
          ticket_id,
          worktree_ref,
          status,
          started_at
        )
        VALUES
          ('setup-delete-one', 'ticket-delete-one', 'worktree-delete-one', 'completed', ${now}),
          ('setup-keep-one', 'ticket-keep-one', 'worktree-keep-one', 'completed', ${now})
      `;
        yield* sql`
        INSERT INTO projection_ticket_message (
          message_id,
          ticket_id,
          step_run_id,
          author,
          body,
          attachments_json,
          created_at
        )
        VALUES
          ('message-delete-one', 'ticket-delete-one', 'step-delete-one', 'user', 'Delete me', '[]', ${now}),
          ('message-keep-one', 'ticket-keep-one', 'step-keep-one', 'user', 'Keep me', '[]', ${now})
      `;

        yield* read.deleteTicketState("ticket-delete-one" as never);

        const counts = yield* sql<{
          readonly tableName: string;
          readonly deleted: number;
          readonly kept: number;
        }>`
        SELECT 'projection_ticket' AS tableName,
          SUM(CASE WHEN ticket_id = 'ticket-delete-one' THEN 1 ELSE 0 END) AS deleted,
          SUM(CASE WHEN ticket_id = 'ticket-keep-one' THEN 1 ELSE 0 END) AS kept
        FROM projection_ticket
        UNION ALL
        SELECT 'projection_pipeline_run' AS tableName,
          SUM(CASE WHEN ticket_id = 'ticket-delete-one' THEN 1 ELSE 0 END) AS deleted,
          SUM(CASE WHEN ticket_id = 'ticket-keep-one' THEN 1 ELSE 0 END) AS kept
        FROM projection_pipeline_run
        UNION ALL
        SELECT 'projection_step_run' AS tableName,
          SUM(CASE WHEN ticket_id = 'ticket-delete-one' THEN 1 ELSE 0 END) AS deleted,
          SUM(CASE WHEN ticket_id = 'ticket-keep-one' THEN 1 ELSE 0 END) AS kept
        FROM projection_step_run
        UNION ALL
        SELECT 'workflow_script_run' AS tableName,
          SUM(CASE WHEN ticket_id = 'ticket-delete-one' THEN 1 ELSE 0 END) AS deleted,
          SUM(CASE WHEN ticket_id = 'ticket-keep-one' THEN 1 ELSE 0 END) AS kept
        FROM workflow_script_run
        UNION ALL
        SELECT 'workflow_dispatch_outbox' AS tableName,
          SUM(CASE WHEN ticket_id = 'ticket-delete-one' THEN 1 ELSE 0 END) AS deleted,
          SUM(CASE WHEN ticket_id = 'ticket-keep-one' THEN 1 ELSE 0 END) AS kept
        FROM workflow_dispatch_outbox
        UNION ALL
        SELECT 'workflow_setup_run' AS tableName,
          SUM(CASE WHEN ticket_id = 'ticket-delete-one' THEN 1 ELSE 0 END) AS deleted,
          SUM(CASE WHEN ticket_id = 'ticket-keep-one' THEN 1 ELSE 0 END) AS kept
        FROM workflow_setup_run
        UNION ALL
        SELECT 'projection_ticket_message' AS tableName,
          SUM(CASE WHEN ticket_id = 'ticket-delete-one' THEN 1 ELSE 0 END) AS deleted,
          SUM(CASE WHEN ticket_id = 'ticket-keep-one' THEN 1 ELSE 0 END) AS kept
        FROM projection_ticket_message
      `;

        assert.deepEqual(
          counts.map((row) => [row.tableName, row.deleted, row.kept]),
          [
            ["projection_ticket", 0, 1],
            ["projection_pipeline_run", 0, 1],
            ["projection_step_run", 0, 1],
            ["workflow_script_run", 0, 1],
            ["workflow_dispatch_outbox", 0, 1],
            ["workflow_setup_run", 0, 1],
            ["projection_ticket_message", 0, 1],
          ],
        );
      }),
  );

  it.effect("listTickets and getTicketDetail include pr field when workflow_pr_state row exists", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-06-12T00:00:00.000Z";

      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        )
        VALUES
          ('ticket-pr-view', 'board-pr-view', 'PR ticket', 'implement', 'idle', ${now}, ${now}),
          ('ticket-no-pr', 'board-pr-view', 'No PR ticket', 'implement', 'idle', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO workflow_pr_state (
          ticket_id, pr_number, pr_url, branch, remote_name, repo, pr_state,
          last_ci_state, updated_at
        )
        VALUES (
          'ticket-pr-view', 99, 'https://github.com/owner/repo/pull/99',
          'ft/feature', 'origin', 'owner/repo', 'open', 'success', ${now}
        )
      `;

      const tickets = yield* read.listTickets("board-pr-view" as never);
      const prTicket = tickets.find((t) => t.ticketId === "ticket-pr-view");
      const noPrTicket = tickets.find((t) => t.ticketId === "ticket-no-pr");

      assert.isDefined(prTicket?.pr);
      assert.equal(prTicket?.pr?.number, 99);
      assert.equal(prTicket?.pr?.url, "https://github.com/owner/repo/pull/99");
      assert.equal(prTicket?.pr?.state, "open");
      assert.equal(prTicket?.pr?.ciState, "success");
      assert.isUndefined(noPrTicket?.pr);

      const detail = yield* read.getTicketDetail("ticket-pr-view" as never);
      assert.isDefined(detail?.ticket.pr);
      assert.equal(detail?.ticket.pr?.number, 99);
      assert.equal(detail?.ticket.pr?.url, "https://github.com/owner/repo/pull/99");
      assert.equal(detail?.ticket.pr?.state, "open");
      assert.equal(detail?.ticket.pr?.ciState, "success");

      const detailNoPr = yield* read.getTicketDetail("ticket-no-pr" as never);
      assert.isUndefined(detailNoPr?.ticket.pr);
    }),
  );

  it.effect("pr.ciState is omitted when last_ci_state is NULL", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-06-12T00:00:00.000Z";

      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        )
        VALUES ('ticket-pr-no-ci', 'board-pr-no-ci', 'PR no CI', 'implement', 'idle', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO workflow_pr_state (
          ticket_id, pr_number, pr_url, branch, remote_name, repo, pr_state, updated_at
        )
        VALUES (
          'ticket-pr-no-ci', 3, 'https://github.com/owner/repo/pull/3',
          'ft/no-ci', 'origin', 'owner/repo', 'merged', ${now}
        )
      `;

      const tickets = yield* read.listTickets("board-pr-no-ci" as never);
      const ticket = tickets[0];
      assert.isDefined(ticket?.pr);
      assert.equal(ticket?.pr?.state, "merged");
      assert.isUndefined(ticket?.pr?.ciState);
    }),
  );

  it.effect("getTicketPrState returns full row or null", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-06-12T00:00:00.000Z";

      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        )
        VALUES ('ticket-pr-state-full', 'board-pr-state-full', 'Full PR state', 'implement', 'idle', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO workflow_pr_state (
          ticket_id, pr_number, pr_url, branch, remote_name, repo, pr_state,
          last_head_sha, last_ci_state, last_review_decision, last_comment_cursor, updated_at
        )
        VALUES (
          'ticket-pr-state-full', 11, 'https://github.com/owner/repo/pull/11',
          'ft/full', 'origin', 'owner/repo', 'open',
          'abc123', 'pending', 'APPROVED', 'cursor-xyz', ${now}
        )
      `;

      const prState = yield* read.getTicketPrState("ticket-pr-state-full" as never);
      assert.isNotNull(prState);
      assert.equal(prState?.prNumber, 11);
      assert.equal(prState?.prUrl, "https://github.com/owner/repo/pull/11");
      assert.equal(prState?.branch, "ft/full");
      assert.equal(prState?.remoteName, "origin");
      assert.equal(prState?.repo, "owner/repo");
      assert.equal(prState?.prState, "open");
      assert.equal(prState?.lastHeadSha, "abc123");
      assert.equal(prState?.lastCiState, "pending");
      assert.equal(prState?.lastReviewDecision, "APPROVED");
      assert.equal(prState?.lastCommentCursor, "cursor-xyz");

      const missing = yield* read.getTicketPrState("ticket-no-such" as never);
      assert.isNull(missing);
    }),
  );

  it.effect("drops the pr view when pr_state is unrecognized", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-06-12T00:00:00.000Z";

      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        )
        VALUES ('ticket-pr-bogus', 'board-pr-bogus', 'Bogus PR state', 'implement', 'idle', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO workflow_pr_state (
          ticket_id, pr_number, pr_url, branch, remote_name, repo, pr_state, updated_at
        )
        VALUES (
          'ticket-pr-bogus', 5, 'https://github.com/owner/repo/pull/5',
          'ft/bogus', 'origin', 'owner/repo', 'reopened', ${now}
        )
      `;

      // An unrecognized pr_state is an invariant violation: the view degrades
      // to "no pr" and the read model logs one warning per query (log output
      // is not captured by this harness, so only the view shape is asserted).
      const tickets = yield* read.listTickets("board-pr-bogus" as never);
      assert.equal(tickets.length, 1);
      assert.isUndefined(tickets[0]?.pr);

      const detail = yield* read.getTicketDetail("ticket-pr-bogus" as never);
      assert.isUndefined(detail?.ticket.pr);
    }),
  );

  it.effect(
    "ticket detail carries attention fields and current-lane actions for a waiting ticket",
    () =>
      Effect.gen(function* () {
        const read = yield* WorkflowReadModel;
        const pipeline = yield* WorkflowProjectionPipeline;
        const registry = yield* BoardRegistry;
        const base = {
          ticketId: "t-attention-detail" as never,
          occurredAt: "2026-06-08T00:00:00.000Z" as never,
        };

        yield* registry.register("b-attention-detail" as never, {
          name: "Attention board",
          lanes: [
            {
              key: "review",
              name: "Review",
              entry: "manual",
              actions: [
                { label: "Approve", to: "done", hint: "Ship it" },
                { label: "Send back", to: "implement" },
              ],
            },
            { key: "implement", name: "Implement", entry: "manual" },
            { key: "done", name: "Done", entry: "manual", terminal: true },
          ],
        });

        yield* pipeline.projectEvent({
          ...base,
          type: "TicketCreated",
          eventId: "attention-detail-a" as never,
          streamVersion: 0,
          payload: {
            boardId: "b-attention-detail" as never,
            title: "Needs you" as never,
            laneKey: "review" as never,
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "StepStarted",
          eventId: "attention-detail-b" as never,
          streamVersion: 1,
          payload: {
            pipelineRunId: "pr-attention-detail" as never,
            stepRunId: "sr-attention-detail" as never,
            stepKey: "review" as never,
            stepType: "agent",
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "StepAwaitingUser",
          eventId: "attention-detail-c" as never,
          streamVersion: 2,
          payload: {
            stepRunId: "sr-attention-detail" as never,
            waitingReason: "Approve this command?",
            providerResponseKind: "request",
          },
        });

        const detail = yield* read.getTicketDetail("t-attention-detail" as never);
        assert.equal(detail?.ticket.attentionKind, "waiting_for_approval");
        assert.equal(detail?.ticket.attentionReason, "Approve this command?");
        assert.deepEqual(detail?.ticket.currentLane, {
          key: "review",
          name: "Review",
          actions: [
            { label: "Approve", to: "done", hint: "Ship it" },
            { label: "Send back", to: "implement" },
          ],
        });
      }),
  );

  it.effect(
    "ticket detail reports no attention and an action-less lane for a running ticket",
    () =>
      Effect.gen(function* () {
        const read = yield* WorkflowReadModel;
        const pipeline = yield* WorkflowProjectionPipeline;
        const registry = yield* BoardRegistry;
        const base = {
          ticketId: "t-running-detail" as never,
          occurredAt: "2026-06-08T00:00:00.000Z" as never,
        };

        yield* registry.register("b-running-detail" as never, {
          name: "Running board",
          lanes: [{ key: "implement", name: "Implement", entry: "manual" }],
        });

        yield* pipeline.projectEvent({
          ...base,
          type: "TicketCreated",
          eventId: "running-detail-a" as never,
          streamVersion: 0,
          payload: {
            boardId: "b-running-detail" as never,
            title: "In progress" as never,
            laneKey: "implement" as never,
          },
        });
        yield* pipeline.projectEvent({
          ...base,
          type: "PipelineStarted",
          eventId: "running-detail-b" as never,
          streamVersion: 1,
          payload: {
            pipelineRunId: "pr-running-detail" as never,
            laneKey: "implement" as never,
            laneEntryToken: "tok-running" as never,
          },
        });

        const detail = yield* read.getTicketDetail("t-running-detail" as never);
        assert.equal(detail?.ticket.status, "running");
        assert.equal(detail?.ticket.attentionKind, null);
        assert.equal(detail?.ticket.attentionReason, null);
        // Lane resolved but has no actions configured.
        assert.deepEqual(detail?.ticket.currentLane, {
          key: "implement",
          name: "Implement",
          actions: [],
        });
      }),
  );

  it.effect(
    "ticket detail falls back to a key-only lane when the board definition is unregistered",
    () =>
      Effect.gen(function* () {
        const read = yield* WorkflowReadModel;
        const pipeline = yield* WorkflowProjectionPipeline;
        const base = {
          ticketId: "t-fallback-detail" as never,
          occurredAt: "2026-06-08T00:00:00.000Z" as never,
        };

        // No registry.register for this board — definition is unresolvable.
        yield* pipeline.projectEvent({
          ...base,
          type: "TicketCreated",
          eventId: "fallback-detail-a" as never,
          streamVersion: 0,
          payload: {
            boardId: "b-fallback-detail" as never,
            title: "Orphan" as never,
            laneKey: "mystery_lane" as never,
          },
        });

        const detail = yield* read.getTicketDetail("t-fallback-detail" as never);
        assert.deepEqual(detail?.ticket.currentLane, {
          key: "mystery_lane",
          name: "mystery_lane",
          actions: [],
        });
      }),
  );

  it.effect(
    "listNeedsAttentionTickets returns only waiting/blocked tickets with board name, oldest first",
    () =>
      Effect.gen(function* () {
        const read = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;

        yield* read.registerBoard({
          boardId: "b-needs-attention" as never,
          projectId: "p-needs-attention" as never,
          name: "Attention Board" as never,
          workflowFilePath: ".t3/boards/attention.json",
          workflowVersionHash: "h",
          maxConcurrentTickets: 3,
        });

        const insertTicket = (input: {
          readonly ticketId: string;
          readonly status: string;
          readonly attentionKind: string | null;
          readonly attentionReason: string | null;
          readonly updatedAt: string;
        }) => sql`
          INSERT INTO projection_ticket (
            ticket_id, board_id, title, current_lane_key, status,
            attention_kind, attention_reason, created_at, updated_at
          )
          VALUES (
            ${input.ticketId}, 'b-needs-attention', ${input.ticketId}, 'review', ${input.status},
            ${input.attentionKind}, ${input.attentionReason},
            '2026-06-08T00:00:00.000Z', ${input.updatedAt}
          )
        `;

        // Newer waiting ticket, older blocked ticket, and an excluded running one.
        yield* insertTicket({
          ticketId: "ticket-waiting",
          status: "waiting_on_user",
          attentionKind: "waiting_for_input",
          attentionReason: "Which API?",
          updatedAt: "2026-06-08T02:00:00.000Z",
        });
        yield* insertTicket({
          ticketId: "ticket-blocked",
          status: "blocked",
          attentionKind: "blocked",
          attentionReason: "Missing creds",
          updatedAt: "2026-06-08T01:00:00.000Z",
        });
        yield* insertTicket({
          ticketId: "ticket-running",
          status: "running",
          attentionKind: null,
          attentionReason: null,
          updatedAt: "2026-06-08T03:00:00.000Z",
        });

        const rows = yield* read.listNeedsAttentionTickets();
        assert.deepEqual(
          rows.map((row) => row.ticketId),
          ["ticket-blocked", "ticket-waiting"],
        );
        assert.equal(rows[0]?.boardName, "Attention Board");
        assert.equal(rows[0]?.status, "blocked");
        assert.equal(rows[0]?.attentionKind, "blocked");
        assert.equal(rows[0]?.attentionReason, "Missing creds");
        assert.equal(rows[0]?.currentLaneKey, "review");
        assert.equal(rows[1]?.attentionKind, "waiting_for_input");
      }),
  );

  it.effect("deleteTicketState removes the ticket's notification outbox rows", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-06-08T00:00:00.000Z";

      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        )
        VALUES ('ticket-outbox', 'b-outbox', 'Outbox', 'review', 'waiting_on_user', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO workflow_notification_outbox (
          outbox_id, ticket_id, board_id, sequence, status, created_at
        )
        VALUES ('outbox-1', 'ticket-outbox', 'b-outbox', 1, 'waiting_on_user', ${now})
      `;

      yield* read.deleteTicketState("ticket-outbox" as never);

      const remaining = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM workflow_notification_outbox WHERE ticket_id = 'ticket-outbox'
      `;
      assert.equal(remaining[0]?.count, 0);
    }),
  );

  it.effect("deleteBoardTicketState removes the board's notification outbox rows", () =>
    Effect.gen(function* () {
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-06-08T00:00:00.000Z";

      yield* sql`
        INSERT INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        )
        VALUES ('ticket-board-outbox', 'b-board-outbox', 'Outbox', 'review', 'blocked', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO workflow_notification_outbox (
          outbox_id, ticket_id, board_id, sequence, status, created_at
        )
        VALUES ('board-outbox-1', 'ticket-board-outbox', 'b-board-outbox', 2, 'blocked', ${now})
      `;

      yield* read.deleteBoardTicketState("b-board-outbox" as never);

      const remaining = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM workflow_notification_outbox WHERE board_id = 'b-board-outbox'
      `;
      assert.equal(remaining[0]?.count, 0);
    }),
  );

  it.effect(
    "deleteBoardTicketState removes work_source_mapping and work_source_state rows for the board",
    () =>
      Effect.gen(function* () {
        const read = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-06-13T00:00:00.000Z";

        // Register the board via the proper API
        yield* read.registerBoard({
          boardId: "b-ws-cascade" as never,
          projectId: "proj-ws" as never,
          name: "WS Board",
          workflowFilePath: ".t3/boards/ws.json",
          workflowVersionHash: "hash-ws",
          maxConcurrentTickets: 5,
        });

        // Insert ticket row
        yield* sql`
          INSERT INTO projection_ticket (
            ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
          )
          VALUES ('ticket-ws-cascade', 'b-ws-cascade', 'Synced', 'inbox', 'running', ${now}, ${now})
        `;

        // Insert work_source_mapping row
        yield* sql`
          INSERT INTO work_source_mapping (
            mapping_id, board_id, source_id, provider, external_id, ticket_id,
            content_hash, lifecycle, sync_status, created_at, last_synced_at
          )
          VALUES (
            'map-ws-cascade', 'b-ws-cascade', 'src-1', 'github', '42',
            'ticket-ws-cascade', 'hash123', 'open', 'active', ${now}, ${now}
          )
        `;

        // Insert work_source_state row (board-scoped)
        yield* sql`
          INSERT INTO work_source_state (
            board_id, source_id, consecutive_failures
          )
          VALUES ('b-ws-cascade', 'src-1', 0)
        `;

        yield* read.deleteBoardTicketState("b-ws-cascade" as never);

        const mappingCount = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM work_source_mapping WHERE ticket_id = 'ticket-ws-cascade'
        `;
        assert.equal(mappingCount[0]?.count, 0, "work_source_mapping should be deleted");

        const stateCount = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM work_source_state WHERE board_id = 'b-ws-cascade'
        `;
        assert.equal(stateCount[0]?.count, 0, "work_source_state should be deleted");
      }),
  );

  it.effect(
    "deleteTicketState removes work_source_mapping for the ticket but leaves board-scoped work_source_state intact",
    () =>
      Effect.gen(function* () {
        const read = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-06-13T00:00:00.000Z";

        // Register the board via the proper API
        yield* read.registerBoard({
          boardId: "b-ws-ticket" as never,
          projectId: "proj-ws-t" as never,
          name: "WS Ticket Board",
          workflowFilePath: ".t3/boards/wst.json",
          workflowVersionHash: "hash-wst",
          maxConcurrentTickets: 5,
        });

        // Insert ticket row
        yield* sql`
          INSERT INTO projection_ticket (
            ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
          )
          VALUES ('ticket-ws-single', 'b-ws-ticket', 'Synced Single', 'inbox', 'running', ${now}, ${now})
        `;

        // Insert work_source_mapping row for the ticket
        yield* sql`
          INSERT INTO work_source_mapping (
            mapping_id, board_id, source_id, provider, external_id, ticket_id,
            content_hash, lifecycle, sync_status, created_at, last_synced_at
          )
          VALUES (
            'map-ws-single', 'b-ws-ticket', 'src-2', 'github', '99',
            'ticket-ws-single', 'hash456', 'open', 'active', ${now}, ${now}
          )
        `;

        // Insert board-scoped work_source_state row (should NOT be deleted)
        yield* sql`
          INSERT INTO work_source_state (
            board_id, source_id, consecutive_failures
          )
          VALUES ('b-ws-ticket', 'src-2', 0)
        `;

        yield* read.deleteTicketState("ticket-ws-single" as never);

        const mappingCount = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM work_source_mapping WHERE ticket_id = 'ticket-ws-single'
        `;
        assert.equal(mappingCount[0]?.count, 0, "work_source_mapping should be deleted for the ticket");

        const stateCount = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM work_source_state WHERE board_id = 'b-ws-ticket'
        `;
        assert.equal(stateCount[0]?.count, 1, "work_source_state (board-scoped) should remain untouched");
      }),
  );

  it.effect(
    "getTicketDetail returns syncedSource when work_source_mapping row has valid source_metadata_json",
    () =>
      Effect.gen(function* () {
        const read = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-06-13T00:00:00.000Z";

        yield* read.registerBoard({
          boardId: "b-synced-detail" as never,
          projectId: "proj-synced" as never,
          name: "Synced Board",
          workflowFilePath: ".t3/boards/synced.json",
          workflowVersionHash: "hash-synced",
          maxConcurrentTickets: 5,
        });

        yield* sql`
          INSERT INTO projection_ticket (
            ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
          )
          VALUES ('ticket-synced', 'b-synced-detail', 'Synced Ticket', 'inbox', 'running', ${now}, ${now})
        `;

        const metadataJson =
          '{"provider":"github","url":"https://github.com/owner/repo/issues/42","assignees":["alice","bob"],"labels":["bug","high-priority"],"lifecycle":"open"}';

        yield* sql`
          INSERT INTO work_source_mapping (
            mapping_id, board_id, source_id, provider, external_id, ticket_id,
            content_hash, lifecycle, sync_status, source_metadata_json, created_at, last_synced_at
          )
          VALUES (
            'map-synced', 'b-synced-detail', 'src-synced', 'github', '42',
            'ticket-synced', 'hashXYZ', 'open', 'active', ${metadataJson}, ${now}, ${now}
          )
        `;

        const detail = yield* read.getTicketDetail("ticket-synced" as never);
        assert.isDefined(detail, "detail should not be null");
        assert.isDefined(detail?.syncedSource, "syncedSource should be present");
        assert.equal(detail?.syncedSource?.provider, "github");
        assert.equal(
          detail?.syncedSource?.url,
          "https://github.com/owner/repo/issues/42",
        );
        assert.deepEqual(detail?.syncedSource?.assignees, ["alice", "bob"]);
        assert.deepEqual(detail?.syncedSource?.labels, ["bug", "high-priority"]);
      }),
  );

  it.effect(
    "getTicketDetail returns syncedSource for orphaned mapping (sync_status=orphaned)",
    () =>
      Effect.gen(function* () {
        const read = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-06-13T00:00:00.000Z";

        yield* read.registerBoard({
          boardId: "b-orphaned-detail" as never,
          projectId: "proj-orphaned" as never,
          name: "Orphaned Board",
          workflowFilePath: ".t3/boards/orphaned.json",
          workflowVersionHash: "hash-orphaned",
          maxConcurrentTickets: 5,
        });

        yield* sql`
          INSERT INTO projection_ticket (
            ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
          )
          VALUES ('ticket-orphaned', 'b-orphaned-detail', 'Orphaned Ticket', 'inbox', 'running', ${now}, ${now})
        `;

        const metadataJson =
          '{"provider":"asana","url":"https://app.asana.com/0/proj/task123","labels":["v2"]}';

        yield* sql`
          INSERT INTO work_source_mapping (
            mapping_id, board_id, source_id, provider, external_id, ticket_id,
            content_hash, lifecycle, sync_status, source_metadata_json, created_at, last_synced_at
          )
          VALUES (
            'map-orphaned', 'b-orphaned-detail', 'src-asana', 'asana', 'task123',
            'ticket-orphaned', 'hashABC', 'closed', 'orphaned', ${metadataJson}, ${now}, ${now}
          )
        `;

        const detail = yield* read.getTicketDetail("ticket-orphaned" as never);
        assert.isDefined(detail?.syncedSource, "syncedSource should be present even for orphaned mapping");
        assert.equal(detail?.syncedSource?.provider, "asana");
        assert.equal(detail?.syncedSource?.url, "https://app.asana.com/0/proj/task123");
        assert.deepEqual(detail?.syncedSource?.labels, ["v2"]);
        assert.isUndefined(detail?.syncedSource?.assignees);
      }),
  );

  it.effect(
    "getTicketDetail returns syncedSource: undefined for a non-synced ticket",
    () =>
      Effect.gen(function* () {
        const read = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-06-13T00:00:00.000Z";

        yield* read.registerBoard({
          boardId: "b-non-synced" as never,
          projectId: "proj-non-synced" as never,
          name: "Non-Synced Board",
          workflowFilePath: ".t3/boards/non-synced.json",
          workflowVersionHash: "hash-non-synced",
          maxConcurrentTickets: 5,
        });

        yield* sql`
          INSERT INTO projection_ticket (
            ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
          )
          VALUES ('ticket-non-synced', 'b-non-synced', 'Non-Synced Ticket', 'inbox', 'running', ${now}, ${now})
        `;

        const detail = yield* read.getTicketDetail("ticket-non-synced" as never);
        assert.isDefined(detail, "detail should not be null");
        assert.isUndefined(detail?.syncedSource, "syncedSource should be undefined for non-synced ticket");
      }),
  );

  it.effect(
    "getTicketDetail returns syncedSource: undefined when source_metadata_json is malformed",
    () =>
      Effect.gen(function* () {
        const read = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-06-13T00:00:00.000Z";

        yield* read.registerBoard({
          boardId: "b-malformed" as never,
          projectId: "proj-malformed" as never,
          name: "Malformed Board",
          workflowFilePath: ".t3/boards/malformed.json",
          workflowVersionHash: "hash-malformed",
          maxConcurrentTickets: 5,
        });

        yield* sql`
          INSERT INTO projection_ticket (
            ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
          )
          VALUES ('ticket-malformed', 'b-malformed', 'Malformed Ticket', 'inbox', 'running', ${now}, ${now})
        `;

        yield* sql`
          INSERT INTO work_source_mapping (
            mapping_id, board_id, source_id, provider, external_id, ticket_id,
            content_hash, lifecycle, sync_status, source_metadata_json, created_at, last_synced_at
          )
          VALUES (
            'map-malformed', 'b-malformed', 'src-malformed', 'github', '99',
            'ticket-malformed', 'hashBAD', 'open', 'active', 'not valid json!!!', ${now}, ${now}
          )
        `;

        const detail = yield* read.getTicketDetail("ticket-malformed" as never);
        assert.isDefined(detail, "detail should not be null (no crash)");
        assert.isUndefined(
          detail?.syncedSource,
          "syncedSource should be undefined for malformed source_metadata_json",
        );
      }),
  );

  it.effect(
    "getTicketDetail returns syncedSource: undefined when source_metadata_json is null",
    () =>
      Effect.gen(function* () {
        const read = yield* WorkflowReadModel;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-06-13T00:00:00.000Z";

        yield* read.registerBoard({
          boardId: "b-null-meta" as never,
          projectId: "proj-null-meta" as never,
          name: "Null Meta Board",
          workflowFilePath: ".t3/boards/null-meta.json",
          workflowVersionHash: "hash-null-meta",
          maxConcurrentTickets: 5,
        });

        yield* sql`
          INSERT INTO projection_ticket (
            ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
          )
          VALUES ('ticket-null-meta', 'b-null-meta', 'Null Meta Ticket', 'inbox', 'running', ${now}, ${now})
        `;

        yield* sql`
          INSERT INTO work_source_mapping (
            mapping_id, board_id, source_id, provider, external_id, ticket_id,
            content_hash, lifecycle, sync_status, source_metadata_json, created_at, last_synced_at
          )
          VALUES (
            'map-null-meta', 'b-null-meta', 'src-null', 'github', '77',
            'ticket-null-meta', 'hashNULL', 'open', 'active', NULL, ${now}, ${now}
          )
        `;

        const detail = yield* read.getTicketDetail("ticket-null-meta" as never);
        assert.isDefined(detail, "detail should not be null");
        assert.isUndefined(
          detail?.syncedSource,
          "syncedSource should be undefined when source_metadata_json is NULL",
        );
      }),
  );
});
