import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { SlackAgentGateway, SlackAgentGatewayError } from "../Services/SlackAgentGateway.ts";
import { SlackAgentDeliveryDispatcher } from "../Services/SlackAgentDeliveryDispatcher.ts";
import {
  makeSlackAgentDeliveryDispatcherLive,
  normalizeSlackAgentDeliveryState,
} from "./SlackAgentDeliveryDispatcher.ts";

interface GatewayCall {
  readonly kind: "post" | "update";
  readonly runId: string;
  readonly statusMessageId?: string;
  readonly sequence: number;
}

const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_agent_run (
      run_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      trigger_ts TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      snapshot_bytes INTEGER NOT NULL,
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
      kind TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      delivery_state TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NULL,
      created_at TEXT NOT NULL,
      last_error TEXT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(run_id, workflow_sequence)
    )
  `;
});

const encodePayloadJson = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ workflowSequence: Schema.Number })),
);

const insertRun = (runId: string, statusMessageId: string | null = "msg-1") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO slack_agent_run (
        run_id, instance_id, external_event_id, workspace_id, channel_id,
        channel_name, thread_key, thread_ts, trigger_ts, snapshot_json,
        snapshot_sha256, snapshot_bytes, ticket_id, status, status_message_id,
        last_applied_sequence, created_at, updated_at
      ) VALUES (
        ${runId}, ${`instance-${runId}`}, ${`event-${runId}`}, 'T123', 'C123',
        'eng', ${`T123:C123:${runId}`}, ${`1000.${runId}`}, ${`1000.${runId}`}, '[]',
        'sha', 2, ${`ticket-${runId}`}, 'running', ${statusMessageId},
        -1, '2026-06-07T00:00:00.000Z', '2026-06-07T00:00:00.000Z'
      )
    `;
  });

const insertDelivery = (input: {
  readonly runId: string;
  readonly sequence: number;
  readonly state?: string;
  readonly attemptCount?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payloadJson = encodePayloadJson({ workflowSequence: input.sequence });
    yield* sql`
      INSERT INTO slack_agent_delivery (
        delivery_id, run_id, workflow_sequence, kind, operation, payload_json,
        delivery_state, attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (
        ${`${input.runId}-${input.sequence}`}, ${input.runId}, ${input.sequence},
        ${input.sequence === 0 ? "accepted" : "progress"},
        ${input.sequence === 0 ? "post" : "update"}, ${payloadJson},
        ${input.state ?? "pending"}, ${input.attemptCount ?? 0}, ${null},
        ${`2026-06-07T00:00:0${input.sequence}.000Z`},
        ${`2026-06-07T00:00:0${input.sequence}.000Z`}
      )
    `;
  });

const readDelivery = (deliveryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly deliveryState: string;
      readonly attemptCount: number;
      readonly lastError: string | null;
      readonly nextAttemptAt: string | null;
      readonly updatedAt: string;
    }>`
      SELECT
        delivery_state AS "deliveryState",
        attempt_count AS "attemptCount",
        last_error AS "lastError",
        next_attempt_at AS "nextAttemptAt",
        updated_at AS "updatedAt"
      FROM slack_agent_delivery WHERE delivery_id = ${deliveryId}
    `;
    return rows[0]!;
  });

const readRun = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly statusMessageId: string | null;
      readonly lastAppliedSequence: number;
    }>`
      SELECT
        status_message_id AS "statusMessageId",
        last_applied_sequence AS "lastAppliedSequence"
      FROM slack_agent_run WHERE run_id = ${runId}
    `;
    return rows[0]!;
  });

