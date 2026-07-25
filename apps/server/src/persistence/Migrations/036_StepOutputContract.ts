import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Output-contracts: validation columns on step runs + dispatch_seq for
 * deterministic initial vs repair dispatch selection.
 */
const migration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_step_run ADD COLUMN output_validation_errors_json TEXT`;
  yield* sql`ALTER TABLE projection_step_run ADD COLUMN output_validation_phase TEXT`;
  yield* sql`ALTER TABLE projection_step_run ADD COLUMN output_repaired INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE workflow_dispatch_outbox ADD COLUMN dispatch_seq INTEGER NOT NULL DEFAULT 0`;
});

export default migration;
