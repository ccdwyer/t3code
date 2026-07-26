import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { MigrationsLive } from "../Migrations.ts";
import { makeSqlitePersistenceLive } from "../Layers/Sqlite.ts";

/**
 * Regression: this migration must survive being re-run against a database that
 * already has its tables.
 *
 * It was renumbered 034 -> 035 when an upstream rebase claimed 034. Any
 * database that recorded the OLD id sees 035 as unapplied and replays it: the
 * CREATE TABLE IF NOT EXISTS statements no-op, and then a bare ADD COLUMN
 * aborts with "duplicate column name" and the server cannot start.
 *
 * This reproduces exactly that by rewinding the recorded id after a normal
 * migration run, then migrating again.
 */
it(
  "re-applies cleanly against a database that recorded the pre-renumber id",
  { timeout: 60_000 },
  async () => {
    // Fixed path: the test owns it, and starting from a clean file is what
    // makes step 1 a genuine first migration.
    const dbPath = "/tmp/t3-migrate-rerun/state.sqlite";
    const layer = MigrationsLive.pipe(
      Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
      Layer.provideMerge(NodeServices.layer),
    );

    // 1. Normal run, so the schema exists. If a previous run left the file,
    // migrations simply find everything applied, which is also a valid start.
    await Effect.runPromise(Effect.void.pipe(Effect.provide(layer)));

    // 2. Rewind to the state a pre-renumber database is in.
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Drop the record of 035 and everything after it while LEAVING the
        // schema in place. That is precisely the state a database reaches when
        // it recorded this migration under its old id: tables present, id
        // unapplied.
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 35`;
      }).pipe(
        Effect.provide(
          makeSqlitePersistenceLive(dbPath).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      ),
    );

    // 3. Migrate again. Before the fix this threw "duplicate column name".
    const exit = await Effect.runPromiseExit(Effect.void.pipe(Effect.provide(layer)));
    assert.isTrue(exit._tag === "Success", `re-run failed: ${JSON.stringify(exit).slice(0, 400)}`);
  },
);
