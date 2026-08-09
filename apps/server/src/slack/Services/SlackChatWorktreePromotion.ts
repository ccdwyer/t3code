import type { ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const SlackChatWorktreePromotionResult = Schema.Struct({
  threadId: Schema.String,
  state: Schema.Literals(["existing", "prepared", "rehydrated"]),
  branch: Schema.String,
  worktreePath: Schema.String,
  baseBranch: Schema.NullOr(Schema.String),
  continuationScheduled: Schema.Boolean,
});
export type SlackChatWorktreePromotionResult = typeof SlackChatWorktreePromotionResult.Type;

export class SlackChatWorktreePromotionUnavailableError extends Schema.TaggedErrorClass<SlackChatWorktreePromotionUnavailableError>()(
  "SlackChatWorktreePromotionUnavailableError",
  {
    threadId: Schema.String,
    reason: Schema.Literals([
      "not-slack-chat",
      "thread-not-found",
      "thread-deleted",
      "project-not-found",
    ]),
    message: Schema.String,
  },
) {}

export class SlackChatWorktreePromotionOperationError extends Schema.TaggedErrorClass<SlackChatWorktreePromotionOperationError>()(
  "SlackChatWorktreePromotionOperationError",
  {
    threadId: Schema.String,
    operation: Schema.Literals([
      "load-slack-chat",
      "load-thread",
      "load-project",
      "prepare-worktree",
      "update-thread",
      "continue-turn",
    ]),
    message: Schema.String,
  },
) {}

export const SlackChatWorktreePromotionError = Schema.Union([
  SlackChatWorktreePromotionUnavailableError,
  SlackChatWorktreePromotionOperationError,
]);
export type SlackChatWorktreePromotionError = typeof SlackChatWorktreePromotionError.Type;

export interface SlackChatWorktreePromotionShape {
  readonly promote: (
    threadId: ThreadId,
  ) => Effect.Effect<SlackChatWorktreePromotionResult, SlackChatWorktreePromotionError>;
  readonly settleTurn: (
    threadId: ThreadId,
    end:
      | { readonly type: "completed" | "aborted"; readonly turnId: TurnId }
      | { readonly type: "session-exited" },
  ) => Effect.Effect<void>;
}

export class SlackChatWorktreePromotion extends Context.Service<
  SlackChatWorktreePromotion,
  SlackChatWorktreePromotionShape
>()("t3/slack/Services/SlackChatWorktreePromotion") {}
