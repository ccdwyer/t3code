import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import { BoardId, LaneKey, TicketId } from "./workflow.ts";

export const MOCK_SLACK_WORKSPACE_ID = "mock";

const makeId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const SlackAgentInstanceId = makeId("SlackAgentInstanceId");
export type SlackAgentInstanceId = typeof SlackAgentInstanceId.Type;

export const SlackAgentRunId = makeId("SlackAgentRunId");
export type SlackAgentRunId = typeof SlackAgentRunId.Type;

export const SlackAgentDeliveryId = makeId("SlackAgentDeliveryId");
export type SlackAgentDeliveryId = typeof SlackAgentDeliveryId.Type;

export const MockSlackThreadId = makeId("MockSlackThreadId");
export type MockSlackThreadId = typeof MockSlackThreadId.Type;

export const MockSlackWorkspaceId = makeId("MockSlackWorkspaceId");
export type MockSlackWorkspaceId = typeof MockSlackWorkspaceId.Type;

export const SlackAgentWorkspaceId = makeId("SlackAgentWorkspaceId");
export type SlackAgentWorkspaceId = typeof SlackAgentWorkspaceId.Type;

export const MockSlackChannelId = makeId("MockSlackChannelId");
export type MockSlackChannelId = typeof MockSlackChannelId.Type;

export const MockSlackMessageId = makeId("MockSlackMessageId");
export type MockSlackMessageId = typeof MockSlackMessageId.Type;

export const MockSlackUserId = makeId("MockSlackUserId");
export type MockSlackUserId = typeof MockSlackUserId.Type;

export const SlackAgentBotUserId = makeId("SlackAgentBotUserId");
export type SlackAgentBotUserId = typeof SlackAgentBotUserId.Type;

export const SlackAgentAppId = makeId("SlackAgentAppId");
export type SlackAgentAppId = typeof SlackAgentAppId.Type;

export const SlackAgentBotId = makeId("SlackAgentBotId");
export type SlackAgentBotId = typeof SlackAgentBotId.Type;

export const SlackAgentWorkspaceName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export type SlackAgentWorkspaceName = typeof SlackAgentWorkspaceName.Type;

export const SlackAgentAppToken = TrimmedNonEmptyString.check(
  Schema.isPattern(/^xapp-/),
  Schema.isMaxLength(4096),
);
export type SlackAgentAppToken = typeof SlackAgentAppToken.Type;

export const SlackAgentBotToken = TrimmedNonEmptyString.check(
  Schema.isPattern(/^xoxb-/),
  Schema.isMaxLength(4096),
);
export type SlackAgentBotToken = typeof SlackAgentBotToken.Type;

export const SlackAgentExternalEventId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type SlackAgentExternalEventId = typeof SlackAgentExternalEventId.Type;

export const SlackAgentHandleSuffix = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9_]+$/),
  Schema.isMaxLength(29),
);
export type SlackAgentHandleSuffix = typeof SlackAgentHandleSuffix.Type;

export const SlackAgentHandle = TrimmedNonEmptyString.check(
  Schema.isPattern(/^t3_[a-z0-9_]+$/),
  Schema.isMaxLength(32),
);
export type SlackAgentHandle = typeof SlackAgentHandle.Type;

export const SlackAgentOwnerLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export type SlackAgentOwnerLabel = typeof SlackAgentOwnerLabel.Type;

export const SlackAgentProjectSelector = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/),
  Schema.isMaxLength(64),
);
export type SlackAgentProjectSelector = typeof SlackAgentProjectSelector.Type;
export const SLACK_AGENT_DEFAULT_PROJECT_SELECTOR = "project" as SlackAgentProjectSelector;

export const SlackAgentProjectBinding = Schema.Struct({
  projectId: ProjectId,
  selector: SlackAgentProjectSelector,
});
export type SlackAgentProjectBinding = typeof SlackAgentProjectBinding.Type;

export const SlackAgentTarget = Schema.Struct({
  projectId: ProjectId,
  projects: Schema.optional(Schema.Array(SlackAgentProjectBinding).check(Schema.isMaxLength(100))),
});
export type SlackAgentTarget = typeof SlackAgentTarget.Type;

