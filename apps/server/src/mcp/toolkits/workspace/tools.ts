import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  SlackChatWorktreePromotion,
  SlackChatWorktreePromotionError,
  SlackChatWorktreePromotionResult,
} from "../../../slack/Services/SlackChatWorktreePromotion.ts";

export const PromoteSlackChatWorktreeTool = Tool.make("promote_slack_chat_worktree", {
  description:
    "Promote this Slack-linked T3 chat into an isolated git worktree before editing files, running mutating commands, or committing. T3 creates the checkout from the latest fetched default branch of the primary remote, or rehydrates the chat's existing durable branch. Call this only when the current Slack request requires workspace changes; it is safe to call repeatedly. If the result says continuationScheduled=true, stop the current response without editing because T3 will continue automatically in the promoted checkout. If continuationScheduled=false, the current session is already in the worktree and you should continue the request normally.",
  parameters: Schema.Struct({}),
  success: SlackChatWorktreePromotionResult,
  failure: SlackChatWorktreePromotionError,
  dependencies: [McpInvocationContext.McpInvocationContext, SlackChatWorktreePromotion],
})
  .annotate(Tool.Title, "Promote Slack chat to worktree")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const WorkspaceToolkit = Toolkit.make(PromoteSlackChatWorktreeTool);
