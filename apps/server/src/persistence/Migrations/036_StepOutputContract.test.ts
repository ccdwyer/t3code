import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { migrationEntries } from "../Migrations.ts";

// SqlitePersistenceMemory runs full MigrationsLive on build.
const layer = it.layer(Layer.mergeAll(SqlitePersistenceMemory));

layer("035_StepOutputContract", (it) => {
  it.effect("adds output-contract columns and dispatch_seq", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stepCols = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_step_run)
      `;
      const names = new Set(stepCols.map((c) => c.name));
      assert.isTrue(names.has("output_validation_errors_json"));
      assert.isTrue(names.has("output_validation_phase"));
      assert.isTrue(names.has("output_repaired"));

      const outboxCols = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(workflow_dispatch_outbox)
      `;
      const onames = new Set(outboxCols.map((c) => c.name));
      assert.isTrue(onames.has("dispatch_seq"));

      // Columns exist once 035 has applied (higher migrations may also be present).
      assert.isTrue(
        migrationEntries.some(([id, name]) => id === 35 && name === "StepOutputContract"),
      );
    }),
  );
});
