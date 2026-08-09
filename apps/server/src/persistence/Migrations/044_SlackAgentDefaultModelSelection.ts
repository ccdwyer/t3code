import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(slack_agent_instance)
  `;
  if (!columns.some((column) => column.name === "default_model_selection_json")) {
    yield* sql`ALTER TABLE slack_agent_instance ADD COLUMN default_model_selection_json TEXT`;
  }
});