const makeLayer = (gateway: SlackAgentGateway["Service"]) =>
  makeSlackAgentDeliveryDispatcherLive().pipe(
    Layer.provideMerge(Layer.succeed(SlackAgentGateway, gateway)),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

it("normalizes legacy store delivery states before exposing contract views", () => {
  assert.equal(normalizeSlackAgentDeliveryState("processing"), "delivering");
  assert.equal(normalizeSlackAgentDeliveryState("sent"), "delivered");
  assert.equal(normalizeSlackAgentDeliveryState("failed"), "failed");
});

it.layer(
  makeLayer({
    snapshotThreadThroughTrigger: () => Effect.die("not needed"),
    subscribeMockThread: () => Effect.die("not needed"),
    subscribeMockThreadChanges: () => Effect.die("not needed"),
    postOrUpdateStatus: () =>
      Effect.succeed({ threadKey: "thread", statusMessageId: "msg-accepted" }),
  }),
)("SlackAgentDeliveryDispatcher", (it) => {
  it.effect("posts accepted sequence zero and stores status_message_id atomically", () =>
    Effect.gen(function* () {
      yield* createTables;
      yield* insertRun("run-accepted", null);
      yield* insertDelivery({ runId: "run-accepted", sequence: 0 });

      const dispatcher = yield* SlackAgentDeliveryDispatcher;
      yield* dispatcher.sweep();

      assert.equal((yield* readDelivery("run-accepted-0")).deliveryState, "delivered");
      const run = yield* readRun("run-accepted");
      assert.equal(run.statusMessageId, "msg-accepted");
      assert.equal(run.lastAppliedSequence, 0);
    }),
  );

  it.effect("applies accepted and the first queued update in one sweep", () =>
    Effect.gen(function* () {
      yield* createTables;
      yield* insertRun("run-same-sweep", null);
      yield* insertDelivery({ runId: "run-same-sweep", sequence: 0 });
      yield* insertDelivery({ runId: "run-same-sweep", sequence: 1 });

      const dispatcher = yield* SlackAgentDeliveryDispatcher;
      yield* dispatcher.sweep();

      assert.equal((yield* readDelivery("run-same-sweep-0")).deliveryState, "delivered");
      assert.equal((yield* readDelivery("run-same-sweep-1")).deliveryState, "delivered");
      const run = yield* readRun("run-same-sweep");
      assert.equal(run.statusMessageId, "msg-accepted");
      assert.equal(run.lastAppliedSequence, 1);
    }),
  );

  it.effect("supersedes stale retries older than last_applied_sequence", () =>
    Effect.gen(function* () {
      yield* createTables;
      yield* insertRun("run-stale", "msg-stale");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE slack_agent_run SET last_applied_sequence = 5 WHERE run_id = 'run-stale'`;
      yield* insertDelivery({ runId: "run-stale", sequence: 4 });

      const dispatcher = yield* SlackAgentDeliveryDispatcher;
      yield* dispatcher.sweep();

      assert.equal((yield* readDelivery("run-stale-4")).deliveryState, "superseded");
    }),
  );

  it.effect("returns restart-interrupted delivery claims to pending", () =>
    Effect.gen(function* () {
      yield* createTables;
      yield* insertRun("run-recovered", "msg-recovered");
      yield* insertDelivery({ runId: "run-recovered", sequence: 1, state: "delivering" });

      const dispatcher = yield* SlackAgentDeliveryDispatcher;
      yield* dispatcher.recoverStaleClaims();

      assert.equal((yield* readDelivery("run-recovered-1")).deliveryState, "pending");
    }),
  );

  it.effect("retryDelivery moves only the newest failed row back to pending", () =>
    Effect.gen(function* () {
      yield* createTables;
      yield* insertRun("run-retry", "msg-retry");
      yield* insertDelivery({ runId: "run-retry", sequence: 1, state: "failed" });
      yield* insertDelivery({ runId: "run-retry", sequence: 2, state: "failed" });

      const dispatcher = yield* SlackAgentDeliveryDispatcher;
      const changes = yield* dispatcher.subscribeRunChanges("run-retry");
      const nextChange = yield* Stream.runHead(changes).pipe(Effect.forkChild);
      const obsolete = yield* dispatcher.retryDelivery("run-retry-1");
      assert.equal(obsolete?.state, "superseded");
      const superseded = Option.getOrNull(yield* Fiber.join(nextChange));
      assert.equal(superseded?.deliveryId, "run-retry-1");
      assert.equal(superseded?.state, "superseded");
      const retried = yield* dispatcher.retryDelivery("run-retry-2");
      assert.equal(retried?.deliveryId, "run-retry-2");
      assert.equal(retried?.state, "pending");

      assert.equal((yield* readDelivery("run-retry-1")).deliveryState, "superseded");
      assert.equal((yield* readDelivery("run-retry-2")).deliveryState, "pending");
    }),
  );
});

it.effect("accepted failure leaves later updates unsent behind sequence zero", () => {
  const calls: Array<GatewayCall> = [];
  const gateway: SlackAgentGateway["Service"] = {
    snapshotThreadThroughTrigger: () => Effect.die("not needed"),
    subscribeMockThread: () => Effect.die("not needed"),
    subscribeMockThreadChanges: () => Effect.die("not needed"),
    postOrUpdateStatus: (input) => {
      calls.push({
        kind: "post",
        runId: input.runId,
        sequence: Number(input.deliveryId.split("-").at(-1) ?? 0),
      });
      return Effect.fail(new SlackAgentGatewayError({ message: "rate limited" }));
    },
  };

  return Effect.gen(function* () {
    yield* createTables;
    yield* insertRun("run-hol", null);
    yield* insertDelivery({ runId: "run-hol", sequence: 0 });
    yield* insertDelivery({ runId: "run-hol", sequence: 1 });

    const dispatcher = yield* SlackAgentDeliveryDispatcher;
    yield* dispatcher.sweep();

    assert.deepEqual(
      calls.map((call) => call.kind),
      ["post"],
    );
    assert.equal((yield* readDelivery("run-hol-0")).deliveryState, "retrying");
    assert.equal((yield* readDelivery("run-hol-0")).attemptCount, 1);
    assert.equal((yield* readDelivery("run-hol-1")).deliveryState, "pending");
  }).pipe(Effect.provide(makeLayer(gateway)));
});

it.effect("does not rewrite pending updates while the accepted post is terminally failed", () => {
  const gateway: SlackAgentGateway["Service"] = {
    snapshotThreadThroughTrigger: () => Effect.die("not needed"),
    subscribeMockThread: () => Effect.die("not needed"),
    subscribeMockThreadChanges: () => Effect.die("not needed"),
    postOrUpdateStatus: () => Effect.die("a blocked update must not reach the gateway"),
  };

  return Effect.gen(function* () {
    yield* createTables;
    yield* insertRun("run-terminal-hol", null);
    yield* insertDelivery({
      runId: "run-terminal-hol",
      sequence: 0,
      state: "failed",
      attemptCount: 5,
    });
    yield* insertDelivery({ runId: "run-terminal-hol", sequence: 1 });

    const before = yield* readDelivery("run-terminal-hol-1");
    const dispatcher = yield* SlackAgentDeliveryDispatcher;
    yield* dispatcher.sweep();
    yield* dispatcher.sweep();
    const after = yield* readDelivery("run-terminal-hol-1");

    assert.equal(after.deliveryState, "pending");
    assert.equal(after.attemptCount, 0);
    assert.equal(after.updatedAt, before.updatedAt);
  }).pipe(Effect.provide(makeLayer(gateway)));
});

it.effect("marks a delivery failed when the retry attempt ceiling is reached", () => {
  const gateway: SlackAgentGateway["Service"] = {
    snapshotThreadThroughTrigger: () => Effect.die("not needed"),
    subscribeMockThread: () => Effect.die("not needed"),
    subscribeMockThreadChanges: () => Effect.die("not needed"),
    postOrUpdateStatus: () =>
      Effect.fail(new SlackAgentGatewayError({ message: "still unavailable" })),
  };

  return Effect.gen(function* () {
    yield* createTables;
    yield* insertRun("run-attempt-ceiling", null);
    yield* insertDelivery({
      runId: "run-attempt-ceiling",
      sequence: 0,
      attemptCount: 4,
    });

    const dispatcher = yield* SlackAgentDeliveryDispatcher;
    yield* dispatcher.sweep();

    const delivery = yield* readDelivery("run-attempt-ceiling-0");
    assert.equal(delivery.deliveryState, "failed");
    assert.equal(delivery.attemptCount, 5);
    assert.equal(delivery.lastError, "still unavailable");
  }).pipe(Effect.provide(makeLayer(gateway)));
});

it.effect("honors gateway retry-after hints", () => {
  const gateway: SlackAgentGateway["Service"] = {
    snapshotThreadThroughTrigger: () => Effect.die("not needed"),
    subscribeMockThread: () => Effect.die("not needed"),
    subscribeMockThreadChanges: () => Effect.die("not needed"),
    postOrUpdateStatus: () =>
      Effect.fail(new SlackAgentGatewayError({ message: "rate limited", retryAfterMs: 120_000 })),
  };

  return Effect.gen(function* () {
    yield* createTables;
    yield* insertRun("run-retry-after", null);
    yield* insertDelivery({ runId: "run-retry-after", sequence: 0 });

    const dispatcher = yield* SlackAgentDeliveryDispatcher;
    yield* dispatcher.sweep();

    const delivery = yield* readDelivery("run-retry-after-0");
    assert.equal(delivery.deliveryState, "retrying");
    assert.isNotNull(delivery.nextAttemptAt);
    assert.isAtLeast(Date.parse(delivery.nextAttemptAt ?? ""), 119_000);
    assert.isAtMost(Date.parse(delivery.nextAttemptAt ?? ""), 121_000);
  }).pipe(Effect.provide(makeLayer(gateway)));
});