export const normalizeSlackAgentTargetProjects = (
  target: SlackAgentTarget,
): ReadonlyArray<SlackAgentProjectBinding> => {
  const bindings: Array<SlackAgentProjectBinding> = [];
  const seenProjects = new Set<string>();
  const seenSelectors = new Set<string>();
  const add = (binding: SlackAgentProjectBinding) => {
    const projectId = String(binding.projectId);
    const selector = String(binding.selector);
    if (seenProjects.has(projectId) || seenSelectors.has(selector)) return;
    seenProjects.add(projectId);
    seenSelectors.add(selector);
    bindings.push(binding);
  };
  for (const binding of target.projects ?? []) {
    add(binding);
  }
  if (!seenProjects.has(String(target.projectId))) {
    add({
      projectId: target.projectId,
      selector: SLACK_AGENT_DEFAULT_PROJECT_SELECTOR,
    });
  }
  return bindings;
};

export const SlackAgentWorkflowTarget = Schema.Struct({
  boardId: BoardId,
  initialLane: LaneKey,
});
export type SlackAgentWorkflowTarget = typeof SlackAgentWorkflowTarget.Type;

export const SlackAgentInvocationMode = Schema.Literals(["chat", "workflow"]);
export type SlackAgentInvocationMode = typeof SlackAgentInvocationMode.Type;

export const SlackAgentInvocation = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("chat"),
    projectSelector: Schema.optional(SlackAgentProjectSelector),
  }),
  Schema.Struct({
    mode: Schema.Literal("workflow"),
    target: SlackAgentWorkflowTarget,
    projectSelector: Schema.optional(SlackAgentProjectSelector),
  }),
]);
export type SlackAgentInvocation = typeof SlackAgentInvocation.Type;

export const SlackAgentTargetValidation = Schema.Struct({
  valid: Schema.Boolean,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  path: Schema.optional(Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128)))),
});
export type SlackAgentTargetValidation = typeof SlackAgentTargetValidation.Type;

export const SlackAgentInstanceState = Schema.Literals(["enabled", "disabled", "needs_setup"]);
export type SlackAgentInstanceState = typeof SlackAgentInstanceState.Type;

export const SlackAgentInstanceKind = Schema.Literals(["mock", "slack"]);
export type SlackAgentInstanceKind = typeof SlackAgentInstanceKind.Type;

export const SlackAgentConnectionState = Schema.Literals([
  "disconnected",
  "connecting",
  "connected",
  "error",
]);
export type SlackAgentConnectionState = typeof SlackAgentConnectionState.Type;

export const SlackAgentWorkspaceMetadata = Schema.Struct({
  workspaceId: SlackAgentWorkspaceId,
  name: Schema.optional(SlackAgentWorkspaceName),
});
export type SlackAgentWorkspaceMetadata = typeof SlackAgentWorkspaceMetadata.Type;

