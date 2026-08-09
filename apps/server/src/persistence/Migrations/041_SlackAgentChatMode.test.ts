import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("041_SlackAgentChatMode", (it) => {
  it.effect("installs Slack agent tables and indexes on an existing workflow database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 39 });
      yield* sql`
        INSERT INTO projection_board (
          board_id,
          project_id,
          name,
          workflow_file_path,
          workflow_version_hash,
          max_concurrent_tickets
        ) VALUES ('board-existing', 'project-existing', 'Existing', 'workflow.yaml', 'hash', 1)
      `;

      yield* runMigrations({ toMigrationInclusive: 41 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'slack_agent_instance',
            'slack_agent_run',
            'slack_agent_delivery',
            'slack_agent_ingested_event',
            'mock_slack_thread'
          )
        ORDER BY name
      `;
      const preserved = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_board WHERE board_id = 'board-existing'
      `;
      assert.deepEqual(
        tables.map((row) => row.name),
        [
          "mock_slack_thread",
          "slack_agent_delivery",
          "slack_agent_ingested_event",
          "slack_agent_instance",
          "slack_agent_run",
        ],
      );
      assert.equal(preserved[0]?.count, 1);
    }),
  );

  it.effect("enforces handle, event, thread, ticket, and delivery uniqueness", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });
      const now = "2026-08-07T00:00:00.000Z";

      yield* sql`
        INSERT INTO slack_agent_instance (
          instance_id, kind, workspace_id, bot_user_id, handle, owner_label,
          owner_principal, project_id, enabled, created_at, updated_at
        ) VALUES (
          'inst-1', 'mock', 'workspace-1', 'bot-1', 't3_chris', 'Chris',
          NULL, 'project-1', 1, ${now}, ${now}
        )
      `;
      const handleCollision = yield* Effect.exit(sql`
        INSERT INTO slack_agent_instance (
          instance_id, kind, workspace_id, bot_user_id, handle, owner_label,
          owner_principal, project_id, enabled, created_at, updated_at
        ) VALUES (
          'inst-2', 'mock', 'workspace-1', 'bot-2', 'T3_CHRIS', 'Chris 2',
          NULL, 'project-1', 1, ${now}, ${now}
        )
      `);
      assert.equal(handleCollision._tag, "Failure");

      yield* sql`
        INSERT INTO slack_agent_run (
          run_id, instance_id, external_event_id, mode, workspace_id, channel_id, channel_name,
          thread_key, thread_ts, trigger_ts, snapshot_json, snapshot_sha256, snapshot_bytes,
          ticket_id, status, created_at, updated_at
        ) VALUES (
          'run-1', 'inst-1', 'event-1', 'workflow', 'workspace-1', 'channel-1', 'general',
          'thread-1', '1000.000001', '1000.000002', '{}', 'sha', 2,
          'ticket-1', 'accepted', ${now}, ${now}
        )
      `;

      const duplicateEvent = yield* Effect.exit(sql`
        INSERT INTO slack_agent_run (
          run_id, instance_id, external_event_id, mode, workspace_id, channel_id, channel_name,
          thread_key, thread_ts, trigger_ts, snapshot_json, snapshot_sha256, snapshot_bytes,
          ticket_id, status, created_at, updated_at
        ) VALUES (
          'run-event', 'inst-1', 'event-1', 'workflow', 'workspace-1', 'channel-2', 'random',
          'thread-2', '2000.000001', '2000.000002', '{}', 'sha', 2,
          'ticket-event', 'accepted', ${now}, ${now}
        )
      `);
      const duplicateThread = yield* Effect.exit(sql`
        INSERT INTO slack_agent_run (
          run_id, instance_id, external_event_id, mode, workspace_id, channel_id, channel_name,
          thread_key, thread_ts, trigger_ts, snapshot_json, snapshot_sha256, snapshot_bytes,
          ticket_id, status, created_at, updated_at
        ) VALUES (
          'run-thread', 'inst-1', 'event-2', 'workflow', 'workspace-1', 'channel-1', 'general',
          'thread-1b', '1000.000001', '1000.000003', '{}', 'sha', 2,
          'ticket-thread', 'accepted', ${now}, ${now}
        )
      `);
      const duplicateTicket = yield* Effect.exit(sql`
        INSERT INTO slack_agent_run (
          run_id, instance_id, external_event_id, mode, workspace_id, channel_id, channel_name,
          thread_key, thread_ts, trigger_ts, snapshot_json, snapshot_sha256, snapshot_bytes,
          ticket_id, status, created_at, updated_at
        ) VALUES (
          'run-ticket', 'inst-1', 'event-3', 'workflow', 'workspace-1', 'channel-3', 'triage',
          'thread-3', '3000.000001', '3000.000002', '{}', 'sha', 2,
          'ticket-1', 'accepted', ${now}, ${now}
        )
      `);
      const validChat = yield* Effect.exit(sql`
        INSERT INTO slack_agent_run (
          run_id, instance_id, external_event_id, mode, workspace_id, channel_id, channel_name,
          thread_key, thread_ts, trigger_ts, snapshot_json, snapshot_sha256, snapshot_bytes,
          t3_thread_id, status, created_at, updated_at
        ) VALUES (
          'run-chat', 'inst-1', 'event-chat', 'chat', 'workspace-1', 'channel-4', 'triage',
          'thread-chat', '4000.000001', '4000.000002', '{}', 'sha', 2,
          'thread-1', 'connected', ${now}, ${now}
        )
      `);
      const invalidChat = yield* Effect.exit(sql`
        INSERT INTO slack_agent_run (
          run_id, instance_id, external_event_id, mode, workspace_id, channel_id, channel_name,
          thread_key, thread_ts, trigger_ts, snapshot_json, snapshot_sha256, snapshot_bytes,
          status, created_at, updated_at
        ) VALUES (
          'run-chat-invalid', 'inst-1', 'event-chat-invalid', 'chat', 'workspace-1', 'channel-5', 'triage',
          'thread-chat-invalid', '5000.000001', '5000.000002', '{}', 'sha', 2,
          'connected', ${now}, ${now}
        )
      `);
      assert.equal(duplicateEvent._tag, "Failure");
      assert.equal(duplicateThread._tag, "Failure");
      assert.equal(duplicateTicket._tag, "Failure");
      assert.equal(validChat._tag, "Success");
      assert.equal(invalidChat._tag, "Failure");

      yield* sql`
        INSERT INTO slack_agent_delivery (
          delivery_id, run_id, workflow_sequence, kind, operation, payload_json,
          delivery_state, attempt_count, next_attempt_at, created_at, updated_at
        ) VALUES (
          'delivery-1', 'run-1', 0, 'accepted', 'post', '{}',
          'pending', 0, ${now}, ${now}, ${now}
        )
      `;
      const duplicateDelivery = yield* Effect.exit(sql`
        INSERT INTO slack_agent_delivery (
          delivery_id, run_id, workflow_sequence, kind, operation, payload_json,
          delivery_state, attempt_count, next_attempt_at, created_at, updated_at
        ) VALUES (
          'delivery-2', 'run-1', 0, 'progress', 'update', '{}',
          'pending', 0, ${now}, ${now}, ${now}
        )
      `);
      const nullableSequence = yield* Effect.exit(sql`
        INSERT INTO slack_agent_delivery (
          delivery_id, run_id, workflow_sequence, kind, operation, payload_json,
          delivery_state, attempt_count, next_attempt_at, created_at, updated_at
        ) VALUES (
          'delivery-null', 'run-1', NULL, 'progress', 'update', '{}',
          'pending', 0, ${now}, ${now}, ${now}
        )
      `);
      assert.equal(duplicateDelivery._tag, "Failure");
      assert.equal(nullableSequence._tag, "Failure");
    }),
  );

  it.effect("enforces ingested-event idempotency per run event and trigger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });
      const now = "2026-08-07T00:00:00.000Z";

      yield* sql`
        INSERT INTO slack_agent_ingested_event (
          run_id, external_event_id, trigger_message_id, message_id, state, created_at
        ) VALUES (
          'run-1', 'event-1', 'trigger-1', 'message-1', 'pending', ${now}
        )
      `;
      const duplicateEvent = yield* Effect.exit(sql`
        INSERT INTO slack_agent_ingested_event (
          run_id, external_event_id, trigger_message_id, message_id, state, created_at
        ) VALUES (
          'run-1', 'event-1', 'trigger-2', 'message-2', 'pending', ${now}
        )
      `);
      const duplicateTrigger = yield* Effect.exit(sql`
        INSERT INTO slack_agent_ingested_event (
          run_id, external_event_id, trigger_message_id, message_id, state, created_at
        ) VALUES (
          'run-1', 'event-2', 'trigger-1', 'message-2', 'pending', ${now}
        )
      `);

      assert.equal(duplicateEvent._tag, "Failure");
      assert.equal(duplicateTrigger._tag, "Failure");
    }),
  );

  it.effect("supports dispatcher delivery states and delivery status_message_id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 41 });
      const now = "2026-08-07T00:00:00.000Z";
      yield* sql`
        INSERT INTO slack_agent_delivery (
          delivery_id, run_id, workflow_sequence, kind, operation, payload_json,
          delivery_state, attempt_count, status_message_id, next_attempt_at, created_at, updated_at
        ) VALUES (
          'delivery-processing', 'run-missing-ok', 1, 'progress', 'update', '{}',
          'processing', 0, 'mock-status-1', ${now}, ${now}, ${now}
        )
      `;
      yield* sql`
        UPDATE slack_agent_delivery SET delivery_state = 'sent' WHERE delivery_id = 'delivery-processing'
      `;
      const rows = yield* sql<{ readonly state: string; readonly statusMessageId: string }>`
        SELECT delivery_state AS state, status_message_id AS "statusMessageId"
        FROM slack_agent_delivery
        WHERE delivery_id = 'delivery-processing'
      `;
      assert.deepEqual(rows[0], { state: "sent", statusMessageId: "mock-status-1" });
    }),
  );
});

const legacyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

legacyLayer("041_SlackAgentChatMode legacy upgrade", (it) => {
  it.effect("preserves rows from the applied workflow-only Slack schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      const now = "2026-08-07T00:00:00.000Z";
      yield* sql`
        INSERT INTO slack_agent_instance (
          instance_id, kind, workspace_id, bot_user_id, handle, owner_label,
          owner_principal, project_id, board_id, initial_lane, enabled, created_at, updated_at
        ) VALUES (
          'inst-legacy', 'mock', 'mock', 'bot-legacy', 't3_legacy', 'Legacy',
          NULL, 'project-legacy', 'board-legacy', 'implement', 1, ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO slack_agent_run (
          run_id, instance_id, external_event_id, workspace_id, channel_id, channel_name,
          thread_key, thread_ts, trigger_ts, snapshot_json, snapshot_sha256, snapshot_bytes,
          ticket_id, status, created_at, updated_at
        ) VALUES (
          'run-legacy', 'inst-legacy', 'event-legacy', 'mock', 'channel-legacy', 'legacy',
          'thread-legacy', '1000.000001', '1000.000002', '{}', 'sha', 2,
          'ticket-legacy', 'running', ${now}, ${now}
        )
      `;
      yield* sql`
        INSERT INTO slack_agent_delivery (
          delivery_id, run_id, workflow_sequence, kind, operation, payload_json,
          delivery_state, attempt_count, created_at, updated_at
        ) VALUES (
          'delivery-legacy', 'run-legacy', 0, 'accepted', 'post', '{}',
          'sent', 0, ${now}, ${now}
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 41 });

      const instance = yield* sql<{
        readonly projectId: string;
        readonly handle: string;
      }>`
        SELECT project_id AS "projectId", handle
        FROM slack_agent_instance
        WHERE instance_id = 'inst-legacy'
      `;
      const run = yield* sql<{
        readonly mode: string;
        readonly threadId: string | null;
        readonly ticketId: string | null;
      }>`
        SELECT mode, t3_thread_id AS "threadId", ticket_id AS "ticketId"
        FROM slack_agent_run
        WHERE run_id = 'run-legacy'
      `;
      const delivery = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM slack_agent_delivery
        WHERE delivery_id = 'delivery-legacy'
      `;

      assert.deepEqual(instance[0], { projectId: "project-legacy", handle: "t3_legacy" });
      assert.deepEqual(run[0], {
        mode: "workflow",
        threadId: null,
        ticketId: "ticket-legacy",
      });
      assert.equal(delivery[0]?.count, 1);
    }),
  );
});
