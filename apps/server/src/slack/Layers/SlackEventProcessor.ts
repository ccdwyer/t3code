import {
  BoardId,
  LaneKey,
  MockSlackMessageId,
  type MockSlackSourceMessage,
  type MockSlackThreadRef,
  type SlackAgentInstanceView,
  type SlackAgentInvocation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  classifySlackEventBody,
  decodeSlackSocketEventBody,
  deriveSlackThreadIdentity,
  normalizeSlackMessage,
  slackMessageId,
  type SlackMessageAttachmentMetadata,
  type SlackEventInvocation,
  type SlackSocketEventsApiBody,
  type SlackSocketMessageEvent,
  type SlackSourceMessage,
} from "../slackEvent.ts";
import { SlackApi, type SlackThreadMessage } from "../Services/SlackApi.ts";
import {
  SlackEventProcessor,
  SlackEventProcessorError,
  type SlackEventProcessorShape,
} from "../Services/SlackEventProcessor.ts";
import { SlackAgentInstanceStore } from "../../workflow/Services/SlackAgentInstanceStore.ts";
import { SlackAgentIntake } from "../../workflow/Services/SlackAgentIntake.ts";
import { SlackAgentRunStore } from "../../workflow/Services/SlackAgentRunStore.ts";
import { makeKeyedSemaphore } from "../../utils/keyedSemaphore.ts";

const sensitivePatterns = [
  /\b(?:xox[baprs]-|xapp-)[A-Za-z0-9-]+/gu,
  /authorization\s*:\s*bearer\s+[^\s,)}\]]+/giu,
];
const isSlackEventProcessorError = Schema.is(SlackEventProcessorError);

const redact = (value: unknown): string => {
  let message = typeof value === "string" ? value : "Slack event processor failed.";
  for (const pattern of sensitivePatterns) {
    message = message.replace(pattern, "[redacted]");
  }
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
};

const toProcessorError =
  (
    reason: SlackEventProcessorError["reason"],
    fallback: string,
  ): ((cause: unknown) => SlackEventProcessorError) =>
  (cause) => {
    if (isSlackEventProcessorError(cause)) {
      return new SlackEventProcessorError({
        reason: cause.reason,
        message: redact(cause.message),
      });
    }
    const causeMessage =
      typeof cause === "object" &&
      cause !== null &&
      "message" in cause &&
      typeof cause.message === "string"
        ? cause.message
        : fallback;
    return new SlackEventProcessorError({ reason, message: redact(causeMessage) });
  };

const safeFailureText =
  "I couldn't process that Slack request. Please try again or check the T3 Code Slack connection.";

const fileAttachments = (
  files: ReadonlyArray<SlackThreadMessage["files"][number]>,
): ReadonlyArray<SlackMessageAttachmentMetadata> =>
  files.map((file) => ({
    id: file.id,
    filename: file.name ?? file.title ?? file.id,
    mediaType: file.mimetype ?? "application/octet-stream",
    sizeBytes: file.size ?? 0,
    permalink: file.permalink ?? "",
  }));

const normalizeFetchedMessage = (input: {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly message: SlackThreadMessage;
}): SlackSourceMessage => {
  const attachments = fileAttachments(input.message.files);
  return {
    messageId: slackMessageId({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      ts: input.message.ts,
    }),
    ts: input.message.ts,
    authorUserId: input.message.authorUserId,
    authorLabel: input.message.authorLabel,
    text: input.message.text,
    ...(input.message.editedTs === undefined ? {} : { editedTs: input.message.editedTs }),
    ...(attachments.length === 0 ? {} : { attachments }),
  };
};

const normalizeFetchedMessages = (input: {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messages: ReadonlyArray<SlackThreadMessage>;
}): ReadonlyArray<SlackSourceMessage> =>
  input.messages.map((message) =>
    normalizeFetchedMessage({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      message,
    }),
  );

const fallback = <A>(value: A) => Effect.catch(() => Effect.succeed(value));

