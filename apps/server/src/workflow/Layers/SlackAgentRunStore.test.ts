import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { SlackAgentInstanceStore } from "../Services/SlackAgentInstanceStore.ts";
import { SlackAgentRunStore, SlackAgentRunStoreError } from "../Services/SlackAgentRunStore.ts";
import { SlackAgentInstanceStoreLive } from "./SlackAgentInstanceStore.ts";
import { SlackAgentRunStoreLive } from "./SlackAgentRunStore.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";

const layer = it.layer(
  Layer.mergeAll(SlackAgentInstanceStoreLive, SlackAgentRunStoreLive).pipe(
    Layer.provide(DeterministicWorkflowIds),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const snapshotJson =
  '{"thread":{"workspaceId":"workspace-1","channelId":"channel-1","channelName":"general","threadTs":"1000.000001","threadKey":"thread-1"},"triggerEventId":"event-1","triggerMessageId":"message-1","triggerTs":"1000.000002","canonicalJsonBytes":2,"messages":[]}';

const snapshotSha = NodeCrypto.createHash("sha256").update(snapshotJson).digest("hex");

const createInstance = (suffix: string) =>
  Effect.gen(function* () {
    const instances = yield* SlackAgentInstanceStore;
    return yield* instances.create({
      workspaceId: "workspace-1",
      ownerLabel: suffix,
      handleSuffix: suffix,
      projectId: "project-1" as never,
      boardId: "board-1" as never,
      initialLane: "todo" as never,
    });
  });

layer("SlackAgentRunStore", (it) => {
  it.effect("creates a run and accepted delivery under the caller's transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const runs = yield* SlackAgentRunStore;
      const instance = yield* createInstance("run_create");

      const run = yield* sql.withTransaction(
        runs.createRunWithAcceptedDelivery({
          instanceId: instance.instanceId,
          externalEventId: "event-create",
          workspaceId: "workspace-1",
          channelId: "channel-create",
          channelName: "general",
          threadKey: "thread-create",
          threadTs: "1100.000001",
          triggerTs: "1100.000002",
          snapshotJson,
          snapshotSha256: snapshotSha,
          snapshotBytes: Buffer.byteLength(snapshotJson, "utf8"),
          ticketId: "ticket-create" as never,
          status: "accepted",
          acceptedPayloadJson: '{"text":"accepted"}',
        }),
      );

      assert.equal(run.state, "accepted");
      assert.equal(run.ticketId, "ticket-create");
      const deliveries = yield* runs.listDeliveries(run.runId);
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]?.workflowSequence, 0);
      assert.equal(deliveries[0]?.state, "pending");
    }),
  );

  it.effect("rolls back run and delivery when the caller transaction fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const runs = yield* SlackAgentRunStore;
      const instance = yield* createInstance("run_rollback");

      const exit = yield* Effect.exit(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* runs.createRunWithAcceptedDelivery({
              instanceId: instance.instanceId,
              externalEventId: "event-rollback",
              workspaceId: "workspace-1",
              channelId: "channel-rollback",
              channelName: "general",
              threadKey: "thread-rollback",
              threadTs: "2000.000001",
              triggerTs: "2000.000002",
              snapshotJson,
              snapshotSha256: snapshotSha,
              snapshotBytes: Buffer.byteLength(snapshotJson, "utf8"),
              ticketId: "ticket-rollback" as never,
              status: "accepted",
              acceptedPayloadJson: "{}",
            });
            return yield* new SlackAgentRunStoreError({ message: "rollback" });
          }),
        ),
      );
      assert.equal(exit._tag, "Failure");

      const runRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM slack_agent_run WHERE ticket_id = 'ticket-rollback'
      `;
      const deliveryRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM slack_agent_delivery
        WHERE run_id IN (
          SELECT run_id FROM slack_agent_run WHERE ticket_id = 'ticket-rollback'
        )
      `;
      assert.equal(runRows[0]?.count, 0);
      assert.equal(deliveryRows[0]?.count, 0);
    }),
  );

  it.effect("dedupes by external event, source thread, ticket, and workflow sequence", () =>
    Effect.gen(function* () {
      const runs = yield* SlackAgentRunStore;
      const instance = yield* createInstance("run_dedupe");
      const created = yield* runs.createRunWithAcceptedDelivery({
        instanceId: instance.instanceId,
        externalEventId: "event-dedupe",
        workspaceId: "workspace-1",
        channelId: "channel-dedupe",
        channelName: "general",
        threadKey: "thread-dedupe",
        threadTs: "1300.000001",
        triggerTs: "1300.000002",
        snapshotJson,
        snapshotSha256: snapshotSha,
        snapshotBytes: Buffer.byteLength(snapshotJson, "utf8"),
        ticketId: "ticket-dedupe" as never,
        status: "accepted",
        acceptedPayloadJson: "{}",
      });

      assert.equal(
        (yield* runs.findByExternalEvent(instance.instanceId, "event-dedupe"))?.runId,
        created.runId,
      );
      assert.equal(
        (yield* runs.findBySourceThread(
          instance.instanceId,
          "workspace-1",
          "channel-dedupe",
          "1300.000001",
        ))?.runId,
        created.runId,
      );
      assert.equal((yield* runs.getRunByTicketId("ticket-dedupe" as never))?.runId, created.runId);

      const duplicateSequence = yield* Effect.exit(
        runs.enqueueDelivery({
          runId: created.runId,
          workflowSequence: 0,
          kind: "progress",
          operation: "update",
          payloadJson: "{}",
        }),
      );
      assert.equal(duplicateSequence._tag, "Failure");
    }),
  );

  it.effect("maps dispatcher delivery states to contract delivery states", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const runs = yield* SlackAgentRunStore;
      const instance = yield* createInstance("run_state");
      const run = yield* runs.createRunWithAcceptedDelivery({
        instanceId: instance.instanceId,
        externalEventId: "event-state",
        workspaceId: "workspace-1",
        channelId: "channel-state",
        channelName: "general",
        threadKey: "thread-state",
        threadTs: "1400.000001",
        triggerTs: "1400.000002",
        snapshotJson,
        snapshotSha256: snapshotSha,
        snapshotBytes: Buffer.byteLength(snapshotJson, "utf8"),
        ticketId: "ticket-state" as never,
        status: "accepted",
        acceptedPayloadJson: "{}",
      });
      const delivery = (yield* runs.listDeliveries(run.runId))[0]!;

      yield* sql`
        UPDATE slack_agent_delivery
        SET delivery_state = 'processing'
        WHERE delivery_id = ${delivery.deliveryId}
      `;
      assert.equal((yield* runs.listDeliveries(run.runId))[0]?.state, "delivering");

      yield* runs.markDeliverySent(delivery.deliveryId, "status-1");
      assert.equal((yield* runs.listDeliveries(run.runId))[0]?.state, "delivered");
      assert.equal((yield* runs.getRunSummary(run.runId))?.statusMessageId, "status-1");
    }),
  );

  it.effect("updates run status and pr URL, and prunes only stale runless mock threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const runs = yield* SlackAgentRunStore;
      const instance = yield* createInstance("run_update");
      const run = yield* runs.createRunWithAcceptedDelivery({
        instanceId: instance.instanceId,
        externalEventId: "event-update",
        workspaceId: "workspace-1",
        channelId: "channel-update",
        channelName: "general",
        threadKey: "thread-update",
        threadTs: "1500.000001",
        triggerTs: "1500.000002",
        snapshotJson,
        snapshotSha256: snapshotSha,
        snapshotBytes: Buffer.byteLength(snapshotJson, "utf8"),
        ticketId: "ticket-update" as never,
        status: "accepted",
        acceptedPayloadJson: "{}",
      });

      yield* runs.updateRunStatus({
        runId: run.runId,
        status: "pr_ready",
        prUrl: "https://github.com/t3/t3code/pull/1",
        lastAppliedSequence: 2,
      });
      const updated = yield* runs.getRunSummary(run.runId);
      assert.equal(updated?.state, "pr_ready");
      assert.equal(updated?.prUrl, "https://github.com/t3/t3code/pull/1");
      assert.equal(updated?.lastAppliedSequence, 2);

      yield* sql`
        INSERT INTO mock_slack_thread (
          thread_key, workspace_id, channel_id, channel_name, thread_ts,
          messages_json, status_replies_json, updated_at
        ) VALUES
          ('thread-linked', 'workspace-1', 'channel-update', 'general', '1500.000001', '[]', '{}', '2026-08-01T00:00:00.000Z'),
          ('thread-runless-old', 'workspace-1', 'channel-old', 'general', '900.000001', '[]', '{}', '2026-08-01T00:00:00.000Z'),
          ('thread-runless-new', 'workspace-1', 'channel-new', 'general', '901.000001', '[]', '{}', '2026-08-07T00:00:00.000Z')
      `;
      const pruned = yield* runs.pruneRunlessMockThreads("2026-08-06T00:00:00.000Z");
      assert.equal(pruned, 1);
      const remaining = yield* sql<{ readonly threadKey: string }>`
        SELECT thread_key AS "threadKey" FROM mock_slack_thread ORDER BY thread_key
      `;
      assert.deepEqual(
        remaining.map((row) => row.threadKey),
        ["thread-linked", "thread-runless-new"],
      );
    }),
  );
});
