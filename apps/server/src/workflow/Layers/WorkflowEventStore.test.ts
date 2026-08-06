import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowEventStoreLive } from "./WorkflowEventStore.ts";

const layer = it.layer(MigrationsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("workflow migration", (it) => {
  it.effect("creates workflow_events and projection tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN (
          'workflow_events',
          'projection_board',
          'projection_ticket',
          'projection_pipeline_run',
          'projection_step_run'
        )
      `;
      assert.equal(tables.length, 5);
    }),
  );
});

const storeLayer = it.layer(
  WorkflowEventStoreLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

storeLayer("WorkflowEventStore", (it) => {
  it.effect("appends and replays a decoded event with assigned version", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const appended = yield* store.append({
        type: "TicketCreated",
        eventId: "evt-a" as never,
        ticketId: "t-1" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "b-1" as never,
          title: "X" as never,
          laneKey: "backlog" as never,
        },
      });
      assert.equal(appended.streamVersion, 0);

      const events = yield* Stream.runCollect(store.readByTicket("t-1" as never)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "TicketCreated");
    }),
  );

  it.effect("assigns incrementing stream versions per ticket", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      yield* store.append({
        type: "TicketCreated",
        eventId: "evt-b" as never,
        ticketId: "t-2" as never,
        occurredAt: "2026-06-07T00:00:00.000Z" as never,
        payload: {
          boardId: "b-1" as never,
          title: "Y" as never,
          laneKey: "backlog" as never,
        },
      });
      const second = yield* store.append({
        type: "TicketBlocked",
        eventId: "evt-c" as never,
        ticketId: "t-2" as never,
        occurredAt: "2026-06-07T00:00:01.000Z" as never,
        payload: { reason: "scope unclear" },
      });
      assert.equal(second.streamVersion, 1);
    }),
  );

  it.effect("deletes events for tickets that belong to a board", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
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
          ('ticket-events-delete', 'board-events-delete', 'Delete', 'backlog', 'idle', ${now}, ${now}),
          ('ticket-events-keep', 'board-events-keep', 'Keep', 'backlog', 'idle', ${now}, ${now})
      `;
      yield* store.append({
        type: "TicketCreated",
        eventId: "evt-delete" as never,
        ticketId: "ticket-events-delete" as never,
        occurredAt: now as never,
        payload: {
          boardId: "board-events-delete" as never,
          title: "Delete" as never,
          laneKey: "backlog" as never,
        },
      });
      yield* store.append({
        type: "TicketCreated",
        eventId: "evt-keep" as never,
        ticketId: "ticket-events-keep" as never,
        occurredAt: now as never,
        payload: {
          boardId: "board-events-keep" as never,
          title: "Keep" as never,
          laneKey: "backlog" as never,
        },
      });

      yield* store.deleteForBoard("board-events-delete" as never);

      const rows = yield* sql<{
        readonly ticketId: string;
        readonly count: number;
      }>`
        SELECT ticket_id AS "ticketId", COUNT(*) AS count
        FROM workflow_events
        WHERE ticket_id IN ('ticket-events-delete', 'ticket-events-keep')
        GROUP BY ticket_id
        ORDER BY ticket_id ASC
      `;
      assert.deepEqual(rows, [{ ticketId: "ticket-events-keep", count: 1 }]);
    }),
  );

  it.effect("deletes events for exactly one ticket", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-06-07T00:00:00.000Z";

      yield* store.append({
        type: "TicketCreated",
        eventId: "evt-ticket-delete" as never,
        ticketId: "ticket-events-delete-one" as never,
        occurredAt: now as never,
        payload: {
          boardId: "board-events-delete-one" as never,
          title: "Delete" as never,
          laneKey: "backlog" as never,
        },
      });
      yield* store.append({
        type: "TicketCreated",
        eventId: "evt-ticket-keep" as never,
        ticketId: "ticket-events-keep-one" as never,
        occurredAt: now as never,
        payload: {
          boardId: "board-events-delete-one" as never,
          title: "Keep" as never,
          laneKey: "backlog" as never,
        },
      });

      yield* store.deleteForTicket("ticket-events-delete-one" as never);

      const rows = yield* sql<{
        readonly ticketId: string;
        readonly count: number;
      }>`
        SELECT ticket_id AS "ticketId", COUNT(*) AS count
        FROM workflow_events
        WHERE ticket_id IN ('ticket-events-delete-one', 'ticket-events-keep-one')
        GROUP BY ticket_id
        ORDER BY ticket_id ASC
      `;
      assert.deepEqual(rows, [{ ticketId: "ticket-events-keep-one", count: 1 }]);
    }),
  );

  const seedTicket = (ticketId: string, boardId: string, count: number) =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const sql = yield* SqlClient.SqlClient;
      // The board reads join through the projection, so the ticket must exist there.
      yield* sql`
        INSERT OR IGNORE INTO projection_ticket (
          ticket_id, board_id, title, current_lane_key, status, created_at, updated_at
        )
        VALUES (${ticketId}, ${boardId}, 'T', 'backlog', 'idle',
                '2026-07-25T00:00:00.000Z', '2026-07-25T00:00:00.000Z')
      `;
      yield* store.append({
        type: "TicketCreated",
        eventId: `${ticketId}-created` as never,
        ticketId: ticketId as never,
        occurredAt: "2026-07-25T00:00:00.000Z" as never,
        payload: {
          boardId: boardId as never,
          title: "T" as never,
          laneKey: "backlog" as never,
        },
      });
      for (let i = 1; i < count; i += 1) {
        yield* store.append({
          type: "TicketBlocked",
          eventId: `${ticketId}-blocked-${String(i)}` as never,
          ticketId: ticketId as never,
          occurredAt: "2026-07-25T00:00:01.000Z" as never,
          payload: { reason: `r${String(i)}` },
        });
      }
    });

  const collect = <A, E>(stream: Stream.Stream<A, E>) =>
    Stream.runCollect(stream).pipe(Effect.map((chunk) => Array.from(chunk)));

  it.effect("readTicketTail returns the newest window DESC with one peek row", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      yield* seedTicket("t-tail", "b-tail", 6);

      const tail = yield* collect(store.readTicketTail("t-tail" as never, 3));
      // limit + 1: three window rows plus the peek that proves truncation.
      assert.equal(tail.length, 4);
      assert.deepStrictEqual(
        tail.map((event) => event.streamVersion),
        [5, 4, 3, 2],
      );

      // A limit at or above the stream length yields no peek row.
      const whole = yield* collect(store.readTicketTail("t-tail" as never, 6));
      assert.equal(whole.length, 6);
    }),
  );

  it.effect("readTicketRange pages a half-open version window ascending", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      yield* seedTicket("t-range", "b-range", 6);

      const first = yield* collect(store.readTicketRange("t-range" as never, 0, 5, 2));
      assert.deepStrictEqual(
        first.map((event) => event.streamVersion),
        [0, 1],
      );
      const next = yield* collect(store.readTicketRange("t-range" as never, 2, 5, 2));
      assert.deepStrictEqual(
        next.map((event) => event.streamVersion),
        [2, 3],
      );
      // Upper bound is exclusive: version 5 is never returned.
      const last = yield* collect(store.readTicketRange("t-range" as never, 4, 5, 10));
      assert.deepStrictEqual(
        last.map((event) => event.streamVersion),
        [4],
      );
      assert.lengthOf(yield* collect(store.readTicketRange("t-range" as never, 5, 5, 10)), 0);
    }),
  );

  it.effect("readByBoard orders by global sequence and honors the cursor and pin", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      yield* seedTicket("t-b1", "b-board", 2);
      yield* seedTicket("t-b2", "b-board", 2);
      yield* seedTicket("t-other", "b-elsewhere", 2);

      const all = yield* collect(store.readByBoard("b-board" as never, 0, null, 100));
      assert.equal(all.length, 4);
      // Interleaved across tickets, ascending by sequence.
      assert.deepStrictEqual(
        [...all].map((event) => event.sequence).sort((a, b) => a - b),
        all.map((event) => event.sequence),
      );
      // Another board's events never appear.
      assert.isTrue(all.every((event) => event.ticketId !== "t-other"));

      const pinned = yield* collect(
        store.readByBoard("b-board" as never, 0, all[1]?.sequence ?? 0, 100),
      );
      assert.equal(pinned.length, 2);

      const after = yield* collect(
        store.readByBoard("b-board" as never, all[1]?.sequence ?? 0, null, 100),
      );
      assert.equal(after.length, 2);
    }),
  );

  it.effect("readByBoard hides events of tickets whose projection row is gone", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedTicket("t-swept", "b-swept", 2);
      assert.equal((yield* collect(store.readByBoard("b-swept" as never, 0, null, 100))).length, 2);

      // Retention/deletion removes the projection row; the timeline must follow.
      yield* sql`DELETE FROM projection_ticket WHERE ticket_id = 't-swept'`;
      assert.equal((yield* collect(store.readByBoard("b-swept" as never, 0, null, 100))).length, 0);
    }),
  );

  it.effect("maxSequenceForBoard reports the board's newest sequence, 0 when empty", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      assert.equal(yield* store.maxSequenceForBoard("b-empty" as never), 0);

      yield* seedTicket("t-max", "b-max", 3);
      const events = yield* collect(store.readByBoard("b-max" as never, 0, null, 100));
      const newest = Math.max(...events.map((event) => event.sequence));
      assert.equal(yield* store.maxSequenceForBoard("b-max" as never), newest);
    }),
  );
});