const invocationFor = (input: {
  readonly body: SlackSocketEventsApiBody;
  readonly linkedRunMode?: "chat" | "workflow" | undefined;
  readonly parsedInvocation: SlackEventInvocation;
}): SlackAgentInvocation | undefined => {
  if (input.linkedRunMode !== undefined) return undefined;
  if (input.body.event.type !== "app_mention" && input.body.event.channel_type !== "im") {
    return undefined;
  }
  if (input.parsedInvocation.mode === "workflow") {
    return {
      mode: "workflow",
      ...(input.parsedInvocation.projectSelector === undefined
        ? {}
        : { projectSelector: input.parsedInvocation.projectSelector as never }),
      target: {
        boardId: BoardId.make(input.parsedInvocation.target.boardId),
        initialLane: LaneKey.make(input.parsedInvocation.target.initialLane),
      },
    };
  }
  return input.parsedInvocation.projectSelector === undefined
    ? undefined
    : {
        mode: "chat",
        projectSelector: input.parsedInvocation.projectSelector as never,
      };
};

const buildThreadRef = (input: {
  readonly body: SlackSocketEventsApiBody;
  readonly channelName: string;
}): MockSlackThreadRef => {
  const identity = deriveSlackThreadIdentity(input.body);
  return {
    workspaceId: identity.workspaceId,
    channelId: identity.channelId,
    channelName: input.channelName,
    threadTs: identity.rootThreadTs,
    threadKey: identity.threadKey,
  } as MockSlackThreadRef;
};

const triggerEventMessage = (body: SlackSocketEventsApiBody): SlackSocketMessageEvent => body.event;

