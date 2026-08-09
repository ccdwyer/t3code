import { assert, describe, it } from "@effect/vitest";
import {
  BoardId,
  LaneKey,
  type MockSlackMessageId,
  type ProjectId,
  type SlackAgentInstanceId,
  type SlackAgentInstanceView,
  type SlackAgentRunSummaryView,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  SlackAgentInstanceStore,
  type SlackAgentInstanceCredentials,
  type SlackAgentInstanceStoreShape,
} from "../../workflow/Services/SlackAgentInstanceStore.ts";
import {
  SlackAgentIntake,
  type SlackAgentIntakeResult,
  type SlackAgentIntakeShape,
  type SlackAgentMentionInput,
} from "../../workflow/Services/SlackAgentIntake.ts";
import {
  SlackAgentRunStore,
  SlackAgentRunStoreError,
  type SlackAgentRunStoreShape,
} from "../../workflow/Services/SlackAgentRunStore.ts";
import {
  SlackApi,
  SlackApiError,
  type SlackApiShape,
  type SlackSocketEnvelope,
} from "../Services/SlackApi.ts";
import { SlackEventProcessor, SlackEventProcessorError } from "../Services/SlackEventProcessor.ts";
import { SlackEventProcessorLive } from "./SlackEventProcessor.ts";

const instanceId = "slack-instance-1" as SlackAgentInstanceId;
const projectId = "project-1" as ProjectId;