export const SlackAgentConnectionStatus = Schema.Struct({
  state: SlackAgentConnectionState,
  connectedAt: Schema.optional(IsoDateTime),
  lastError: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type SlackAgentConnectionStatus = typeof SlackAgentConnectionStatus.Type;

export const SlackAgentLatestRunSummary = Schema.Struct({
  runId: SlackAgentRunId,
  mode: SlackAgentInvocationMode.pipe(Schema.withDecodingDefaultKey(Effect.succeed("workflow"))),
  threadId: Schema.optional(ThreadId),
  ticketId: Schema.optional(TicketId),
  state: Schema.Literals([
    "accepted",
    "connected",
    "queued",
    "running",
    "waiting",
    "blocked",
    "failed",
    "pr_ready",
    "done",
  ]),
  updatedAt: IsoDateTime,
  prUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
});
export type SlackAgentLatestRunSummary = typeof SlackAgentLatestRunSummary.Type;

export const SlackAgentInstanceView = Schema.Struct({
  instanceId: SlackAgentInstanceId,
  kind: SlackAgentInstanceKind.pipe(Schema.withDecodingDefaultKey(Effect.succeed("mock"))),
  workspace: SlackAgentWorkspaceMetadata.pipe(
    Schema.withDecodingDefaultKey(
      Effect.succeed({
        workspaceId: MOCK_SLACK_WORKSPACE_ID,
      }),
    ),
  ),
  appId: Schema.optional(SlackAgentAppId),
  botId: Schema.optional(SlackAgentBotId),
  handle: SlackAgentHandle,
  ownerLabel: SlackAgentOwnerLabel,
  botUserId: SlackAgentBotUserId,
  target: SlackAgentTarget,
  defaultModelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  enabled: Schema.Boolean,
  state: SlackAgentInstanceState,
  validation: SlackAgentTargetValidation,
  credentialsConfigured: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  connection: SlackAgentConnectionStatus.pipe(
    Schema.withDecodingDefaultKey(
      Effect.succeed({
        state: "connected",
      }),
    ),
  ),
  activeRunCount: NonNegativeInt,
  latestRun: Schema.optional(SlackAgentLatestRunSummary),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SlackAgentInstanceView = typeof SlackAgentInstanceView.Type;

export const SlackAgentListInstancesResult = Schema.Struct({
  instances: Schema.Array(SlackAgentInstanceView),
});
export type SlackAgentListInstancesResult = typeof SlackAgentListInstancesResult.Type;

export const SlackAgentCreateInstanceInput = Schema.Struct({
  ownerLabel: SlackAgentOwnerLabel,
  handleSuffix: SlackAgentHandleSuffix,
  target: SlackAgentTarget,
  appToken: SlackAgentAppToken,
  botToken: SlackAgentBotToken,
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  acknowledged: Schema.Literal(true),
});
export type SlackAgentCreateInstanceInput = typeof SlackAgentCreateInstanceInput.Type;

export const SlackAgentCreateMockInstanceInput = Schema.Struct({
  ownerLabel: SlackAgentOwnerLabel,
  handleSuffix: SlackAgentHandleSuffix,
  target: SlackAgentTarget,
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  acknowledged: Schema.Literal(true),
});
export type SlackAgentCreateMockInstanceInput = typeof SlackAgentCreateMockInstanceInput.Type;

export const SlackAgentCreateInstanceResult = Schema.Struct({
  instance: SlackAgentInstanceView,
});
export type SlackAgentCreateInstanceResult = typeof SlackAgentCreateInstanceResult.Type;

export const SlackAgentUpdateInstanceInput = Schema.Struct({
  instanceId: SlackAgentInstanceId,
  ownerLabel: Schema.optional(SlackAgentOwnerLabel),
  handleSuffix: Schema.optional(SlackAgentHandleSuffix),
  target: Schema.optional(SlackAgentTarget),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
});
export type SlackAgentUpdateInstanceInput = typeof SlackAgentUpdateInstanceInput.Type;

export const SlackAgentConnectInstanceInput = Schema.Struct({
  instanceId: SlackAgentInstanceId,
  appToken: SlackAgentAppToken,
  botToken: SlackAgentBotToken,
});
export type SlackAgentConnectInstanceInput = typeof SlackAgentConnectInstanceInput.Type;

export const SlackAgentTestConnectionInput = Schema.Struct({
  instanceId: SlackAgentInstanceId,
});
export type SlackAgentTestConnectionInput = typeof SlackAgentTestConnectionInput.Type;

export const SlackAgentTestConnectionResult = Schema.Struct({
  instance: SlackAgentInstanceView,
  ok: Schema.Boolean,
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
});
export type SlackAgentTestConnectionResult = typeof SlackAgentTestConnectionResult.Type;

export const SlackAgentInstanceIdInput = Schema.Struct({
  instanceId: SlackAgentInstanceId,
});
export type SlackAgentInstanceIdInput = typeof SlackAgentInstanceIdInput.Type;

export const SlackAgentGetRunInput = Schema.Struct({
  runId: SlackAgentRunId,
});
export type SlackAgentGetRunInput = typeof SlackAgentGetRunInput.Type;

export const SlackAgentRetryDeliveryInput = Schema.Struct({
  deliveryId: SlackAgentDeliveryId,
});
export type SlackAgentRetryDeliveryInput = typeof SlackAgentRetryDeliveryInput.Type;

export const MockSlackAttachmentMetadata = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  filename: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mediaType: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  sizeBytes: NonNegativeInt,
  permalink: Schema.String.check(Schema.isMaxLength(2048)),
});
export type MockSlackAttachmentMetadata = typeof MockSlackAttachmentMetadata.Type;

export const MockSlackSourceMessage = Schema.Struct({
  messageId: MockSlackMessageId,
  ts: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  authorUserId: MockSlackUserId,
  authorLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  text: Schema.String.check(Schema.isMaxLength(64_000)),
  editedTs: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  attachments: Schema.optional(
    Schema.Array(MockSlackAttachmentMetadata).check(Schema.isMaxLength(20)),
  ),
});
export type MockSlackSourceMessage = typeof MockSlackSourceMessage.Type;

export const MockSlackThreadKey = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type MockSlackThreadKey = typeof MockSlackThreadKey.Type;

export const MockSlackThreadRef = Schema.Struct({
  workspaceId: MockSlackWorkspaceId,
  channelId: MockSlackChannelId,
  channelName: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  threadTs: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  threadKey: Schema.optional(MockSlackThreadKey),
});
export type MockSlackThreadRef = typeof MockSlackThreadRef.Type;

export const SlackAgentThreadSnapshot = Schema.Struct({
  thread: MockSlackThreadRef,
  triggerEventId: SlackAgentExternalEventId,
  triggerMessageId: MockSlackMessageId,
  triggerTs: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  messages: Schema.Array(MockSlackSourceMessage).check(Schema.isMaxLength(500)),
  canonicalJsonBytes: PositiveInt,
});
export type SlackAgentThreadSnapshot = typeof SlackAgentThreadSnapshot.Type;

export const SlackAgentSimulateMentionInput = Schema.Struct({
  instanceId: SlackAgentInstanceId,
  thread: MockSlackThreadRef,
  // The server enforces the 500-message domain limit so callers receive the
  // typed SlackAgentOversizedSnapshotError instead of a transport decode error.
  messages: Schema.Array(MockSlackSourceMessage),
  triggerMessageId: MockSlackMessageId,
  externalEventId: Schema.optional(SlackAgentExternalEventId),
  invocation: Schema.optional(SlackAgentInvocation),
});
export type SlackAgentSimulateMentionInput = typeof SlackAgentSimulateMentionInput.Type;

export const SlackAgentSimulateMentionResult = Schema.Struct({
  runId: SlackAgentRunId,
  mode: SlackAgentInvocationMode.pipe(Schema.withDecodingDefaultKey(Effect.succeed("workflow"))),
  threadId: Schema.optional(ThreadId),
  ticketId: Schema.optional(TicketId),
  statusMessageId: MockSlackMessageId,
  duplicate: Schema.Boolean,
  createdThread: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  state: SlackAgentLatestRunSummary.fields.state,
  message: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
});
export type SlackAgentSimulateMentionResult = typeof SlackAgentSimulateMentionResult.Type;

export const SlackAgentDeliveryState = Schema.Literals([
  "pending",
  "delivering",
  "delivered",
  "retrying",
  "failed",
  "superseded",
]);
export type SlackAgentDeliveryState = typeof SlackAgentDeliveryState.Type;

export const SlackAgentDeliveryView = Schema.Struct({
  deliveryId: SlackAgentDeliveryId,
  runId: SlackAgentRunId,
  workflowSequence: NonNegativeInt,
  state: SlackAgentDeliveryState,
  attempts: NonNegativeInt,
  nextAttemptAt: Schema.optional(IsoDateTime),
  lastError: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SlackAgentDeliveryView = typeof SlackAgentDeliveryView.Type;

export const SlackAgentRunSummaryView = Schema.Struct({
  runId: SlackAgentRunId,
  instanceId: SlackAgentInstanceId,
  projectId: Schema.optional(ProjectId),
  handle: SlackAgentHandle,
  botUserId: SlackAgentBotUserId,
  mode: SlackAgentInvocationMode.pipe(Schema.withDecodingDefaultKey(Effect.succeed("workflow"))),
  threadId: Schema.optional(ThreadId),
  ticketId: Schema.optional(TicketId),
  thread: MockSlackThreadRef,
  state: SlackAgentLatestRunSummary.fields.state,
  statusMessageId: Schema.optional(MockSlackMessageId),
  prUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  lastAppliedSequence: Schema.Int,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SlackAgentRunSummaryView = typeof SlackAgentRunSummaryView.Type;

export const SlackAgentRunDetailView = Schema.Struct({
  run: SlackAgentRunSummaryView,
  snapshot: SlackAgentThreadSnapshot,
  deliveries: Schema.Array(SlackAgentDeliveryView),
});
export type SlackAgentRunDetailView = typeof SlackAgentRunDetailView.Type;

export const SlackAgentRunStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    run: SlackAgentRunDetailView,
  }),
  Schema.Struct({
    type: Schema.Literal("updated"),
    run: SlackAgentRunSummaryView,
    delivery: Schema.optional(SlackAgentDeliveryView),
  }),
]);
export type SlackAgentRunStreamEvent = typeof SlackAgentRunStreamEvent.Type;

export const MockSlackStatusReplyView = Schema.Struct({
  messageId: MockSlackMessageId,
  botUserId: SlackAgentBotUserId,
  runId: SlackAgentRunId,
  text: Schema.String.check(Schema.isMaxLength(16_000)),
  updatedAt: IsoDateTime,
});
export type MockSlackStatusReplyView = typeof MockSlackStatusReplyView.Type;

export const MockSlackThreadView = Schema.Struct({
  threadId: MockSlackThreadId,
  ref: MockSlackThreadRef,
  sourceMessages: Schema.Array(MockSlackSourceMessage).check(Schema.isMaxLength(500)),
  statusReplies: Schema.Array(MockSlackStatusReplyView),
  updatedAt: IsoDateTime,
});
export type MockSlackThreadView = typeof MockSlackThreadView.Type;

export const MockSlackSubscribeThreadInput = Schema.Struct({
  threadId: MockSlackThreadId,
});
export type MockSlackSubscribeThreadInput = typeof MockSlackSubscribeThreadInput.Type;

export const MockSlackThreadStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    thread: MockSlackThreadView,
  }),
  Schema.Struct({
    type: Schema.Literal("updated"),
    thread: MockSlackThreadView,
  }),
]);
export type MockSlackThreadStreamEvent = typeof MockSlackThreadStreamEvent.Type;

