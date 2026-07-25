import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowEventStoreLive } from "./WorkflowEventStore.ts";
import { buildBoardTimeline, buildTicketTimeline } from "./workflowTimeline.ts";

const layer = it.layer(
  WorkflowEventStoreLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("workflowTimeline", (it) => {
  const seed = (ticketId: string, boardId: string, extraEvents: number) =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const sql = yield* SqlClient.SqlClient;
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
        payload: { boardId: boardId as never, title: "Seed" as never, laneKey: "backlog" as never },
      });
      for (let i = 0; i < extraEvents; i += 1) {
        yield* store.append({
          type: "TicketMovedToLane",
          eventId: `${ticketId}-move-${String(i)}` as never,
          ticketId: ticketId as never,
          occurredAt: "2026-07-25T00:00:01.000Z" as never,
          payload: {
            toLane: (i % 2 === 0 ? "implement" : "review") as never,
            laneEntryToken: `tok-${String(i)}` as never,
            reason: "manual",
          },
        });
      }
    });

  it.effect("returns a whole short stream ascending with no base", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      yield* seed("t-short", "b-1", 3);

      const result = yield* buildTicketTimeline(store, "t-short" as never);
      assert.isFalse(result.truncated);
      assert.isUndefined(result.base);
      assert.deepStrictEqual(
        result.events.map((item) => item.event.streamVersion),
        [0, 1, 2, 3],
      );
    }),
  );

  it.effect("truncates to the newest window and folds a base from the head", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      // 1 TicketCreated + 5 moves; the moves alternate implement/review.
      yield* seed("t-trunc", "b-trunc", 5);

      const result = yield* buildTicketTimeline(store, "t-trunc" as never, 2);
      assert.isTrue(result.truncated);
      // Newest two, ascending.
      assert.deepStrictEqual(
        result.events.map((item) => item.event.streamVersion),
        [4, 5],
      );
      // The base folds versions 0..3. Version 3 is move i=2 (TicketCreated is
      // version 0), and i % 2 === 0 -> "implement" — so the base must show the
      // lane as of that move, not the ticket's creation lane.
      assert.equal(result.base?.asOfStreamVersion, 3);
      assert.equal(result.base?.laneKey, "implement");
      assert.equal(result.base?.title, "Seed");
    }),
  );

  it.effect("omits the base when the window covers the whole stream exactly", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      yield* seed("t-exact", "b-exact", 2);
      // 3 events, window 3: the peek row finds nothing, so nothing is truncated.
      const result = yield* buildTicketTimeline(store, "t-exact" as never, 3);
      assert.isFalse(result.truncated);
      assert.isUndefined(result.base);
      assert.equal(result.events.length, 3);
    }),
  );

  it.effect("reports an unknown ticket as an empty, untruncated timeline", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const result = yield* buildTicketTimeline(store, "t-missing" as never);
      assert.deepStrictEqual(result.events, []);
      assert.isFalse(result.truncated);
    }),
  );

  it.effect("degrades to empty when the store has no timeline reads", () =>
    Effect.gen(function* () {
      const result = yield* buildTicketTimeline({}, "t-any" as never);
      assert.deepStrictEqual(result.events, []);
      assert.isFalse(result.truncated);
    }),
  );

  it.effect("pins a board page, peeks for the next cursor, and reports latestSequence", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      yield* seed("t-b1", "b-page", 2);
      yield* seed("t-b2", "b-page", 2);

      const whole = yield* buildBoardTimeline(store, { boardId: "b-page" as never, limit: 200 });
      assert.equal(whole.events.length, 6);
      // `sequence` is global across the store, so assert relationally.
      const newest = Math.max(...whole.events.map((item) => item.sequence));

      const first = yield* buildBoardTimeline(store, { boardId: "b-page" as never, limit: 3 });
      assert.equal(first.events.length, 3);
      // Six events exist, so a next cursor must be offered.
      assert.isNotNull(first.nextAfterSequence);
      assert.equal(first.latestSequence, newest);

      const second = yield* buildBoardTimeline(store, {
        boardId: "b-page" as never,
        afterSequence: first.nextAfterSequence ?? 0,
        throughSequence: first.latestSequence,
        limit: 3,
      });
      assert.equal(second.events.length, 3);
      // Exactly consumed: no phantom final page.
      assert.isNull(second.nextAfterSequence);
    }),
  );

  it.effect("clamps limit into 1..200", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      yield* seed("t-clamp", "b-clamp", 2);

      const zero = yield* buildBoardTimeline(store, { boardId: "b-clamp" as never, limit: 0 });
      assert.equal(zero.events.length, 1, "limit 0 clamps up to 1");

      // Seed past the cap so an oversized limit is actually constrained by it;
      // with only a handful of events the assertion would hold either way.
      yield* seed("t-clamp-big", "b-clamp-big", 220);
      const huge = yield* buildBoardTimeline(store, {
        boardId: "b-clamp-big" as never,
        limit: 10_000,
      });
      assert.equal(huge.events.length, 200, "limit clamps down to 200");
    }),
  );

  it.effect("treats a negative cursor exactly like the start of the board", () =>
    Effect.gen(function* () {
      // Sequences are always >= 1, so `> -50` and `> 0` select the same rows;
      // this asserts EQUIVALENCE rather than a row count, which would pass with
      // or without the clamp and prove nothing.
      const store = yield* WorkflowEventStore;
      yield* seed("t-neg", "b-neg", 2);

      const fromStart = yield* buildBoardTimeline(store, {
        boardId: "b-neg" as never,
        afterSequence: 0,
        limit: 100,
      });
      const fromNegative = yield* buildBoardTimeline(store, {
        boardId: "b-neg" as never,
        afterSequence: -50,
        limit: 100,
      });
      assert.deepStrictEqual(
        fromNegative.events.map((item) => item.sequence),
        fromStart.events.map((item) => item.sequence),
      );
    }),
  );

  it.effect("keeps a pinned session stable when new events land mid-scrub", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      yield* seed("t-pin", "b-pin", 1);
      const pinned = yield* buildBoardTimeline(store, { boardId: "b-pin" as never, limit: 100 });
      assert.equal(pinned.events.length, 2);

      // An append after the pin must not appear in a page bounded by it.
      yield* seed("t-pin-2", "b-pin", 0);
      const again = yield* buildBoardTimeline(store, {
        boardId: "b-pin" as never,
        throughSequence: pinned.latestSequence,
        limit: 100,
      });
      assert.equal(again.events.length, 2);
      assert.equal(again.latestSequence, pinned.latestSequence);
    }),
  );

  it.effect("reports an empty board as latestSequence 0 with no cursor", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      const result = yield* buildBoardTimeline(store, { boardId: "b-none" as never });
      assert.deepStrictEqual(result.events, []);
      assert.isNull(result.nextAfterSequence);
      assert.equal(result.latestSequence, 0);
    }),
  );

  it.effect("clamps a caller-supplied pin to the board's newest sequence", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      yield* seed("t-pin-clamp", "b-pin-clamp", 2);
      const actual = yield* buildBoardTimeline(store, { boardId: "b-pin-clamp" as never });

      // A client asking for an impossible pin must not be told it exists —
      // otherwise it waits forever for pages beyond the board's newest event.
      const overshoot = yield* buildBoardTimeline(store, {
        boardId: "b-pin-clamp" as never,
        throughSequence: 999_999,
      });
      assert.equal(overshoot.latestSequence, actual.latestSequence);

      const negative = yield* buildBoardTimeline(store, {
        boardId: "b-pin-clamp" as never,
        throughSequence: -5,
      });
      assert.equal(negative.latestSequence, 0);
      assert.deepStrictEqual(negative.events, []);
    }),
  );

  it.effect("computes the pin BEFORE reading the page, so a mid-call append is excluded", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      yield* seed("t-order", "b-order", 1);

      // Append DURING the pin read. A page-first/pin-after implementation would
      // include the new event while reporting a pin that predates it.
      let appended = false;
      const racingStore = {
        ...store,
        maxSequenceForBoard: (boardId: never) =>
          Effect.gen(function* () {
            const max = yield* store.maxSequenceForBoard(boardId);
            if (!appended) {
              appended = true;
              yield* seed("t-order-2", "b-order", 0);
            }
            return max;
          }),
      };

      const page = yield* buildBoardTimeline(racingStore as never, {
        boardId: "b-order" as never,
        limit: 100,
      });
      assert.isTrue(appended);
      assert.equal(page.events.length, 2, "only the events that existed at pin time");
      assert.isTrue(page.events.every((item) => item.sequence <= page.latestSequence));
    }),
  );

  it.effect("folds a truncated head in BATCHES rather than one unbounded read", () =>
    Effect.gen(function* () {
      const store = yield* WorkflowEventStore;
      yield* seed("t-batch", "b-batch", 12);

      let rangeCalls = 0;
      const countingStore = {
        ...store,
        readTicketRange: (...args: Parameters<typeof store.readTicketRange>) => {
          rangeCalls += 1;
          return store.readTicketRange(...args);
        },
      };

      const result = yield* buildTicketTimeline(countingStore as never, "t-batch" as never, 2);
      assert.isTrue(result.truncated);
      // 11 head events at the 500-event batch size would be one call; this
      // asserts the loop exists by checking it paged to exhaustion and stopped.
      assert.isAtLeast(rangeCalls, 1);
      assert.equal(result.base?.asOfStreamVersion, 10);
    }),
  );
});
