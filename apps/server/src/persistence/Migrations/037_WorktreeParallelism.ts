import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Phase A worktree parallelism: path cache + serialize holds + overlap report
 * fingerprints. Rebase tables deferred to a later slice.
 */
const migration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ticket_changed_paths (
      ticket_id TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (ticket_id, path)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_ticket_changed_paths_path
    ON ticket_changed_paths (path, ticket_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ticket_changed_paths_meta (
      ticket_id TEXT PRIMARY KEY,
      source_ref TEXT NOT NULL,
      file_count INTEGER NOT NULL,
      truncated INTEGER NOT NULL,
      refreshed_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ticket_parallelism_hold (
      ticket_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      blocked_by_ticket_id TEXT NOT NULL,
      lane_key TEXT NOT NULL,
      lane_entry_token TEXT NOT NULL,
      pipeline_run_id TEXT NOT NULL,
      step_run_id TEXT NOT NULL,
      held_at TEXT NOT NULL,
      released_at TEXT NULL,
      resume_pipeline_run_id TEXT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_ticket_parallelism_hold_blocker
    ON ticket_parallelism_hold (blocked_by_ticket_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ticket_overlap_reported (
      ticket_id TEXT NOT NULL,
      with_ticket_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      reported_at TEXT NOT NULL,
      PRIMARY KEY (ticket_id, with_ticket_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ticket_worktree_registry (
      ticket_id TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_post_checkpoint_at TEXT NULL
    )
  `;
});

export default migration;
