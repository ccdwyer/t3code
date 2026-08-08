import type {
  BoardId,
  LaneKey,
  ProjectId,
  SlackAgentBotUserId,
  SlackAgentHandle,
  SlackAgentInstanceId,
  SlackAgentInstanceView,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export class SlackAgentInstanceStoreError extends Data.TaggedError("SlackAgentInstanceStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SlackAgentInstanceStoreShape {
  readonly create: (input: {
    readonly workspaceId: string;
    readonly ownerLabel: string;
    readonly handleSuffix: string;
    readonly projectId: ProjectId;
    readonly boardId: BoardId;
    readonly initialLane: LaneKey;
    readonly ownerPrincipal?: string | null | undefined;
  }) => Effect.Effect<SlackAgentInstanceView, SlackAgentInstanceStoreError>;

  readonly list: (
    workspaceId?: string | undefined,
  ) => Effect.Effect<ReadonlyArray<SlackAgentInstanceView>, SlackAgentInstanceStoreError>;

  readonly get: (
    instanceId: SlackAgentInstanceId | string,
  ) => Effect.Effect<SlackAgentInstanceView | null, SlackAgentInstanceStoreError>;

  readonly getEnabledByBotUserId: (
    workspaceId: string,
    botUserId: SlackAgentBotUserId | string,
  ) => Effect.Effect<SlackAgentInstanceView | null, SlackAgentInstanceStoreError>;

  readonly update: (
    instanceId: SlackAgentInstanceId | string,
    input: {
      readonly ownerLabel?: string | undefined;
      readonly handleSuffix?: string | undefined;
      readonly projectId?: ProjectId | undefined;
      readonly boardId?: BoardId | undefined;
      readonly initialLane?: LaneKey | undefined;
    },
  ) => Effect.Effect<SlackAgentInstanceView, SlackAgentInstanceStoreError>;

  readonly disable: (
    instanceId: SlackAgentInstanceId | string,
  ) => Effect.Effect<SlackAgentInstanceView, SlackAgentInstanceStoreError>;

  readonly enable: (
    instanceId: SlackAgentInstanceId | string,
  ) => Effect.Effect<SlackAgentInstanceView, SlackAgentInstanceStoreError>;

  readonly delete: (
    instanceId: SlackAgentInstanceId | string,
  ) => Effect.Effect<void, SlackAgentInstanceStoreError>;

  readonly disableForBoard: (boardId: BoardId) => Effect.Effect<void, SlackAgentInstanceStoreError>;
}

export class SlackAgentInstanceStore extends Context.Service<
  SlackAgentInstanceStore,
  SlackAgentInstanceStoreShape
>()("t3/workflow/Services/SlackAgentInstanceStore") {}

export type { SlackAgentInstanceView, SlackAgentHandle };
