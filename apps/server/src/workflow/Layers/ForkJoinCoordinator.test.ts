// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ForkJoinCoordinator } from "../Services/ForkJoinCoordinator.ts";
import { ForkJoinCoordinatorLive } from "./ForkJoinCoordinator.ts";

const layer = it.layer(
  ForkJoinCoordinatorLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("ForkJoinCoordinator", (it) => {
  it.effect("spawn + settle require-K join", () =>
    Effect.gen(function* () {
      const coord = yield* ForkJoinCoordinator;
      yield* coord.recordSpawn({
        stepRunId: "sr-1" as never,
        parentTicketId: "parent" as never,
        boardId: "b1" as never,
        stepKey: "fanout",
        joinRequire: 1,
        onBranchFailure: "waitImpossible",
        spawnSeq: 1,
        children: [
          {
            childKey: "a",
            ticketId: "c-a" as never,
            laneKey: "impl",
            title: "Child A",
          },
          {
            childKey: "b",
            ticketId: "c-b" as never,
            laneKey: "impl",
            title: "Child B",
          },
        ],
      });

      const waiting = yield* coord.settleChild({
        childTicketId: "c-a" as never,
        outcome: "success",
      });
      assert.equal(waiting.status, "resolved");
      if (waiting.status === "resolved") {
        assert.equal(waiting.join.result, "success");
        assert.equal(waiting.join.succeeded, 1);
      }

      const fork = yield* coord.getForkByStepRunId("sr-1" as never);
      assert.isNotNull(fork);
      assert.equal(fork?.resolution, "success");
    }),
  );

  it.effect("failFast resolves on first failure", () =>
    Effect.gen(function* () {
      const coord = yield* ForkJoinCoordinator;
      yield* coord.recordSpawn({
        stepRunId: "sr-2" as never,
        parentTicketId: "parent2" as never,
        boardId: "b1" as never,
        stepKey: "fanout",
        joinRequire: 2,
        onBranchFailure: "failFast",
        spawnSeq: 2,
        children: [
          {
            childKey: "a",
            ticketId: "c2-a" as never,
            laneKey: "impl",
            title: "A",
          },
          {
            childKey: "b",
            ticketId: "c2-b" as never,
            laneKey: "impl",
            title: "B",
          },
        ],
      });
      const r = yield* coord.settleChild({
        childTicketId: "c2-a" as never,
        outcome: "failure",
      });
      assert.equal(r.status, "resolved");
      if (r.status === "resolved") {
        assert.equal(r.join.result, "failure");
      }
    }),
  );

  it.effect("unsatisfiable join when cancelled shrinks capacity", () =>
    Effect.gen(function* () {
      const coord = yield* ForkJoinCoordinator;
      yield* coord.recordSpawn({
        stepRunId: "sr-3" as never,
        parentTicketId: "parent3" as never,
        boardId: "b1" as never,
        stepKey: "fanout",
        joinRequire: 2,
        onBranchFailure: "waitImpossible",
        spawnSeq: 3,
        children: [
          {
            childKey: "a",
            ticketId: "c3-a" as never,
            laneKey: "impl",
            title: "A",
          },
          {
            childKey: "b",
            ticketId: "c3-b" as never,
            laneKey: "impl",
            title: "B",
          },
        ],
      });
      // require 2 with one cancelled → max remaining successes is 1 → failure now.
      const r = yield* coord.settleChild({
        childTicketId: "c3-a" as never,
        outcome: "cancelled",
      });
      assert.equal(r.status, "resolved");
      if (r.status === "resolved") {
        assert.equal(r.join.result, "failure");
      }
    }),
  );

  it.effect("waits when still possible", () =>
    Effect.gen(function* () {
      const coord = yield* ForkJoinCoordinator;
      yield* coord.recordSpawn({
        stepRunId: "sr-4" as never,
        parentTicketId: "parent4" as never,
        boardId: "b1" as never,
        stepKey: "fanout",
        joinRequire: 2,
        onBranchFailure: "waitImpossible",
        spawnSeq: 4,
        children: [
          {
            childKey: "a",
            ticketId: "c4-a" as never,
            laneKey: "impl",
            title: "A",
          },
          {
            childKey: "b",
            ticketId: "c4-b" as never,
            laneKey: "impl",
            title: "B",
          },
        ],
      });
      const r = yield* coord.settleChild({
        childTicketId: "c4-a" as never,
        outcome: "success",
      });
      assert.equal(r.status, "waiting");
    }),
  );
});
