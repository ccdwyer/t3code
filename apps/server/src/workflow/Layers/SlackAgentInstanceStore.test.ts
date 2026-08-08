import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { SlackAgentInstanceStore } from "../Services/SlackAgentInstanceStore.ts";
import { SlackAgentInstanceStoreLive } from "./SlackAgentInstanceStore.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";

const layer = it.layer(
  SlackAgentInstanceStoreLive.pipe(
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
        boardId: "board-1" as never,
        initialLane: "todo" as never,
      });

      assert.equal(instance.handle, "t3_chris");
      assert.equal(instance.enabled, true);
      assert.equal(instance.state, "enabled");
      assert.deepEqual(instance.target, {
        projectId: "project-1",
        boardId: "board-1",
        initialLane: "todo",
      });

      const listed = yield* store.list("workspace-1");
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.instanceId, instance.instanceId);
      assert.equal(
        (yield* store.getEnabledByBotUserId("workspace-1", instance.botUserId))?.handle,
        "t3_chris",
      );
    }),
  );

  it.effect("treats a t3-prefixed value as a literal suffix at the store boundary", () =>
    Effect.gen(function* () {
      const store = yield* SlackAgentInstanceStore;

      const instance = yield* store.create({
        workspaceId: "workspace-1",
        ownerLabel: "Chris",
        handleSuffix: "t3_",
        projectId: "project-1" as never,
        boardId: "board-1" as never,
        initialLane: "todo" as never,
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
        boardId: "board-1" as never,
        initialLane: "todo" as never,
      });

      const collision = yield* Effect.exit(
        store.create({
          workspaceId: "workspace-1",
          ownerLabel: "Theo",
          handleSuffix: "CASEY",
          projectId: "project-1" as never,
          boardId: "board-1" as never,
          initialLane: "todo" as never,
        }),
      );
      assert.equal(collision._tag, "Failure");

      const otherWorkspace = yield* store.create({
        workspaceId: "workspace-2",
        ownerLabel: "Theo",
        handleSuffix: "casey",
        projectId: "project-1" as never,
        boardId: "board-1" as never,
        initialLane: "todo" as never,
      });
      assert.equal(otherWorkspace.handle, "t3_casey");
    }),
  );

  it.effect("updates, disables, enables, and disables all instances for a board", () =>
    Effect.gen(function* () {
      const store = yield* SlackAgentInstanceStore;
      const first = yield* store.create({
        workspaceId: "workspace-1",
        ownerLabel: "Chris",
        handleSuffix: "update_chris",
        projectId: "project-1" as never,
        boardId: "board-1" as never,
        initialLane: "todo" as never,
      });
      const second = yield* store.create({
        workspaceId: "workspace-1",
        ownerLabel: "Julius",
        handleSuffix: "update_julius",
        projectId: "project-1" as never,
        boardId: "board-2" as never,
        initialLane: "todo" as never,
      });

      const updated = yield* store.update(first.instanceId, {
        ownerLabel: "Christopher",
        handleSuffix: "chris2",
        projectId: "project-2" as never,
        boardId: "board-1" as never,
        initialLane: "build" as never,
      });
      assert.equal(updated.handle, "t3_chris2");
      assert.equal(updated.ownerLabel, "Christopher");
      assert.equal(updated.target.projectId, "project-2");
      assert.equal(updated.target.initialLane, "build");

      const disabled = yield* store.disable(first.instanceId);
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.state, "disabled");
      assert.equal(yield* store.getEnabledByBotUserId("workspace-1", first.botUserId), null);

      const enabled = yield* store.enable(first.instanceId);
      assert.equal(enabled.enabled, true);

      yield* store.disableForBoard("board-1" as never);
      assert.equal((yield* store.get(first.instanceId))?.enabled, false);
      assert.equal((yield* store.get(second.instanceId))?.enabled, true);
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
        boardId: "board-1" as never,
        initialLane: "todo" as never,
      });

      yield* sql`
        INSERT INTO slack_agent_run (
          run_id, instance_id, external_event_id, workspace_id, channel_id, channel_name,
          thread_key, thread_ts, trigger_ts, snapshot_json, snapshot_sha256, snapshot_bytes,
          ticket_id, status, created_at, updated_at
        ) VALUES (
          'run-1', ${instance.instanceId}, 'event-1', 'workspace-1', 'channel-1', 'general',
          'thread-1', '1000.000001', '1000.000002', '{}', 'sha', 2,
          'ticket-1', 'accepted', ${now}, ${now}
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
