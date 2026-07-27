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
  /**
   * Monotonic within a step run: 0 = initial (and panel members), then
   * `max(seq) + 1` for every follow-up turn.
   *
   * It orders rows for the "latest turn" reads and NOTHING else — what a row IS
   * lives in `dispatchKind`, because a repair can now follow a question
   * continuation and so cannot be pinned to a fixed seq.
   */
  readonly dispatchSeq?: number;
  /** Absent = the initial turn. Follow-up turns say which kind they are. */
  readonly dispatchKind?: "repair" | "question-continuation";
}

/** Everything needed to build a follow-up DispatchRequest for an existing step. */
export interface DispatchAssembly {
  readonly ticketId: TicketId;
  readonly threadId: ThreadId;
  readonly providerInstance: string;
  readonly model: string;
  readonly worktreePath: string;
  readonly options?: ProviderOptionSelections | undefined;
  readonly projectId?: string | undefined;
  readonly threadTitle?: string | undefined;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "full-access" | undefined;
  readonly captureOutput?: boolean | undefined;
  readonly nextDispatchSeq: number;
  /**
   * How many question continuations this step run has already had.
   *
   * The continuation budget is counted from persisted dispatch rows rather than
   * from anything in the agent's output, so an agent cannot talk its way past
   * the cap by re-asking.
   */
  readonly questionContinuations: number;
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
    /** Must mirror the in-flight dispatch so steering cannot change permissions. */
    readonly runtimeMode: "approval-required" | "auto-accept-edits" | "full-access";
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
  /** Null only in the post-start window before the first turn id is observed. */
  readonly turnId: TurnId | null;
  readonly captureOutput: boolean;
  readonly panelSize: number | null;
  readonly steerPendingMessageId: string | null;
  /** Runtime mode the dispatch was started with; a steer must not change it. */
  readonly runtimeMode: string | null;
}

/** Staged delivered steer awaiting a durable `StepSteered` append. */
export interface StagedSteerDelivery {
  readonly dispatchId: DispatchId;
  readonly ticketId: TicketId;
  readonly stepRunId: StepRunId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
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
  /**
   * The seq-0 dispatch for a step, as the fields needed to build another one.
   *
   * A question continuation runs a fresh turn for a step whose original
   * execution context is gone — possibly on a different process after a
   * restart — so the assembly fields (worktree, options, runtime mode) have to
   * come from the persisted row rather than from an executor closure.
   * `nextDispatchSeq` is `max(seq) + 1` so a continuation never collides with a
   * repair or an earlier continuation.
   */
  readonly getDispatchRequestForStep: (
    stepRunId: StepRunId,
  ) => Effect.Effect<DispatchAssembly | null, WorkflowEventStoreError>;
  /** Latest started dispatch for a step, including steer reservation cells. */
  readonly getSteerTarget: (
    stepRunId: StepRunId,
  ) => Effect.Effect<SteerTarget | null, WorkflowEventStoreError>;
  /**
   * CAS: set `steer_pending_message_id` (+ text) only when currently null and
   * not tombstoned. Returns true when this caller won the reservation (or
   * already holds the same messageId).
   */
  readonly markSteerPending: (
    dispatchId: DispatchId,
    messageId: MessageId,
    text: string,
  ) => Effect.Effect<boolean, WorkflowEventStoreError>;
  /**
   * Clear pending only when it still matches `messageId` (never clobber a
   * newer reservation).
   */
  readonly clearSteerPending: (
    dispatchId: DispatchId,
    messageId: MessageId,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
  /**
   * On delivered receipt: bump ack columns, stage text for `StepSteered`,
   * clear pending (messageId-keyed). Returns true when this call staged a
   * new delivery (caller should append `StepSteered`).
   */
  readonly ackSteerDelivered: (
    dispatchId: DispatchId,
    messageId: MessageId,
  ) => Effect.Effect<boolean, WorkflowEventStoreError>;
  /** Rows with a staged delivery waiting for `StepSteered`. */
  readonly listStagedSteerDeliveries: () => Effect.Effect<
    ReadonlyArray<StagedSteerDelivery>,
    WorkflowEventStoreError
  >;
  /** Clear staged delivery after a successful `StepSteered` append. */
  readonly clearStagedSteerDelivery: (
    dispatchId: DispatchId,
    messageId: MessageId,
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