const makeEnvelope = (event: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  ({
    envelopeId: "env-1",
    type: "events_api",
    acceptsResponsePayload: false,
    payload: {
      team_id: "T123",
      api_app_id: "A123",
      event_id: "Ev123",
      event,
      ...overrides,
    },
  }) satisfies SlackSocketEnvelope;

const appMentionEvent = (overrides: Record<string, unknown> = {}) => ({
  type: "app_mention",
  channel: "C123",
  ts: "1700000002.000002",
  thread_ts: "1700000001.000001",
  user: "U123",
  text: "<@U999> ship it",
  ...overrides,
});

const messageEvent = (overrides: Record<string, unknown> = {}) => ({
  type: "message",
  channel: "C123",
  ts: "1700000003.000003",
  thread_ts: "1700000001.000001",
  user: "U123",
  text: "follow-up text",
  ...overrides,
});

const realInstance = (overrides: Partial<SlackAgentInstanceView> = {}) =>
  ({
    instanceId,
    kind: "slack",
    workspace: { workspaceId: "T123", name: "Acme" },
    appId: "A123",
    botId: "B999",
    handle: "t3_chris",
    ownerLabel: "Chris",
    botUserId: "U999",
    target: { projectId },
    enabled: true,
    state: "enabled",
    validation: { valid: true },
    credentialsConfigured: true,
    connection: { state: "connected" },
    activeRunCount: 0,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  }) as SlackAgentInstanceView;

const runSummary = (mode: "chat" | "workflow" = "chat") =>
  ({
    runId: `run-${mode}`,
    mode,
    state: "connected",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...(mode === "chat" ? { threadId: "thread-1" } : { ticketId: "ticket-1" }),
  }) as SlackAgentRunSummaryView;

interface HarnessInput {
  readonly instance?: SlackAgentInstanceView | null | undefined;
  readonly credentials?: SlackAgentInstanceCredentials | null | undefined;
  readonly linkedRun?: SlackAgentRunSummaryView | null | undefined;
  readonly beforeReadCredentials?: Effect.Effect<void> | undefined;
  readonly findBySourceThread?: SlackAgentRunStoreShape["findBySourceThread"] | undefined;
  readonly findRootChatByChannel?: SlackAgentRunStoreShape["findRootChatByChannel"] | undefined;
  readonly slack?: Partial<SlackApiShape> | undefined;
  readonly intake?: Partial<SlackAgentIntakeShape> | undefined;
}

const unused = () => Effect.die(new Error("unused"));

const makeHarness = Effect.fn("makeHarness")(function* (input: HarnessInput = {}) {
  const accepted = yield* Ref.make<ReadonlyArray<SlackAgentMentionInput>>([]);
  const posted = yield* Ref.make<
    ReadonlyArray<{ readonly channelId: string; readonly threadTs: string; readonly text: string }>
  >([]);
  const fetchCount = yield* Ref.make(0);
  const credentialReadCount = yield* Ref.make(0);
  const sourceLookups = yield* Ref.make<
    ReadonlyArray<{
      readonly workspaceId: string;
      readonly channelId: string;
      readonly threadTs: string;
    }>
  >([]);

  const instanceStore: SlackAgentInstanceStoreShape = {
    create: () => unused(),
    createMock: () => unused(),
    createReal: () => unused(),
    list: () => Effect.succeed([]),
    get: () => Effect.succeed(input.instance === undefined ? realInstance() : input.instance),
    getEnabledByBotUserId: () => Effect.succeed(null),
    readCredentials: () =>
      Ref.update(credentialReadCount, (count) => count + 1).pipe(
        Effect.andThen(input.beforeReadCredentials ?? Effect.void),
        Effect.as(
          input.credentials === undefined
            ? { appToken: "xapp-secret", botToken: "xoxb-secret" }
            : input.credentials,
        ),
      ),
    replaceCredentials: () => unused(),
    disconnect: () => unused(),
    updateConnectionState: () => unused(),
    update: () => unused(),
    disable: () => unused(),
    enable: () => unused(),
    delete: () => Effect.void,
  };

  const runStore: SlackAgentRunStoreShape = {
    createRunWithAcceptedDelivery: () => unused(),
    getRun: () => Effect.succeed(null),
    getRunSummary: () => Effect.succeed(null),
    getRunByTicketId: () => Effect.succeed(null),
    getRunByDeliveryId: () => Effect.succeed(null),
    findByExternalEvent: () => Effect.succeed(null),
    findBySourceThread:
      input.findBySourceThread ??
      ((_instanceId, workspaceId, channelId, threadTs) =>
        Ref.update(sourceLookups, (items) => [...items, { workspaceId, channelId, threadTs }]).pipe(
          Effect.as(input.linkedRun ?? null),
        )),
    findRootChatByChannel:
      input.findRootChatByChannel ?? (() => Effect.succeed(input.linkedRun ?? null)),
    findChatByThreadId: () => Effect.succeed(null),
    relinkChatThread: () => unused(),
    reserveIngestedEvent: () => Effect.succeed(true),
    markIngestedEventDelivered: () => Effect.void,
    seedDeliveredIngestedEvents: () => Effect.void,
    enqueueDelivery: () => unused(),
    listDeliveries: () => Effect.succeed([]),
    markDeliverySent: () => Effect.void,
    markDeliveryFailed: () => Effect.void,
    markDeliverySuperseded: () => Effect.void,
    updateRunStatus: () => Effect.void,
    pruneRunlessMockThreads: () => Effect.succeed(0),
  };

  const intake: SlackAgentIntakeShape = {
    acceptMention:
      input.intake?.acceptMention ??
      ((acceptedInput) =>
        Ref.update(accepted, (items) => [...items, acceptedInput]).pipe(
          Effect.as({
            run: runSummary(acceptedInput.invocation?.mode === "workflow" ? "workflow" : "chat"),
            duplicate: false,
            statusMessageId: "status-1" as MockSlackMessageId,
            createdThread: acceptedInput.invocation?.mode !== "workflow",
          } satisfies SlackAgentIntakeResult),
        )),
  };

  const slack: SlackApiShape = {
    validateCredentials: () => unused(),
    openSocket: () => unused(),
    fetchThreadThrough:
      input.slack?.fetchThreadThrough ??
      ((request) =>
        Ref.update(fetchCount, (count) => count + 1).pipe(
          Effect.as({
            channelId: request.channelId,
            threadTs: request.threadTs,
            triggerTs: request.triggerTs,
            messages: [
              {
                messageId: "client-msg-1",
                ts: "1700000001.000001",
                authorUserId: "U111",
                authorLabel: "Ada",
                text: "root text",
                files: [],
              },
              {
                messageId: "client-msg-2",
                ts: "1700000002.000002",
                authorUserId: "U123",
                authorLabel: "Chris",
                text: "<@U999> ship it",
                files: [
                  {
                    id: "F123",
                    name: "trace.log",
                    mimetype: "text/plain",
                    size: 42,
                    permalink: "https://slack.test/files/F123",
                  },
                ],
              },
            ],
          }),
        )),
    resolveChannelName:
      input.slack?.resolveChannelName ??
      ((request) => Effect.succeed(`channel-${request.channelId}`)),
    resolveUserLabel:
      input.slack?.resolveUserLabel ?? ((request) => Effect.succeed(`user-${request.userId}`)),
    postMessage:
      input.slack?.postMessage ??
      ((request) =>
        Ref.update(posted, (items) => [
          ...items,
          { channelId: request.channelId, threadTs: request.threadTs, text: request.text },
        ]).pipe(Effect.as({ channelId: request.channelId, messageTs: "1700000004.000004" }))),
    updateMessage: () => unused(),
  };

  const layer = SlackEventProcessorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SlackAgentInstanceStore, instanceStore),
        Layer.succeed(SlackAgentRunStore, runStore),
        Layer.succeed(SlackAgentIntake, intake),
        Layer.succeed(SlackApi, slack),
      ),
    ),
  );

  const run = <A, E>(effect: Effect.Effect<A, E, SlackEventProcessor>) =>
    effect.pipe(Effect.provide(layer));

  return { accepted, posted, fetchCount, credentialReadCount, sourceLookups, run };
});

