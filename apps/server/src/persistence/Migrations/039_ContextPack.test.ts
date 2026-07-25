import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { migrationEntries } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(SqlitePersistenceMemory));

layer("039_ContextPack", (it) => {
  it.effect("migration entry exists at id 39", () =>
    Effect.gen(function* () {
      assert.isTrue(migrationEntries.some(([id, name]) => id === 39 && name === "ContextPack"));
    }),
  );

  it.effect("projection_context_pack has the expected columns and composite PK", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const cols = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(projection_context_pack)`;

      assert.deepStrictEqual(
        cols.map((c) => c.name),
        ["ticket_id", "for_lane", "from_lane", "compiled_at", "edited_at", "sections_json"],
      );

      // (ticket_id, for_lane) is the composite key: at most one pack per
      // destination lane, which is what makes the clear-then-upsert fold safe.
      const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
      assert.deepStrictEqual(
        pkCols.map((c) => c.name),
        ["ticket_id", "for_lane"],
      );

      // edited_at is the only nullable column besides the PK-adjacent ones.
      const nullable = cols.filter((c) => c.notnull === 0).map((c) => c.name);
      assert.include(nullable, "edited_at");
      for (const required of ["from_lane", "compiled_at", "sections_json"]) {
        assert.notInclude(nullable, required);
      }
    }),
  );
});
