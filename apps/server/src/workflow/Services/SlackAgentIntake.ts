import type {
  MockSlackMessageId,
  MockSlackSourceMessage,
  MockSlackThreadRef,
  SlackAgentBotUserId,
  SlackAgentInstanceId,
  SlackAgentRunSummaryView,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";
import type { SlackAgentGatewayError } from "./SlackAgentGateway.ts";
import type { SlackAgentInstanceStoreError } from "./SlackAgentInstanceStore.ts";
import type { SlackAgentRunStoreError } from "./SlackAgentRunStore.ts";
import type { SlackThreadSnapshotError } from "../slack/slackThreadSnapshot.ts";
import type {
  SlackAgentDisabledInstanceError,
  SlackAgentInvalidTargetError,
  SlackAgentOversizedSnapshotError,
} from "@t3tools/contracts";

export interface SlackAgentMentionInput {
  readonly instanceId: SlackAgentInstanceId;
  readonly botUserId: SlackAgentBotUserId;
  readonly externalEventId: string;
  readonly thread: MockSlackThreadRef;
  readonly messages: ReadonlyArray<MockSlackSourceMessage>;
  readonly triggerMessageId: MockSlackMessageId;
}

export interface SlackAgentIntakeResult {
  readonly run: SlackAgentRunSummaryView;
  readonly duplicate: boolean;
  /** Deterministic mock message id reserved for the accepted delivery. */
  readonly statusMessageId: MockSlackMessageId;
  /** Explains idempotent replays without implying a later trigger was included. */
  readonly message?: string;
}

export type SlackAgentIntakeError =
  | SlackAgentDisabledInstanceError
  | SlackAgentInvalidTargetError
  | SlackAgentOversizedSnapshotError
  | SlackAgentGatewayError
  | SlackThreadSnapshotError
  | SlackAgentInstanceStoreError
  | SlackAgentRunStoreError
  | WorkflowEventStoreError;

export interface SlackAgentIntakeShape {
  readonly acceptMention: (
    input: SlackAgentMentionInput,
  ) => Effect.Effect<SlackAgentIntakeResult, SlackAgentIntakeError>;
}

export class SlackAgentIntake extends Context.Service<SlackAgentIntake, SlackAgentIntakeShape>()(
  "t3/workflow/Services/SlackAgentIntake",
) {}
