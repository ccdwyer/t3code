import * as Schema from "effect/Schema";

export const SlackEventFile = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  mimetype: Schema.optional(Schema.String),
  filetype: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  permalink: Schema.optional(Schema.String),
  url_private: Schema.optional(Schema.String),
});
export type SlackEventFile = typeof SlackEventFile.Type;

export const SlackSocketMessageEvent = Schema.Struct({
  type: Schema.Literals(["app_mention", "message"]),
  channel: Schema.String,
  ts: Schema.String,
  thread_ts: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  channel_type: Schema.optional(Schema.String),
  files: Schema.optional(Schema.Array(SlackEventFile)),
  edited: Schema.optional(Schema.Struct({ ts: Schema.optional(Schema.String) })),
  subtype: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  bot_profile: Schema.optional(Schema.Unknown),
  hidden: Schema.optional(Schema.Boolean),
});
export type SlackSocketMessageEvent = typeof SlackSocketMessageEvent.Type;

export const SlackSocketEventsApiBody = Schema.Struct({
  team_id: Schema.String,
  api_app_id: Schema.String,
  event_id: Schema.String,
  event: SlackSocketMessageEvent,
});
export type SlackSocketEventsApiBody = typeof SlackSocketEventsApiBody.Type;

const decodeSlackSocketEventsApiBody = Schema.decodeUnknownSync(SlackSocketEventsApiBody);

export type SlackMessageAttachmentMetadata = {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly permalink: string;
};

export type SlackSourceMessage = {
  readonly messageId: string;
  readonly ts: string;
  readonly authorUserId: string;
  readonly authorLabel: string;
  readonly text: string;
  readonly editedTs?: string | undefined;
  readonly attachments?: ReadonlyArray<SlackMessageAttachmentMetadata> | undefined;
};

export type SlackThreadIdentity = {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly triggerTs: string;
  readonly threadKey: string;
  readonly triggerMessageId: string;
};

export type SlackEventInvocation =
  | { readonly mode: "chat"; readonly projectSelector?: string | undefined }
  | {
      readonly mode: "workflow";
      readonly projectSelector?: string | undefined;
      readonly target: {
        readonly boardId: string;
        readonly initialLane: string;
      };
    };

export type SlackEventClassification =
  | {
      readonly type: "accepted";
      readonly reason: "initial_app_mention" | "initial_dm" | "linked_thread_follow_up";
      readonly event: SlackSocketMessageEvent;
      readonly identity: SlackThreadIdentity;
      readonly invocation: SlackEventInvocation;
    }
  | {
      readonly type: "ignored";
      readonly reason:
        | "bot_or_self"
        | "system_or_unsupported_subtype"
        | "hidden"
        | "unrelated_message";
    };

export const decodeSlackSocketEventBody = (input: unknown) => decodeSlackSocketEventsApiBody(input);

const workflowDirectivePattern =
  /(?:^|\s)workflow\s+board:(?<boardId>[A-Za-z0-9._:-]+)\s+lane:(?<laneKey>[A-Za-z0-9._:-]+)(?:\s|$)/u;
const projectDirectivePattern = /(?:^|\s)project:(?<projectSelector>[a-z0-9][a-z0-9_-]*)(?=\s|$)/iu;

export const parseSlackWorkflowDirective = (text: string): SlackEventInvocation => {
  const projectSelector = projectDirectivePattern
    .exec(text)
    ?.groups?.projectSelector?.toLowerCase();
  const match = workflowDirectivePattern.exec(text);
  if (match?.groups?.boardId === undefined || match.groups.laneKey === undefined) {
    return projectSelector === undefined ? { mode: "chat" } : { mode: "chat", projectSelector };
  }
  return {
    mode: "workflow",
    ...(projectSelector === undefined ? {} : { projectSelector }),
    target: {
      boardId: match.groups.boardId,
      initialLane: match.groups.laneKey,
    },
  };
};

export const deriveSlackThreadIdentity = (body: SlackSocketEventsApiBody): SlackThreadIdentity => {
  const rootThreadTs = body.event.thread_ts ?? body.event.ts;
  return {
    workspaceId: body.team_id,
    channelId: body.event.channel,
    rootThreadTs,
    triggerTs: body.event.ts,
    threadKey: `slack:${body.team_id}:${body.event.channel}:${rootThreadTs}`,
    triggerMessageId: slackMessageId({
      workspaceId: body.team_id,
      channelId: body.event.channel,
      ts: body.event.ts,
    }),
  };
};

