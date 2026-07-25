import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Agent handoff context packs: one pack per (ticket, destination lane), compiled
 * by the engine on a routed lane entry and editable from the ticket drawer.
 *
 * Sections live as JSON on the row rather than in a child table: the pack is
 * always read and written whole (full-set edit semantics), capped at four
 * sections, and never queried by section.
 */
const migration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_context_pack (
      ticket_id TEXT NOT NULL,
      for_lane TEXT NOT NULL,
      from_lane TEXT NOT NULL,
      compiled_at TEXT NOT NULL,
      edited_at TEXT NULL,
      sections_json TEXT NOT NULL,
      PRIMARY KEY (ticket_id, for_lane)
    )
  `;
});

export default migration;
