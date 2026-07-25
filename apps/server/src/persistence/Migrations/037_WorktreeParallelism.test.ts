import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { migrationEntries } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(SqlitePersistenceMemory));

layer("037_WorktreeParallelism", (it) => {
  it.effect("creates path cache, hold, overlap report, and registry tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'ticket_changed_paths',
            'ticket_changed_paths_meta',
            'ticket_parallelism_hold',
            'ticket_overlap_reported',
            'ticket_worktree_registry'
          )
        ORDER BY name
      `;
      const names = tables.map((t) => t.name);
      assert.includeMembers(names, [
        "ticket_changed_paths",
        "ticket_changed_paths_meta",
        "ticket_overlap_reported",
        "ticket_parallelism_hold",
        "ticket_worktree_registry",
      ]);

      assert.isTrue(
        migrationEntries.some(([id, name]) => id === 37 && name === "WorktreeParallelism"),
      );
    }),
  );

  it.effect("ticket_parallelism_hold has release columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const cols = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(ticket_parallelism_hold)
      `;
      const names = new Set(cols.map((c) => c.name));
      assert.isTrue(names.has("blocked_by_ticket_id"));
      assert.isTrue(names.has("released_at"));
      assert.isTrue(names.has("resume_pipeline_run_id"));
      assert.isTrue(names.has("lane_entry_token"));
    }),
  );
});
