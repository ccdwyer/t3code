import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type SlackAgentInstanceView,
  type SlackAgentRunSummaryView,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { SlackAgentInstanceStore } from "../../workflow/Services/SlackAgentInstanceStore.ts";
import { SlackAgentRunStore } from "../../workflow/Services/SlackAgentRunStore.ts";
import { SlackApi, type SlackPostMessageInput } from "../Services/SlackApi.ts";
import { SlackChatReplyRelay } from "../Services/SlackChatReplyRelay.ts";
import { SlackChatReplyRelayLive } from "./SlackChatReplyRelay.ts";

const threadId = ThreadId.make("thread-slack-reply");
const messageId = MessageId.make("message-slack-reply");
const turnId = TurnId.make("turn-slack-reply");
const lateLinkedThreadId = ThreadId.make("thread-slack-reply-linked-late");
const lateLinkedMessageId = MessageId.make("message-slack-reply-linked-late");
const now = "2026-08-08T12:00:00.000Z";

const assistantEvent = (
  sequence: number,
  text: string,
  streaming: boolean,
  overrides?: {
    readonly threadId?: ThreadId;
    readonly messageId?: MessageId;
  },
): Extract<OrchestrationEvent, { type: "thread.message-sent" }> => ({
  sequence,
  eventId: EventId.make(`event-slack-reply-${sequence}`),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  aggregateKind: "thread",
  aggregateId: overrides?.threadId ?? threadId,
  occurredAt: now as never,
  type: "thread.message-sent",
  payload: {
    threadId: overrides?.threadId ?? threadId,
    messageId: overrides?.messageId ?? messageId,
    role: "assistant",
    text,
    turnId,
    streaming,
    createdAt: now as never,
    updatedAt: now as never,
  },
});

const linkedRun = {
  runId: "slackrun-linked",
  instanceId: "slackinst-linked",
  mode: "chat",
  threadId,
  thread: {
    workspaceId: "workspace-linked",
    channelId: "channel-linked",
    channelName: "mobile-dev",
    threadTs: "1234.000001",
  },
} as SlackAgentRunSummaryView;

const realInstance = {
  instanceId: linkedRun.instanceId,
  kind: "slack",
  enabled: true,
} as unknown as SlackAgentInstanceView;

it.effect("copies a completed T3 assistant response into its linked Slack thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const posted = yield* Ref.make<ReadonlyArray<SlackPostMessageInput>>([]);
      const responsePosted = yield* Deferred.make<void>();
      const unlinkedProcessed = yield* Deferred.make<void>();
      const lateLinkMissed = yield* Deferred.make<void>();
      const lateResponsePosted = yield* Deferred.make<void>();
      const lateRunAvailable = yield* Ref.make(false);

      const layer = SlackChatReplyRelayLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(OrchestrationEngineService, {
              readEvents: () => Stream.empty,
              dispatch: () => Effect.succeed({ sequence: 1 }),
              streamDomainEvents: Stream.fromQueue(events),
              latestSequence: Effect.succeed(0),
            }),
            Layer.succeed(SlackAgentRunStore, {
              findChatByThreadId: (candidateThreadId: ThreadId | string) =>
                String(candidateThreadId) === String(threadId)
                  ? Effect.succeed(linkedRun)
                  : String(candidateThreadId) === String(lateLinkedThreadId)
                    ? Ref.get(lateRunAvailable).pipe(
                        Effect.flatMap((available) =>
                          available
                            ? Effect.succeed({
                                ...linkedRun,
                                runId: "slackrun-linked-late" as never,
                                threadId: lateLinkedThreadId,
                              })
                            : Deferred.succeed(lateLinkMissed, undefined).pipe(Effect.as(null)),
                        ),
                      )
                    : Deferred.succeed(unlinkedProcessed, undefined).pipe(Effect.as(null)),
            } as unknown as SlackAgentRunStore["Service"]),
            Layer.succeed(SlackAgentInstanceStore, {
              get: () => Effect.succeed(realInstance),
              readCredentials: () =>
                Effect.succeed({ appToken: "xapp-test", botToken: "xoxb-test" }),
            } as unknown as SlackAgentInstanceStore["Service"]),
            Layer.succeed(SlackApi, {
              postMessage: (input: SlackPostMessageInput) =>
                Ref.update(posted, (calls) => [...calls, input]).pipe(
                  Effect.andThen(Deferred.succeed(responsePosted, undefined)),
                  Effect.andThen(
                    input.text === "Fast response."
                      ? Deferred.succeed(lateResponsePosted, undefined)
                      : Effect.void,
                  ),
                  Effect.as({ channelId: input.channelId, messageTs: "1234.000002" }),
                ),
            } as unknown as SlackApi["Service"]),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const relay = yield* SlackChatReplyRelay;
        yield* relay.start();
        yield* Queue.offer(events, assistantEvent(1, "Reviewed PR #2892. ", true));
        yield* Queue.offer(events, assistantEvent(2, "It looks correct.", true));
        yield* Queue.offer(events, assistantEvent(3, "", false));
        yield* Deferred.await(responsePosted).pipe(Effect.timeout("2 seconds"));

        assert.deepStrictEqual(yield* Ref.get(posted), [
          {
            botToken: "xoxb-test",
            channelId: "channel-linked",
            threadTs: "1234.000001",
            text: "Reviewed PR #2892. It looks correct.",
          },
        ]);

        yield* Queue.offer(events, assistantEvent(4, "", false));
        yield* Queue.offer(
          events,
          assistantEvent(5, "This thread is not linked to Slack.", false, {
            threadId: ThreadId.make("thread-not-linked"),
            messageId: MessageId.make("message-not-linked"),
          }),
        );
        yield* Deferred.await(unlinkedProcessed).pipe(Effect.timeout("2 seconds"));
        assert.equal((yield* Ref.get(posted)).length, 1);

        yield* Queue.offer(
          events,
          assistantEvent(6, "Fast response.", true, {
            threadId: lateLinkedThreadId,
            messageId: lateLinkedMessageId,
          }),
        );
        yield* Queue.offer(
          events,
          assistantEvent(7, "", false, {
            threadId: lateLinkedThreadId,
            messageId: lateLinkedMessageId,
          }),
        );
        yield* Deferred.await(lateLinkMissed).pipe(Effect.timeout("2 seconds"));
        yield* Ref.set(lateRunAvailable, true);
        yield* relay.notifyChatLinked(lateLinkedThreadId);
        yield* Deferred.await(lateResponsePosted).pipe(Effect.timeout("2 seconds"));
        assert.equal((yield* Ref.get(posted)).length, 2);
      }).pipe(Effect.provide(layer));
    }),
  ).pipe(TestClock.withLive),
);
