import type {
  ApprovalRequestId,
  DispatchId,
  MessageId,
  ProviderOptionSelections,
  StepRunId,
  ThreadId,
  TicketId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface DispatchRequest {
  readonly dispatchId: DispatchId;
  readonly ticketId: TicketId;
  readonly stepRunId: StepRunId;
  readonly threadId: ThreadId;
  readonly providerInstance: string;
  readonly model: string;
  readonly instruction: string;
  readonly worktreePath: string;
  readonly options?: ProviderOptionSelections;
  // Project + title for the hidden thread shell that lets provider runtime
  // ingestion project this thread's turns/messages/activities. Without a
  // shell, ingestion drops the events and the turn never reaches a terminal
  // state from the workflow's perspective.
  readonly projectId?: string;
  readonly threadTitle?: string;
  // Defaults to "full-access" (worktree-isolated steps); intake runs at the
  // real project root and passes a stricter mode.
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "full-access";
  /** Dispatch-time step metadata for steer validation (TOCTOU-safe). */
  readonly captureOutput?: boolean;
  readonly panelSize?: number;
}

export interface ProviderTurnPortShape {
  readonly ensureTurnStarted: (
    req: DispatchRequest,
  ) => Effect.Effect<{ readonly turnId: TurnId }, WorkflowEventStoreError>;
  /**
   * Mid-run steer: durable `thread.turn.start` with commandId
   * `workflow-steer-<messageId>`. Implemented in live-agent-steering task 6.
   */
  readonly steerTurn?: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly text: string;
  }) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class ProviderTurnPort extends Context.Service<ProviderTurnPort, ProviderTurnPortShape>()(
  "t3/workflow/Services/ProviderDispatchOutbox/ProviderTurnPort",
) {}

/** Non-awaitingUser arms always carry the terminal turn id (steer-safe capture). */
export type ProviderDispatchTerminalResult =
  | { readonly ok: true; readonly turnId: TurnId }
  | { readonly ok: false; readonly turnId: TurnId; readonly error?: string }
  | {
      readonly ok: false;
      readonly awaitingUser: true;
      readonly waitingReason: string;
      readonly providerThreadId: ThreadId;
      readonly providerRequestId: ApprovalRequestId;
      readonly providerResponseKind: "request" | "user-input";
      readonly providerQuestionId?: string;
    };

export interface SteerTarget {
  readonly dispatchId: DispatchId;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly captureOutput: boolean;
  readonly panelSize: number | null;
  readonly steerPendingMessageId: string | null;
}

export interface ProviderDispatchOutboxShape {
  readonly confirmStep: (stepRunId: StepRunId) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly ensureStarted: (
    req: DispatchRequest,
  ) => Effect.Effect<{ readonly turnId: TurnId }, WorkflowEventStoreError>;
  readonly getDispatchForStep: (
    stepRunId: StepRunId,
  ) => Effect.Effect<
    { readonly threadId: ThreadId; readonly turnId: TurnId } | null,
    WorkflowEventStoreError
  >;
  /** Latest started dispatch for a step, including steer reservation cells. */
  readonly getSteerTarget: (
    stepRunId: StepRunId,
  ) => Effect.Effect<SteerTarget | null, WorkflowEventStoreError>;
  /**
   * CAS: set `steer_pending_message_id` only when currently null and not
   * tombstoned. Returns true when this caller won the reservation.
   */
  readonly markSteerPending: (
    dispatchId: DispatchId,
    messageId: MessageId,
  ) => Effect.Effect<boolean, WorkflowEventStoreError>;
  readonly clearSteerPending: (
    dispatchId: DispatchId,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  readonly awaitTerminal: (
    dispatchId: DispatchId,
    threadId: ThreadId,
  ) => Effect.Effect<ProviderDispatchTerminalResult, WorkflowEventStoreError>;
  readonly awaitStepTerminal: (
    stepRunId: StepRunId,
    threadId: ThreadId,
  ) => Effect.Effect<ProviderDispatchTerminalResult, WorkflowEventStoreError>;
  readonly recoverPending: () => Effect.Effect<void, WorkflowEventStoreError>;
}

export class ProviderDispatchOutbox extends Context.Service<
  ProviderDispatchOutbox,
  ProviderDispatchOutboxShape
>()("t3/workflow/Services/ProviderDispatchOutbox") {}