describe("SlackEventProcessorLive", () => {
  it.effect("fetches full context for an initial app mention", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(appMentionEvent()),
            workflowAuthorized: true,
          });
        }),
      );

      const accepted = yield* Ref.get(harness.accepted);
      assert.equal(accepted.length, 1);
      assert.equal(yield* Ref.get(harness.fetchCount), 1);
      assert.equal(accepted[0]?.thread.channelName, "channel-C123");
      assert.equal(accepted[0]?.externalEventId, "Ev123");
      assert.equal(accepted[0]?.trimSnapshotToFit, true);
      assert.deepStrictEqual(
        accepted[0]?.messages.map((message) => message.messageId),
        ["slack:T123:C123:1700000001.000001", "slack:T123:C123:1700000002.000002"],
      );
      assert.deepStrictEqual(accepted[0]?.messages[1]?.attachments, [
        {
          id: "F123",
          filename: "trace.log",
          mediaType: "text/plain",
          sizeBytes: 42,
          permalink: "https://slack.test/files/F123",
        },
      ]);
    }),
  );

  it.effect("accepts an untagged linked follow-up with only the triggering message", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ linkedRun: runSummary("chat") });
      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(messageEvent()),
            workflowAuthorized: true,
          });
        }),
      );

      const accepted = yield* Ref.get(harness.accepted);
      assert.equal(accepted.length, 1);
      assert.equal(yield* Ref.get(harness.fetchCount), 0);
      assert.equal(accepted[0]?.messages.length, 1);
      assert.equal(accepted[0]?.messages[0]?.text, "follow-up text");
      assert.equal(accepted[0]?.messages[0]?.authorLabel, "user-U123");
      assert.equal(accepted[0]?.workflowAuthorized, false);
    }),
  );

  it.effect("serializes initial mention linking before an immediate untagged reply", () =>
    Effect.gen(function* () {
      const firstEnteredIntake = yield* Deferred.make<void>();
      const releaseFirstIntake = yield* Deferred.make<void>();
      const firstLinked = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const credentialsReads = yield* Ref.make(0);
      const linkedRun = yield* Ref.make<SlackAgentRunSummaryView | null>(null);
      const order = yield* Ref.make<ReadonlyArray<string>>([]);

      const harness = yield* makeHarness({
        beforeReadCredentials: Ref.update(credentialsReads, (count) => count + 1),
        findBySourceThread: () => Ref.get(linkedRun),
        intake: {
          acceptMention: (acceptedInput) =>
            Effect.gen(function* () {
              yield* Ref.update(order, (items) => [...items, acceptedInput.externalEventId]);
              if (acceptedInput.externalEventId === "Ev-initial") {
                yield* Deferred.succeed(firstEnteredIntake, undefined);
                yield* Deferred.await(releaseFirstIntake);
                yield* Ref.set(linkedRun, runSummary("chat"));
                yield* Deferred.succeed(firstLinked, undefined);
              }
              return {
                run: runSummary("chat"),
                duplicate: false,
                statusMessageId: "status-1" as MockSlackMessageId,
                createdThread: true,
              } satisfies SlackAgentIntakeResult;
            }),
        },
      });

      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          const first = yield* Effect.forkChild(
            processor.process({
              instanceId,
              envelope: makeEnvelope(appMentionEvent(), { event_id: "Ev-initial" }),
              workflowAuthorized: true,
            }),
            { startImmediately: true },
          );

          yield* Deferred.await(firstEnteredIntake);

          const second = yield* Effect.forkChild(
            Effect.gen(function* () {
              yield* Deferred.succeed(secondStarted, undefined);
              yield* processor.process({
                instanceId,
                envelope: makeEnvelope(messageEvent(), { event_id: "Ev-reply" }),
                workflowAuthorized: true,
              });
            }),
            { startImmediately: true },
          );

          yield* Deferred.await(secondStarted);
          yield* Effect.yieldNow;
          assert.deepStrictEqual(yield* Ref.get(order), ["Ev-initial"]);
          assert.equal(yield* Ref.get(credentialsReads), 1);

          yield* Deferred.succeed(releaseFirstIntake, undefined);
          yield* Deferred.await(firstLinked);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
        }),
      );

      assert.deepStrictEqual(yield* Ref.get(order), ["Ev-initial", "Ev-reply"]);
    }),
  );

  it.effect("ignores unrelated public messages", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(messageEvent({ thread_ts: undefined, channel_type: "channel" })),
            workflowAuthorized: true,
          });
        }),
      );

      assert.equal((yield* Ref.get(harness.accepted)).length, 0);
      assert.equal((yield* Ref.get(harness.posted)).length, 0);
      assert.equal(yield* Ref.get(harness.credentialReadCount), 0);
    }),
  );

  it.effect("accepts a human DM as an initial chat event", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(
              messageEvent({ channel: "D123", thread_ts: undefined, channel_type: "im" }),
            ),
            workflowAuthorized: true,
          });
        }),
      );

      const accepted = yield* Ref.get(harness.accepted);
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0]?.thread.channelId, "D123");
      assert.equal(accepted[0]?.invocation, undefined);
    }),
  );

  it.effect("keeps sequential unthreaded DM messages in one linked chat", () =>
    Effect.gen(function* () {
      const rootLookups = yield* Ref.make(0);
      const linkedDmRun = {
        ...runSummary("chat"),
        thread: {
          workspaceId: "T123",
          channelId: "D123",
          channelName: "direct-message",
          threadTs: "1700000003.000003",
        },
      } as SlackAgentRunSummaryView;
      const harness = yield* makeHarness({
        findRootChatByChannel: () =>
          Ref.updateAndGet(rootLookups, (count) => count + 1).pipe(
            Effect.map((count) => (count === 1 ? null : linkedDmRun)),
          ),
      });

      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(
              messageEvent({ channel: "D123", thread_ts: undefined, channel_type: "im" }),
              { event_id: "Ev-dm-initial" },
            ),
            workflowAuthorized: true,
          });
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(
              messageEvent({
                channel: "D123",
                ts: "1700000004.000004",
                thread_ts: undefined,
                channel_type: "im",
                text: "second DM turn",
              }),
              { event_id: "Ev-dm-follow-up" },
            ),
            workflowAuthorized: true,
          });
        }),
      );

      const accepted = yield* Ref.get(harness.accepted);
      assert.equal(accepted.length, 2);
      assert.equal(accepted[0]?.thread.threadTs, "1700000003.000003");
      assert.equal(accepted[1]?.thread.threadTs, "1700000003.000003");
      assert.equal(accepted[1]?.messages.length, 1);
      assert.equal(accepted[1]?.messages[0]?.text, "second DM turn");
      assert.equal(yield* Ref.get(harness.fetchCount), 1);
    }),
  );

  it.effect("rejects workspace and app mismatches without intake", () =>
    Effect.gen(function* () {
      const workspaceHarness = yield* makeHarness();
      const workspaceExit = yield* workspaceHarness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(appMentionEvent(), { team_id: "T999" }),
            workflowAuthorized: true,
          });
        }).pipe(Effect.exit),
      );
      assert.equal(Exit.isFailure(workspaceExit), true);
      if (Exit.isFailure(workspaceExit)) {
        const error = Cause.squash(workspaceExit.cause);
        assert.instanceOf(error, SlackEventProcessorError);
        assert.equal(error.reason, "workspace_mismatch");
      }
      assert.equal((yield* Ref.get(workspaceHarness.accepted)).length, 0);

      const appHarness = yield* makeHarness();
      const appExit = yield* appHarness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(appMentionEvent(), { api_app_id: "A999" }),
            workflowAuthorized: true,
          });
        }).pipe(Effect.exit),
      );
      assert.equal(Exit.isFailure(appExit), true);
      if (Exit.isFailure(appExit)) {
        const error = Cause.squash(appExit.cause);
        assert.instanceOf(error, SlackEventProcessorError);
        assert.equal(error.reason, "app_mismatch");
      }
      assert.equal((yield* Ref.get(appHarness.accepted)).length, 0);
    }),
  );

  it.effect("defaults app mentions to chat when no workflow directive is present", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(appMentionEvent()),
            workflowAuthorized: true,
          });
        }),
      );

      const accepted = yield* Ref.get(harness.accepted);
      assert.equal(accepted[0]?.invocation, undefined);
      assert.equal(accepted[0]?.workflowAuthorized, false);
    }),
  );

  it.effect("passes chat project selectors from new app mentions", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(appMentionEvent({ text: "<@U999> project:beta ship it" })),
            workflowAuthorized: true,
          });
        }),
      );

      const accepted = yield* Ref.get(harness.accepted);
      assert.deepStrictEqual(accepted[0]?.invocation, {
        mode: "chat",
        projectSelector: "beta",
      });
      assert.equal(accepted[0]?.workflowAuthorized, false);
    }),
  );

  it.effect("passes chat project selectors from initial DMs", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(
              messageEvent({
                channel: "D123",
                thread_ts: undefined,
                channel_type: "im",
                text: "project:mobile please check this",
              }),
            ),
            workflowAuthorized: true,
          });
        }),
      );

      const accepted = yield* Ref.get(harness.accepted);
      assert.deepStrictEqual(accepted[0]?.invocation, {
        mode: "chat",
        projectSelector: "mobile",
      });
    }),
  );

  it.effect("passes explicit workflow invocation only from a new app mention", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(
              appMentionEvent({ text: "<@U999> workflow board:board-1 lane:triage project:beta" }),
            ),
            workflowAuthorized: true,
          });
        }),
      );

      const accepted = yield* Ref.get(harness.accepted);
      assert.deepStrictEqual(accepted[0]?.invocation, {
        mode: "workflow",
        projectSelector: "beta",
        target: { boardId: BoardId.make("board-1"), initialLane: LaneKey.make("triage") },
      });
      assert.equal(accepted[0]?.workflowAuthorized, true);
    }),
  );

  it.effect("ignores selector changes on linked follow-ups", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ linkedRun: runSummary("chat") });
      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(messageEvent({ text: "project:beta route somewhere else" })),
            workflowAuthorized: true,
          });
        }),
      );

      const accepted = yield* Ref.get(harness.accepted);
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0]?.invocation, undefined);
      assert.equal(accepted[0]?.messages[0]?.text, "project:beta route somewhere else");
    }),
  );

  it.effect("keeps chat available while withholding workflow authorization", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(
              appMentionEvent({ text: "<@U999> workflow board:board-1 lane:triage" }),
            ),
            workflowAuthorized: false,
          });
        }),
      );

      const accepted = yield* Ref.get(harness.accepted);
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0]?.invocation?.mode, "workflow");
      assert.equal(accepted[0]?.workflowAuthorized, false);
    }),
  );

  it.effect("ignores self and bot-loop events", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ linkedRun: runSummary("chat") });
      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(messageEvent({ user: "U999" })),
            workflowAuthorized: true,
          });
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(messageEvent({ user: undefined, bot_id: "B999" })),
            workflowAuthorized: true,
          });
        }),
      );

      assert.equal((yield* Ref.get(harness.accepted)).length, 0);
      assert.equal((yield* Ref.get(harness.posted)).length, 0);
    }),
  );

  it.effect("falls back to Slack ids when channel or user label resolution fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        linkedRun: runSummary("workflow"),
        slack: {
          resolveChannelName: () =>
            Effect.fail(new SlackApiError({ operation: "resolve", message: "xoxb-secret leaked" })),
          resolveUserLabel: () =>
            Effect.fail(
              new SlackApiError({
                operation: "resolve",
                message: "authorization: bearer xoxb-secret leaked",
              }),
            ),
        },
      });
      yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(messageEvent()),
            workflowAuthorized: true,
          });
        }),
      );

      const accepted = yield* Ref.get(harness.accepted);
      assert.equal(accepted[0]?.thread.channelName, "C123");
      assert.equal(accepted[0]?.messages[0]?.authorLabel, "U123");
      assert.equal(accepted[0]?.workflowAuthorized, true);
      assert.equal(accepted[0]?.invocation, undefined);
    }),
  );

  it.effect("posts a concise safe failure reply when an accepted human request fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        intake: {
          acceptMention: () =>
            Effect.fail(
              new SlackAgentRunStoreError({
                message: "xoxb-secret authorization: bearer xoxb-secret",
              }),
            ),
        },
      });
      const exit = yield* harness.run(
        Effect.gen(function* () {
          const processor = yield* SlackEventProcessor;
          yield* processor.process({
            instanceId,
            envelope: makeEnvelope(appMentionEvent()),
            workflowAuthorized: true,
          });
        }).pipe(Effect.exit),
      );

      assert.equal(Exit.isFailure(exit), true);
      const posted = yield* Ref.get(harness.posted);
      assert.equal(posted.length, 1);
      assert.equal(posted[0]?.channelId, "C123");
      assert.equal(posted[0]?.threadTs, "1700000001.000001");
      assert.notInclude(posted[0]?.text ?? "", "xoxb-");
      assert.notInclude(posted[0]?.text ?? "", "authorization");
    }),
  );
});
