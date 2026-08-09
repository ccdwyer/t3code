import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  SlackAgentInstanceStore,
  type SlackAgentInstanceCredentials,
  type SlackAgentInstanceStoreShape,
} from "../../workflow/Services/SlackAgentInstanceStore.ts";
import { SlackAgentGatewayError } from "../../workflow/Services/SlackAgentGateway.ts";
import { SlackThreadSnapshotError } from "../../workflow/slack/slackThreadSnapshot.ts";
import {
  SlackApi,
  SlackApiError,
  type SlackApiShape,
  type SlackPostMessageInput,
  type SlackUpdateMessageInput,
} from "../Services/SlackApi.ts";
import { RealSlackGateway } from "../Services/RealSlackGateway.ts";
import { RealSlackGatewayLive } from "./RealSlackGateway.ts";

interface SlackCall {
  readonly type: "post" | "update";
  readonly botToken: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly text: string;
  readonly messageTs?: string | undefined;
}

const createRunTable = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE IF NOT EXISTS slack_agent_run (
        run_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('chat', 'workflow')),
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        trigger_ts TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL,
        snapshot_bytes INTEGER NOT NULL,
        t3_thread_id TEXT,
        ticket_id TEXT,
        status TEXT NOT NULL,
        status_message_id TEXT,
        pr_url TEXT,
        last_applied_sequence INTEGER NOT NULL DEFAULT -1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
  }),
);

