import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const instanceColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(slack_agent_instance)
  `;
  const runColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(slack_agent_run)
  `;
  const legacySchema =
    instanceColumns.some((column) => column.name === "board_id") ||
    !runColumns.some((column) => column.name === "mode");

  if (legacySchema) {
    yield* sql`DROP INDEX IF EXISTS idx_slack_agent_instance_board_enabled`;
    yield* sql`DROP INDEX IF EXISTS idx_slack_agent_run_instance_status_updated`;
    yield* sql`ALTER TABLE slack_agent_instance RENAME TO slack_agent_instance_legacy_040`;
    yield* sql`ALTER TABLE slack_agent_run RENAME TO slack_agent_run_legacy_040`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_agent_instance (
      instance_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind = 'mock'),
      workspace_id TEXT NOT NULL,
      bot_user_id TEXT NOT NULL,
      handle TEXT NOT NULL,
      owner_label TEXT NOT NULL,
      owner_principal TEXT,
      project_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT,
      UNIQUE (workspace_id, bot_user_id),
      UNIQUE (workspace_id, handle COLLATE NOCASE)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_agent_run (
      run_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('chat', 'workflow')),
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      trigger_ts TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      snapshot_bytes INTEGER NOT NULL,
      t3_thread_id TEXT,
      ticket_id TEXT,
      status TEXT NOT NULL CHECK (
        status IN (
          'accepted',
          'connected',
          'queued',
          'running',
          'waiting',
          'blocked',
          'failed',
          'pr_ready',
          'done'
        )
      ),
      status_message_id TEXT,
      pr_url TEXT,
      last_applied_sequence INTEGER NOT NULL DEFAULT -1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (mode = 'chat' AND t3_thread_id IS NOT NULL AND ticket_id IS NULL)
        OR (mode = 'workflow' AND ticket_id IS NOT NULL AND t3_thread_id IS NULL)
      ),
      UNIQUE (instance_id, external_event_id),
      UNIQUE (instance_id, workspace_id, channel_id, thread_ts),
      UNIQUE (t3_thread_id),
      UNIQUE (ticket_id)
    )
  `;

  if (legacySchema) {
    yield* sql`
      INSERT INTO slack_agent_instance (
        instance_id,
        kind,
        workspace_id,
        bot_user_id,
        handle,
        owner_label,
        owner_principal,
        project_id,
        enabled,
        created_at,
        updated_at,
        disabled_at
      )
      SELECT
        instance_id,
        kind,
        workspace_id,
        bot_user_id,
        handle,
        owner_label,
        owner_principal,
        project_id,
        enabled,
        created_at,
        updated_at,
        disabled_at
      FROM slack_agent_instance_legacy_040
    `;
    yield* sql`
      INSERT INTO slack_agent_run (
        run_id,
        instance_id,
        external_event_id,
        mode,
        workspace_id,
        channel_id,
        channel_name,
        thread_key,
        thread_ts,
        trigger_ts,
        snapshot_json,
        snapshot_sha256,
        snapshot_bytes,
        t3_thread_id,
        ticket_id,
        status,
        status_message_id,
        pr_url,
        last_applied_sequence,
        created_at,
        updated_at
      )
      SELECT
        run_id,
        instance_id,
        external_event_id,
        'workflow',
        workspace_id,
        channel_id,
        channel_name,
        thread_key,
        thread_ts,
        trigger_ts,
        snapshot_json,
        snapshot_sha256,
        snapshot_bytes,
        NULL,
        ticket_id,
        status,
        status_message_id,
        pr_url,
        last_applied_sequence,
        created_at,
        updated_at
      FROM slack_agent_run_legacy_040
    `;
    yield* sql`DROP TABLE slack_agent_run_legacy_040`;
    yield* sql`DROP TABLE slack_agent_instance_legacy_040`;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_slack_agent_run_instance_status_updated
    ON slack_agent_run (instance_id, status, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_agent_ingested_event (
      run_id TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      trigger_message_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'delivered')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE (run_id, external_event_id),
      UNIQUE (run_id, trigger_message_id)
    )
  `;
});
