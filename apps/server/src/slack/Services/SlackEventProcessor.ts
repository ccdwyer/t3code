import type { SlackAgentInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { SlackSocketEnvelope } from "./SlackApi.ts";
import type { SlackAgentInstanceStoreError } from "../../workflow/Services/SlackAgentInstanceStore.ts";
import type { SlackAgentIntakeError } from "../../workflow/Services/SlackAgentIntake.ts";
import type { SlackAgentRunStoreError } from "../../workflow/Services/SlackAgentRunStore.ts";
import type { SlackApiError } from "./SlackApi.ts";

export class SlackEventProcessorError extends Schema.TaggedErrorClass<SlackEventProcessorError>()(
  "SlackEventProcessorError",
  {
    reason: Schema.Literals([
      "malformed_payload",
      "instance_not_found",
      "instance_not_enabled",
      "instance_not_real",
      "missing_credentials",
      "workspace_mismatch",
      "app_mismatch",
      "store_error",
      "slack_api_error",
      "intake_error",
    ]),
    message: Schema.String,
  },
) {}

export interface SlackEventProcessorInput {
  readonly instanceId: SlackAgentInstanceId | string;
  readonly envelope: SlackSocketEnvelope;
  readonly workflowAuthorized: boolean;
}

export interface SlackEventProcessorShape {
  readonly process: (
    input: SlackEventProcessorInput,
  ) => Effect.Effect<void, SlackEventProcessorError>;
}

export class SlackEventProcessor extends Context.Service<
  SlackEventProcessor,
  SlackEventProcessorShape
>()("t3/slack/Services/SlackEventProcessor") {}

export type SlackEventProcessorDependencyError =
  | SlackAgentInstanceStoreError
  | SlackAgentRunStoreError
  | SlackAgentIntakeError
  | SlackApiError;
