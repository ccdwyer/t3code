import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface SlackChatReplyRelayShape {
  /** Flushes completed replies that arrived before their Slack chat link committed. */
  readonly notifyChatLinked: (threadId: ThreadId) => Effect.Effect<void>;

  /** Starts relaying completed assistant messages from linked T3 chats to Slack. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class SlackChatReplyRelay extends Context.Service<
  SlackChatReplyRelay,
  SlackChatReplyRelayShape
>()("t3/slack/Services/SlackChatReplyRelay") {}
