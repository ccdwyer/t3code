import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type {
  SlackThreadMessageInput,
  SlackThreadSnapshot,
  SlackThreadSnapshotError,
  SlackThreadSnapshotInput,
} from "../slack/slackThreadSnapshot.ts";

export class SlackAgentGatewayError extends Schema.TaggedErrorClass<SlackAgentGatewayError>()(
  "SlackAgentGatewayError",
  {
    message: Schema.String,
    retryAfterMs: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface SlackStatusPostInput {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly threadTs: string;
  readonly runId: string;
  readonly deliveryId: string;
  readonly text: string;
  readonly statusMessageId?: string | undefined;
  readonly now?: string | undefined;
}

export interface SlackStatusPostResult {
  readonly threadKey: string;
  readonly statusMessageId: string;
}

export interface MockSlackThreadKeyInput {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadTs: string;
}

export interface MockSlackStatusReply {
  readonly statusMessageId: string;
  readonly runId: string;
  readonly text: string;
  readonly updatedAt: string;
  readonly history: ReadonlyArray<{
    readonly deliveryId: string;
    readonly text: string;
    readonly updatedAt: string;
  }>;
}

export interface MockSlackThreadView {
  readonly threadKey: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly threadTs: string;
  readonly messages: ReadonlyArray<SlackThreadMessageInput>;
  readonly statusReplies: Record<string, MockSlackStatusReply>;
  readonly updatedAt: string;
}

export interface SlackAgentGatewayShape {
  readonly snapshotThreadThroughTrigger: (
    input: SlackThreadSnapshotInput,
  ) => Effect.Effect<SlackThreadSnapshot, SlackThreadSnapshotError | SlackAgentGatewayError>;
  readonly postOrUpdateStatus: (
    input: SlackStatusPostInput,
  ) => Effect.Effect<SlackStatusPostResult, SlackAgentGatewayError>;
  readonly subscribeMockThread: (
    input: MockSlackThreadKeyInput,
  ) => Effect.Effect<MockSlackThreadView | null, SlackAgentGatewayError>;
  readonly subscribeMockThreadChanges: (
    input: MockSlackThreadKeyInput,
  ) => Effect.Effect<Stream.Stream<MockSlackThreadView>, never, Scope.Scope>;
}

export class SlackAgentGateway extends Context.Service<SlackAgentGateway, SlackAgentGatewayShape>()(
  "t3/workflow/Services/SlackAgentGateway",
) {}
