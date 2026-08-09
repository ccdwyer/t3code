import type { CommandId, MessageId, ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface SlackChatBridgeDeliverInput {
  readonly projectId: ProjectId;
  /** Optional Slack identity override used only when creating a new T3 chat thread. */
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  readonly threadId: ThreadId;
  readonly createThreadCommandId: CommandId;
  readonly unarchiveThreadCommandId: CommandId;
  readonly startTurnCommandId: CommandId;
  readonly messageId: MessageId;
  readonly title: string;
  readonly text: string;
  /** New-message text used only after the linked thread already has a durable first turn. */
  readonly existingThreadText?: string | undefined;
}

export interface SlackChatBridgeDeliverResult {
  readonly threadId: ThreadId;
  readonly createdThread: boolean;
}

export class SlackChatBridgeProjectNotFoundError extends Schema.TaggedErrorClass<SlackChatBridgeProjectNotFoundError>()(
  "SlackChatBridgeProjectNotFoundError",
  {
    projectId: Schema.String,
    message: Schema.String,
  },
) {}

export class SlackChatBridgeThreadDeletedError extends Schema.TaggedErrorClass<SlackChatBridgeThreadDeletedError>()(
  "SlackChatBridgeThreadDeletedError",
  {
    threadId: Schema.String,
    message: Schema.String,
  },
) {}

export type SlackChatBridgeError =
  | ProjectionRepositoryError
  | OrchestrationDispatchError
  | SlackChatBridgeProjectNotFoundError
  | SlackChatBridgeThreadDeletedError;

export interface SlackChatBridgeShape {
  readonly deliverUserMessage: (
    input: SlackChatBridgeDeliverInput,
  ) => Effect.Effect<SlackChatBridgeDeliverResult, SlackChatBridgeError>;
}

export class SlackChatBridge extends Context.Service<SlackChatBridge, SlackChatBridgeShape>()(
  "t3/slack/Services/SlackChatBridge",
) {}
