import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface SlackChatWorktreeCoordinatorShape {
  readonly withPermit: <A, E, R>(
    threadId: ThreadId | string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export class SlackChatWorktreeCoordinator extends Context.Service<
  SlackChatWorktreeCoordinator,
  SlackChatWorktreeCoordinatorShape
>()("t3/slack/Services/SlackChatWorktreeCoordinator") {}
