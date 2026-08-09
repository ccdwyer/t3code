import type {
  ModelSelection,
  ProjectId,
  SlackAgentBotUserId,
  SlackAgentConnectionState,
  SlackAgentHandle,
  SlackAgentInstanceId,
  SlackAgentInstanceView,
  SlackAgentProjectBinding,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export class SlackAgentInstanceStoreError extends Data.TaggedError("SlackAgentInstanceStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SlackAgentInstanceCredentials {
  readonly appToken: string;
  readonly botToken: string;
}

export interface SlackAgentRealIdentityInput {
  readonly workspaceId: string;
  readonly workspaceName?: string | null | undefined;
  readonly appId?: string | null | undefined;
  readonly botId?: string | null | undefined;
  readonly botUserId: SlackAgentBotUserId | string;
  readonly handle: SlackAgentHandle | string;
}

export interface SlackAgentInstanceStoreShape {
  readonly create: (input: {
    readonly workspaceId: string;
    readonly ownerLabel: string;
    readonly handleSuffix: string;
    readonly projectId: ProjectId;
    readonly projects?: ReadonlyArray<SlackAgentProjectBinding> | undefined;
    readonly defaultModelSelection?: ModelSelection | null | undefined;
    readonly ownerPrincipal?: string | null | undefined;
  }) => Effect.Effect<SlackAgentInstanceView, SlackAgentInstanceStoreError>;

  readonly createMock: (input: {
    readonly workspaceId: string;
    readonly ownerLabel: string;
    readonly handleSuffix: string;
    readonly projectId: ProjectId;
    readonly projects?: ReadonlyArray<SlackAgentProjectBinding> | undefined;
    readonly defaultModelSelection?: ModelSelection | null | undefined;
    readonly ownerPrincipal?: string | null | undefined;
  }) => Effect.Effect<SlackAgentInstanceView, SlackAgentInstanceStoreError>;

  readonly createReal: (input: {
    readonly identity: SlackAgentRealIdentityInput;
    readonly ownerLabel: string;
    readonly projectId: ProjectId;
    readonly projects?: ReadonlyArray<SlackAgentProjectBinding> | undefined;
    readonly defaultModelSelection?: ModelSelection | null | undefined;
    readonly appToken: string;
    readonly botToken: string;
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

  readonly readCredentials: (
    instanceId: SlackAgentInstanceId | string,
  ) => Effect.Effect<SlackAgentInstanceCredentials | null, SlackAgentInstanceStoreError>;

  readonly replaceCredentials: (
    instanceId: SlackAgentInstanceId | string,
    input: SlackAgentInstanceCredentials,
  ) => Effect.Effect<SlackAgentInstanceView, SlackAgentInstanceStoreError>;

  readonly disconnect: (
    instanceId: SlackAgentInstanceId | string,
  ) => Effect.Effect<SlackAgentInstanceView, SlackAgentInstanceStoreError>;

  readonly updateConnectionState: (
    instanceId: SlackAgentInstanceId | string,
    input: {
      readonly state: SlackAgentConnectionState;
      readonly connectedAt?: string | null | undefined;
      readonly lastError?: string | null | undefined;
    },
  ) => Effect.Effect<SlackAgentInstanceView, SlackAgentInstanceStoreError>;

  readonly update: (
    instanceId: SlackAgentInstanceId | string,
    input: {
      readonly ownerLabel?: string | undefined;
      readonly handleSuffix?: string | undefined;
      readonly projectId?: ProjectId | undefined;
      readonly projects?: ReadonlyArray<SlackAgentProjectBinding> | undefined;
      readonly defaultModelSelection?: ModelSelection | null | undefined;
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
}

export class SlackAgentInstanceStore extends Context.Service<
  SlackAgentInstanceStore,
  SlackAgentInstanceStoreShape
>()("t3/workflow/Services/SlackAgentInstanceStore") {}

export type { SlackAgentInstanceView, SlackAgentHandle };
