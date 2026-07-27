import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * What KIND of dispatch a `workflow_dispatch_outbox` row is.
 *
 * `dispatch_seq` used to carry this implicitly (0 = initial, 1 = repair). Agent
 * question continuations broke that: they must sit ABOVE earlier rows in the
 * `dispatch_seq DESC` reads that pick "the latest turn", so a repair that
 * follows a continuation can no longer be pinned to 1 — it would be read as
 * older than the output it is repairing. The seq is now monotonic and the kind
 * is explicit. NULL means the initial turn (or a row written before this).
 *
 * A separate migration rather than an ALTER inside 035 on purpose: 035 has a
 * golden `sqlite_master` test asserting its exact stored SQL byte-for-byte, and
 * editing an already-applied migration would never run for any database that
 * had applied it — every dispatch INSERT would then fail on a missing column.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(workflow_dispatch_outbox)
  `;

  // Guarded so a database that was hand-reconciled with this column (or that
  // ran an earlier build carrying it inside 035) migrates cleanly instead of
  // failing on a duplicate column.
  if (!columns.some((column) => column.name === "dispatch_kind")) {
    yield* sql`
      ALTER TABLE workflow_dispatch_outbox
      ADD COLUMN dispatch_kind TEXT
    `;
  }
});
