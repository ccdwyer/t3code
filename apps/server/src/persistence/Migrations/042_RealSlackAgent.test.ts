import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const withMemoryDb = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(NodeSqliteClient.layerMemory())));

describe("042_RealSlackAgent", () => {
  it.effect("allows real Slack agent rows with metadata and credential refs", () =>
    withMemoryDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 42 });
        const now = "2026-08-08T00:00:00.000Z";

        yield* sql`
        INSERT INTO slack_agent_instance (
          instance_id, kind, workspace_id, workspace_name, app_id, bot_id,
          bot_user_id, handle, owner_label, owner_principal, project_id,
          app_token_secret_name, bot_token_secret_name, connection_state,
          connected_at, last_error, enabled, created_at, updated_at
        ) VALUES (
          'inst-real', 'slack', 'T123', 'T3', 'A123', 'B123',
          'U123', 't3_chris', 'Chris', NULL, 'project-1',
          'slack-agent:inst-real:app-token', 'slack-agent:inst-real:bot-token', 'connected',
          ${now}, NULL, 1, ${now}, ${now}
        )
      `;

        const rows = yield* sql<{
          readonly kind: string;
          readonly workspaceName: string | null;
          readonly appSecret: string | null;
          readonly botSecret: string | null;
          readonly state: string;
        }>`
        SELECT
          kind,
          workspace_name AS "workspaceName",
          app_token_secret_name AS "appSecret",
          bot_token_secret_name AS "botSecret",
          connection_state AS state
        FROM slack_agent_instance
        WHERE instance_id = 'inst-real'
      `;

        assert.deepEqual(rows[0], {
          kind: "slack",
          workspaceName: "T3",
          appSecret: "slack-agent:inst-real:app-token",
          botSecret: "slack-agent:inst-real:bot-token",
          state: "connected",
        });
      }),
    ),
  );

  it.effect("preserves mock rows and runs when rebuilding the 041 instance table", () =>
    withMemoryDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 41 });
        const now = "2026-08-08T00:00:00.000Z";

        yield* sql`
        INSERT INTO slack_agent_instance (
          instance_id, kind, workspace_id, bot_user_id, handle, owner_label,
          owner_principal, project_id, enabled, created_at, updated_at
        ) VALUES (
          'inst-mock', 'mock', 'mock', 'bot-mock', 't3_mock', 'Mock',
          NULL, 'project-mock', 1, ${now}, ${now}
        )
      `;
        yield* sql`
        INSERT INTO slack_agent_run (
          run_id, instance_id, external_event_id, mode, workspace_id, channel_id, channel_name,
          thread_key, thread_ts, trigger_ts, snapshot_json, snapshot_sha256, snapshot_bytes,
          ticket_id, status, created_at, updated_at
        ) VALUES (
          'run-mock', 'inst-mock', 'event-mock', 'workflow', 'mock', 'channel-mock', 'mock',
          'thread-mock', '1000.000001', '1000.000002', '{}', 'sha', 2,
          'ticket-mock', 'running', ${now}, ${now}
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 42 });

        const instance = yield* sql<{
          readonly kind: string;
          readonly workspaceName: string | null;
          readonly appSecret: string | null;
          readonly botSecret: string | null;
          readonly state: string;
          readonly connectedAt: string | null;
        }>`
        SELECT
          kind,
          workspace_name AS "workspaceName",
          app_token_secret_name AS "appSecret",
          bot_token_secret_name AS "botSecret",
          connection_state AS state,
          connected_at AS "connectedAt"
        FROM slack_agent_instance
        WHERE instance_id = 'inst-mock'
      `;
        const runs = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM slack_agent_run
        WHERE run_id = 'run-mock'
      `;

        assert.deepEqual(instance[0], {
          kind: "mock",
          workspaceName: null,
          appSecret: null,
          botSecret: null,
          state: "connected",
          connectedAt: now,
        });
        assert.equal(runs[0]?.count, 1);
      }),
    ),
  );

  it.effect("keeps one project mapping per installed bot identity", () =>
    withMemoryDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 42 });
        const now = "2026-08-08T00:00:00.000Z";

        yield* sql`
        INSERT INTO slack_agent_instance (
          instance_id, kind, workspace_id, bot_user_id, handle, owner_label,
          project_id, app_token_secret_name, bot_token_secret_name, connection_state,
          enabled, created_at, updated_at
        ) VALUES (
          'inst-1', 'slack', 'T123', 'U123', 't3_chris', 'Chris',
          'project-1', 'app-1', 'bot-1', 'connected',
          1, ${now}, ${now}
        )
      `;
        const sameBotOtherProject = yield* Effect.exit(sql`
        INSERT INTO slack_agent_instance (
          instance_id, kind, workspace_id, bot_user_id, handle, owner_label,
          project_id, app_token_secret_name, bot_token_secret_name, connection_state,
          enabled, created_at, updated_at
        ) VALUES (
          'inst-2', 'slack', 'T123', 'U123', 't3_chris', 'Chris',
          'project-2', 'app-2', 'bot-2', 'connected',
          1, ${now}, ${now}
        )
      `);
        const sameWorkspaceHandle = yield* Effect.exit(sql`
        INSERT INTO slack_agent_instance (
          instance_id, kind, workspace_id, bot_user_id, handle, owner_label,
          project_id, app_token_secret_name, bot_token_secret_name, connection_state,
          enabled, created_at, updated_at
        ) VALUES (
          'inst-3', 'slack', 'T123', 'U456', 't3_chris', 'Chris',
          'project-1', 'app-3', 'bot-3', 'connected',
          1, ${now}, ${now}
        )
      `);

        yield* sql`
        UPDATE slack_agent_instance
        SET project_id = 'project-retargeted'
        WHERE instance_id = 'inst-1'
      `;
        const rows = yield* sql<{ readonly projectId: string }>`
        SELECT project_id AS "projectId"
        FROM slack_agent_instance
        WHERE instance_id = 'inst-1'
      `;

        assert.equal(sameBotOtherProject._tag, "Failure");
        assert.equal(sameWorkspaceHandle._tag, "Failure");
        assert.equal(rows[0]?.projectId, "project-retargeted");
      }),
    ),
  );
});
