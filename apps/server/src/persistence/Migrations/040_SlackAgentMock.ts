import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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
      board_id TEXT NOT NULL,
      initial_lane TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT,
      UNIQUE (workspace_id, bot_user_id),
      UNIQUE (workspace_id, handle COLLATE NOCASE)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_slack_agent_instance_board_enabled
    ON slack_agent_instance (board_id, enabled)
  `;

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
      ticket_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('accepted', 'queued', 'running', 'waiting', 'blocked', 'failed', 'pr_ready', 'done')
      ),
      status_message_id TEXT,
      pr_url TEXT,
      last_applied_sequence INTEGER NOT NULL DEFAULT -1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (instance_id, external_event_id),
      UNIQUE (instance_id, workspace_id, channel_id, thread_ts),
      UNIQUE (ticket_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_slack_agent_run_instance_status_updated
    ON slack_agent_run (instance_id, status, updated_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_agent_delivery (
      delivery_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      workflow_sequence INTEGER NOT NULL CHECK (workflow_sequence >= 0),
      kind TEXT NOT NULL CHECK (
        kind IN ('accepted', 'progress', 'needs_attention', 'pr_opened', 'done')
      ),
      operation TEXT NOT NULL CHECK (operation IN ('post', 'update')),
      payload_json TEXT NOT NULL,
      delivery_state TEXT NOT NULL CHECK (
        delivery_state IN (
          'pending',
          'processing',
          'delivering',
          'sent',
          'delivered',
          'retrying',
          'failed',
          'superseded'
        )
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      status_message_id TEXT,
      next_attempt_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (run_id, workflow_sequence)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_slack_agent_delivery_due
    ON slack_agent_delivery (delivery_state, next_attempt_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS mock_slack_thread (
      thread_key TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      status_replies_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, channel_id, thread_ts)
    )
  `;
});