export class SlackAgentHandleCollisionError extends Schema.TaggedErrorClass<SlackAgentHandleCollisionError>()(
  "SlackAgentHandleCollisionError",
  {
    handle: SlackAgentHandle,
    message: TrimmedNonEmptyString,
  },
) {}

export class SlackAgentInvalidTargetError extends Schema.TaggedErrorClass<SlackAgentInvalidTargetError>()(
  "SlackAgentInvalidTargetError",
  {
    message: TrimmedNonEmptyString,
    path: Schema.optional(Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128)))),
  },
) {}

export class SlackAgentOversizedSnapshotError extends Schema.TaggedErrorClass<SlackAgentOversizedSnapshotError>()(
  "SlackAgentOversizedSnapshotError",
  {
    messageCount: NonNegativeInt,
    canonicalJsonBytes: NonNegativeInt,
    message: TrimmedNonEmptyString,
  },
) {}

export class SlackAgentDuplicateSourceThreadError extends Schema.TaggedErrorClass<SlackAgentDuplicateSourceThreadError>()(
  "SlackAgentDuplicateSourceThreadError",
  {
    runId: SlackAgentRunId,
    threadId: Schema.optional(ThreadId),
    ticketId: Schema.optional(TicketId),
    message: TrimmedNonEmptyString,
  },
) {}

