import type {
  SlackAgentDeliveryId,
  SlackAgentDeliveryState,
  SlackAgentDeliveryView,
  SlackAgentInstanceId,
  SlackAgentRunDetailView,
  SlackAgentRunId,
  SlackAgentRunSummaryView,
  TicketId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export type SlackAgentRunStatus = SlackAgentRunSummaryView["state"];
export type SlackAgentDeliveryKind =
  | "accepted"
  | "progress"
  | "needs_attention"
  | "pr_opened"
  | "done";
export type SlackAgentDeliveryOperation = "post" | "update";

export class SlackAgentRunStoreError extends Data.TaggedError("SlackAgentRunStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SlackAgentRunStoreShape {
  readonly createRunWithAcceptedDelivery: (input: {
    readonly runId?: SlackAgentRunId | string | undefined;
    readonly instanceId: SlackAgentInstanceId | string;
    readonly externalEventId: string;
    readonly workspaceId: string;
    readonly channelId: string;
    readonly channelName: string;
    readonly threadKey: string;
    readonly threadTs: string;
    readonly triggerTs: string;
    readonly snapshotJson: string;
    readonly snapshotSha256: string;
    readonly snapshotBytes: number;
    readonly ticketId: TicketId;
    readonly status: SlackAgentRunStatus;
    readonly acceptedPayloadJson: string;
    readonly nextAttemptAt?: string | null | undefined;
  }) => Effect.Effect<SlackAgentRunSummaryView, SlackAgentRunStoreError>;

  readonly getRun: (
    runId: SlackAgentRunId | string,
  ) => Effect.Effect<SlackAgentRunDetailView | null, SlackAgentRunStoreError>;

  readonly getRunSummary: (
    runId: SlackAgentRunId | string,
  ) => Effect.Effect<SlackAgentRunSummaryView | null, SlackAgentRunStoreError>;

  readonly getRunByTicketId: (
    ticketId: TicketId,
  ) => Effect.Effect<SlackAgentRunSummaryView | null, SlackAgentRunStoreError>;

  readonly findByExternalEvent: (
    instanceId: SlackAgentInstanceId | string,
    externalEventId: string,
  ) => Effect.Effect<SlackAgentRunSummaryView | null, SlackAgentRunStoreError>;

  readonly findBySourceThread: (
    instanceId: SlackAgentInstanceId | string,
    workspaceId: string,
    channelId: string,
    threadTs: string,
  ) => Effect.Effect<SlackAgentRunSummaryView | null, SlackAgentRunStoreError>;

  readonly enqueueDelivery: (input: {
    readonly runId: SlackAgentRunId | string;
    readonly workflowSequence: number;
    readonly kind: SlackAgentDeliveryKind;
    readonly operation: SlackAgentDeliveryOperation;
    readonly payloadJson: string;
    readonly nextAttemptAt?: string | null | undefined;
  }) => Effect.Effect<SlackAgentDeliveryView, SlackAgentRunStoreError>;

  readonly listDeliveries: (
    runId: SlackAgentRunId | string,
  ) => Effect.Effect<ReadonlyArray<SlackAgentDeliveryView>, SlackAgentRunStoreError>;

  readonly markDeliverySent: (
    deliveryId: SlackAgentDeliveryId | string,
    statusMessageId?: string | null | undefined,
  ) => Effect.Effect<void, SlackAgentRunStoreError>;

  readonly markDeliveryFailed: (
    deliveryId: SlackAgentDeliveryId | string,
    lastError: string,
    nextAttemptAt: string,
  ) => Effect.Effect<void, SlackAgentRunStoreError>;

  readonly markDeliverySuperseded: (
    deliveryId: SlackAgentDeliveryId | string,
  ) => Effect.Effect<void, SlackAgentRunStoreError>;

  readonly updateRunStatus: (input: {
    readonly runId: SlackAgentRunId | string;
    readonly status: SlackAgentRunStatus;
    readonly prUrl?: string | null | undefined;
    readonly statusMessageId?: string | null | undefined;
    readonly lastAppliedSequence?: number | undefined;
  }) => Effect.Effect<void, SlackAgentRunStoreError>;

  readonly pruneRunlessMockThreads: (
    cutoffIso: string,
  ) => Effect.Effect<number, SlackAgentRunStoreError>;
}

export class SlackAgentRunStore extends Context.Service<
  SlackAgentRunStore,
  SlackAgentRunStoreShape
>()("t3/workflow/Services/SlackAgentRunStore") {}

export type { SlackAgentDeliveryState, SlackAgentDeliveryView, SlackAgentRunDetailView };