const insertRun = (input: {
  readonly runId: string;
  readonly instanceId: string;
  readonly statusMessageId?: string | null | undefined;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO slack_agent_run (
        run_id,
        instance_id,
        external_event_id,
        mode,
        workspace_id,
        channel_id,
        channel_name,
        thread_key,
        thread_ts,
        trigger_ts,
        snapshot_json,
        snapshot_sha256,
        snapshot_bytes,
        t3_thread_id,
        ticket_id,
        status,
        status_message_id,
        pr_url,
        last_applied_sequence,
        created_at,
        updated_at
      ) VALUES (
        ${input.runId},
        ${input.instanceId},
        ${`event-${input.runId}`},
        'workflow',
        'TREAL',
        'C123',
        'eng',
        ${`TREAL:C123:${input.runId}`},
        '1000.000000',
        '1000.000000',
        '{}',
        'sha',
        2,
        NULL,
        ${`ticket-${input.runId}`},
        'running',
        ${input.statusMessageId ?? null},
        NULL,
        -1,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z'
      )
    `;
  });

const baseStatusInput = {
  workspaceId: "TREAL",
  channelId: "C123",
  channelName: "eng",
  threadTs: "1000.000000",
  deliveryId: "delivery-1",
  text: "working",
};

const baseSnapshotInput = {
  workspaceId: "TREAL",
  channelId: "C123",
  channelName: "eng",
  threadTs: "1000.000000",
  triggerEventId: "event-1",
  triggerTs: "1000.000002",
  messages: [
    {
      messageId: "root",
      ts: "1000.000000",
      authorUserId: "U1",
      authorLabel: "Chris",
      text: "root",
    },
    {
      messageId: "trigger",
      ts: "1000.000002",
      authorUserId: "U2",
      authorLabel: "Taylor",
      text: "@t3 fix it",
    },
  ],
};

const makeStore = (
  credentialsByInstance: ReadonlyMap<string, SlackAgentInstanceCredentials>,
): SlackAgentInstanceStoreShape =>
  ({
    create: () => Effect.die(new Error("unused create")),
    createMock: () => Effect.die(new Error("unused createMock")),
    createReal: () => Effect.die(new Error("unused createReal")),
    list: () => Effect.die(new Error("unused list")),
    get: () => Effect.die(new Error("unused get")),
    getEnabledByBotUserId: () => Effect.die(new Error("unused getEnabledByBotUserId")),
    readCredentials: (instanceId) =>
      Effect.succeed(credentialsByInstance.get(String(instanceId)) ?? null),
    replaceCredentials: () => Effect.die(new Error("unused replaceCredentials")),
    disconnect: () => Effect.die(new Error("unused disconnect")),
    updateConnectionState: () => Effect.die(new Error("unused updateConnectionState")),
    update: () => Effect.die(new Error("unused update")),
    disable: () => Effect.die(new Error("unused disable")),
    enable: () => Effect.die(new Error("unused enable")),
    delete: () => Effect.die(new Error("unused delete")),
  }) satisfies SlackAgentInstanceStoreShape;

const makeApi = (input: {
  readonly calls: Array<SlackCall>;
  readonly failWith?: SlackApiError | undefined;
}): SlackApiShape => ({
  validateCredentials: () => Effect.die(new Error("unused validateCredentials")),
  openSocket: () => Effect.die(new Error("unused openSocket")),
  fetchThreadThrough: () => Effect.die(new Error("unused fetchThreadThrough")),
  resolveChannelName: () => Effect.die(new Error("unused resolveChannelName")),
  resolveUserLabel: () => Effect.die(new Error("unused resolveUserLabel")),
  postMessage: (message: SlackPostMessageInput) =>
    input.failWith === undefined
      ? Effect.sync(() => {
          input.calls.push({ type: "post", ...message });
          return { channelId: message.channelId, messageTs: "1700.000001" };
        })
      : Effect.fail(input.failWith),
  updateMessage: (message: SlackUpdateMessageInput) =>
    input.failWith === undefined
      ? Effect.sync(() => {
          input.calls.push({ type: "update", ...message });
          return { channelId: message.channelId, messageTs: "1700.000002" };
        })
      : Effect.fail(input.failWith),
});

const provideRealGateway =
  (
    input: {
      readonly credentialsByInstance?:
        | ReadonlyMap<string, SlackAgentInstanceCredentials>
        | undefined;
      readonly calls?: Array<SlackCall> | undefined;
      readonly failWith?: SlackApiError | undefined;
    } = {},
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        RealSlackGatewayLive.pipe(
          Layer.provideMerge(createRunTable),
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provideMerge(
            Layer.succeed(
              SlackAgentInstanceStore,
              makeStore(input.credentialsByInstance ?? new Map()),
            ),
          ),
          Layer.provideMerge(
            Layer.succeed(
              SlackApi,
              makeApi({ calls: input.calls ?? [], failWith: input.failWith }),
            ),
          ),
        ),
      ),
    );

describe("RealSlackGatewayLive", () => {
  it.effect("posts an initial status with credentials for the run instance", () => {
    const calls: Array<SlackCall> = [];
    return Effect.gen(function* () {
      yield* insertRun({ runId: "run-1", instanceId: "inst-1" });
      const gateway = yield* RealSlackGateway;

      const result = yield* gateway.postOrUpdateStatus({
        ...baseStatusInput,
        runId: "run-1",
      });

      assert.deepStrictEqual(result, {
        threadKey: "TREAL:C123:1000.000000",
        statusMessageId: "1700.000001",
      });
      assert.deepStrictEqual(calls, [
        {
          type: "post",
          botToken: "xoxb-inst-1",
          channelId: "C123",
          threadTs: "1000.000000",
          text: "working",
        },
      ]);
    }).pipe(
      provideRealGateway({
        calls,
        credentialsByInstance: new Map([
          ["inst-1", { appToken: "xapp-inst-1", botToken: "xoxb-inst-1" }],
        ]),
      }),
    );
  });

  it.effect("updates an existing status when the run already has a Slack message ts", () => {
    const calls: Array<SlackCall> = [];
    return Effect.gen(function* () {
      yield* insertRun({
        runId: "run-2",
        instanceId: "inst-2",
        statusMessageId: "1700.000000",
      });
      const gateway = yield* RealSlackGateway;

      const result = yield* gateway.postOrUpdateStatus({
        ...baseStatusInput,
        runId: "run-2",
      });

      assert.equal(result.statusMessageId, "1700.000002");
      assert.deepStrictEqual(calls, [
        {
          type: "update",
          botToken: "xoxb-inst-2",
          channelId: "C123",
          threadTs: "1000.000000",
          text: "working",
          messageTs: "1700.000000",
        },
      ]);
    }).pipe(
      provideRealGateway({
        calls,
        credentialsByInstance: new Map([
          ["inst-2", { appToken: "xapp-inst-2", botToken: "xoxb-inst-2" }],
        ]),
      }),
    );
  });

  it.effect("posts a standalone message without replacing the run status", () => {
    const calls: Array<SlackCall> = [];
    return Effect.gen(function* () {
      yield* insertRun({
        runId: "run-standalone",
        instanceId: "inst-standalone",
        statusMessageId: "1700.000000",
      });
      const gateway = yield* RealSlackGateway;

      const result = yield* gateway.postOrUpdateStatus({
        ...baseStatusInput,
        runId: "run-standalone",
        forceNewMessage: true,
      });

      assert.equal(result.statusMessageId, "1700.000001");
      assert.deepStrictEqual(calls, [
        {
          type: "post",
          botToken: "xoxb-inst-standalone",
          channelId: "C123",
          threadTs: "1000.000000",
          text: "working",
        },
      ]);
    }).pipe(
      provideRealGateway({
        calls,
        credentialsByInstance: new Map([
          [
            "inst-standalone",
            { appToken: "xapp-inst-standalone", botToken: "xoxb-inst-standalone" },
          ],
        ]),
      }),
    );
  });

  it.effect("isolates credentials by the instance attached to the run", () => {
    const calls: Array<SlackCall> = [];
    return Effect.gen(function* () {
      yield* insertRun({ runId: "run-a", instanceId: "inst-a" });
      yield* insertRun({ runId: "run-b", instanceId: "inst-b" });
      const gateway = yield* RealSlackGateway;

      yield* gateway.postOrUpdateStatus({
        ...baseStatusInput,
        runId: "run-b",
      });

      assert.deepStrictEqual(
        calls.map((call) => call.botToken),
        ["xoxb-inst-b"],
      );
    }).pipe(
      provideRealGateway({
        calls,
        credentialsByInstance: new Map([
          ["inst-a", { appToken: "xapp-inst-a", botToken: "xoxb-inst-a" }],
          ["inst-b", { appToken: "xapp-inst-b", botToken: "xoxb-inst-b" }],
        ]),
      }),
    );
  });

  it.effect("fails with a typed gateway error when run credentials are missing", () =>
    Effect.gen(function* () {
      yield* insertRun({ runId: "run-missing", instanceId: "inst-missing" });
      const gateway = yield* RealSlackGateway;

      const error = yield* gateway
        .postOrUpdateStatus({
          ...baseStatusInput,
          runId: "run-missing",
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, SlackAgentGatewayError);
      assert.equal(error.message, "Slack credentials are missing for instance: inst-missing");
    }).pipe(provideRealGateway()),
  );

  it.effect("preserves Slack API retry hints without surfacing credentials", () =>
    Effect.gen(function* () {
      yield* insertRun({ runId: "run-retry", instanceId: "inst-retry" });
      const gateway = yield* RealSlackGateway;

      const error = yield* gateway
        .postOrUpdateStatus({
          ...baseStatusInput,
          runId: "run-retry",
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, SlackAgentGatewayError);
      assert.equal(error.retryAfterMs, 1234);
      assert.notInclude(error.message, "xoxb-inst-retry");
      assert.include(error.message, "[redacted-token]");
    }).pipe(
      provideRealGateway({
        credentialsByInstance: new Map([
          ["inst-retry", { appToken: "xapp-inst-retry", botToken: "xoxb-inst-retry" }],
        ]),
        failWith: new SlackApiError({
          operation: "SlackApi.postMessage",
          message: "Slack rate limited token xoxb-inst-retry.",
          retryAfterMs: 1234,
        }),
      }),
    ),
  );

  it.effect("builds snapshots from provided messages and applies snapshot limits", () =>
    Effect.gen(function* () {
      const gateway = yield* RealSlackGateway;
      const snapshot = yield* gateway.snapshotThreadThroughTrigger(baseSnapshotInput);
      assert.deepEqual(
        snapshot.messages.map((message) => message.messageId),
        ["root", "trigger"],
      );

      const error = yield* gateway
        .snapshotThreadThroughTrigger({
          ...baseSnapshotInput,
          maxMessages: 1,
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, SlackThreadSnapshotError);
      assert.equal(error.reason, "too_many_messages");
    }).pipe(provideRealGateway()),
  );

  it.effect("returns inert mock-thread subscriptions for real workspaces", () =>
    Effect.gen(function* () {
      const gateway = yield* RealSlackGateway;

      const thread = yield* gateway.subscribeMockThread({
        workspaceId: "TREAL",
        channelId: "C123",
        threadTs: "1000.000000",
      });
      const changes = yield* gateway.subscribeMockThreadChanges({
        workspaceId: "TREAL",
        channelId: "C123",
        threadTs: "1000.000000",
      });
      const collected = yield* changes.pipe(Stream.take(1), Stream.runCollect);

      assert.equal(thread, null);
      assert.deepEqual(Array.from(collected), []);
    }).pipe(provideRealGateway()),
  );
});
