import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(slack_agent_instance)
  `;
  const needsRebuild =
    !columns.some((column) => column.name === "workspace_name") ||
    !columns.some((column) => column.name === "app_token_secret_name");

  if (needsRebuild) {
    yield* sql`ALTER TABLE slack_agent_instance RENAME TO slack_agent_instance_legacy_041`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_agent_instance (
      instance_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('mock', 'slack')),
      workspace_id TEXT NOT NULL,
      workspace_name TEXT,
      app_id TEXT,
      bot_id TEXT,
      bot_user_id TEXT NOT NULL,
      handle TEXT NOT NULL,
      owner_label TEXT NOT NULL,
      owner_principal TEXT,
      project_id TEXT NOT NULL,
      app_token_secret_name TEXT,
      bot_token_secret_name TEXT,
      connection_state TEXT NOT NULL CHECK (
        connection_state IN ('disconnected', 'connecting', 'connected', 'error')
      ),
      connected_at TEXT,
      last_error TEXT,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT,
        UNIQUE (workspace_id, bot_user_id),
        UNIQUE (workspace_id, handle COLLATE NOCASE)
      )
    `;

  if (needsRebuild) {
    yield* sql`
      INSERT INTO slack_agent_instance (
        instance_id,
        kind,
        workspace_id,
        workspace_name,
        app_id,
        bot_id,
        bot_user_id,
        handle,
        owner_label,
        owner_principal,
        project_id,
        app_token_secret_name,
        bot_token_secret_name,
        connection_state,
        connected_at,
        last_error,
        enabled,
        created_at,
        updated_at,
        disabled_at
      )
      SELECT
        instance_id,
        kind,
        workspace_id,
        NULL,
        NULL,
        NULL,
        bot_user_id,
        handle,
        owner_label,
        owner_principal,
        project_id,
        NULL,
        NULL,
        'connected',
        created_at,
        NULL,
        enabled,
        created_at,
        updated_at,
        disabled_at
      FROM slack_agent_instance_legacy_041
    `;
    yield* sql`DROP TABLE slack_agent_instance_legacy_041`;
  }
});
