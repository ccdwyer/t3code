import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS slack_agent_instance_project (
      instance_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      selector TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, project_id),
      UNIQUE (instance_id, selector)
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO slack_agent_instance_project (
      instance_id,
      project_id,
      selector,
      created_at
    )
    SELECT
      instance_id,
      project_id,
      'project',
      created_at
    FROM slack_agent_instance
  `;

  const runColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(slack_agent_run)
  `;
  if (!runColumns.some((column) => column.name === "project_id")) {
    yield* sql`ALTER TABLE slack_agent_run ADD COLUMN project_id TEXT`;
  }

  yield* sql`
    UPDATE slack_agent_run
    SET project_id = (
      SELECT project_id
      FROM slack_agent_instance
      WHERE slack_agent_instance.instance_id = slack_agent_run.instance_id
    )
    WHERE project_id IS NULL
  `;
});
