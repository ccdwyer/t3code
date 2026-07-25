import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Checkpoint form columns on `projection_step_run`.
 *
 * The `StepAwaitingUser` event stays the authority for what was asked — these
 * are a read cache so the drawer can render a waiting checkpoint without
 * replaying the event stream, and so a resolved step can show what was answered.
 *
 * All nullable: every step run that predates checkpoint forms, and every step
 * that is not an approval, simply has no form.
 */
const Migration0040 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_step_run ADD COLUMN checkpoint_form_json TEXT`;
  yield* sql`ALTER TABLE projection_step_run ADD COLUMN checkpoint_decision TEXT`;
  yield* sql`ALTER TABLE projection_step_run ADD COLUMN checkpoint_answers_json TEXT`;
});

export default Migration0040;