export const slackMessageId = (input: {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly ts: string;
}) => `slack:${input.workspaceId}:${input.channelId}:${input.ts}`;

const ignoredSystemSubtypes = new Set([
  "bot_message",
  "message_changed",
  "message_deleted",
  "channel_join",
  "channel_leave",
  "channel_archive",
  "channel_unarchive",
  "channel_name",
  "channel_topic",
  "channel_purpose",
  "group_join",
  "group_leave",
  "group_archive",
  "group_unarchive",
  "group_name",
  "group_topic",
  "group_purpose",
]);

export const classifySlackEventBody = (input: {
  readonly body: SlackSocketEventsApiBody;
  readonly botUserId: string;
  readonly linkedThread: boolean;
}): SlackEventClassification => {
  const event = input.body.event;
  if (event.hidden === true) return { type: "ignored", reason: "hidden" };
  if (
    event.user === input.botUserId ||
    event.bot_id !== undefined ||
    event.bot_profile !== undefined
  ) {
    return { type: "ignored", reason: "bot_or_self" };
  }
  if (
    event.user === undefined ||
    (event.subtype !== undefined && ignoredSystemSubtypes.has(event.subtype))
  ) {
    return { type: "ignored", reason: "system_or_unsupported_subtype" };
  }

  const identity = deriveSlackThreadIdentity(input.body);
  if (input.linkedThread) {
    return {
      type: "accepted",
      reason: "linked_thread_follow_up",
      event,
      identity,
      invocation: { mode: "chat" },
    };
  }

  if (event.type === "app_mention") {
    return {
      type: "accepted",
      reason: "initial_app_mention",
      event,
      identity,
      invocation: parseSlackWorkflowDirective(event.text ?? ""),
    };
  }

  if (event.channel_type === "im") {
    return {
      type: "accepted",
      reason: "initial_dm",
      event,
      identity,
      invocation: parseSlackWorkflowDirective(event.text ?? ""),
    };
  }

  return { type: "ignored", reason: "unrelated_message" };
};

export const classifySlackEventPayload = (input: {
  readonly payload: unknown;
  readonly botUserId: string;
  readonly linkedThread: boolean;
}) =>
  classifySlackEventBody({
    body: decodeSlackSocketEventBody(input.payload),
    botUserId: input.botUserId,
    linkedThread: input.linkedThread,
  });

const fallbackFileName = (file: SlackEventFile) => file.name ?? file.title ?? file.id;
const fallbackMediaType = (file: SlackEventFile) =>
  file.mimetype ?? file.filetype ?? "application/octet-stream";
const fallbackPermalink = (file: SlackEventFile) => file.permalink ?? file.url_private ?? "";

export const normalizeSlackMessage = (input: {
  readonly workspaceId: string;
  readonly message: SlackSocketMessageEvent;
  readonly authorLabel: string;
}): SlackSourceMessage => {
  const attachments =
    input.message.files?.map((file) => ({
      id: file.id,
      filename: fallbackFileName(file),
      mediaType: fallbackMediaType(file),
      sizeBytes: file.size ?? 0,
      permalink: fallbackPermalink(file),
    })) ?? [];

  return {
    messageId: slackMessageId({
      workspaceId: input.workspaceId,
      channelId: input.message.channel,
      ts: input.message.ts,
    }),
    ts: input.message.ts,
    authorUserId: input.message.user ?? "unknown",
    authorLabel: input.authorLabel,
    text: input.message.text ?? "",
    ...(input.message.edited?.ts === undefined ? {} : { editedTs: input.message.edited.ts }),
    ...(attachments.length === 0 ? {} : { attachments }),
  };
};

export const normalizeSlackMessages = (input: {
  readonly workspaceId: string;
  readonly messages: ReadonlyArray<SlackSocketMessageEvent>;
  readonly authorLabelFor: (userId: string) => string;
}): ReadonlyArray<SlackSourceMessage> =>
  input.messages.map((message) =>
    normalizeSlackMessage({
      workspaceId: input.workspaceId,
      message,
      authorLabel: input.authorLabelFor(message.user ?? "unknown"),
    }),
  );
