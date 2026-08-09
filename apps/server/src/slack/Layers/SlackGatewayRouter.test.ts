import { MOCK_SLACK_WORKSPACE_ID } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  MockSlackGateway,
  SlackAgentGateway,
  type MockSlackThreadView,
  type SlackAgentGatewayShape,
} from "../../workflow/Services/SlackAgentGateway.ts";
import type { SlackThreadSnapshotInput } from "../../workflow/slack/slackThreadSnapshot.ts";
import { RealSlackGateway } from "../Services/RealSlackGateway.ts";
import { SlackGatewayRouterLive } from "./SlackGatewayRouter.ts";

const snapshotInput = (workspaceId: string): SlackThreadSnapshotInput => ({
  workspaceId,
  channelId: "C123",
  channelName: "eng",
  threadTs: "1000.000000",
  triggerEventId: "event-1",
  triggerTs: "1000.000000",
  messages: [
    {
      messageId: "root",
      ts: "1000.000000",
      authorUserId: "U1",
      authorLabel: "Chris",
      text: "root",
    },
  ],
});

const threadView = (workspaceId: string): MockSlackThreadView => ({
  threadKey: `${workspaceId}:C123:1000.000000`,
  workspaceId,
  channelId: "C123",
  channelName: "eng",
  threadTs: "1000.000000",
  messages: [],
  statusReplies: {},
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeProvider = (label: "mock" | "real", calls: Array<string>): SlackAgentGatewayShape => ({
  snapshotThreadThroughTrigger: (input) =>
    Effect.sync(() => {
      calls.push(`${label}:snapshot:${input.workspaceId}`);
      return {
        ...input,
        triggerMessageId: input.messages[0]?.messageId ?? "missing",
        messages: [],
        canonicalJson: "{}",
        byteLength: 2,
      };
    }),
  postOrUpdateStatus: (input) =>
    Effect.sync(() => {
      calls.push(`${label}:status:${input.workspaceId}`);
      return {
        threadKey: `${input.workspaceId}:${input.channelId}:${input.threadTs}`,
        statusMessageId: `${label}-status`,
      };
    }),
  subscribeMockThread: (input) =>
    Effect.sync(() => {
      calls.push(`${label}:subscribe:${input.workspaceId}`);
      return label === "mock" ? threadView(input.workspaceId) : null;
    }),
  subscribeMockThreadChanges: (input) =>
    Effect.sync(() => {
      calls.push(`${label}:changes:${input.workspaceId}`);
      return label === "mock" ? Stream.make(threadView(input.workspaceId)) : Stream.empty;
    }),
});

const provideRouter =
  (calls: Array<string>) =>
  <A, E>(effect: Effect.Effect<A, E, SlackAgentGateway>) =>
    effect.pipe(
      Effect.provide(
        SlackGatewayRouterLive.pipe(
          Layer.provideMerge(Layer.succeed(MockSlackGateway, makeProvider("mock", calls))),
          Layer.provideMerge(Layer.succeed(RealSlackGateway, makeProvider("real", calls))),
        ),
      ),
    );

describe("SlackGatewayRouterLive", () => {
  it.effect("routes mock workspace calls to the mock provider", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const gateway = yield* SlackAgentGateway;
      const snapshot = yield* gateway.snapshotThreadThroughTrigger(
        snapshotInput(MOCK_SLACK_WORKSPACE_ID),
      );
      const status = yield* gateway.postOrUpdateStatus({
        workspaceId: MOCK_SLACK_WORKSPACE_ID,
        channelId: "C123",
        channelName: "eng",
        threadTs: "1000.000000",
        runId: "run-1",
        deliveryId: "delivery-1",
        text: "working",
      });

      assert.equal(snapshot.workspaceId, MOCK_SLACK_WORKSPACE_ID);
      assert.equal(status.statusMessageId, "mock-status");
      assert.deepStrictEqual(calls, ["mock:snapshot:mock", "mock:status:mock"]);
    }).pipe(provideRouter(calls), Effect.scoped);
  });

  it.effect("routes real workspace calls to the real provider", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const gateway = yield* SlackAgentGateway;
      const snapshot = yield* gateway.snapshotThreadThroughTrigger(snapshotInput("TREAL"));
      const status = yield* gateway.postOrUpdateStatus({
        workspaceId: "TREAL",
        channelId: "C123",
        channelName: "eng",
        threadTs: "1000.000000",
        runId: "run-1",
        deliveryId: "delivery-1",
        text: "working",
      });

      assert.equal(snapshot.workspaceId, "TREAL");
      assert.equal(status.statusMessageId, "real-status");
      assert.deepStrictEqual(calls, ["real:snapshot:TREAL", "real:status:TREAL"]);
    }).pipe(Effect.scoped, provideRouter(calls));
  });

  it.effect("keeps mock thread subscriptions on the mock provider only", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const gateway = yield* SlackAgentGateway;
      const initial = yield* gateway.subscribeMockThread({
        workspaceId: MOCK_SLACK_WORKSPACE_ID,
        channelId: "C123",
        threadTs: "1000.000000",
      });
      const mockChanges = yield* gateway.subscribeMockThreadChanges({
        workspaceId: MOCK_SLACK_WORKSPACE_ID,
        channelId: "C123",
        threadTs: "1000.000000",
      });
      const realInitial = yield* gateway.subscribeMockThread({
        workspaceId: "TREAL",
        channelId: "C123",
        threadTs: "1000.000000",
      });
      const realChanges = yield* gateway.subscribeMockThreadChanges({
        workspaceId: "TREAL",
        channelId: "C123",
        threadTs: "1000.000000",
      });

      const mockCollected = yield* mockChanges.pipe(Stream.take(1), Stream.runCollect);
      const realCollected = yield* realChanges.pipe(Stream.take(1), Stream.runCollect);

      assert.equal(initial?.workspaceId, MOCK_SLACK_WORKSPACE_ID);
      assert.equal(realInitial, null);
      assert.equal(Array.from(mockCollected).length, 1);
      assert.deepEqual(Array.from(realCollected), []);
      assert.deepStrictEqual(calls, [
        "mock:subscribe:mock",
        "mock:changes:mock",
        "real:subscribe:TREAL",
        "real:changes:TREAL",
      ]);
    }).pipe(Effect.scoped, provideRouter(calls));
  });
});
