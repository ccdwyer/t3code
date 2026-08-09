import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export interface SlackCredentialsInput {
  readonly appToken: string;
  readonly botToken: string;
}

export interface SlackCredentialsValidation {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly botUserId: string;
  readonly botUserName?: string | undefined;
  readonly botId?: string | undefined;
  readonly appId?: string | undefined;
  readonly grantedScopes?: ReadonlyArray<string> | undefined;
}

export interface SlackSocketEnvelope {
  readonly envelopeId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly acceptsResponsePayload: boolean;
}

export type SlackSocketState =
  | { readonly type: "connecting" }
  | { readonly type: "connected" }
  | { readonly type: "disconnect"; readonly reason?: string | undefined }
  | { readonly type: "closed" }
  | { readonly type: "error"; readonly error: SlackApiError };

export interface SlackOpenSocketInput {
  readonly appToken: string;
  readonly onEnvelope: (envelope: SlackSocketEnvelope) => Effect.Effect<void, SlackApiError>;
  readonly onState: (state: SlackSocketState) => Effect.Effect<void, never>;
}

export interface SlackSocketConnection {
  readonly close: Effect.Effect<void, SlackApiError>;
}

export interface SlackFetchThreadInput {
  readonly botToken: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly triggerTs: string;
}

export interface SlackThreadMessage {
  readonly messageId: string;
  readonly ts: string;
  readonly authorUserId: string;
  readonly authorLabel: string;
  readonly text: string;
  readonly files: ReadonlyArray<SlackThreadFile>;
  readonly editedTs?: string | undefined;
}

export interface SlackThreadFile {
  readonly id: string;
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly mimetype?: string | undefined;
  readonly size?: number | undefined;
  readonly permalink?: string | undefined;
}

export interface SlackThreadSnapshot {
  readonly channelId: string;
  readonly threadTs: string;
  readonly triggerTs: string;
  readonly messages: ReadonlyArray<SlackThreadMessage>;
}

export interface SlackChannelNameInput {
  readonly botToken: string;
  readonly channelId: string;
}

export interface SlackUserLabelInput {
  readonly botToken: string;
  readonly userId: string;
}

export interface SlackPostMessageInput {
  readonly botToken: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly text: string;
}

export interface SlackUpdateMessageInput extends SlackPostMessageInput {
  readonly messageTs: string;
}

export interface SlackPostedMessage {
  readonly channelId: string;
  readonly messageTs: string;
}

export class SlackApiError extends Schema.TaggedErrorClass<SlackApiError>()("SlackApiError", {
  operation: Schema.String,
  message: Schema.String,
  retryAfterMs: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface SlackApiShape {
  readonly validateCredentials: (
    input: SlackCredentialsInput,
  ) => Effect.Effect<SlackCredentialsValidation, SlackApiError>;
  readonly openSocket: (
    input: SlackOpenSocketInput,
  ) => Effect.Effect<SlackSocketConnection, SlackApiError, Scope.Scope>;
  readonly fetchThreadThrough: (
    input: SlackFetchThreadInput,
  ) => Effect.Effect<SlackThreadSnapshot, SlackApiError>;
  readonly resolveChannelName: (
    input: SlackChannelNameInput,
  ) => Effect.Effect<string, SlackApiError>;
  readonly resolveUserLabel: (input: SlackUserLabelInput) => Effect.Effect<string, SlackApiError>;
  readonly postMessage: (
    input: SlackPostMessageInput,
  ) => Effect.Effect<SlackPostedMessage, SlackApiError>;
  readonly updateMessage: (
    input: SlackUpdateMessageInput,
  ) => Effect.Effect<SlackPostedMessage, SlackApiError>;
}

export class SlackApi extends Context.Service<SlackApi, SlackApiShape>()(
  "t3/slack/Services/SlackApi",
) {}
