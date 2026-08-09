import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const withMemoryDb = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.mergeAll(NodeSqliteClient.layerMemory())));

describe("044_SlackAgentDefaultModelSelection", () => {
  it.effect("adds a nullable default model selection column to Slack identities", () =>
    withMemoryDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 43 });
        const now = "2026-08-09T00:00:00.000Z";
        yield* sql`
          INSERT INTO slack_agent_instance (
            instance_id, kind, workspace_id, bot_user_id, handle, owner_label,
            owner_principal, project_id, connection_state, enabled, created_at, updated_at
          ) VALUES (
            'inst-legacy', 'mock', 'mock', 'bot-legacy', 't3_legacy', 'Legacy',
            NULL, 'project-legacy', 'connected', 1, ${now}, ${now}
          )
        `;

        yield* runMigrations({ toMigrationInclusive: 44 });

        const rows = yield* sql<{
          readonly defaultModelSelection: string | null;
        }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM slack_agent_instance
          WHERE instance_id = 'inst-legacy'
        `;
        assert.equal(rows[0]?.defaultModelSelection, null);

        yield* sql`
          UPDATE slack_agent_instance
          SET default_model_selection_json = '{"instanceId":"codex","model":"gpt-5.5"}'
          WHERE instance_id = 'inst-legacy'
        `;
        yield* runMigrations({ toMigrationInclusive: 44 });
        const updated = yield* sql<{
          readonly defaultModelSelection: string | null;
        }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM slack_agent_instance
          WHERE instance_id = 'inst-legacy'
        `;
        assert.equal(updated[0]?.defaultModelSelection, '{"instanceId":"codex","model":"gpt-5.5"}');
      }),
    ),
  );
});
