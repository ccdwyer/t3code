import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface SlackChatWorktreeSweepResult {
  readonly enabled: boolean;
  readonly candidateCount: number;
  readonly removedCount: number;
  readonly dirtyCount: number;
  readonly inUseCount: number;
  readonly failedCount: number;
}

export interface SlackChatWorktreeJanitorShape {
  readonly sweep: () => Effect.Effect<SlackChatWorktreeSweepResult>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class SlackChatWorktreeJanitor extends Context.Service<
  SlackChatWorktreeJanitor,
  SlackChatWorktreeJanitorShape
>()("t3/slack/Services/SlackChatWorktreeJanitor") {}