const make = Effect.fn("SlackEventProcessor.make")(function* () {
  const instances = yield* SlackAgentInstanceStore;
  const runs = yield* SlackAgentRunStore;
  const intake = yield* SlackAgentIntake;
  const slack = yield* SlackApi;
  const sourceLocks = yield* makeKeyedSemaphore;

  const processAccepted = Effect.fn("SlackEventProcessor.processAccepted")(function* (input: {
    readonly body: SlackSocketEventsApiBody;
    readonly instance: SlackAgentInstanceView;
    readonly botToken: string;
    readonly linkedRunMode?: "chat" | "workflow" | undefined;
    readonly parsedInvocation: SlackEventInvocation;
    readonly workflowAuthorized: boolean;
  }) {
    const identity = deriveSlackThreadIdentity(input.body);
    const channelName = yield* slack
      .resolveChannelName({
        botToken: input.botToken,
        channelId: identity.channelId,
      })
      .pipe(
        fallback(identity.channelId),
        Effect.mapError(toProcessorError("slack_api_error", "Failed to resolve Slack channel.")),
      );

    const messages =
      input.linkedRunMode === undefined
        ? yield* slack
            .fetchThreadThrough({
              botToken: input.botToken,
              channelId: identity.channelId,
              threadTs: identity.rootThreadTs,
              triggerTs: identity.triggerTs,
            })
            .pipe(
              Effect.map((snapshot) =>
                normalizeFetchedMessages({
                  workspaceId: identity.workspaceId,
                  channelId: identity.channelId,
                  messages: snapshot.messages,
                }),
              ),
              Effect.mapError(toProcessorError("slack_api_error", "Failed to fetch Slack thread.")),
            )
        : [
            normalizeSlackMessage({
              workspaceId: identity.workspaceId,
              message: triggerEventMessage(input.body),
              authorLabel: yield* slack
                .resolveUserLabel({
                  botToken: input.botToken,
                  userId: input.body.event.user ?? "unknown",
                })
                .pipe(
                  fallback(input.body.event.user ?? "unknown"),
                  Effect.mapError(
                    toProcessorError("slack_api_error", "Failed to resolve Slack user."),
                  ),
                ),
            }),
          ];

    yield* intake
      .acceptMention({
        instanceId: input.instance.instanceId,
        botUserId: input.instance.botUserId,
        externalEventId: input.body.event_id,
        thread: buildThreadRef({ body: input.body, channelName }),
        messages: messages as ReadonlyArray<MockSlackSourceMessage>,
        triggerMessageId: MockSlackMessageId.make(identity.triggerMessageId),
        invocation: invocationFor(input),
        workflowAuthorized:
          input.workflowAuthorized &&
          (input.parsedInvocation.mode === "workflow" || input.linkedRunMode === "workflow"),
        trimSnapshotToFit: true,
      })
      .pipe(Effect.mapError(toProcessorError("intake_error", "Failed to accept Slack event.")));
  });

  const postSafeFailureReply = (input: {
    readonly body: SlackSocketEventsApiBody;
    readonly botToken: string;
  }) => {
    const identity = deriveSlackThreadIdentity(input.body);
    const postSlackMessage = slack.postMessage;
    return postSlackMessage({
      botToken: input.botToken,
      channelId: identity.channelId,
      threadTs: identity.rootThreadTs,
      text: safeFailureText,
    }).pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    );
  };

  const process: SlackEventProcessorShape["process"] = Effect.fn("SlackEventProcessor.process")(
    function* (input) {
      if (input.envelope.type !== "events_api") return;

      const body = yield* Effect.try({
        try: () => decodeSlackSocketEventBody(input.envelope.payload),
        catch: toProcessorError("malformed_payload", "Slack event payload was malformed."),
      });
      const identity = deriveSlackThreadIdentity(body);
      const isUnthreadedDm = body.event.channel_type === "im" && body.event.thread_ts === undefined;
      const sourceKey = `${input.instanceId}:${identity.workspaceId}:${identity.channelId}:${isUnthreadedDm ? "dm-root" : identity.rootThreadTs}`;
      return yield* sourceLocks.withPermit(
        sourceKey,
        Effect.gen(function* () {
          const instance = yield* instances
            .get(input.instanceId)
            .pipe(
              Effect.mapError(
                toProcessorError("store_error", "Failed to load Slack agent instance."),
              ),
            );
          if (instance === null) {
            return yield* new SlackEventProcessorError({
              reason: "instance_not_found",
              message: "Slack agent instance was not found.",
            });
          }
          if (instance.enabled !== true || instance.state !== "enabled") {
            return yield* new SlackEventProcessorError({
              reason: "instance_not_enabled",
              message: "Slack agent instance is not enabled.",
            });
          }
          if (instance.kind !== "slack") {
            return yield* new SlackEventProcessorError({
              reason: "instance_not_real",
              message: "Slack agent instance is not a real Slack installation.",
            });
          }

          if (body.team_id !== instance.workspace.workspaceId) {
            return yield* new SlackEventProcessorError({
              reason: "workspace_mismatch",
              message: "Slack event workspace did not match the agent installation.",
            });
          }
          if (instance.appId !== undefined && body.api_app_id !== instance.appId) {
            return yield* new SlackEventProcessorError({
              reason: "app_mismatch",
              message: "Slack event app did not match the agent installation.",
            });
          }

          const linkedRun = yield* (
            isUnthreadedDm
              ? runs.findRootChatByChannel(
                  instance.instanceId,
                  identity.workspaceId,
                  identity.channelId,
                )
              : runs.findBySourceThread(
                  instance.instanceId,
                  identity.workspaceId,
                  identity.channelId,
                  identity.rootThreadTs,
                )
          ).pipe(
            Effect.mapError(toProcessorError("store_error", "Failed to load Slack agent run.")),
          );
          const routedBody: SlackSocketEventsApiBody =
            isUnthreadedDm && linkedRun !== null
              ? {
                  ...body,
                  event: {
                    ...body.event,
                    thread_ts: linkedRun.thread.threadTs,
                  },
                }
              : body;

          const classification = classifySlackEventBody({
            body: routedBody,
            botUserId: instance.botUserId,
            linkedThread: linkedRun !== null,
          });
          if (classification.type === "ignored") return;

          const credentials = yield* instances
            .readCredentials(instance.instanceId)
            .pipe(
              Effect.mapError(
                toProcessorError("store_error", "Failed to load Slack agent credentials."),
              ),
            );
          if (credentials === null) {
            return yield* new SlackEventProcessorError({
              reason: "missing_credentials",
              message: "Slack agent credentials are not configured.",
            });
          }

          const accepted = processAccepted({
            body: routedBody,
            instance,
            botToken: credentials.botToken,
            linkedRunMode: linkedRun?.mode,
            parsedInvocation: classification.invocation,
            workflowAuthorized: input.workflowAuthorized,
          });

          return yield* accepted.pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                yield* postSafeFailureReply({ body: routedBody, botToken: credentials.botToken });
                return yield* error;
              }),
            ),
          );
        }),
      );
    },
  );

  return { process } satisfies SlackEventProcessorShape;
});

export const SlackEventProcessorLive = Layer.effect(SlackEventProcessor, make());
