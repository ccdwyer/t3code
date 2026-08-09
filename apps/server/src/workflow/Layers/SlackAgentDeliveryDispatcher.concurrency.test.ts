import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { SlackAgentGateway } from "../Services/SlackAgentGateway.ts";
import { SlackAgentDeliveryDispatcher } from "../Services/SlackAgentDeliveryDispatcher.ts";
import {
  claimSlackAgentDeliveryRow,
  makeSlackAgentDeliveryDispatcherLive,
} from "./SlackAgentDeliveryDispatcher.ts";

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

const insertRun = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO slack_agent_run (
        run_id, instance_id, external_event_id, workspace_id, channel_id,
        channel_name, thread_key, thread_ts, trigger_ts, snapshot_json,
        snapshot_sha256, snapshot_bytes, mode, t3_thread_id, ticket_id, status, status_message_id,
        last_applied_sequence, created_at, updated_at
      ) VALUES (
        ${runId}, ${`instance-${runId}`}, ${`event-${runId}`}, 'T123', 'C123',
        'eng', ${`T123:C123:${runId}`}, ${`1000.${runId}`}, ${`1000.${runId}`}, '[]',
        'sha', 2, 'workflow', NULL, ${`ticket-${runId}`}, 'running', ${`msg-${runId}`},
        -1, '2026-06-07T00:00:00.000Z', '2026-06-07T00:00:00.000Z'
      )
    `;
  });

const insertDelivery = (runId: string, sequence: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payloadJson = encodePayloadJson({ workflowSequence: sequence });
    yield* sql`
      INSERT INTO slack_agent_delivery (
        delivery_id, run_id, workflow_sequence, kind, operation, payload_json,
        delivery_state, attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (
        ${`${runId}-${sequence}`}, ${runId}, ${sequence}, 'progress', 'update', ${payloadJson},
        'pending', 0, ${null}, ${`2026-06-07T00:00:0${sequence}.000Z`},
        ${`2026-06-07T00:00:0${sequence}.000Z`}
      )
    `;
  });

const layer = (gateway: SlackAgentGateway["Service"]) =>
  makeSlackAgentDeliveryDispatcherLive().pipe(
    Layer.provideMerge(Layer.succeed(SlackAgentGateway, gateway)),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

it.effect("two concurrent claimRow UPDATEs elect exactly one winner", () =>
  Effect.gen(function* () {
    yield* createTables;
    yield* insertRun("run-claim");
    yield* insertDelivery("run-claim", 1);
    const sql = yield* SqlClient.SqlClient;

    const results = yield* Effect.all(
      [
        claimSlackAgentDeliveryRow(sql, "run-claim-1"),
        claimSlackAgentDeliveryRow(sql, "run-claim-1"),
      ],
      { concurrency: "unbounded" },
    );

    assert.equal(results.filter((rows) => rows.length > 0).length, 1);
    assert.equal(results.filter((rows) => rows.length === 0).length, 1);
  }).pipe(Effect.provide(Layer.merge(SqlitePersistenceMemory, TestClock.layer()))),
);

it.effect("serializes deliveries per run while allowing cross-run concurrency", () => {
  const orderByRun = new Map<string, Array<number>>();
  let active = 0;
  let maxActive = 0;
  const gateway: SlackAgentGateway["Service"] = {
    snapshotThreadThroughTrigger: () => Effect.die("not used"),
    subscribeMockThread: () => Effect.die("not used"),
    subscribeMockThreadChanges: () => Effect.die("not used"),
    postOrUpdateStatus: (input) =>
      Effect.gen(function* () {
        const sequence = Number(input.deliveryId.split("-").at(-1) ?? 0);
        orderByRun.set(input.runId, [...(orderByRun.get(input.runId) ?? []), sequence]);
        active += 1;
        maxActive = Math.max(maxActive, active);
        yield* Effect.sleep(Duration.millis(10));
        active -= 1;
        return {
          threadKey: "thread",
          statusMessageId: input.statusMessageId ?? `msg-${input.runId}`,
        };
      }),
  };

  return Effect.gen(function* () {
    yield* createTables;
    yield* insertRun("run-a");
    yield* insertRun("run-b");
    yield* insertDelivery("run-a", 1);
    yield* insertDelivery("run-a", 2);
    yield* insertDelivery("run-b", 1);
    yield* insertDelivery("run-b", 2);

    const dispatcher = yield* SlackAgentDeliveryDispatcher;
    const fiber = yield* dispatcher.sweep().pipe(Effect.forkScoped);
    yield* TestClock.adjust(Duration.millis(40));
    yield* Fiber.join(fiber);

    assert.deepEqual(orderByRun.get("run-a"), [1, 2]);
    assert.deepEqual(orderByRun.get("run-b"), [1, 2]);
    assert.isAtLeast(maxActive, 2);
  }).pipe(Effect.provide(Layer.merge(layer(gateway), TestClock.layer())));
});
