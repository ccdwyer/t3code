import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SlackChatWorktreePromotion } from "../../../slack/Services/SlackChatWorktreePromotion.ts";
import { WorkspaceToolkit } from "./tools.ts";

export const WorkspaceToolkitHandlersLive = WorkspaceToolkit.toLayer({
  promote_slack_chat_worktree: () =>
    Effect.gen(function* () {
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const promotion = yield* SlackChatWorktreePromotion;
      return yield* promotion.promote(invocation.threadId);
    }),
});
