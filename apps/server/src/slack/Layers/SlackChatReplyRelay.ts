import type { OrchestrationEvent } from "@t3tools/contracts";
/* oxlint-disable unicorn/require-post-message-target-origin -- SlackApi.postMessage is the Slack Web API, not Window.postMessage. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { forkParked } from "../../serverActivation.ts";
import { makeKeyedSemaphore } from "../../utils/keyedSemaphore.ts";
import { SlackAgentInstanceStore } from "../../workflow/Services/SlackAgentInstanceStore.ts";
import { SlackAgentRunStore } from "../../workflow/Services/SlackAgentRunStore.ts";
import { SlackApi } from "../Services/SlackApi.ts";
import {
  SlackChatReplyRelay,
  type SlackChatReplyRelayShape,
} from "../Services/SlackChatReplyRelay.ts";

type AssistantMessageEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

interface PendingAssistantReply {
  readonly threadId: AssistantMessageEvent["payload"]["threadId"];
  readonly messageId: AssistantMessageEvent["payload"]["messageId"];
  readonly text: string;
  readonly complete: boolean;
}

const MAX_TRACKED_MESSAGES = 10_000;
const MAX_BUFFERED_MESSAGES = 1_000;
const MAX_SLACK_MESSAGE_CHARS = 35_000;

const isAssistantMessageEvent = (event: OrchestrationEvent): event is AssistantMessageEvent =>
  event.type === "thread.message-sent" && event.payload.role === "assistant";

const messageKey = (event: AssistantMessageEvent) =>
  `${String(event.payload.threadId)}\u0000${String(event.payload.messageId)}`;

const addBounded = (set: Set<string>, value: string, maximum: number) => {
  set.add(value);
  while (set.size > maximum) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
};

const setBounded = <A>(map: Map<string, A>, key: string, value: A, maximum: number) => {
  if (!map.has(key) && map.size >= maximum) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
};

export const splitSlackReply = (text: string): ReadonlyArray<string> => {
  if (text.length <= MAX_SLACK_MESSAGE_CHARS) return [text];

  const chunks: Array<string> = [];
  for (let offset = 0; offset < text.length; offset += MAX_SLACK_MESSAGE_CHARS) {
    chunks.push(text.slice(offset, offset + MAX_SLACK_MESSAGE_CHARS));
  }
  return chunks;
};

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const runs = yield* SlackAgentRunStore;
  const instances = yield* SlackAgentInstanceStore;
  const slackApi = yield* SlackApi;

  // The engine stream is hot and never replays old events. Keep completed
  // replies in memory until their Slack chat link is visible, then bound both
  // pending and delivered state so unrelated T3 chats cannot grow this reactor.
  const pending = new Map<string, PendingAssistantReply>();
  const delivered = new Set<string>();
  const deliveryLocks = yield* makeKeyedSemaphore;

  const attemptDelivery = Effect.fn("SlackChatReplyRelay.attemptDelivery")((key: string) =>
    deliveryLocks.withPermit(
      key,
      Effect.gen(function* () {
        if (delivered.has(key)) return;
        const reply = pending.get(key);
        if (reply === undefined || !reply.complete) return;

        const run = yield* runs.findChatByThreadId(reply.threadId);
        if (run === null) return;

        const instance = yield* instances.get(run.instanceId);
        if (instance === null || instance.kind !== "slack" || !instance.enabled) {
          pending.delete(key);
          return;
        }

        const credentials = yield* instances.readCredentials(run.instanceId);
        if (credentials === null) {
          pending.delete(key);
          yield* Effect.logWarning("Slack chat reply skipped because credentials are unavailable", {
            instanceId: run.instanceId,
            runId: run.runId,
            threadId: reply.threadId,
          });
          return;
        }

        yield* Effect.forEach(
          splitSlackReply(reply.text),
          (chunk) =>
            slackApi
              .postMessage({
                botToken: credentials.botToken,
                channelId: run.thread.channelId,
                threadTs: run.thread.threadTs,
                text: chunk,
              })
              .pipe(
                Effect.retry({
                  schedule: Schedule.exponential("500 millis"),
                  times: 2,
                }),
              ),
          { discard: true },
        );

        pending.delete(key);
        addBounded(delivered, key, MAX_TRACKED_MESSAGES);
      }),
    ),
  );

  const attemptDeliverySafely = (key: string) => {
    const reply = pending.get(key);
    if (reply === undefined) return Effect.void;

    return attemptDelivery(key).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Slack chat reply relay failed to deliver assistant message", {
          threadId: reply.threadId,
          messageId: reply.messageId,
          errorType: error._tag,
          detail: error.message,
        }),
      ),
      Effect.catchDefect(() =>
        Effect.logWarning("Slack chat reply relay encountered an unexpected delivery defect", {
          threadId: reply.threadId,
          messageId: reply.messageId,
        }),
      ),
    );
  };

  const processAssistantMessage = Effect.fn("SlackChatReplyRelay.processAssistantMessage")(
    function* (event: AssistantMessageEvent) {
      const key = messageKey(event);
      if (delivered.has(key)) return;

      if (event.payload.streaming) {
        const existing = pending.get(key);
        setBounded(
          pending,
          key,
          {
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            text: `${existing?.text ?? ""}${event.payload.text}`,
            complete: false,
          },
          MAX_BUFFERED_MESSAGES,
        );
        return;
      }

      const text =
        event.payload.text.length > 0 ? event.payload.text : (pending.get(key)?.text ?? "");
      if (text.trim().length === 0) {
        pending.delete(key);
        return;
      }

      setBounded(
        pending,
        key,
        {
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          text,
          complete: true,
        },
        MAX_BUFFERED_MESSAGES,
      );
      yield* attemptDeliverySafely(key);
    },
  );

  const processSafely = (event: OrchestrationEvent) => {
    if (!isAssistantMessageEvent(event)) return Effect.void;

    return processAssistantMessage(event).pipe(
      Effect.catchDefect(() =>
        Effect.logWarning("Slack chat reply relay encountered an unexpected defect", {
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
        }),
      ),
    );
  };

  const start: SlackChatReplyRelayShape["start"] = () =>
    forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, processSafely));

  const notifyChatLinked: SlackChatReplyRelayShape["notifyChatLinked"] = (threadId) =>
    Effect.forEach(
      [...pending.entries()],
      ([key, reply]) =>
        reply.complete && reply.threadId === threadId ? attemptDeliverySafely(key) : Effect.void,
      { discard: true },
    );

  return SlackChatReplyRelay.of({
    notifyChatLinked,
    start,
  });
});

export const SlackChatReplyRelayLive = Layer.effect(SlackChatReplyRelay, make);
