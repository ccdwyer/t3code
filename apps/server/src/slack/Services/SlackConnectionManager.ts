import { type SlackAgentInstanceId, type SlackAgentInstanceView } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type { SlackAgentInstanceStoreError } from "../../workflow/Services/SlackAgentInstanceStore.ts";
import type { SlackEventProcessorError } from "../Services/SlackEventProcessor.ts";
import type { SlackApiError } from "./SlackApi.ts";

export const SlackConnectionManagerValidationMismatchReason = Schema.Literals([
  "workspace",
  "botUser",
  "app",
]);
export type SlackConnectionManagerValidationMismatchReason =
  typeof SlackConnectionManagerValidationMismatchReason.Type;

export class SlackConnectionManagerUnknownInstanceError extends Schema.TaggedErrorClass<SlackConnectionManagerUnknownInstanceError>()(
  "SlackConnectionManagerUnknownInstanceError",
  {
    instanceId: Schema.String,
    message: Schema.String,
  },
) {}

export class SlackConnectionManagerWrongKindError extends Schema.TaggedErrorClass<SlackConnectionManagerWrongKindError>()(
  "SlackConnectionManagerWrongKindError",
  {
    instanceId: Schema.String,
    kind: Schema.String,
    message: Schema.String,
  },
) {}

export class SlackConnectionManagerMissingCredentialsError extends Schema.TaggedErrorClass<SlackConnectionManagerMissingCredentialsError>()(
  "SlackConnectionManagerMissingCredentialsError",
  {
    instanceId: Schema.String,
    message: Schema.String,
  },
) {}

export class SlackConnectionManagerValidationMismatchError extends Schema.TaggedErrorClass<SlackConnectionManagerValidationMismatchError>()(
  "SlackConnectionManagerValidationMismatchError",
  {
    instanceId: Schema.String,
    field: SlackConnectionManagerValidationMismatchReason,
    expected: Schema.String,
    actual: Schema.String,
    message: Schema.String,
  },
) {}

export class SlackConnectionManagerStateError extends Data.TaggedError(
  "SlackConnectionManagerStateError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type SlackConnectionManagerError =
  | SlackConnectionManagerUnknownInstanceError
  | SlackConnectionManagerWrongKindError
  | SlackConnectionManagerMissingCredentialsError
  | SlackConnectionManagerValidationMismatchError
  | SlackConnectionManagerStateError
  | SlackApiError
  | SlackAgentInstanceStoreError
  | SlackEventProcessorError;

export interface SlackConnectionManagerShape {
  readonly startAll: (
    workflowAuthorized: boolean,
  ) => Effect.Effect<void, SlackConnectionManagerError>;
  readonly startInstance: (
    instanceId: SlackAgentInstanceId,
  ) => Effect.Effect<void, SlackConnectionManagerError>;
  readonly stopInstance: (instanceId: SlackAgentInstanceId) => Effect.Effect<void>;
  readonly restartInstance: (
    instanceId: SlackAgentInstanceId,
  ) => Effect.Effect<void, SlackConnectionManagerError>;
  readonly testInstance: (
    instanceId: SlackAgentInstanceId,
  ) => Effect.Effect<SlackAgentInstanceView, SlackConnectionManagerError>;
}

export class SlackConnectionManager extends Context.Service<
  SlackConnectionManager,
  SlackConnectionManagerShape
>()("t3/slack/Services/SlackConnectionManager") {}