export class SlackAgentDisabledInstanceError extends Schema.TaggedErrorClass<SlackAgentDisabledInstanceError>()(
  "SlackAgentDisabledInstanceError",
  {
    instanceId: SlackAgentInstanceId,
    message: TrimmedNonEmptyString,
  },
) {}

export class SlackAgentFailedDeliveryError extends Schema.TaggedErrorClass<SlackAgentFailedDeliveryError>()(
  "SlackAgentFailedDeliveryError",
  {
    deliveryId: SlackAgentDeliveryId,
    message: TrimmedNonEmptyString,
  },
) {}

export class SlackAgentMissingRunError extends Schema.TaggedErrorClass<SlackAgentMissingRunError>()(
  "SlackAgentMissingRunError",
  {
    runId: SlackAgentRunId,
    message: TrimmedNonEmptyString,
  },
) {}

export const SlackAgentRpcError = Schema.Union([
  SlackAgentHandleCollisionError,
  SlackAgentInvalidTargetError,
  SlackAgentOversizedSnapshotError,
  SlackAgentDuplicateSourceThreadError,
  SlackAgentDisabledInstanceError,
  SlackAgentFailedDeliveryError,
  SlackAgentMissingRunError,
]);
export type SlackAgentRpcError = typeof SlackAgentRpcError.Type;
