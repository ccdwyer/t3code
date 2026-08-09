import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { SlackAgentInstanceStore } from "../Services/SlackAgentInstanceStore.ts";
import { SlackAgentInstanceStoreLive } from "./SlackAgentInstanceStore.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";

const makeInMemorySecretStore = () => {
  const store = new Map<string, Uint8Array>();
  const layer = Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) => Effect.succeed(Option.fromNullishOr(store.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        store.set(name, value);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        store.set(name, value);
      }),
    getOrCreateRandom: () => Effect.die("not needed in test"),
    remove: (name) =>
      Effect.sync(() => {
        store.delete(name);
      }),
  } satisfies ServerSecretStore.ServerSecretStore["Service"]);
  return { layer, store };
};

const buildTestLayer = () => {
  const { layer: secretStoreLayer, store } = makeInMemorySecretStore();
  return {
    layer: SlackAgentInstanceStoreLive.pipe(
      Layer.provide(secretStoreLayer),
      Layer.provide(DeterministicWorkflowIds),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
    secretStore: store,
  };
};

const layer = it.layer(
  SlackAgentInstanceStoreLive.pipe(
    Layer.provide(makeInMemorySecretStore().layer),
    Layer.provide(DeterministicWorkflowIds),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("SlackAgentInstanceStore", (it) => {
  it.effect("creates normalized instances and lists contract-shaped views", () =>
    Effect.gen(function* () {
      const store = yield* SlackAgentInstanceStore;

      const instance = yield* store.create({
        workspaceId: "workspace-1",
        ownerLabel: "Chris",
        handleSuffix: "Chris",
        projectId: "project-1" as never,
        defaultModelSelection: {
          instanceId: "codex" as never,
          model: "gpt-5.5" as never,
        },
      });

      assert.equal(instance.handle, "t3_chris");
      assert.equal(instance.kind, "mock");
      assert.equal(instance.workspace.workspaceId, "workspace-1");
      assert.equal(instance.enabled, true);
      assert.equal(instance.state, "enabled");
      assert.equal(instance.credentialsConfigured, false);
      assert.equal(instance.connection.state, "connected");
      assert.equal(String(instance.target.projectId), "project-1");
      assert.deepEqual(instance.defaultModelSelection, {
        instanceId: "codex" as never,
        model: "gpt-5.5",
      });
      assert.deepEqual(
        instance.target.projects?.map(({ projectId, selector }) => ({
          projectId: String(projectId),
          selector: String(selector),
        })),
        [{ projectId: "project-1", selector: "project" }],
      );
      assert.notProperty(instance, "appToken");
      assert.notProperty(instance, "botToken");

      const listed = yield* store.list("workspace-1");
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.instanceId, instance.instanceId);
      assert.deepEqual(listed[0]?.defaultModelSelection, {
        instanceId: "codex" as never,
        model: "gpt-5.5",
      });
      assert.equal(
        (yield* store.getEnabledByBotUserId("workspace-1", instance.botUserId))?.handle,
        "t3_chris",
      );
    }),
  );

  it.effect("creates and atomically replaces multi-project bindings", () =>
    Effect.gen(function* () {
      const store = yield* SlackAgentInstanceStore;
      const instance = yield* store.create({
        workspaceId: "workspace-1",
        ownerLabel: "Chris",
        handleSuffix: "multi_chris",
        projectId: "project-1" as never,
        projects: [
          { projectId: "project-1" as never, selector: "one" as never },
          { projectId: "project-2" as never, selector: "two" as never },
          { projectId: "project-3" as never, selector: "three" as never },
        ],
      });

      assert.deepEqual(
        (instance.target.projects ?? [])
          .map(({ projectId, selector }) => ({
            projectId: String(projectId),
            selector: String(selector),
          }))
          .sort((a, b) => a.projectId.localeCompare(b.projectId)),
        [
          { projectId: "project-1", selector: "one" },
          { projectId: "project-2", selector: "two" },
          { projectId: "project-3", selector: "three" },
        ],
      );

      const updated = yield* store.update(instance.instanceId, {
        projectId: "project-4" as never,
        projects: [{ projectId: "project-5" as never, selector: "five" as never }],
      });

      assert.deepEqual(
        updated.target.projects?.map(({ projectId, selector }) => ({
          projectId: String(projectId),
          selector: String(selector),
        })),
        [
          { projectId: "project-4", selector: "project" },
          { projectId: "project-5", selector: "five" },
        ],
      );

      const duplicateSelector = yield* Effect.exit(
        store.update(instance.instanceId, {
          projects: [
            { projectId: "project-6" as never, selector: "dup" as never },
            { projectId: "project-7" as never, selector: "dup" as never },
          ],
        }),
      );
      assert.equal(duplicateSelector._tag, "Failure");
      assert.deepEqual(
        (yield* store.get(instance.instanceId))?.target.projects?.map(
          ({ projectId, selector }) => ({
            projectId: String(projectId),
            selector: String(selector),
          }),
        ),
        [
          { projectId: "project-4", selector: "project" },
          { projectId: "project-5", selector: "five" },
        ],
      );
    }),
  );

  it.effect("uses a schema-valid fallback selector for legacy-shaped project ids", () =>
    Effect.gen(function* () {
      const store = yield* SlackAgentInstanceStore;
      const sql = yield* SqlClient.SqlClient;
      const instance = yield* store.create({
        workspaceId: "workspace-1",
        ownerLabel: "Legacy",
        handleSuffix: "legacy_project",
        projectId: "Legacy Project.ID" as never,
      });

      assert.deepEqual(
        instance.target.projects?.map(({ projectId, selector }) => ({
          projectId: String(projectId),
          selector: String(selector),
        })),
        [{ projectId: "Legacy Project.ID", selector: "project" }],
      );

      yield* sql`
        UPDATE slack_agent_instance_project
        SET selector = 'Legacy Project.ID'
        WHERE instance_id = ${instance.instanceId}
      `;
      assert.deepEqual(
        (yield* store.get(instance.instanceId))?.target.projects?.map(
          ({ projectId, selector }) => ({
            projectId: String(projectId),
            selector: String(selector),
          }),
        ),
        [{ projectId: "Legacy Project.ID", selector: "project" }],
      );

      const updated = yield* store.update(instance.instanceId, {
        projectId: "Another Legacy.ID" as never,
      });
      assert.deepEqual(
        updated.target.projects?.map(({ projectId, selector }) => ({
          projectId: String(projectId),
          selector: String(selector),
        })),
        [{ projectId: "Another Legacy.ID", selector: "project" }],
      );
    }),
  );

  it.effect("creates real Slack instances while storing tokens only in ServerSecretStore", () => {
    const { layer } = buildTestLayer();
    return Effect.gen(function* () {
      const store = yield* SlackAgentInstanceStore;
      const sql = yield* SqlClient.SqlClient;

      const instance = yield* store.createReal({
        identity: {
          workspaceId: "T123",
          workspaceName: "T3",
          appId: "A123",
          botId: "B123",
          botUserId: "U123",
          handle: "t3_chris",
        },
        ownerLabel: "Chris",
        projectId: "project-1" as never,
        appToken: "xapp-real",
        botToken: "xoxb-real",
      });

      assert.equal(instance.kind, "slack");
      assert.equal(instance.workspace.workspaceId, "T123");
      assert.equal(instance.workspace.name, "T3");
      assert.equal(instance.appId, "A123");
      assert.equal(instance.botId, "B123");
      assert.equal(instance.credentialsConfigured, true);
      assert.equal(instance.connection.state, "connecting");
      assert.notProperty(instance, "appToken");
      assert.notProperty(instance, "botToken");

      assert.deepEqual(yield* store.readCredentials(instance.instanceId), {
        appToken: "xapp-real",
        botToken: "xoxb-real",
      });

      const rows = yield* sql<{
        readonly appSecret: string | null;
        readonly botSecret: string | null;
      }>`
        SELECT
          app_token_secret_name AS "appSecret",
          bot_token_secret_name AS "botSecret"
        FROM slack_agent_instance
        WHERE instance_id = ${instance.instanceId}
      `;
      assert.notEqual(rows[0]?.appSecret, "xapp-real");
      assert.notEqual(rows[0]?.botSecret, "xoxb-real");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "replaces credentials, records connection errors, and disconnects without deleting history",
    () => {
      const { layer } = buildTestLayer();
      return Effect.gen(function* () {
        const store = yield* SlackAgentInstanceStore;
        const sql = yield* SqlClient.SqlClient;
        const instance = yield* store.createReal({
          identity: {
            workspaceId: "T456",
            workspaceName: "T3",
            appId: "A456",
            botId: "B456",
            botUserId: "U456",
            handle: "t3_julius",
          },
          ownerLabel: "Julius",
          projectId: "project-1" as never,
          appToken: "xapp-old",
          botToken: "xoxb-old",
        });

        const reconnecting = yield* store.replaceCredentials(instance.instanceId, {
          appToken: "xapp-new",
          botToken: "xoxb-new",
        });
        assert.equal(reconnecting.credentialsConfigured, true);
        assert.equal(reconnecting.connection.state, "connecting");
        assert.deepEqual(yield* store.readCredentials(instance.instanceId), {
          appToken: "xapp-new",
          botToken: "xoxb-new",
        });

        const failed = yield* store.updateConnectionState(instance.instanceId, {
          state: "error",
          lastError: "x".repeat(600),
        });
        assert.equal(failed.connection.state, "error");
        assert.equal(failed.connection.lastError?.length, 500);

        const disconnected = yield* store.disconnect(instance.instanceId);
        assert.equal(disconnected.credentialsConfigured, false);
        assert.equal(disconnected.connection.state, "disconnected");
        assert.equal(disconnected.connection.connectedAt, undefined);
        assert.equal(yield* store.readCredentials(instance.instanceId), null);
        const refs = yield* sql<{
          readonly appSecret: string | null;
          readonly botSecret: string | null;
        }>`
        SELECT
          app_token_secret_name AS "appSecret",
          bot_token_secret_name AS "botSecret"
        FROM slack_agent_instance
        WHERE instance_id = ${instance.instanceId}
      `;
        assert.deepEqual(refs[0], { appSecret: null, botSecret: null });
        assert.equal((yield* store.get(instance.instanceId))?.instanceId, instance.instanceId);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("treats a t3-prefixed value as a literal suffix at the store boundary", () =>
    Effect.gen(function* () {
      const store = yield* SlackAgentInstanceStore;

      const instance = yield* store.create({
        workspaceId: "workspace-1",
        ownerLabel: "Chris",
        handleSuffix: "t3_",
        projectId: "project-1" as never,
      });

      assert.equal(instance.handle, "t3_t3_");
    }),
  );

  it.effect("rejects case-insensitive handle collisions in one workspace", () =>
    Effect.gen(function* () {
      const store = yield* SlackAgentInstanceStore;
      yield* store.create({
        workspaceId: "workspace-1",
        ownerLabel: "Casey",
        handleSuffix: "casey",
        projectId: "project-1" as never,
      });

      const collision = yield* Effect.exit(
        store.create({
          workspaceId: "workspace-1",
          ownerLabel: "Theo",
          handleSuffix: "CASEY",
          projectId: "project-1" as never,
        }),
      );
      assert.equal(collision._tag, "Failure");

      const otherWorkspace = yield* store.create({
        workspaceId: "workspace-2",
        ownerLabel: "Theo",
        handleSuffix: "casey",
        projectId: "project-1" as never,
      });
      assert.equal(otherWorkspace.handle, "t3_casey");
    }),
  );

  it.effect("updates, disables, and enables instances", () =>
    Effect.gen(function* () {
      const store = yield* SlackAgentInstanceStore;
      const first = yield* store.create({
        workspaceId: "workspace-1",
        ownerLabel: "Chris",
        handleSuffix: "update_chris",
        projectId: "project-1" as never,
        defaultModelSelection: {
          instanceId: "codex" as never,
          model: "gpt-5.5" as never,
        },
      });

      const updated = yield* store.update(first.instanceId, {
        ownerLabel: "Christopher",
        handleSuffix: "chris2",
        projectId: "project-2" as never,
      });
      assert.equal(updated.handle, "t3_chris2");
      assert.equal(updated.ownerLabel, "Christopher");
      assert.equal(updated.target.projectId, "project-2");
      assert.deepEqual(updated.defaultModelSelection, {
        instanceId: "codex" as never,
        model: "gpt-5.5",
      });

      const selected = yield* store.update(first.instanceId, {
        defaultModelSelection: {
          instanceId: "claude" as never,
          model: "opus-5" as never,
        },
      });
      assert.deepEqual(selected.defaultModelSelection, {
        instanceId: "claude" as never,
        model: "opus-5",
      });

      const cleared = yield* store.update(first.instanceId, {
        defaultModelSelection: null,
      });
      assert.equal(cleared.defaultModelSelection, null);

      const disabled = yield* store.disable(first.instanceId);
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.state, "disabled");
      assert.equal(yield* store.getEnabledByBotUserId("workspace-1", first.botUserId), null);

      const enabled = yield* store.enable(first.instanceId);
      assert.equal(enabled.enabled, true);
    }),
  );

  it.effect("counts active workflow runs and maps latest chat run metadata", () =>
    Effect.gen(function* () {
      const store = yield* SlackAgentInstanceStore;
      const sql = yield* SqlClient.SqlClient;
      const instance = yield* store.create({
        workspaceId: "workspace-1",
        ownerLabel: "Chris",
        handleSuffix: "latest_chris",
        projectId: "project-1" as never,
      });

      yield* sql`
        INSERT INTO slack_agent_run (
          run_id, instance_id, external_event_id, mode, workspace_id, channel_id, channel_name,
          thread_key, thread_ts, trigger_ts, snapshot_json, snapshot_sha256, snapshot_bytes,
          ticket_id, status, created_at, updated_at
        ) VALUES (
          'run-workflow', ${instance.instanceId}, 'event-workflow', 'workflow', 'workspace-1', 'channel-1', 'general',
          'thread-workflow', '1000.000001', '1000.000002', '{}', 'sha', 2,
          'ticket-workflow', 'running', '2026-08-07T00:00:00.000Z', '2026-08-07T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO slack_agent_run (
          run_id, instance_id, external_event_id, mode, workspace_id, channel_id, channel_name,
          thread_key, thread_ts, trigger_ts, snapshot_json, snapshot_sha256, snapshot_bytes,
          t3_thread_id, status, created_at, updated_at
        ) VALUES (
          'run-chat', ${instance.instanceId}, 'event-chat', 'chat', 'workspace-1', 'channel-1', 'general',
          'thread-chat', '1001.000001', '1001.000002', '{}', 'sha', 2,
          'thread-chat', 'connected', '2026-08-07T00:00:00.000Z', '2026-08-07T00:01:00.000Z'
        )
      `;

      const view = yield* store.get(instance.instanceId);
      assert.equal(view?.activeRunCount, 1);
      assert.equal(view?.latestRun?.mode, "chat");
      assert.equal(view?.latestRun?.threadId, "thread-chat");
      assert.notProperty(view?.latestRun ?? {}, "ticketId");
    }),
  );

  it.effect("refuses hard delete while runs exist and allows it after cleanup", () =>
    Effect.gen(function* () {
      const store = yield* SlackAgentInstanceStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-07T00:00:00.000Z";
      const instance = yield* store.create({
        workspaceId: "workspace-1",
        ownerLabel: "Chris",
        handleSuffix: "delete_chris",
        projectId: "project-1" as never,
      });

      yield* sql`
        INSERT INTO slack_agent_run (
          run_id, instance_id, external_event_id, workspace_id, channel_id, channel_name,
          thread_key, thread_ts, trigger_ts, snapshot_json, snapshot_sha256, snapshot_bytes,
          mode, ticket_id, status, created_at, updated_at
        ) VALUES (
          'run-1', ${instance.instanceId}, 'event-1', 'workspace-1', 'channel-1', 'general',
          'thread-1', '1000.000001', '1000.000002', '{}', 'sha', 2,
          'workflow', 'ticket-1', 'accepted', ${now}, ${now}
        )
      `;

      const blocked = yield* Effect.exit(store.delete(instance.instanceId));
      assert.equal(blocked._tag, "Failure");

      yield* sql`DELETE FROM slack_agent_run WHERE run_id = 'run-1'`;
      yield* store.delete(instance.instanceId);
      assert.equal(yield* store.get(instance.instanceId), null);
    }),
  );
});
