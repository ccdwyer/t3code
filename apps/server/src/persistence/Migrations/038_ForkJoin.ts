import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Fork-join ticket graphs: parent fork rows, child settlement rows, lineage ledger.
 */
const migration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_ticket_fork (
      step_run_id TEXT PRIMARY KEY,
      parent_ticket_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      join_require INTEGER NOT NULL,
      on_branch_failure TEXT NOT NULL,
      spawn_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT NULL,
      resolution TEXT NULL,
      resolution_succeeded INTEGER NULL,
      resolution_failed INTEGER NULL,
      resolution_cancelled INTEGER NULL,
      route_applied_at TEXT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_parent
    ON projection_ticket_fork (parent_ticket_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_unresolved
    ON projection_ticket_fork (board_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_ticket_fork_child (
      step_run_id TEXT NOT NULL,
      child_ticket_id TEXT NOT NULL,
      child_key TEXT NOT NULL,
      title_snapshot TEXT NOT NULL,
      lane_key TEXT NOT NULL,
      settled_outcome TEXT NULL,
      settled_at TEXT NULL,
      detached_at TEXT NULL,
      deleted_at_seq INTEGER NULL,
      PRIMARY KEY (step_run_id, child_ticket_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_child_ticket
    ON projection_ticket_fork_child (child_ticket_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_fork_lineage (
      root_ticket_id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      fork_count INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_fork_lineage_board
    ON workflow_fork_lineage (board_id)
  `;

  // Optional origin columns on projection_ticket (idempotent).
  const cols = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_ticket)`;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("fork_origin")) {
    yield* sql`ALTER TABLE projection_ticket ADD COLUMN fork_origin TEXT NULL`;
  }
  if (!names.has("fork_root_ticket_id")) {
    yield* sql`ALTER TABLE projection_ticket ADD COLUMN fork_root_ticket_id TEXT NULL`;
  }
  if (!names.has("human_touched_at")) {
    yield* sql`ALTER TABLE projection_ticket ADD COLUMN human_touched_at TEXT NULL`;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_ticket_fork_root
    ON projection_ticket (fork_root_ticket_id)
  `;
});

export default migration;
