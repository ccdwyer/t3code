import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { migrationEntries } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(SqlitePersistenceMemory));

layer("038_ForkJoin", (it) => {
  it.effect("creates fork projection and lineage tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'projection_ticket_fork',
            'projection_ticket_fork_child',
            'workflow_fork_lineage'
          )
        ORDER BY name
      `;
      assert.deepEqual(
        tables.map((t) => t.name),
        ["projection_ticket_fork", "projection_ticket_fork_child", "workflow_fork_lineage"],
      );
      assert.isTrue(migrationEntries.some(([id, name]) => id === 38 && name === "ForkJoin"));

      const cols = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_ticket)`;
      const names = new Set(cols.map((c) => c.name));
      assert.isTrue(names.has("fork_origin"));
      assert.isTrue(names.has("fork_root_ticket_id"));
    }),
  );
});
