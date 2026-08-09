import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const withMemoryDb = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(NodeSqliteClient.layerMemory())));

describe("043_SlackAgentMultiProject", () => {
  it.effect("backfills instance project bindings and run project ids", () =>
    withMemoryDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 42 });
        const now = "2026-08-08T00:00:00.000Z";

        yield* sql`
          INSERT INTO slack_agent_instance (
            instance_id, kind, workspace_id, bot_user_id, handle, owner_label,
            owner_principal, project_id, connection_state, enabled, created_at, updated_at
          ) VALUES (
            'inst-legacy', 'mock', 'mock', 'bot-legacy', 't3_legacy', 'Legacy',
            NULL, 'Legacy Project.ID', 'connected', 1, ${now}, ${now}
          )
        `;
        yield* sql`
          INSERT INTO slack_agent_run (
            run_id, instance_id, external_event_id, mode, workspace_id, channel_id, channel_name,
            thread_key, thread_ts, trigger_ts, snapshot_json, snapshot_sha256, snapshot_bytes,
            ticket_id, status, created_at, updated_at
          ) VALUES (
            'run-legacy', 'inst-legacy', 'event-legacy', 'workflow', 'mock', 'channel-legacy', 'legacy',
            'thread-legacy', '1000.000001', '1000.000002', '{}', 'sha', 2,
            'ticket-legacy', 'running', ${now}, ${now}
          )
        `;

        yield* runMigrations({ toMigrationInclusive: 43 });

        const bindings = yield* sql<{
          readonly projectId: string;
          readonly selector: string;
        }>`
          SELECT project_id AS "projectId", selector
          FROM slack_agent_instance_project
          WHERE instance_id = 'inst-legacy'
        `;
        const runs = yield* sql<{ readonly projectId: string | null }>`
          SELECT project_id AS "projectId"
          FROM slack_agent_run
          WHERE run_id = 'run-legacy'
        `;

        assert.deepEqual(bindings, [{ projectId: "Legacy Project.ID", selector: "project" }]);
        assert.equal(runs[0]?.projectId, "Legacy Project.ID");
      }),
    ),
  );

  it.effect("enforces project and selector uniqueness per instance", () =>
    withMemoryDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 43 });
        const now = "2026-08-08T00:00:00.000Z";

        yield* sql`
          INSERT INTO slack_agent_instance (
            instance_id, kind, workspace_id, bot_user_id, handle, owner_label,
            owner_principal, project_id, connection_state, enabled, created_at, updated_at
          ) VALUES (
            'inst-1', 'mock', 'mock', 'bot-1', 't3_one', 'One',
            NULL, 'project-1', 'connected', 1, ${now}, ${now}
          )
        `;
        yield* sql`
          INSERT INTO slack_agent_instance_project (
            instance_id, project_id, selector, created_at
          ) VALUES (
            'inst-1', 'project-2', 'two', ${now}
          )
        `;

        const duplicateProject = yield* Effect.exit(sql`
          INSERT INTO slack_agent_instance_project (
            instance_id, project_id, selector, created_at
          ) VALUES (
            'inst-1', 'project-2', 'other', ${now}
          )
        `);
        const duplicateSelector = yield* Effect.exit(sql`
          INSERT INTO slack_agent_instance_project (
            instance_id, project_id, selector, created_at
          ) VALUES (
            'inst-1', 'project-3', 'two', ${now}
          )
        `);

        assert.equal(duplicateProject._tag, "Failure");
        assert.equal(duplicateSelector._tag, "Failure");
      }),
    ),
  );
});
