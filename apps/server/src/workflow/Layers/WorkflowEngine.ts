import type {
  BoardId,
  LaneEntryToken,
  LaneKey,
  MessageId,
  PipelineRunId,
  StepKey,
  StepOutcome,
  StepRunId,
  TicketAttachment,
  ThreadId,
  TicketId,
  TurnId,
  WorkflowEventId,
  WorkflowLane,
  WorkflowParkTarget,
  WorkflowStep,
  WorkflowStepUsage,
  WorkflowContextPackSection,
  WorkflowContextPackSectionKey,
  CheckpointForm,
} from "@t3tools/contracts";
import {
  applyTotalCap,
  canonicalizeSubmittedSections,
  redactAndCap,
  sectionsEqual,
} from "../contextPack.ts";
import { isParkTarget, PARK_ACTION_DRIFT_MESSAGES } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ApprovalGate, type CheckpointResolution } from "../Services/ApprovalGate.ts";
import { validateCheckpointSubmission } from "@t3tools/contracts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { CapturedStepOutputReader } from "../Services/CapturedStepOutputReader.ts";
import { WorkflowEventStoreError, WorkflowEventStoreErrorCode } from "../Services/Errors.ts";
import { PredicateEvaluator } from "../Services/PredicateEvaluator.ts";
import { ProviderDispatchOutbox, ProviderTurnPort } from "../Services/ProviderDispatchOutbox.ts";
import { ProviderResponsePort } from "../Services/ProviderResponsePort.ts";
import { frameSteerText, STEER_REJECTION } from "../steerHelpers.ts";
import {
  classifyFallback,
  decideRetry,
  TURN_TIMEOUT_LITERAL,
  type FailureClass,
} from "../failureClass.ts";
import { WorktreeCoordinator } from "../Services/WorktreeCoordinator.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor } from "../Services/StepExecutor.ts";
import { StepUsageReader } from "../Services/StepUsageReader.ts";
import { TurnStateReader, type TurnState } from "../Services/TurnStateReader.ts";
import { WorkflowAgentSessionStore } from "../Services/WorkflowAgentSessionStore.ts";
import {
  WorkflowEngine,
  type RecoveredStepResult,
  type WorkflowEngineShape,
} from "../Services/WorkflowEngine.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import {
  WorkflowEventStore,
  type PersistedWorkflowEvent,
  type WorkflowEventInput,
} from "../Services/WorkflowEventStore.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { ContextPackCompiler } from "../Services/ContextPackCompiler.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import {
  WorkflowRoutingContextBuilder,
  type WorkflowRoutingContext,
} from "../Services/WorkflowRoutingContextBuilder.ts";
import {
  AGENT_QUESTIONS_KEY,
  QUESTION_CONTINUE_VALUE,
  mapAgentQuestions,
  questionsWaitingReason,
} from "../agentQuestions.ts";
import { ruleReferencesRunCount } from "../jsonLogicRule.ts";
import { validateStepOutput } from "../stepOutputContract.ts";
import { resolveParkActions } from "../parkActions.ts";
import { buildParkOrigin } from "../parkOrigin.ts";
import { MAX_TICKET_MESSAGE_BODY_LENGTH, truncateTicketMessageBody } from "../ticketMessageBody.ts";
import { isParallelismHoldReason } from "../worktreeOverlap.ts";
import { ForkJoinCoordinator } from "../Services/ForkJoinCoordinator.ts";
import {
  exceedsForkDepth,
  MAX_FORK_DEPTH,
  nextForkDepth,
  renderForkChildTitle,
} from "../forkSpawnHelpers.ts";

type PipelineResult = "success" | "failure" | "blocked";
type StepResult = "completed" | "failed" | "blocked" | "awaiting_children";
type RouteSource = "step_on" | "lane_transition" | "lane_on";
type MoveReason = "manual" | "routed" | "initial" | "external" | "sla";
type EscalateTicketSlaResult = "escalated" | "queued" | "notified" | "stale";
const MAX_LIFETIME_SLA_ESCALATIONS = 25;
const MIN_SLA_BUDGET_MS = 60_000;

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const toEngineSqlError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "workflow engine sql failed", cause });
const wrapSql = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toEngineSqlError));

const alreadyStoppedProviderErrorTags = new Set([
  "ProviderSessionNotFoundError",
  "ProviderAdapterSessionNotFoundError",
  "ProviderAdapterSessionClosedError",
]);

const providerErrorTag = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null || !("_tag" in cause)) {
    return null;
  }
  const tag = (cause as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : null;
};

const isAlreadyStoppedProviderError = (cause: unknown) => {
  const tag = providerErrorTag(cause);
  if (tag !== null && alreadyStoppedProviderErrorTags.has(tag)) {
    return true;
  }
  if (!(cause instanceof Error)) {
    return false;
  }
  return /(?:no active (?:provider )?(?:session|turn)|unknown provider thread|unknown .* adapter thread|adapter thread is closed)/i.test(
    cause.message,
  );
};

const providerCleanupAttempt = <A, E>(
  effect: Effect.Effect<A, E>,
  message: string,
): Effect.Effect<WorkflowEventStoreError | null> =>
  effect.pipe(
    Effect.as(null),
    Effect.catch((cause) =>
      isAlreadyStoppedProviderError(cause)
        ? Effect.succeed(null)
        : Effect.succeed(new WorkflowEventStoreError({ message, cause })),
    ),
  );

const stepCompletedPayload = (
  stepRunId: StepRunId,
  output?: unknown,
  usage?: WorkflowStepUsage,
  outputRepaired?: boolean,
) => ({
  stepRunId,
  ...(output === undefined ? {} : { output }),
  ...(usage === undefined ? {} : { usage }),
  ...(outputRepaired === undefined ? {} : { outputRepaired }),
});

const stepFailedPayload = (
  stepRunId: StepRunId,
  error: string,
  usage?: WorkflowStepUsage,
  retryable?: boolean,
  contractViolation?: boolean,
  failureClass?: import("@t3tools/contracts").WorkflowFailureClass,
) => ({
  stepRunId,
  error,
  ...(retryable === undefined ? {} : { retryable }),
  ...(usage === undefined ? {} : { usage }),
  ...(contractViolation === undefined ? {} : { contractViolation }),
  ...(failureClass === undefined ? {} : { failureClass }),
});

const MAX_TICKET_ANSWER_BODY_LENGTH = MAX_TICKET_MESSAGE_BODY_LENGTH;
const MAX_TICKET_ANSWER_ATTACHMENT_COUNT = 6;
const MAX_TICKET_ANSWER_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const SAFE_TICKET_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const SAFE_TICKET_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,/i;

type PendingWait = Extract<PersistedWorkflowEvent, { readonly type: "StepAwaitingUser" }>;
type StepStarted = Extract<PersistedWorkflowEvent, { readonly type: "StepStarted" }>;
type PipelineStarted = Extract<PersistedWorkflowEvent, { readonly type: "PipelineStarted" }>;
type TicketCreated = Extract<PersistedWorkflowEvent, { readonly type: "TicketCreated" }>;
type UnstampedWorkflowEventInput = WorkflowEventInput extends infer Event
  ? Event extends WorkflowEventInput
    ? Omit<Event, "eventId" | "occurredAt">
    : never
  : never;

interface ActivePipeline {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly laneEntryToken: LaneEntryToken;
}

interface StepTicketRow {
  readonly ticketId: TicketId;
}

interface StepAwaitingStateRow {
  readonly status: string;
  readonly providerResponseKind: "request" | "user-input" | null;
}

interface PipelineRunForTokenRow {
  readonly pipelineRunId: PipelineRunId;
}

interface ActiveProviderTurnRow {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
}

// The engine-local routing decision. A plain lane move is `kind: "lane"`; a
// park-in-place is `kind: "park"`, carrying the resolved park target and its
// built origin JSON. Only lane decisions ever become a `TicketRouteDecided`
// event — a park is recorded solely by `TicketParked` (see parkTicket).
interface LaneRouteDecision {
  readonly kind: "lane";
  readonly toLane: LaneKey;
  readonly source: RouteSource;
  readonly matchedTransitionIndex?: number;
}

interface ParkRouteDecision {
  readonly kind: "park";
  readonly target: WorkflowParkTarget;
  readonly source: RouteSource;
  // Informational only — never trusted for identity/re-resolution (the origin
  // fingerprint is identity). Kept so the reason string can name the transition.
  readonly matchedTransitionIndex?: number;
  readonly parkOrigin: string;
}

type RouteDecision = LaneRouteDecision | ParkRouteDecision;

interface CaptureTurn {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
}

interface PipelineStartAction {
  readonly ticketId: TicketId;
  readonly boardId: BoardId;
  readonly lane: WorkflowLane;
  readonly laneEntryToken: LaneEntryToken;
}

interface RoutedEnterLaneOptions {
  readonly routeDecision: LaneRouteDecision;
  readonly contextSnapshot: WorkflowRoutingContext;
  readonly expectedToken: LaneEntryToken;
  readonly pipelineRunId: PipelineRunId;
  readonly fromLane: WorkflowLane;
  /**
   * Handoff sections compiled by the CALLER, before the admission lock. They are
   * compiled outside the lock on purpose: the git stat behind `diff_summary` can
   * take seconds, and running it here would stall admission and WIP decisions for
   * every ticket on the board. Empty means no pack event is emitted.
   */
  readonly contextPackSections?: ReadonlyArray<WorkflowContextPackSection> | undefined;
}

interface ExternalEnterLaneOptions {
  // The lane the matcher was evaluated against — a concurrent move makes the
  // decision stale and the external move becomes a no-op.
  readonly expectedFromLane: LaneKey;
  readonly routeEvent: UnstampedWorkflowEventInput;
  // Re-runs matcher resolution under the admission lock: a board save between
  // evaluation and commit may have removed the matcher or the target lane.
  readonly revalidate: Effect.Effect<boolean, WorkflowEventStoreError>;
}

const pipelineResultForStep = (result: StepResult): PipelineResult => {
  if (result === "completed") {
    return "success";
  }
  if (result === "awaiting_children") {
    // Should not be mapped into route decisions — completePipelineFrom returns early.
    return "blocked";
  }
  return result === "blocked" ? "blocked" : "failure";
};

const routingKeyForResult = (result: PipelineResult): "success" | "failure" | "blocked" =>
  result === "failure" ? "failure" : result;

const stepRouteDecision = (step: WorkflowStep, result: PipelineResult): RouteDecision | null => {
  const routingKey = routingKeyForResult(result);
  const target = step.on?.[routingKey];
  if (target === undefined) {
    return null;
  }
  if (isParkTarget(target)) {
    return {
      kind: "park",
      target,
      source: "step_on",
      parkOrigin: buildParkOrigin({ src: "step", target, stepKey: step.key, key: routingKey }),
    } satisfies RouteDecision;
  }
  return { kind: "lane", toLane: target, source: "step_on" } satisfies RouteDecision;
};

const PARK_REASON_MAX_LENGTH = 200;

const truncateReason = (text: string): string =>
  text.length > PARK_REASON_MAX_LENGTH ? text.slice(0, PARK_REASON_MAX_LENGTH) : text;

// The human-readable reason recorded on a park. Sourced from the actual cause:
// the failing step's error/blocked text, the review-budget exhaustion count, or
// the malformed-verdict "no matching transition" case.
const parkReason = (
  decision: ParkRouteDecision,
  result: PipelineResult,
  failureDetail: string | undefined,
  lane: WorkflowLane,
  context: WorkflowRoutingContext,
): string => {
  if (decision.source === "lane_transition") {
    const index = decision.matchedTransitionIndex;
    const transition = index === undefined ? undefined : (lane.transitions ?? [])[index];
    // A transition whose predicate consults lane.runCount is a review-budget
    // guard — report the exhaustion with the pass count from the eval context.
    const isBudgetGuard = transition !== undefined && ruleReferencesRunCount(transition.when);
    if (isBudgetGuard) {
      return `review budget exhausted after ${context.lane.runCount} passes`;
    }
    return index === undefined ? "transition matched" : `transition matched (index ${index})`;
  }
  // step_on / lane_on parks: report the failing step's cause, or the
  // no-matching-transition case when the pipeline succeeded.
  if (result === "blocked") {
    return truncateReason(failureDetail ?? "pipeline blocked with no route");
  }
  if (result === "failure") {
    return truncateReason(failureDetail ?? "pipeline failed with no route");
  }
  return decision.source === "step_on"
    ? "step routed on success"
    : "pipeline succeeded with no matching transition";
};

interface StepRunOutcome {
  readonly result: StepResult;
  // User rejections (approval reject / awaiting-user reject) and explicit
  // cancellations must never be retried — the user already said no.
  readonly noRetry: boolean;
  // Human-readable cause of a non-success outcome: the failure error text, the
  // blocked reason, or a fixed marker like `rejected`. Used to build a park
  // reason when the pipeline parks in place.
  readonly detail?: string | undefined;
  /**
   * Worktree serialize hold (SPEC §2.4): ticket stays in lane with its entry
   * token; completePipelineFrom must NOT run step/lane on.blocked routing.
   * TicketBlocked is still emitted for attention.
   */
  readonly parallelismHold?: boolean;
  /** Closed taxonomy class for failed outcomes (feeds decideRetry). */
  readonly failureClass?: FailureClass | undefined;
  /** Explicit retryable flag from StepOutcome when present. */
  readonly retryable?: boolean | undefined;
  /** Failed step run id — needed for StepRetryScheduled payload. */
  readonly stepRunId?: StepRunId;
  readonly stepKey?: StepKey;
}

// Defensive clamp so a hand-edited workflow file cannot retry unboundedly;
// the linter enforces 2..5 at save time.
const MAX_RETRY_ATTEMPTS = 5;

const retryAttemptsForStep = (step: WorkflowStep): number => {
  const retryPolicy = step.type === "agent" || step.type === "script" ? step.retry : undefined;
  if (retryPolicy === undefined) {
    return 1;
  }
  return Math.min(Math.max(1, retryPolicy.maxAttempts), MAX_RETRY_ATTEMPTS);
};

const stepForAttempt = (step: WorkflowStep, attempt: number): WorkflowStep => {
  if (attempt === 1 || step.type !== "agent" || step.retry?.escalate === undefined) {
    return step;
  }
  const escalate = step.retry.escalate;
  return {
    ...step,
    agent: {
      ...step.agent,
      ...(escalate.instance === undefined ? {} : { instance: escalate.instance }),
      ...(escalate.model === undefined ? {} : { model: escalate.model }),
      ...(escalate.options === undefined ? {} : { options: escalate.options }),
    },
  };
};

const make = Effect.gen(function* () {
  const approvals = yield* ApprovalGate;
  const scriptCancels = yield* ScriptCancelRegistry;
  const committer = yield* WorkflowEventCommitter;
  const executor = yield* StepExecutor;
  const ids = yield* WorkflowIds;
  const predicates = yield* PredicateEvaluator;
  const read = yield* WorkflowReadModel;
  const registry = yield* BoardRegistry;
  const routingContextBuilder = yield* WorkflowRoutingContextBuilder;
  const forkJoinOption = yield* Effect.serviceOption(ForkJoinCoordinator);
  const worktreeCoordOption = yield* Effect.serviceOption(WorktreeCoordinator);
  // Optional: a runtime without it simply routes without handoff packs, which is
  // what every engine test layer that predates the feature expects.
  const contextPackCompilerOption = yield* Effect.serviceOption(ContextPackCompiler);
  const sql = yield* SqlClient.SqlClient;
  const boardSemaphores = yield* SynchronizedRef.make<
    Map<string, { readonly semaphore: Semaphore.Semaphore; readonly permits: number }>
  >(new Map());
  const admissionSemaphores = yield* SynchronizedRef.make<Map<string, Semaphore.Semaphore>>(
    new Map(),
  );
  const runningPipelines = yield* SynchronizedRef.make<Map<string, ActivePipeline>>(new Map());
  // One recovery continuation per step run per process: the dispatch monitors
  // and the stranded-pipeline sweep can race to recover the same step.
  const recoveredStepClaims = yield* SynchronizedRef.make<Set<string>>(new Set());

  const getOptionalServices = Effect.context<never>().pipe(
    Effect.map((context) => ({
      providerResponses: Context.getOption(
        context as Context.Context<ProviderResponsePort>,
        ProviderResponsePort,
      ),
      providerDispatches: Context.getOption(
        context as Context.Context<ProviderDispatchOutbox>,
        ProviderDispatchOutbox,
      ),
      providerTurnPort: Context.getOption(
        context as Context.Context<ProviderTurnPort>,
        ProviderTurnPort,
      ),
      providerService: Context.getOption(
        context as Context.Context<ProviderService>,
        ProviderService,
      ),
      turnStateReader: Context.getOption(
        context as Context.Context<TurnStateReader>,
        TurnStateReader,
      ),
      capturedOutputs: Context.getOption(
        context as Context.Context<CapturedStepOutputReader>,
        CapturedStepOutputReader,
      ),
      usageReader: Context.getOption(context as Context.Context<StepUsageReader>, StepUsageReader),
      store: Context.getOption(context as Context.Context<WorkflowEventStore>, WorkflowEventStore),
      agentSessions: Context.getOption(
        context as Context.Context<WorkflowAgentSessionStore>,
        WorkflowAgentSessionStore,
      ),
    })),
  );

  // Best-effort live stop of a set of stored agent-session threads. `stopSession`
  // is a NON-rollbackable live side effect (it kills the provider session AND
  // does a `directory.upsert` SQL write), so it MUST run OUTSIDE any transaction.
  // The public move path calls this in-band (no chunk tx is open). The unlocked
  // source-close/create path snapshots the threads in-tx and defers this to the
  // committer's post-commit phase (see `stopAgentSessionsForTicket`). Best-effort:
  // a missing provider or a stop error is swallowed.
  const stopAgentSessionThreads = (threadIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (threadIds.length === 0) {
        return;
      }
      const { providerService } = yield* getOptionalServices;
      if (Option.isNone(providerService)) {
        return;
      }
      const provider = providerService.value;
      yield* Effect.forEach(
        threadIds,
        (threadId) =>
          providerCleanupAttempt(
            provider.stopSession({ threadId: threadId as ThreadId }),
            "workflow agent session stop failed",
          ),
        { discard: true },
      );
    });

  // A terminal lane is the ticket's resting place: its per-agent sessions can
  // never be resumed again, so drop the stored rows (tx-safe SQL) and — on the
  // public path — stop their live provider sessions. This MUST NOT fail the lane
  // transition — a missing store, a provider error, or a delete failure is
  // swallowed.
  //
  // `stopProviderSessions` gates the live `stopSession` calls. The public move
  // runs them IN-BAND (true) because no chunk transaction is open. The unlocked
  // source committer path passes `false`: only the tx-safe `deleteByTicket` runs
  // here (inside the chunk tx), and the committer collects the threads BEFORE the
  // close and stops them in its POST-COMMIT phase, so the non-rollbackable live
  // stop never runs inside the chunk transaction (mirrors how `boardDeletion`
  // lists-before / deletes-in-tx / stops-after-commit).
  const tearDownTicketAgentSessions = (ticketId: TicketId, stopProviderSessions: boolean) =>
    Effect.gen(function* () {
      const { agentSessions } = yield* getOptionalServices;
      if (Option.isNone(agentSessions)) {
        return;
      }
      const sessions = agentSessions.value;
      if (stopProviderSessions) {
        const rows = yield* sessions.listByTicket(ticketId).pipe(Effect.orElseSucceed(() => []));
        yield* stopAgentSessionThreads(rows.map((row) => row.threadId));
      }
      yield* sessions.deleteByTicket(ticketId).pipe(Effect.catch(() => Effect.void));
    });

  const ticketIdForStepRun = (stepRunId: StepRunId) =>
    wrapSql(sql<StepTicketRow>`
      SELECT ticket_id AS "ticketId"
      FROM projection_step_run
      WHERE step_run_id = ${stepRunId}
      UNION ALL
      SELECT ticket_id AS "ticketId"
      FROM workflow_events
      WHERE event_type = 'StepAwaitingUser'
        AND json_extract(payload_json, '$.stepRunId') = ${stepRunId}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0]?.ticketId ?? null));

  const awaitingStateForStepRun = (stepRunId: StepRunId) =>
    wrapSql(sql<StepAwaitingStateRow>`
      SELECT
        status,
        provider_response_kind AS "providerResponseKind"
      FROM projection_step_run
      WHERE step_run_id = ${stepRunId}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const readStoredEventsForStep = (stepRunId: StepRunId) =>
    Effect.gen(function* () {
      const { store } = yield* getOptionalServices;
      if (Option.isNone(store)) {
        return null;
      }

      const ticketId = yield* ticketIdForStepRun(stepRunId);
      if (ticketId === null) {
        return null;
      }

      return yield* Stream.runCollect(store.value.readByTicket(ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
    });

  const pendingWaitInEvents = (
    events: ReadonlyArray<PersistedWorkflowEvent>,
    stepRunId: StepRunId,
  ) => {
    let pending: PendingWait | null = null;
    for (const event of events) {
      if (event.type === "StepAwaitingUser" && event.payload.stepRunId === stepRunId) {
        pending = event;
        continue;
      }
      if (event.type === "StepUserResolved" && event.payload.stepRunId === stepRunId) {
        pending = null;
      }
    }
    return pending;
  };

  const isLiveProviderUserInputWait = (pending: PendingWait, state: TurnState) => {
    if (
      state._tag !== "awaiting_user" ||
      state.providerResponseKind !== "user-input" ||
      pending.payload.providerResponseKind !== "user-input" ||
      pending.payload.providerThreadId === undefined ||
      pending.payload.providerRequestId === undefined
    ) {
      return false;
    }

    return (
      String(state.providerThreadId) === String(pending.payload.providerThreadId) &&
      String(state.providerRequestId) === String(pending.payload.providerRequestId) &&
      (state.providerQuestionId ?? null) === (pending.payload.providerQuestionId ?? null)
    );
  };

  const ensureLiveProviderUserInputWait = (pending: PendingWait | null) =>
    Effect.gen(function* () {
      if (
        pending?.payload.providerResponseKind !== "user-input" ||
        pending.payload.providerThreadId === undefined ||
        pending.payload.providerRequestId === undefined
      ) {
        return;
      }

      const { providerDispatches, turnStateReader } = yield* getOptionalServices;
      if (Option.isNone(turnStateReader)) {
        if (Option.isSome(providerDispatches)) {
          return yield* new WorkflowEventStoreError({
            message:
              "provider user-input request is not live yet; retry after recovery refreshes it",
          });
        }
        return;
      }

      const state = yield* turnStateReader.value.read(pending.payload.providerThreadId);
      if (isLiveProviderUserInputWait(pending, state)) {
        return;
      }

      return yield* new WorkflowEventStoreError({
        message: "provider user-input request is not live yet; retry after recovery refreshes it",
      });
    });

  const hasTerminalStepEvent = (
    events: ReadonlyArray<PersistedWorkflowEvent>,
    stepRunId: StepRunId,
  ) =>
    events.some(
      (event) =>
        (event.type === "StepCompleted" ||
          event.type === "StepFailed" ||
          event.type === "StepBlocked") &&
        event.payload.stepRunId === stepRunId,
    );

  const hasPipelineCompletedEvent = (
    events: ReadonlyArray<PersistedWorkflowEvent>,
    pipelineRunId: PipelineRunId,
  ) =>
    events.some(
      (event) =>
        event.type === "PipelineCompleted" && event.payload.pipelineRunId === pipelineRunId,
    );

  const pendingWaitFor = (stepRunId: StepRunId) =>
    Effect.gen(function* () {
      const events = yield* readStoredEventsForStep(stepRunId);
      if (events === null) {
        return null;
      }
      return pendingWaitInEvents(events, stepRunId);
    });

  const ticketAnswerAttachmentBytes = (attachments: ReadonlyArray<TicketAttachment>) =>
    attachments.reduce((total, attachment) => {
      if (attachment.kind !== "image") {
        return total;
      }
      return total + new TextEncoder().encode(attachment.dataUrl).byteLength;
    }, 0);

  const semaphoreFor = (boardId: BoardId, permits: number) =>
    SynchronizedRef.modifyEffect(boardSemaphores, (current) => {
      const key = boardId as string;
      const existing = current.get(key);
      if (existing && existing.permits === permits) {
        return Effect.succeed([existing.semaphore, current] as const);
      }

      // Effect semaphores are not resizable, so a changed maxConcurrentTickets
      // swaps in a fresh semaphore. In-flight holders drain on the old
      // semaphore and are invisible to the new one, so total concurrency can
      // transiently exceed the new limit (whether raised or lowered) until
      // they finish — bounded by the previously running pipelines and
      // self-correcting, which is accepted here.
      return Semaphore.make(permits).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(key, { semaphore, permits });
          return [semaphore, next] as const;
        }),
      );
    });

  const admissionSemaphoreFor = (boardId: BoardId) =>
    SynchronizedRef.modifyEffect(admissionSemaphores, (current) => {
      const key = boardId as string;
      const existing = current.get(key);
      if (existing) {
        return Effect.succeed([existing, current] as const);
      }

      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(key, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const withAdmissionLock = <A, E, R>(
    boardId: BoardId,
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const semaphore = yield* admissionSemaphoreFor(boardId);
      return yield* semaphore.withPermits(1)(body);
    });

  // Public exposure of the per-board admission semaphore (the WIP read-decide
  // serializer). Reuses the SAME `admissionSemaphores` instance via
  // `withAdmissionLock` — there is no second semaphore map. The source committer
  // MUST wrap its chunk in this (OUTER) -> the board save lock (INNER) -> the
  // transaction, matching the public enterLane lock order (admission->save), so
  // its sync admits serialize against concurrent user moves and cannot violate a
  // WIP limit. The unlocked enterLane cores assume this is already held.
  const withBoardAdmissionLock: WorkflowEngineShape["withBoardAdmissionLock"] = (boardId, effect) =>
    withAdmissionLock(boardId, effect);

  const commit = (
    event: UnstampedWorkflowEventInput,
    precondition?: Effect.Effect<void, WorkflowEventStoreError>,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const eventId = yield* ids.eventId();
      yield* committer.commit(
        {
          ...event,
          eventId: eventId as WorkflowEventId,
          occurredAt: (yield* nowIso) as never,
        } as WorkflowEventInput,
        precondition,
      );
    });

  const commitMany = (
    events: ReadonlyArray<UnstampedWorkflowEventInput>,
    precondition?: Effect.Effect<void, WorkflowEventStoreError>,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const stamped: Array<WorkflowEventInput> = [];
      for (const event of events) {
        const eventId = yield* ids.eventId();
        stamped.push({
          ...event,
          eventId: eventId as WorkflowEventId,
          occurredAt: (yield* nowIso) as never,
        } as WorkflowEventInput);
      }
      yield* committer.commitMany(stamped, precondition);
    });

  const userInputPromptMessageEvent = (
    ticketId: TicketId,
    stepRunId: StepRunId,
    body: string,
  ): Effect.Effect<UnstampedWorkflowEventInput, never> =>
    Effect.gen(function* () {
      const messageId = yield* ids.messageId();
      const createdAt = yield* nowIso;
      return {
        type: "TicketMessagePosted",
        ticketId,
        payload: {
          messageId: messageId as MessageId,
          stepRunId,
          author: "agent",
          body: truncateTicketMessageBody(body),
          attachments: [],
          createdAt: createdAt as never,
        },
      } satisfies UnstampedWorkflowEventInput;
    });

  const awaitingUserEvents = (
    ticketId: TicketId,
    event: Extract<UnstampedWorkflowEventInput, { readonly type: "StepAwaitingUser" }>,
  ): Effect.Effect<ReadonlyArray<UnstampedWorkflowEventInput>, never> =>
    Effect.gen(function* () {
      if (event.payload.providerResponseKind !== "user-input") {
        return [event];
      }
      const message = yield* userInputPromptMessageEvent(
        ticketId,
        event.payload.stepRunId,
        event.payload.waitingReason,
      );
      return [event, message];
    });

  const currentToken = (ticketId: TicketId) =>
    read
      .getTicketDetail(ticketId)
      .pipe(Effect.map((detail) => detail?.ticket.currentLaneEntryToken ?? null));

  const evaluateTransition = (rule: unknown, context: WorkflowRoutingContext) =>
    predicates.evaluate(rule, context).pipe(
      Effect.mapError(
        (cause) =>
          new WorkflowEventStoreError({
            message: "workflow route predicate evaluation failed",
            cause,
          }),
      ),
    );

  const laneTransitionDecision = (
    lane: WorkflowLane,
    context: WorkflowRoutingContext,
  ): Effect.Effect<RouteDecision | null, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const transitions = lane.transitions ?? [];
      for (const [index, transition] of transitions.entries()) {
        const evaluation = yield* evaluateTransition(transition.when, context);
        if (evaluation.result) {
          if (isParkTarget(transition.to)) {
            return {
              kind: "park",
              target: transition.to,
              source: "lane_transition",
              matchedTransitionIndex: index,
              // No index in the origin — identity is the fingerprint so a
              // transition inserted above cannot silently rebind the park.
              parkOrigin: buildParkOrigin({ src: "transition", target: transition.to }),
            } satisfies RouteDecision;
          }
          return {
            kind: "lane",
            toLane: transition.to,
            source: "lane_transition",
            matchedTransitionIndex: index,
          } satisfies RouteDecision;
        }
      }
      return null;
    });

  const laneOnDecision = (lane: WorkflowLane, result: PipelineResult): RouteDecision | null => {
    const routingKey = routingKeyForResult(result);
    const target = lane.on?.[routingKey];
    if (target === undefined) {
      return null;
    }
    if (isParkTarget(target)) {
      return {
        kind: "park",
        target,
        source: "lane_on",
        parkOrigin: buildParkOrigin({ src: "lane_on", target, key: routingKey }),
      } satisfies RouteDecision;
    }
    return { kind: "lane", toLane: target, source: "lane_on" } satisfies RouteDecision;
  };

  const routeDecisionEvent = (
    ticketId: TicketId,
    pipelineRunId: PipelineRunId,
    lane: WorkflowLane,
    decision: LaneRouteDecision,
    contextSnapshot: WorkflowRoutingContext,
  ): UnstampedWorkflowEventInput =>
    ({
      type: "TicketRouteDecided",
      ticketId,
      payload: {
        pipelineRunId,
        fromLane: lane.key,
        toLane: decision.toLane,
        source: decision.source,
        ...(decision.matchedTransitionIndex === undefined
          ? {}
          : { matchedTransitionIndex: decision.matchedTransitionIndex }),
        contextSnapshot,
      },
    }) as UnstampedWorkflowEventInput;

  const clearRunningPipeline = (ticketId: TicketId, laneEntryToken: LaneEntryToken) =>
    SynchronizedRef.update(runningPipelines, (current) => {
      const key = ticketId as string;
      const active = current.get(key);
      if (!active || active.laneEntryToken !== laneEntryToken) {
        return current;
      }

      const next = new Map(current);
      next.delete(key);
      return next;
    });

  /**
   * Run ticket work on a forked fiber that park/move can still interrupt.
   *
   * `runningPipelines` is the only interrupt registry, and recovery's other
   * paths run inline and unregistered. A question continuation must NOT run
   * inline (it is a full agent turn on the answering user's RPC fiber) and must
   * NOT be unregistered (a superseding park could not reach it), so it registers
   * under the ticket's current lane-entry token and clears on exit.
   */
  const forkTicketWork = (ticketId: TicketId, work: Effect.Effect<void, WorkflowEventStoreError>) =>
    Effect.gen(function* () {
      const laneEntryToken = yield* currentToken(ticketId);
      if (laneEntryToken === null) {
        // No live lane entry: the ticket moved or was parked out from under this
        // wait, so there is nothing to resume into.
        return false;
      }
      const token = laneEntryToken as LaneEntryToken;
      let started = false;
      yield* SynchronizedRef.updateEffect(runningPipelines, (current) =>
        Effect.gen(function* () {
          const key = ticketId as string;
          if (current.get(key)) {
            // Something else already owns this ticket's fiber slot; do not
            // displace it — the newer owner is the live pipeline.
            return current;
          }
          started = true;
          const fiber = yield* work.pipe(
            Effect.ignoreCause({ log: true }),
            Effect.ensuring(clearRunningPipeline(ticketId, token)),
            Effect.forkDetach({ startImmediately: false, uninterruptible: false }),
          );
          const next = new Map(current);
          next.set(key, { fiber, laneEntryToken: token });
          return next;
        }),
      );
      yield* Effect.yieldNow;
      return started;
    });

  const interruptRunningPipeline = (ticketId: TicketId) =>
    Effect.gen(function* () {
      const active = yield* SynchronizedRef.modify(runningPipelines, (current) => {
        const key = ticketId as string;
        const existing = current.get(key) ?? null;
        if (!existing) {
          return [null, current] as const;
        }

        const next = new Map(current);
        next.delete(key);
        return [existing, next] as const;
      });
      if (active) {
        yield* Fiber.interrupt(active.fiber).pipe(Effect.ignore);
      }
    });

  const readStepUsage = (
    threadId: ThreadId | undefined,
  ): Effect.Effect<WorkflowStepUsage | undefined> =>
    Effect.gen(function* () {
      if (threadId === undefined) {
        return undefined;
      }
      const { usageReader } = yield* getOptionalServices;
      if (Option.isNone(usageReader)) {
        return undefined;
      }
      return yield* usageReader.value.read(threadId);
    });

  const awaitProviderTerminalForStep = (
    stepRunId: StepRunId,
    threadId: ThreadId,
    step?: WorkflowStep,
  ): Effect.Effect<RecoveredStepResult, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const { providerDispatches } = yield* getOptionalServices;
      if (Option.isNone(providerDispatches)) {
        return { _tag: "completed" } satisfies RecoveredStepResult;
      }

      const result = yield* providerDispatches.value.awaitStepTerminal(stepRunId, threadId);
      const usage = yield* readStepUsage(threadId);
      if (result.ok) {
        const completed = yield* completedResultForStep(stepRunId, step);
        return usage === undefined || completed._tag === "blocked"
          ? completed
          : { ...completed, usage };
      }
      if ("awaitingUser" in result) {
        return {
          _tag: "failed",
          error: "provider requested additional user input",
          retryable: false,
          failureClass: "infra",
          ...(usage === undefined ? {} : { usage }),
        } satisfies RecoveredStepResult;
      }
      const error = result.error ?? "turn failed";
      const failureClass =
        error === TURN_TIMEOUT_LITERAL ||
        error === "turn did not reach a terminal state before timeout"
          ? ("infra" as const)
          : ("agent_error" as const);
      return {
        _tag: "failed",
        error,
        failureClass,
        ...(usage === undefined ? {} : { usage }),
      } satisfies RecoveredStepResult;
    });

  /**
   * Remove the reserved questions key from a recovered capture.
   *
   * The live executor strips it before an output is ever stored; recovery reads
   * the same turn back and must strip it too, or a step recovered around a
   * question turn keeps the raw block as its `output_json` and feeds it to
   * `{{prev.output}}`.
   */
  const stripQuestionsFromOutput = (output: unknown): unknown => {
    if (typeof output !== "object" || output === null || Array.isArray(output)) return output;
    if (!(AGENT_QUESTIONS_KEY in output)) return output;
    const { [AGENT_QUESTIONS_KEY]: _questions, ...rest } = output as Record<string, unknown>;
    return rest;
  };

  const completedResultForStep = (
    stepRunId: StepRunId,
    step: WorkflowStep | undefined,
    output?: unknown,
    captureTurn?: CaptureTurn,
  ): Effect.Effect<RecoveredStepResult, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      if (output !== undefined) {
        return {
          _tag: "completed",
          output: stripQuestionsFromOutput(output),
        } satisfies RecoveredStepResult;
      }
      if (step?.type !== "agent" || step.captureOutput !== true) {
        return { _tag: "completed" } satisfies RecoveredStepResult;
      }

      const { capturedOutputs } = yield* getOptionalServices;
      if (Option.isNone(capturedOutputs)) {
        return {
          _tag: "failed",
          error: "missing or invalid structured output",
          failureClass: "agent_error",
        } satisfies RecoveredStepResult;
      }
      let turn = captureTurn;
      if (turn === undefined) {
        const { providerDispatches } = yield* getOptionalServices;
        if (Option.isSome(providerDispatches)) {
          turn = (yield* providerDispatches.value.getDispatchForStep(stepRunId)) ?? undefined;
        }
      }
      if (turn === undefined) {
        return {
          _tag: "failed",
          error: "missing or invalid structured output",
          failureClass: "agent_error",
        } satisfies RecoveredStepResult;
      }

      return yield* capturedOutputs.value.read({ stepRunId, ...turn }).pipe(
        Effect.map((captured) => {
          if (captured === undefined) {
            return {
              _tag: "failed",
              error: "missing or invalid structured output",
              failureClass: "agent_error",
            } satisfies RecoveredStepResult;
          }
          const cleaned = stripQuestionsFromOutput(captured);
          // A contracted step must not terminal-complete on unvalidated output
          // just because it finished through recovery. The live path validates
          // (and gets one repair); recovery has no repair budget, so a violation
          // fails closed rather than silently completing.
          const contract = step.type === "agent" ? step.outputContract : undefined;
          if (contract !== undefined) {
            const errors = validateStepOutput(contract, {
              output: cleaned as object,
              rawBlock: JSON.stringify(cleaned),
            });
            if (errors.length > 0) {
              return {
                _tag: "failed",
                error: `output contract violation on recovery: ${errors.join("; ")}`,
                retryable: false,
                failureClass: "agent_error",
              } satisfies RecoveredStepResult;
            }
          }
          return { _tag: "completed", output: cleaned } satisfies RecoveredStepResult;
        }),
        Effect.orElseSucceed(
          () =>
            ({
              _tag: "failed",
              error: "structured output lookup failed",
              failureClass: "infra",
            }) satisfies RecoveredStepResult,
        ),
      );
    });

  const runStep = (
    ticketId: TicketId,
    boardId: BoardId,
    pipelineRunId: PipelineRunId,
    step: WorkflowStep,
    laneEntryToken: LaneEntryToken,
    laneKey: LaneKey,
    laneStepKeys: ReadonlyArray<StepKey>,
    attempt: number,
    // The executor cannot derive this: laneStepKeys carries keys, not types.
    // Keyed on the step KEY, so a retry of the same step is still the first
    // agent step.
    isFirstAgentStep = false,
  ): Effect.Effect<StepRunOutcome, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const stepRunId = yield* ids.stepRunId();
      yield* commit({
        type: "StepStarted",
        ticketId,
        payload: { pipelineRunId, stepRunId, stepKey: step.key, stepType: step.type, attempt },
      });

      if (step.type === "approval") {
        yield* commit({
          type: "StepAwaitingUser",
          ticketId,
          payload: {
            stepRunId,
            waitingReason: step.prompt ?? "Approval required",
            // Snapshot the form as it is NOW. The reviewer may not answer for
            // days, by which time the board definition can have changed; the
            // event, not the definition, is the authority for what was asked.
            ...(step.form === undefined ? {} : { formSnapshot: step.form }),
          },
        });
        const resolution = yield* approvals.await(stepRunId);
        yield* commit({
          type: "StepUserResolved",
          ticketId,
          payload: {
            stepRunId,
            outcome: resolution.outcome,
            ...(resolution.decision === undefined ? {} : { decision: resolution.decision }),
            ...(resolution.answers === undefined ? {} : { answers: resolution.answers }),
          },
        });
        if (resolution.outcome === "blocked") {
          // A "hold"-style decision is neither approval nor rejection: the step
          // blocks so lane on.blocked routing can pick it up.
          yield* commit({
            type: "StepBlocked",
            ticketId,
            payload: { stepRunId, reason: resolution.decision ?? "checkpoint blocked" },
          });
          return {
            result: "blocked",
            noRetry: true,
            detail: resolution.decision ?? "checkpoint blocked",
          };
        }
        if (resolution.outcome === "failure") {
          yield* commit({
            type: "StepFailed",
            ticketId,
            payload: stepFailedPayload(
              stepRunId,
              resolution.decision ?? "rejected",
              undefined,
              false,
              undefined,
              "human_rejection",
            ),
          });
          return {
            result: "failed",
            noRetry: true,
            detail: resolution.decision ?? "rejected",
          };
        }
        yield* commit({
          type: "StepCompleted",
          ticketId,
          payload: stepCompletedPayload(stepRunId),
        });
        return { result: "completed", noRetry: false };
      }

      // Fork-join: spawn child tickets, suspend parent (SPEC §2.4).
      if (step.type === "fork") {
        if (Option.isNone(forkJoinOption)) {
          yield* commit({
            type: "StepFailed",
            ticketId,
            payload: stepFailedPayload(
              stepRunId,
              "fork join coordinator unavailable",
              undefined,
              false,
              undefined,
              "infra",
            ),
          });
          return { result: "failed", noRetry: true, detail: "fork join coordinator unavailable" };
        }
        const forkCoord = forkJoinOption.value;
        const parentDetail = yield* read.getTicketDetail(ticketId);
        const parentTitle = parentDetail?.ticket.title ?? "ticket";
        const parentDescription = parentDetail?.ticket.description ?? "";
        // Nested-fork lineage: propagate root + depth from parent forkOrigin
        // (WorkflowReadModel surfaces projection_ticket.fork_origin).
        const parentOrigin = parentDetail?.ticket.forkOrigin;
        const rootTicketId = (parentOrigin?.rootTicketId ?? (ticketId as string)) as TicketId;
        const forkDepth = nextForkDepth(parentOrigin?.forkDepth);
        if (exceedsForkDepth(forkDepth)) {
          yield* commit({
            type: "StepFailed",
            ticketId,
            payload: stepFailedPayload(
              stepRunId,
              `fork cap reached: depth ${forkDepth} > ${MAX_FORK_DEPTH}`,
              undefined,
              false,
              undefined,
              "infra",
            ),
          });
          return {
            result: "failed",
            noRetry: true,
            detail: `fork cap reached: depth ${forkDepth}`,
          };
        }
        const joinRequire = step.join?.require ?? step.children.length;
        const onBranchFailure = step.join?.onBranchFailure ?? "waitImpossible";
        const childIds: Array<{
          childKey: string;
          ticketId: TicketId;
          lane: string;
          title: string;
        }> = [];
        // Pre-allocate child ids so recordSpawn can run BEFORE TicketCreated
        // (crash-safe: join table exists before children start).
        for (const child of step.children) {
          const childTicketId = yield* ids.ticketId();
          const title = renderForkChildTitle(child.titleTemplate, {
            ticketTitle: parentTitle,
            ticketId: ticketId as string,
            childKey: child.key as string,
          });
          childIds.push({
            childKey: child.key as string,
            ticketId: childTicketId,
            lane: child.lane as string,
            title,
          });
        }

        yield* forkCoord.recordSpawn({
          stepRunId,
          parentTicketId: ticketId,
          rootTicketId,
          boardId,
          stepKey: step.key as string,
          joinRequire,
          onBranchFailure,
          spawnSeq: yield* Clock.currentTimeMillis,
          children: childIds.map((s) => ({
            childKey: s.childKey,
            ticketId: s.ticketId,
            laneKey: s.lane,
            title: s.title,
          })),
        });

        for (let i = 0; i < step.children.length; i++) {
          const child = step.children[i]!;
          const planned = childIds[i]!;
          const description = (child.descriptionTemplate ?? "")
            .replaceAll("{{ticket.title}}", parentTitle)
            .replaceAll("{{ticket.description}}", parentDescription)
            .replaceAll("{{ticket.id}}", ticketId as string)
            .replaceAll("{{child.key}}", child.key as string)
            .slice(0, 4000);
          const tokenBudget = normalizeTokenBudget(child.tokenBudget);
          yield* commit({
            type: "TicketCreated",
            ticketId: planned.ticketId,
            payload: {
              boardId,
              title: planned.title as never,
              laneKey: child.lane,
              ...(description.trim().length > 0 ? { description: description.trim() } : {}),
              ...(tokenBudget === undefined || tokenBudget === null ? {} : { tokenBudget }),
              forkOrigin: {
                parentTicketId: ticketId,
                stepRunId,
                childKey: child.key,
                forkDepth,
                rootTicketId,
              },
            },
          } as UnstampedWorkflowEventInput);
          if (child.dependsOn !== undefined && child.dependsOn.length > 0) {
            const depTicketIds = child.dependsOn
              .map((key) => childIds.find((s) => s.childKey === (key as string))?.ticketId)
              .filter((id): id is TicketId => id !== undefined);
            if (depTicketIds.length > 0) {
              yield* commit({
                type: "TicketDependenciesSet",
                ticketId: planned.ticketId,
                payload: { dependsOn: depTicketIds },
              });
            }
          }
          yield* moveToLane(planned.ticketId, boardId, child.lane, "initial");
        }

        yield* commit({
          type: "TicketForkSpawned",
          ticketId,
          payload: {
            pipelineRunId,
            stepRunId,
            stepKey: step.key,
            joinRequire,
            onBranchFailure,
            children: childIds.map((s) => ({
              childKey: s.childKey as never,
              ticketId: s.ticketId,
              lane: s.lane as never,
              title: s.title,
            })) as never,
          },
        } as UnstampedWorkflowEventInput);

        return {
          result: "awaiting_children" as const,
          noRetry: true,
          detail: `fork awaiting ${childIds.length} children (require ${joinRequire})`,
        };
      }

      const executionContext = {
        ticketId,
        boardId,
        pipelineRunId,
        stepRunId,
        laneEntryToken,
        laneKey,
        laneStepKeys,
        step,
        isFirstAgentStep,
      };
      let outcome = yield* (
        executor.execute(executionContext) as Effect.Effect<StepOutcome, WorkflowEventStoreError>
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed<StepOutcome>({ _tag: "failed", error: formatError(error) }),
        ),
      );
      // Loops ONLY for agent questions: answering one produces a fresh outcome
      // that has to run through this same handling, including the case where the
      // continuation asks again. Every other arm returns.
      for (;;) {
        if (outcome._tag === "awaiting_user") {
          const awaitingEvent = {
            type: "StepAwaitingUser",
            ticketId,
            payload: {
              stepRunId,
              waitingReason: outcome.waitingReason,
              ...(outcome.providerThreadId === undefined
                ? {}
                : { providerThreadId: outcome.providerThreadId }),
              ...(outcome.providerRequestId === undefined
                ? {}
                : { providerRequestId: outcome.providerRequestId }),
              ...(outcome.providerResponseKind === undefined
                ? {}
                : { providerResponseKind: outcome.providerResponseKind }),
              ...(outcome.providerQuestionId === undefined
                ? {}
                : { providerQuestionId: outcome.providerQuestionId }),
            },
          } satisfies UnstampedWorkflowEventInput;
          yield* commitMany(yield* awaitingUserEvents(ticketId, awaitingEvent));
          const userResolution = yield* approvals.await(stepRunId);
          yield* commit({
            type: "StepUserResolved",
            ticketId,
            payload: {
              stepRunId,
              // No `outcome` here on purpose: this is a provider-originated wait,
              // whose real terminal arrives below from the provider turn. Stamping
              // one would let boot replay fabricate a terminal that never happened.
              ...(userResolution.decision === undefined
                ? {}
                : { decision: userResolution.decision }),
              ...(userResolution.answers === undefined ? {} : { answers: userResolution.answers }),
            },
          });
          if (userResolution.outcome !== "success") {
            yield* commit({
              type: "StepFailed",
              ticketId,
              payload: stepFailedPayload(
                stepRunId,
                "rejected",
                undefined,
                false,
                undefined,
                "human_rejection",
              ),
            });
            return {
              result: "failed",
              noRetry: true,
              detail: "rejected",
              failureClass: "human_rejection",
              stepRunId,
              stepKey: step.key,
            };
          }
          if (outcome.providerThreadId !== undefined) {
            const terminalResult = yield* awaitProviderTerminalForStep(
              stepRunId,
              outcome.providerThreadId,
              step,
            );
            if (terminalResult._tag === "failed") {
              const failureClass =
                terminalResult.failureClass ??
                classifyFallback(terminalResult.error, terminalResult.retryable);
              yield* commit({
                type: "StepFailed",
                ticketId,
                payload: stepFailedPayload(
                  stepRunId,
                  terminalResult.error,
                  terminalResult.usage,
                  terminalResult.retryable === false ? false : undefined,
                  undefined,
                  failureClass,
                ),
              });
              return {
                result: "failed",
                noRetry: terminalResult.retryable === false,
                detail: terminalResult.error,
                failureClass,
                retryable: terminalResult.retryable,
                stepRunId,
                stepKey: step.key,
              };
            }
            if (terminalResult._tag === "blocked") {
              yield* commit({
                type: "StepBlocked",
                ticketId,
                payload: { stepRunId, reason: terminalResult.reason },
              });
              const hold = isParallelismHoldReason(terminalResult.reason);
              return {
                result: "blocked",
                noRetry: hold,
                detail: terminalResult.reason,
                parallelismHold: hold,
              };
            }
            yield* commit({
              type: "StepCompleted",
              ticketId,
              payload: stepCompletedPayload(stepRunId, terminalResult.output, terminalResult.usage),
            });
            return { result: "completed", noRetry: false };
          }
          yield* commit({
            type: "StepCompleted",
            ticketId,
            payload: stepCompletedPayload(stepRunId),
          });
          return { result: "completed", noRetry: false };
        }
        if (outcome._tag === "failed") {
          const failureClass =
            outcome.failureClass ?? classifyFallback(outcome.error, outcome.retryable);
          yield* commit({
            type: "StepFailed",
            ticketId,
            payload: stepFailedPayload(
              stepRunId,
              outcome.error,
              outcome.usage,
              outcome.retryable === false ? false : undefined,
              outcome.contractViolation === true ? true : undefined,
              failureClass,
            ),
          });
          return {
            result: "failed",
            noRetry: outcome.retryable === false,
            detail: outcome.error,
            failureClass,
            retryable: outcome.retryable,
            stepRunId,
            stepKey: step.key,
          };
        }
        if (outcome._tag === "blocked") {
          yield* commit({
            type: "StepBlocked",
            ticketId,
            payload: { stepRunId, reason: outcome.reason },
          });
          const hold = isParallelismHoldReason(outcome.reason);
          return {
            result: "blocked",
            noRetry: hold,
            detail: outcome.reason,
            parallelismHold: hold,
          };
        }

        if (outcome._tag === "awaiting_questions") {
          // An agent asked the operator something. Park on the SAME approval gate
          // every other human wait uses (SPEC §3): no provider fields are set, so
          // `resolveApproval` accepts it, no provider respond is attempted, and
          // DurableApprovalResume re-parks it after a restart.
          const questions = outcome;
          yield* commitMany(
            yield* awaitingUserEvents(ticketId, {
              type: "StepAwaitingUser",
              ticketId,
              payload: {
                stepRunId,
                waitingReason: questions.waitingReason,
                formSnapshot: questions.form,
                questionPhase: true,
                raisedFromDispatchId: questions.raisedFromDispatchId,
              },
            } satisfies UnstampedWorkflowEventInput),
          );
          const answered = yield* approvals.await(stepRunId);
          yield* commit({
            type: "StepUserResolved",
            ticketId,
            payload: {
              stepRunId,
              // No `outcome` stamped: the step's real terminal comes from the
              // continuation turn below, and stamping one here would let boot
              // replay fabricate a terminal that never happened.
              ...(answered.decision === undefined ? {} : { decision: answered.decision }),
              ...(answered.answers === undefined ? {} : { answers: answered.answers }),
            },
          });
          if (answered.outcome !== "success") {
            // Cancel is the operator declining to answer; the step fails and
            // routes through the board's existing on.failure, exactly as any
            // other failure would.
            yield* commit({
              type: "StepFailed",
              ticketId,
              payload: stepFailedPayload(
                stepRunId,
                "cancelled at question",
                undefined,
                false,
                undefined,
                "human_rejection",
              ),
            });
            return {
              result: "failed",
              noRetry: true,
              detail: "cancelled at question",
              failureClass: "human_rejection",
              stepRunId,
              stepKey: step.key,
            };
          }
          outcome = yield* (
            executor.continueWithAnswers({
              ctx: executionContext,
              form: questions.form,
              answers: answered.answers ?? {},
            }) as Effect.Effect<StepOutcome, WorkflowEventStoreError>
          ).pipe(
            Effect.catch((error) =>
              Effect.succeed<StepOutcome>({ _tag: "failed", error: formatError(error) }),
            ),
          );
          continue;
        }

        if (outcome._tag === "awaiting_children") {
          // Fork suspension is decided by the engine before dispatch (see the fork
          // branch above) and RealStepExecutor guards fork steps, so an executor must
          // never produce this outcome. Fail closed rather than falling through to the
          // completed path, which would commit StepCompleted and defeat the join.
          const error = "executor returned awaiting_children for a non-fork step";
          yield* commit({
            type: "StepFailed",
            ticketId,
            payload: stepFailedPayload(stepRunId, error, undefined, false, undefined, "infra"),
          });
          return {
            result: "failed",
            noRetry: true,
            detail: error,
            failureClass: "infra",
            retryable: false,
            stepRunId,
          };
        }

        yield* commit({
          type: "StepCompleted",
          ticketId,
          payload: stepCompletedPayload(
            stepRunId,
            outcome.output,
            outcome.usage,
            outcome.outputRepaired === true ? true : undefined,
          ),
        });
        return { result: "completed", noRetry: false };
      }
    });

  const runPipeline = (
    ticketId: TicketId,
    boardId: BoardId,
    lane: WorkflowLane,
    laneEntryToken: LaneEntryToken,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const definition = yield* registry.getDefinition(boardId);
      const permits = Math.max(1, definition?.settings?.maxConcurrentTickets ?? 3);
      const semaphore = yield* semaphoreFor(boardId, permits);
      yield* semaphore.withPermits(1)(runPipelineBody(ticketId, boardId, lane, laneEntryToken));
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const reason = `pipeline error: ${Cause.pretty(cause)}`;
        return Effect.logWarning("workflow pipeline orchestration failed", {
          boardId,
          laneEntryToken,
          laneKey: lane.key,
          reason,
          ticketId,
        }).pipe(
          Effect.flatMap(() =>
            // Token-guard the fallback block, mirroring the "no route" block
            // below: an external park may have nulled/rotated the token before
            // this handler ran, and a TicketBlocked here would overwrite the
            // parked status and orphan the parked_* columns. Only block if this
            // run still owns the ticket's lane-entry token.
            Effect.uninterruptible(
              Effect.gen(function* () {
                const token = yield* currentToken(ticketId);
                if (token !== laneEntryToken) {
                  return;
                }
                yield* commit({
                  type: "TicketBlocked",
                  ticketId,
                  payload: { reason },
                });
              }),
            ),
          ),
          Effect.catch(() => Effect.void),
        );
      }),
    );

  const completePipelineFrom = (
    ticketId: TicketId,
    boardId: BoardId,
    lane: WorkflowLane,
    laneEntryToken: LaneEntryToken,
    pipelineRunId: PipelineRunId,
    steps: ReadonlyArray<WorkflowStep>,
    startIndex: number,
    initialResult: PipelineResult,
    initialRouteDecision?: RouteDecision,
    // Whether the FIRST dispatched step may skip the inter-step token guard.
    // The live start (runPipelineBody) passes `true`: the pipeline was just
    // admitted on this exact token, so re-checking cannot catch a race the
    // start-guard already covered. The RECOVERY entry passes `false`: its token
    // was read before a restart/continuation and an external park can have
    // nulled it in the interim, so even the first recovered step must token-check
    // before starting new agent/script work.
    exemptFirstStep = true,
    // Recovery may enter already held (serialize hold terminal) without a further
    // step dispatch — bypass on.blocked routing the same way as a live hold.
    initialParallelismHold = false,
    initialHoldDetail?: string,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      let result: PipelineResult = initialResult;
      let routeDecision: RouteDecision | null = initialParallelismHold
        ? null
        : (initialRouteDecision ?? null);
      // The error text / blocked reason of the step that ended the pipeline —
      // sourced from the step outcome so a park can report why it happened.
      let failureDetail: string | undefined = initialHoldDetail;
      // Serialize hold: skip on.blocked routing; keep lane entry token (SPEC §2.4).
      let parallelismHeld = initialParallelismHold;
      const laneStepKeys = steps.map((s) => s.key);
      // The default handoff-pack injection targets only the lane's FIRST agent
      // step, not every agent step in the lane.
      const firstAgentStepKey = steps.find((s) => s.type === "agent")?.key;

      if (routeDecision === null) {
        let firstStep = true;
        for (const step of steps.slice(startIndex)) {
          if (result !== "success") {
            break;
          }
          // Inter-step supersession guard: before dispatching a step, re-read the
          // ticket's lane-entry token. An external park (or a manual move) can
          // null/rotate the token mid-pipeline; continuing would run further
          // agent/script work and StepStarted writes against a parked/moved row.
          // If the token no longer matches this run's entry token, abort SILENTLY
          // — emit nothing, so we never write onto the superseded row. The first
          // step is guarded UNLESS `exemptFirstStep` (see the param doc): the live
          // start just minted this token, but a recovered continuation did not.
          if (!firstStep || !exemptFirstStep) {
            const tokenNow = yield* currentToken(ticketId);
            if (tokenNow !== laneEntryToken) {
              return;
            }
          }
          firstStep = false;
          const maxAttempts = retryAttemptsForStep(step);
          let attempt = 1;
          let stepOutcome = yield* runStep(
            ticketId,
            boardId,
            pipelineRunId,
            step,
            laneEntryToken,
            lane.key,
            laneStepKeys,
            attempt,
            step.key === firstAgentStepKey,
          );
          // Taxonomy-aware retry: decideRetry is the sole gate (SPEC failure-taxonomy).
          while (stepOutcome.result === "failed" && !stepOutcome.noRetry) {
            const failureClass =
              stepOutcome.failureClass ??
              classifyFallback(stepOutcome.detail ?? "unknown", stepOutcome.retryable);
            const byClass =
              step.type === "agent" || step.type === "script" ? step.retry?.byClass : undefined;
            const decision = decideRetry({
              failureClass,
              attempt,
              maxAttempts,
              retryable: stepOutcome.retryable,
              byClass,
              error: stepOutcome.detail,
              stepHasEscalate: step.type === "agent" && step.retry?.escalate !== undefined,
              mode: "live",
            });
            if (decision.kind === "give_up") {
              break;
            }
            // Intra-step retry guard: re-check lane-entry token before attempt N+1.
            if ((yield* currentToken(ticketId)) !== laneEntryToken) {
              yield* commit({
                type: "PipelineCompleted",
                ticketId,
                payload: { pipelineRunId, result: "superseded" },
              });
              return;
            }
            if (stepOutcome.stepRunId !== undefined && stepOutcome.stepKey !== undefined) {
              yield* commit({
                type: "StepRetryScheduled",
                ticketId,
                payload: {
                  pipelineRunId,
                  stepRunId: stepOutcome.stepRunId,
                  stepKey: stepOutcome.stepKey,
                  failureClass,
                  nextAttempt: decision.nextAttempt,
                  maxAttempts,
                  delayMs: decision.delayMs,
                },
              } as UnstampedWorkflowEventInput);
            }
            if (decision.delayMs > 0) {
              yield* Effect.sleep(Duration.millis(decision.delayMs));
              // Token may have rotated during backoff sleep.
              if ((yield* currentToken(ticketId)) !== laneEntryToken) {
                yield* commit({
                  type: "PipelineCompleted",
                  ticketId,
                  payload: { pipelineRunId, result: "superseded" },
                });
                return;
              }
            }
            attempt = decision.nextAttempt;
            const nextStep = decision.escalate ? stepForAttempt(step, attempt) : step;
            stepOutcome = yield* runStep(
              ticketId,
              boardId,
              pipelineRunId,
              nextStep,
              laneEntryToken,
              lane.key,
              laneStepKeys,
              attempt,
              nextStep.key === firstAgentStepKey,
            );
          }
          if (stepOutcome.result === "awaiting_children") {
            // SPEC §2.4: parent suspends; fiber exits without PipelineCompleted.
            return;
          }
          result = pipelineResultForStep(stepOutcome.result);
          if (result !== "success") {
            failureDetail = stepOutcome.detail;
          }
          if (stepOutcome.parallelismHold === true) {
            // SPEC §2.4: held outcome bypasses step/lane on.blocked routing.
            parallelismHeld = true;
            routeDecision = null;
            break;
          }
          routeDecision = stepRouteDecision(step, result);
          if (routeDecision !== null || result !== "success") {
            break;
          }
        }
      }

      const contextSnapshot = yield* routingContextBuilder.build({
        ticketId,
        pipelineRunId,
        result,
      });
      if (routeDecision === null && !parallelismHeld) {
        routeDecision =
          (yield* laneTransitionDecision(lane, contextSnapshot)) ?? laneOnDecision(lane, result);
      }

      // Compile the handoff pack BEFORE the completion commit. A crash during
      // compilation then leaves the pipeline `running`, which the existing
      // stranded-running sweep recovers and recompiles. Compiling after the
      // commit would widen the pre-existing completed-but-unrouted window.
      //
      // Compilation is speculative: `enterLaneCore` can still early-return on a
      // stale token or a phantom lane and discard these sections. That costs one
      // bounded git stat and is side-effect free — no writes happen until the
      // route batch.
      const contextPackSections =
        routeDecision !== null &&
        !parallelismHeld &&
        routeDecision.kind !== "park" &&
        Option.isSome(contextPackCompilerOption)
          ? yield* contextPackCompilerOption.value.compile({
              ticketId,
              pipelineRunId,
              laneEntryToken,
              steps,
            })
          : [];

      yield* commit({
        type: "PipelineCompleted",
        ticketId,
        payload: { pipelineRunId, result },
      });

      if (routeDecision !== null && !parallelismHeld) {
        if (routeDecision.kind === "park") {
          yield* parkTicket(
            ticketId,
            boardId,
            lane.key,
            laneEntryToken,
            routeDecision.target,
            routeDecision.parkOrigin,
            parkReason(routeDecision, result, failureDetail, lane, contextSnapshot),
            pipelineRunId,
          );
          return;
        }
        yield* enterLane(ticketId, boardId, routeDecision.toLane, "routed", {
          routeDecision,
          contextSnapshot,
          expectedToken: laneEntryToken,
          pipelineRunId,
          fromLane: lane,
          contextPackSections,
        });
        return;
      }

      if (result !== "success") {
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = yield* currentToken(ticketId);
            if (token !== laneEntryToken) {
              return;
            }
            yield* commit({
              type: "TicketBlocked",
              ticketId,
              payload: {
                reason: parallelismHeld
                  ? truncateReason(failureDetail ?? "worktree serialize hold")
                  : `pipeline ${result} with no route`,
              },
            });
            // Fork child blocked → settle failure (unless serialize hold).
            // Not under admission lock here — apply deferred parent route inline.
            if (!parallelismHeld) {
              const deferred = yield* settleForkChildIfAny(ticketId, "failure").pipe(
                Effect.catch(() => Effect.succeed(null as DeferredParentRoute | null)),
              );
              if (deferred !== null) {
                yield* applyDeferredParentRoute(deferred);
              }
            }
          }),
        );
      }
    });

  const runPipelineBody = (
    ticketId: TicketId,
    boardId: BoardId,
    lane: WorkflowLane,
    laneEntryToken: LaneEntryToken,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const steps = lane.pipeline ?? [];
      if (steps.length === 0) {
        return;
      }

      const pipelineRunId = yield* ids.pipelineRunId();
      yield* commit({
        type: "PipelineStarted",
        ticketId,
        payload: { pipelineRunId, laneKey: lane.key, laneEntryToken },
      });

      yield* completePipelineFrom(
        ticketId,
        boardId,
        lane,
        laneEntryToken,
        pipelineRunId,
        steps,
        0,
        "success",
      );
    });

  // The ticket's current lane/token as stored in the projection. A pipeline
  // start may have been SNAPSHOTTED (e.g. by recoverBoardWip) before a
  // concurrent user/source move changed the ticket's lane entry token; this is
  // the authority for "is this start still current?".
  const ticketLaneTokenRow = (ticketId: TicketId) =>
    wrapSql(sql<{ readonly currentLaneKey: string; readonly currentLaneEntryToken: string | null }>`
      SELECT
        current_lane_key AS "currentLaneKey",
        current_lane_entry_token AS "currentLaneEntryToken"
      FROM projection_ticket
      WHERE ticket_id = ${ticketId}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const startPipeline = (
    ticketId: TicketId,
    boardId: BoardId,
    lane: WorkflowLane,
    laneEntryToken: LaneEntryToken,
  ) =>
    Effect.gen(function* () {
      const fiber = yield* SynchronizedRef.modifyEffect(runningPipelines, (current) =>
        Effect.gen(function* () {
          const key = ticketId as string;
          const active = current.get(key);
          if (active?.laneEntryToken === laneEntryToken) {
            return [null, current] as const;
          }

          // Stale-start guard: re-read the ticket and require its current lane
          // entry token AND lane key still match the start this call is for. A
          // snapshot-then-start path (recoverBoardWip) can race a user/source
          // move that re-tokened or re-laned the ticket between the snapshot and
          // here; starting then would run a pipeline for a lane the ticket has
          // already left (and the manual move could not interrupt it because it
          // was not yet in runningPipelines). This read runs INSIDE the
          // runningPipelines modify (and the caller holds the admission lock),
          // so a stale start is prevented atomically with the map insert.
          const row = yield* ticketLaneTokenRow(ticketId);
          if (
            row === null ||
            row.currentLaneEntryToken !== (laneEntryToken as string) ||
            row.currentLaneKey !== (lane.key as string)
          ) {
            return [null, current] as const;
          }

          return yield* runPipeline(ticketId, boardId, lane, laneEntryToken).pipe(
            Effect.ensuring(clearRunningPipeline(ticketId, laneEntryToken)),
            Effect.forkDetach({ startImmediately: false, uninterruptible: false }),
            Effect.map((fiber) => {
              const next = new Map(current);
              next.set(key, { fiber, laneEntryToken });
              return [fiber, next] as const;
            }),
          );
        }),
      );
      if (fiber !== null) {
        yield* Effect.yieldNow;
      }
    });

  const runPipelineStarts = (starts: ReadonlyArray<PipelineStartAction>) =>
    Effect.forEach(
      starts,
      (start) => startPipeline(start.ticketId, start.boardId, start.lane, start.laneEntryToken),
      { discard: true },
    );

  const collectStartAction = (
    starts: Array<PipelineStartAction>,
    ticketId: TicketId,
    boardId: BoardId,
    lane: WorkflowLane | null,
    laneEntryToken: LaneEntryToken,
  ) => {
    if (lane?.entry === "auto") {
      starts.push({ ticketId, boardId, lane, laneEntryToken });
    }
  };

  // How a lane-entry body persists its events. The locked emitter (default)
  // re-acquires the board save lock + opens a transaction per emission through
  // commit/commitMany, and publishes live ticket views — used by every existing
  // caller. The unlocked emitter (committer-driven Task 9 path) appends+projects
  // through the committer's appendManyUnlocked, which ASSUMES the caller already
  // holds the board save lock + an open transaction and does NOT publish; the
  // committer publishes after releasing the lock.
  // `precondition`, when supplied, runs IN the board save lock right before the
  // append (see the committer contract) — used by the unpark path to serialize a
  // board-definition-drift recheck with the emit. The unlocked emitter already
  // runs inside the caller's save lock, so its precondition simply runs before
  // the append there too.
  type EmitEvents = (
    events: ReadonlyArray<UnstampedWorkflowEventInput>,
    precondition?: Effect.Effect<void, WorkflowEventStoreError>,
  ) => Effect.Effect<void, WorkflowEventStoreError>;

  const lockedEmit: EmitEvents = (events, precondition) =>
    events.length === 0
      ? Effect.void
      : events.length === 1
        ? commit(events[0] as UnstampedWorkflowEventInput, precondition)
        : commitMany(events, precondition);

  const stampEvent = (event: UnstampedWorkflowEventInput) =>
    Effect.gen(function* () {
      const eventId = yield* ids.eventId();
      return {
        ...event,
        eventId: eventId as WorkflowEventId,
        occurredAt: (yield* nowIso) as never,
      } as WorkflowEventInput;
    });

  // Append+project through the caller's already-held board save lock + open
  // transaction. Asserts (via the committer's contract) that the caller opened
  // the lock + tx — it never acquires either itself.
  const unlockedEmit: EmitEvents = (events, precondition) =>
    Effect.gen(function* () {
      if (events.length === 0) {
        return;
      }
      // Caller already holds the save lock; running the precondition here keeps
      // it in-lock before the append, matching the locked path's guarantee.
      if (precondition !== undefined) {
        yield* precondition;
      }
      const stamped: Array<WorkflowEventInput> = [];
      for (const event of events) {
        stamped.push(yield* stampEvent(event));
      }
      yield* committer.appendManyUnlocked(stamped);
    });

  // Sweeps queued tickets into a lane up to its WIP limit. Runs under either
  // emitter — the locked public path (default `lockedEmit`) or the unlocked
  // source-committer path (caller passes `unlockedEmit`) — so it carries no
  // "Locked" suffix; the caller owns the serialization (admission lock).
  const admitNext = (
    boardId: BoardId,
    laneKey: LaneKey,
    emit: EmitEvents = lockedEmit,
  ): Effect.Effect<ReadonlyArray<PipelineStartAction>, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const lane = yield* registry.getLane(boardId, laneKey);
      const limit = lane?.wipLimit;
      if (lane === null || limit === undefined) {
        return [];
      }

      const starts: Array<PipelineStartAction> = [];
      while ((yield* read.countAdmittedInLane(boardId, laneKey)) < limit) {
        const queued = yield* read.oldestQueuedForLane(boardId, laneKey);
        if (queued === null) {
          break;
        }

        const laneEntryToken = yield* ids.token();
        const queuedTicketId = queued.ticketId as TicketId;
        yield* emit([
          {
            type: "TicketAdmitted",
            ticketId: queuedTicketId,
            payload: { lane: laneKey, laneEntryToken },
          },
        ]);
        collectStartAction(starts, queuedTicketId, boardId, lane, laneEntryToken);
      }

      return starts;
    });

  /**
   * Parent route to apply AFTER admission lock release (or, on unlocked paths
   * that already hold admission, via enterLaneCore with serialize: body => body).
   */
  interface DeferredParentRoute {
    readonly parentTicketId: TicketId;
    readonly boardId: BoardId;
    readonly stepRunId: StepRunId;
    readonly toLane: LaneKey | null;
    readonly blockReason: string | null;
    /** Join outcome — drives contextSnapshot.pipeline.result (not inferred from blockReason). */
    readonly joinResult: "success" | "failure";
  }

  interface EnterLaneCoreOptions {
    readonly routedOptions?: RoutedEnterLaneOptions | undefined;
    readonly externalOptions?: ExternalEnterLaneOptions | undefined;
    // Persists the lane-entry events. Defaults to the locked emitter; the
    // committer-driven unlocked path passes unlockedEmit.
    readonly emit?: EmitEvents | undefined;
    // Serializes the WIP read-decide body. The board SAVE lock does NOT
    // serialize the WIP decision: it is taken only transiently at commit time
    // (after the admit/queue decision), so concurrent paths can both read
    // occupancy and both admit. The ADMISSION lock is what serializes the
    // read-decide. The public path therefore wraps the body in the board
    // admission lock. The unlocked path (the source committer) passes
    // `Effect.uninterruptible` here ONLY because it MUST already hold the
    // admission lock for the whole chunk via `withBoardAdmissionLock` (OUTER) ->
    // save lock (INNER) -> transaction. Taking the admission lock again here,
    // under the save lock, would invert that admission->save order and deadlock.
    readonly serialize?:
      | (<A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>)
      | undefined;
    // Runs the manual/external supersession (interrupt pipeline + cancel turns +
    // tombstone dispatches). Injected so the unlocked path reuses the identical
    // side effect.
    readonly supersedeRunningWork: Effect.Effect<void, WorkflowEventStoreError>;
    // Unpark compare-and-act: when present, the ticket MUST still be parked with
    // this exact `parked_event_id` when the admission lock is held, or the whole
    // move no-ops (`acted: "none"`) with nothing emitted. This is the
    // authoritative TOCTOU-safe guard — it is re-read from the projection row
    // INSIDE the serialized section. A null/undefined `parked_event_id` on the
    // row always fails the guard toward "none" (never toward acting). The
    // supersession side effect runs only AFTER this guard passes.
    //
    // `revalidate`, when present, runs INSIDE the lock right after the identity
    // check passes and BEFORE any emission. It re-reads the CURRENT board
    // definition and re-resolves the park action, failing with a typed error if
    // a concurrent board save changed/removed it between the pre-lock resolution
    // and here. It FAILS (does not no-op) so the caller learns the definition
    // drifted rather than silently moving to a stale target.
    readonly parkedGuard?:
      | {
          readonly expectedParkedEventId: WorkflowEventId;
          readonly revalidate?: Effect.Effect<void, WorkflowEventStoreError> | undefined;
        }
      | undefined;
    // When a terminal lane is entered, whether to call `provider.stopSession` for
    // the ticket's stored agent threads IN-BAND. Defaults to `true` for the public
    // move (no chunk tx is open). The unlocked source-committer callers pass
    // `false`: `stopSession` is a non-rollbackable live side effect that must not
    // run inside the chunk transaction, so only the tx-safe `deleteByTicket` runs
    // here and the committer defers the live stop to its post-commit phase.
    readonly stopProviderSessionsOnTeardown?: boolean | undefined;
    // Optional save-lock precondition for the move/queue emission (e.g. SLA
    // revalidation). Combined with parkedGuard.revalidate when both present —
    // park revalidate wins for the unpark path; SLA passes this alone.
    readonly emitPrecondition?: Effect.Effect<void, WorkflowEventStoreError> | undefined;
  }

  // The in-lock / in-tx body of a lane entry: revalidation, WIP/admission/queue
  // decision, emit, and prior-lane sweep. Returns the pipeline starts to run
  // AFTER the lock (and, for the unlocked path, after the caller's transaction)
  // plus the outcome. Assumes the ticket already exists. Used by the public
  // enterLane (locked emit + admission lock) and by the committer-facing unlocked
  // ops (unlocked emit; they take no admission lock HERE only because the source
  // committer must already hold it via `withBoardAdmissionLock` — the save lock
  // alone does NOT serialize the WIP read-decide).
  const enterLaneCore = (
    ticketId: TicketId,
    boardId: BoardId,
    toLane: LaneKey,
    reason: MoveReason,
    options: EnterLaneCoreOptions,
  ): Effect.Effect<
    {
      readonly starts: ReadonlyArray<PipelineStartAction>;
      readonly acted: "moved" | "queued" | "none";
      readonly deferredForkRoutes: ReadonlyArray<DeferredParentRoute>;
      readonly releasedHoldTicketIds: ReadonlyArray<TicketId>;
    },
    WorkflowEventStoreError
  > => {
    const { routedOptions, externalOptions, supersedeRunningWork, parkedGuard } = options;
    const emit = options.emit ?? lockedEmit;
    const serialize =
      options.serialize ??
      (<A, E, R>(body: Effect.Effect<A, E, R>) =>
        withAdmissionLock(boardId, Effect.uninterruptible(body)));
    return serialize(
      Effect.gen(function* () {
        const none = {
          starts: [] as Array<PipelineStartAction>,
          acted: "none" as "moved" | "queued" | "none",
          deferredForkRoutes: [] as ReadonlyArray<DeferredParentRoute>,
          releasedHoldTicketIds: [] as ReadonlyArray<TicketId>,
        };
        const detail = yield* read.getTicketDetail(ticketId);
        const priorLane = detail?.ticket.currentLaneKey as LaneKey | undefined;
        const priorWasAdmitted = detail !== null && detail.ticket.currentLaneEntryToken !== null;
        if (reason === "routed") {
          if (
            routedOptions === undefined ||
            detail?.ticket.currentLaneEntryToken !== routedOptions.expectedToken
          ) {
            return none;
          }
        }
        if (reason === "external") {
          if (
            externalOptions === undefined ||
            detail?.ticket.currentLaneKey !== (externalOptions.expectedFromLane as string)
          ) {
            return none;
          }
          // A board save may have removed the matcher or its target lane
          // between evaluation and this commit — re-resolve before acting.
          if (!(yield* externalOptions.revalidate)) {
            return none;
          }
          // Only a confirmed-fresh event may kill the ticket's running
          // work; stale events must no-op without side effects.
          yield* supersedeRunningWork;
        }
        // Unpark compare-and-act (TOCTOU-safe): the ticket must STILL be parked
        // with the expected `parked_event_id` now that we hold the admission
        // lock. Re-read from the projection row (getTicketDetail selects
        // parked_event_id). A concurrent move/invoke that already unparked the
        // ticket, a status that is no longer "parked", or a null/undefined
        // parked_event_id all fail the guard toward "none" — nothing is emitted.
        if (parkedGuard !== undefined) {
          const rowParkedEventId = detail?.ticket.parkedEventId ?? null;
          if (
            detail?.ticket.status !== "parked" ||
            rowParkedEventId === null ||
            rowParkedEventId !== parkedGuard.expectedParkedEventId
          ) {
            return none;
          }
          // Identity holds — re-resolve the action against the CURRENT board
          // definition IN-LOCK before emitting. A board save that changed or
          // removed the action between the caller's pre-lock resolution and here
          // fails this typed (definition drift), so we never enter a stale lane.
          // This run is a fast pre-check (fail before the supersede side effect);
          // the SAME revalidate is also handed to the emit below as a save-lock
          // precondition, which is the authoritative recheck — a board save
          // (`register`) cannot interleave between that recheck and the append
          // because both hold the board save lock (the admission lock alone does
          // not serialize saves).
          if (parkedGuard.revalidate !== undefined) {
            yield* parkedGuard.revalidate;
          }
          // Guard passed — only now supersede any (defense-in-depth) running
          // work. Parked tickets have no running pipeline by invariant, so this
          // is belt-and-braces, mirroring the external path's ordering.
          yield* supersedeRunningWork;
        }
        const routeEvent =
          reason === "routed" && routedOptions !== undefined
            ? routeDecisionEvent(
                ticketId,
                routedOptions.pipelineRunId,
                routedOptions.fromLane,
                routedOptions.routeDecision,
                routedOptions.contextSnapshot,
              )
            : reason === "external" && externalOptions !== undefined
              ? externalOptions.routeEvent
              : null;
        const targetLane = yield* registry.getLane(boardId, toLane);
        // Defense-in-depth: a routed move may resolve to a lane key that no
        // longer exists in the current board def (e.g. the lane was removed via
        // the normal editor between route evaluation and this commit). Committing
        // a TicketMovedToLane into a non-existent lane would strand the ticket in
        // a phantom lane. Instead of moving, surface the ticket for human
        // attention via TicketBlocked: its pipeline is already done, so a silent
        // no-op would leave it admitted in its old lane with no signal. Block it
        // so attention_kind='blocked' fires through the existing path. We never
        // commit a move/queue into the phantom lane.
        if (targetLane === null) {
          if (reason === "routed") {
            yield* Effect.logWarning(
              "workflow routed move targets a lane missing from the current board def — blocking ticket",
              { boardId, ticketId, toLane },
            );
            yield* emit([
              {
                type: "TicketBlocked",
                ticketId,
                payload: {
                  reason: `routed to lane '${toLane}' which no longer exists in the board definition`,
                },
              } as UnstampedWorkflowEventInput,
            ]);
            return none;
          }
          // A manual move (menu/drag or an unpark park-action) or an external
          // event targeting a lane that no longer exists must FAIL loudly rather
          // than commit a move into a phantom lane and strand the ticket — the
          // pre-existing hole this closes (spec: enterLane phantom-lane guard,
          // previously routed-only). `initial` keeps its legacy behavior (the
          // initial lane is validated at ticket creation).
          // SLA escalations return none so the caller can downgrade to a
          // notify-only TicketSlaBreached without a phantom move.
          if (reason === "sla") {
            return none;
          }
          if (reason === "manual" || reason === "external") {
            return yield* new WorkflowEventStoreError({
              message: `cannot move ticket to lane '${toLane}' which no longer exists in the board definition`,
            });
          }
        }
        const limit = targetLane?.wipLimit;
        const admittedCount =
          limit === undefined ? 0 : yield* read.countAdmittedInLane(boardId, toLane);
        const selfInTarget = priorWasAdmitted && priorLane === toLane ? 1 : 0;
        const starts: Array<PipelineStartAction> = [];

        // A ticket waiting on dependencies never starts an auto lane's
        // pipeline — queue it; resolution of the last dependency
        // releases it through the admission sweep.
        const unresolvedDeps = detail?.ticket.unresolvedDependencyCount ?? 0;
        const dependencyGated = targetLane?.entry === "auto" && unresolvedDeps > 0;

        // The unpark path re-checks board-definition drift IN the save lock at
        // append time (see the parkedGuard comment above): pass its revalidate as
        // the emit precondition so a concurrent save cannot slip a changed/removed
        // action past the append. SLA passes emitPrecondition for the same reason.
        const emitPrecondition = options.emitPrecondition ?? parkedGuard?.revalidate;

        // The pack event goes LAST in the batch. The projection folds events one
        // at a time with no batch identity, and every move/queue fold clears the
        // destination lane's pack; only a trailing pack event survives that clear.
        const packSections =
          reason === "routed" && routedOptions !== undefined
            ? (routedOptions.contextPackSections ?? [])
            : [];
        const packEvents: ReadonlyArray<UnstampedWorkflowEventInput> =
          packSections.length === 0
            ? []
            : [
                {
                  type: "TicketContextPackCompiled",
                  ticketId,
                  payload: {
                    forLane: toLane,
                    fromLane: routedOptions?.fromLane.key,
                    sections: packSections,
                  },
                } as UnstampedWorkflowEventInput,
              ];

        let acted: "moved" | "queued" = "moved";
        if ((limit !== undefined && admittedCount - selfInTarget >= limit) || dependencyGated) {
          acted = "queued";
          const queueEvent = {
            type: "TicketQueued",
            ticketId,
            payload: { lane: toLane },
          } as UnstampedWorkflowEventInput;
          yield* emit(
            routeEvent === null
              ? [queueEvent, ...packEvents]
              : [routeEvent, queueEvent, ...packEvents],
            emitPrecondition,
          );
        } else {
          const laneEntryToken = yield* ids.token();
          const moveEvent = {
            type: "TicketMovedToLane",
            ticketId,
            payload: { toLane, laneEntryToken, reason },
          } as UnstampedWorkflowEventInput;
          yield* emit(
            routeEvent === null
              ? [moveEvent, ...packEvents]
              : [routeEvent, moveEvent, ...packEvents],
            emitPrecondition,
          );
          collectStartAction(starts, ticketId, boardId, targetLane, laneEntryToken);
        }

        if (priorWasAdmitted && priorLane !== undefined && priorLane !== toLane) {
          starts.push(...(yield* admitNext(boardId, priorLane, emit)));
        }

        // Landing in a terminal lane is the end of the ticket's agent work:
        // tear down its stored per-agent sessions so resumable threads are not
        // left dangling. Shared across all enterLaneCore callers (enterLane,
        // closeTicketFromSourceUnlocked, createTicketAndEnterUnlocked). Queued
        // tickets have not actually entered the lane yet, so only on a move.
        // `deleteByTicket` (SQL) always runs in-band here (tx-safe). The live
        // `provider.stopSession` runs in-band ONLY on the public path; the
        // unlocked source-committer callers pass `false` and defer it to their
        // post-commit phase so it never runs inside the chunk transaction.
        const deferredForkRoutes: DeferredParentRoute[] = [];
        let releasedHoldTicketIds: ReadonlyArray<TicketId> = [];
        if (acted === "moved" && targetLane?.terminal === true) {
          yield* tearDownTicketAgentSessions(
            ticketId,
            options.stopProviderSessionsOnTeardown ?? true,
          );
          // Under lock: settle only (no enterLane — admission lock is non-reentrant).
          const deferred = yield* settleForkChildIfAny(ticketId, "success").pipe(
            Effect.catch(() => Effect.succeed(null as DeferredParentRoute | null)),
          );
          if (deferred !== null) {
            deferredForkRoutes.push(deferred);
          }
          // Under lock: clear hold rows; resume runLane outside the lock.
          releasedHoldTicketIds = yield* releaseHoldsBlockedByIds(ticketId).pipe(
            Effect.catch(() => Effect.succeed([] as ReadonlyArray<TicketId>)),
          );
        }

        return { starts, acted, deferredForkRoutes, releasedHoldTicketIds };
      }),
    );
  };

  /**
   * Settle a fork child. Safe under admission lock (coordinator SQL + event
   * commits only). Returns a deferred parent route when the join resolved —
   * callers MUST apply it outside the lock via applyDeferredParentRoute.
   */
  const settleForkChildIfAny = (
    childTicketId: TicketId,
    outcome: "success" | "failure" | "cancelled",
  ): Effect.Effect<DeferredParentRoute | null, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      if (Option.isNone(forkJoinOption)) {
        return null;
      }
      const coord = forkJoinOption.value;
      const result = yield* coord.settleChild({ childTicketId, outcome });
      if (result.status === "unknown_child" || result.status === "already_settled") {
        return null;
      }
      const emitChildSettled = () => {
        const child = result.fork.children.find((c) => c.ticketId === childTicketId);
        if (child === undefined) {
          return Effect.void;
        }
        return commit({
          type: "TicketForkChildSettled",
          ticketId: result.fork.parentTicketId,
          payload: {
            stepRunId: result.fork.stepRunId,
            childTicketId,
            childKey: child.childKey as never,
            outcome,
          },
        } as UnstampedWorkflowEventInput);
      };
      if (result.status === "waiting") {
        yield* emitChildSettled();
        return null;
      }
      yield* emitChildSettled();
      const detached = result.fork.children
        .filter((c) => c.settledOutcome === null || c.settledOutcome === "unsettled")
        .map((c) => c.childKey as never);
      const joinResult = result.join.result === "success" ? "success" : "failure";
      yield* commit({
        type: "TicketForkResolved",
        ticketId: result.fork.parentTicketId,
        payload: {
          stepRunId: result.fork.stepRunId,
          result: joinResult,
          succeeded: result.join.succeeded,
          failed: result.join.failed,
          cancelled: result.join.cancelled,
          detached,
        },
      } as UnstampedWorkflowEventInput);

      const pipelineRows = yield* wrapSql(sql<{ readonly pipelineRunId: string }>`
        SELECT pipeline_run_id AS "pipelineRunId"
        FROM projection_step_run
        WHERE step_run_id = ${result.fork.stepRunId}
        LIMIT 1
      `).pipe(Effect.catch(() => Effect.succeed([] as Array<{ pipelineRunId: string }>)));
      const pipelineRunId = (pipelineRows[0]?.pipelineRunId ??
        result.fork.stepRunId) as PipelineRunId;

      if (joinResult === "success") {
        yield* commit({
          type: "StepCompleted",
          ticketId: result.fork.parentTicketId,
          payload: stepCompletedPayload(result.fork.stepRunId),
        });
      } else {
        yield* commit({
          type: "StepFailed",
          ticketId: result.fork.parentTicketId,
          payload: stepFailedPayload(
            result.fork.stepRunId,
            `fork join failed: ${result.join.succeeded} of ${result.fork.joinRequire} required`,
            undefined,
            false,
            undefined,
            "agent_error",
          ),
        });
      }
      yield* commit({
        type: "PipelineCompleted",
        ticketId: result.fork.parentTicketId,
        payload: {
          pipelineRunId,
          result: joinResult === "success" ? "success" : "failure",
        },
      });

      const parentDetail = yield* read.getTicketDetail(result.fork.parentTicketId);
      if (parentDetail === null) {
        return null;
      }
      const boardId = parentDetail.ticket.boardId as BoardId;
      const parentLaneKey = parentDetail.ticket.currentLaneKey as LaneKey;
      const definition = yield* registry.getDefinition(boardId);
      const parentLane = definition?.lanes.find(
        (l) => (l.key as string) === (parentLaneKey as string),
      );
      const forkStep = parentLane?.pipeline?.find(
        (s) => s.type === "fork" && (s.key as string) === result.fork.stepKey,
      );
      // Failures only use on.failure (never fall through to on.success).
      const routeTarget =
        forkStep?.type === "fork"
          ? joinResult === "success"
            ? forkStep.on?.success
            : forkStep.on?.failure
          : undefined;

      if (routeTarget !== undefined && !isParkTarget(routeTarget)) {
        return {
          parentTicketId: result.fork.parentTicketId,
          boardId,
          stepRunId: result.fork.stepRunId,
          toLane: routeTarget as LaneKey,
          blockReason: null,
          joinResult,
        } satisfies DeferredParentRoute;
      }
      if (joinResult !== "success") {
        return {
          parentTicketId: result.fork.parentTicketId,
          boardId,
          stepRunId: result.fork.stepRunId,
          toLane: null,
          blockReason: truncateReason(
            `fork join failed: ${result.join.succeeded} of ${result.fork.joinRequire} required`,
          ),
          joinResult,
        } satisfies DeferredParentRoute;
      }
      // Success with no on.success: stamp applied (nothing to route).
      yield* wrapSql(sql`
        UPDATE projection_ticket_fork
        SET route_applied_at = ${yield* nowIso}
        WHERE step_run_id = ${result.fork.stepRunId}
          AND route_applied_at IS NULL
      `).pipe(Effect.catch(() => Effect.void));
      return null;
    });

  /**
   * Build routedOptions for a post-join parent move. enterLaneCore rejects
   * reason "routed" when routedOptions is missing (expectedToken guard).
   * Errors (missing ticket mid-tx, etc.) are caught by applyDeferredParentRoute
   * so a best-effort drain never aborts an enclosing sync transaction.
   */
  const buildForkParentRoutedOptions = (deferred: DeferredParentRoute) =>
    Effect.gen(function* () {
      if (deferred.toLane === null) {
        return null;
      }
      const toLane = deferred.toLane;
      const detail = yield* read.getTicketDetail(deferred.parentTicketId);
      if (detail === null) {
        return null;
      }
      const token = detail.ticket.currentLaneEntryToken;
      const fromLaneKey = detail.ticket.currentLaneKey as LaneKey;
      const fromLane = yield* registry.getLane(deferred.boardId, fromLaneKey);
      if (token === null || fromLane === null) {
        return null;
      }
      const pipelineRows = yield* wrapSql(sql<{ readonly pipelineRunId: string }>`
        SELECT pipeline_run_id AS "pipelineRunId"
        FROM projection_step_run
        WHERE step_run_id = ${deferred.stepRunId}
        LIMIT 1
      `).pipe(Effect.catch(() => Effect.succeed([] as Array<{ pipelineRunId: string }>)));
      const pipelineRunId = (pipelineRows[0]?.pipelineRunId ?? deferred.stepRunId) as PipelineRunId;
      const result: PipelineResult = deferred.joinResult;
      const contextSnapshot = yield* routingContextBuilder.build({
        ticketId: deferred.parentTicketId,
        pipelineRunId,
        result,
      });
      return {
        routeDecision: {
          kind: "lane" as const,
          toLane,
          source: "step_on" as const,
        } satisfies LaneRouteDecision,
        contextSnapshot,
        expectedToken: token as LaneEntryToken,
        pipelineRunId,
        fromLane,
      } satisfies RoutedEnterLaneOptions;
    });

  /** Apply deferred parent route OUTSIDE admission lock (or with identity serialize). */
  const applyDeferredParentRoute = (
    deferred: DeferredParentRoute,
    unlocked?: {
      readonly emit: typeof lockedEmit;
      readonly serialize: <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    },
  ) =>
    Effect.gen(function* () {
      // Only stamp route_applied_at when the parent actually moved/queued or blocked —
      // never after a silent "none" (token race). Leaving NULL preserves the option
      // for a future recovery sweep; today there is no automatic re-apply consumer.
      let applied = false;

      if (deferred.toLane !== null) {
        const toLane = deferred.toLane;
        // Best-effort: build errors must not abort enclosing unlocked chunk txs.
        const routedOptions = yield* buildForkParentRoutedOptions(deferred).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (routedOptions === null) {
          // Token/lane missing: still advance parent so join is not a silent no-op.
          // Manual path skips the routed token guard (narrow: only when options null).
          if (unlocked !== undefined) {
            const acted = yield* enterLaneCore(
              deferred.parentTicketId,
              deferred.boardId,
              toLane,
              "manual",
              {
                emit: unlocked.emit,
                serialize: unlocked.serialize,
                supersedeRunningWork: Effect.void,
                stopProviderSessionsOnTeardown: false,
              },
            ).pipe(
              Effect.map((r) => r.acted),
              Effect.catch(() => Effect.succeed("none" as const)),
            );
            applied = acted !== "none";
          } else {
            const acted = yield* enterLane(
              deferred.parentTicketId,
              deferred.boardId,
              toLane,
              "manual",
            ).pipe(Effect.catch(() => Effect.succeed("none" as const)));
            applied = acted !== "none";
          }
        } else if (unlocked !== undefined) {
          const acted = yield* enterLaneCore(
            deferred.parentTicketId,
            deferred.boardId,
            toLane,
            "routed",
            {
              emit: unlocked.emit,
              serialize: unlocked.serialize,
              supersedeRunningWork: Effect.void,
              routedOptions,
              stopProviderSessionsOnTeardown: false,
            },
          ).pipe(
            Effect.map((r) => r.acted),
            Effect.catch(() => Effect.succeed("none" as const)),
          );
          applied = acted !== "none";
        } else {
          const acted = yield* enterLane(
            deferred.parentTicketId,
            deferred.boardId,
            toLane,
            "routed",
            routedOptions,
          ).pipe(Effect.catch(() => Effect.succeed("none" as const)));
          applied = acted !== "none";
        }
      } else if (deferred.blockReason !== null) {
        const blockEvent = {
          type: "TicketBlocked",
          ticketId: deferred.parentTicketId,
          payload: { reason: deferred.blockReason },
        } as UnstampedWorkflowEventInput;
        if (unlocked !== undefined) {
          applied = yield* unlocked.emit([blockEvent]).pipe(
            Effect.map(() => true),
            Effect.catch(() => Effect.succeed(false)),
          );
        } else {
          applied = yield* commit(blockEvent).pipe(
            Effect.map(() => true),
            Effect.catch(() => Effect.succeed(false)),
          );
        }
      }
      if (applied) {
        yield* wrapSql(sql`
          UPDATE projection_ticket_fork
          SET route_applied_at = ${yield* nowIso}
          WHERE step_run_id = ${deferred.stepRunId}
            AND route_applied_at IS NULL
        `).pipe(Effect.catch(() => Effect.void));
      }
    });

  const releaseHoldsBlockedByIds = (blockerTicketId: TicketId) =>
    Effect.gen(function* () {
      if (Option.isNone(worktreeCoordOption)) {
        return [] as ReadonlyArray<TicketId>;
      }
      return yield* worktreeCoordOption.value.releaseHoldsBlockedBy(blockerTicketId);
    });

  const resumeReleasedHolds = (ticketIds: ReadonlyArray<TicketId>) =>
    Effect.gen(function* () {
      for (const ticketId of ticketIds) {
        yield* runLane(ticketId).pipe(Effect.catch(() => Effect.void));
      }
    });

  // Stop whatever the ticket was doing: interrupt the running pipeline fiber,
  // cancel live provider turns so a stale agent cannot keep mutating the worktree
  // underneath the next lane's steps (e.g. a merge), and tombstone the outbox
  // rows so restart recovery never re-dispatches the stale work. Shared by the
  // manual move (runs it before the lock) and the external/unpark paths (run it
  // inside the lock, once their guard has confirmed the move still applies).
  const supersedeRunningWorkFor = (ticketId: TicketId) =>
    Effect.gen(function* () {
      yield* interruptRunningPipeline(ticketId);
      yield* cancelActiveProviderTurnsForTicket(ticketId).pipe(Effect.catch(() => Effect.void));
      yield* abandonTicketDispatches(ticketId).pipe(Effect.catch(() => Effect.void));
    });

  const enterLane = (
    ticketId: TicketId,
    boardId: BoardId,
    toLane: LaneKey,
    reason: MoveReason,
    routedOptions?: RoutedEnterLaneOptions,
    externalOptions?: ExternalEnterLaneOptions,
  ): Effect.Effect<"moved" | "queued" | "none", WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const supersedeRunningWork = supersedeRunningWorkFor(ticketId);
      if (reason === "manual") {
        yield* supersedeRunningWork;
      }

      const lockResult = yield* enterLaneCore(ticketId, boardId, toLane, reason, {
        routedOptions,
        externalOptions,
        supersedeRunningWork,
      });

      yield* runPipelineStarts(lockResult.starts);
      // Parent join routes + hold resumes MUST run outside admission lock.
      for (const deferred of lockResult.deferredForkRoutes) {
        yield* applyDeferredParentRoute(deferred);
      }
      yield* resumeReleasedHolds(lockResult.releasedHoldTicketIds);

      const movedLane = yield* registry.getLane(boardId, toLane);
      if (movedLane?.terminal === true) {
        // Resolution releases queued dependents; failure here must never undo
        // the move itself.
        yield* releaseDependents(ticketId).pipe(Effect.catch(() => Effect.void));
      }

      return lockResult.acted;
    });

  const moveToLane = (
    ticketId: TicketId,
    boardId: BoardId,
    toLane: LaneKey,
    reason: MoveReason,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    enterLane(ticketId, boardId, toLane, reason).pipe(Effect.asVoid);

  // A manual move driven by an unpark action. Unlike the plain manual move,
  // supersession does NOT run before the lock — it runs INSIDE the admission
  // lock only after the parked compare-and-act guard passes (a stale invoke must
  // have zero side effects). The guard is the authoritative TOCTOU check; the
  // action re-resolution + target-lane validation happen before this (race-free
  // definition data).
  const enterLaneWithParkedGuard = (
    ticketId: TicketId,
    boardId: BoardId,
    toLane: LaneKey,
    parkedGuard: {
      readonly expectedParkedEventId: WorkflowEventId;
      readonly revalidate?: Effect.Effect<void, WorkflowEventStoreError> | undefined;
    },
  ): Effect.Effect<"moved" | "queued" | "none", WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const lockResult = yield* enterLaneCore(ticketId, boardId, toLane, "manual", {
        supersedeRunningWork: supersedeRunningWorkFor(ticketId),
        parkedGuard,
      });

      yield* runPipelineStarts(lockResult.starts);
      for (const deferred of lockResult.deferredForkRoutes) {
        yield* applyDeferredParentRoute(deferred);
      }
      yield* resumeReleasedHolds(lockResult.releasedHoldTicketIds);

      const movedLane = yield* registry.getLane(boardId, toLane);
      if (movedLane?.terminal === true) {
        yield* releaseDependents(ticketId).pipe(Effect.catch(() => Effect.void));
      }

      return lockResult.acted;
    });

  // Parks a ticket in place. The ENTIRE critical section runs under the board
  // admission lock (uninterruptible), mirroring enterLaneCore's idiom: re-read
  // the ticket in-lock and bail unless BOTH its lane-entry token AND its lane
  // key still match the park decision (a concurrent move supersedes the park —
  // no TOCTOU), emit TicketParked (its token-null projection frees this lane's
  // WIP occupancy), then admit the next queued ticket. Collected starts run
  // AFTER the lock releases, exactly like enterLane. `expectedToken` is the
  // ticket's lane-entry token captured before the lock (string form so the
  // projection value passes without a cast); `laneKey` is the lane the park
  // decision was computed for.
  //
  // Lane binding (not just token) is load-bearing: a QUEUED ticket has a NULL
  // token, so a token-only guard would treat `NULL === NULL` as identity and
  // could park it in the WRONG lane after a concurrent move re-queued it
  // elsewhere. The lane key is what disambiguates the queued case.
  //
  // `supersedeRunningWork`, when provided, runs INSIDE the lock AFTER the guard
  // passes — this is the external-park path stopping the still-running pipeline
  // fiber (interrupt + cancel turns + tombstone dispatches), mirroring
  // enterLaneCore's external lane-move branch. It MUST be omitted on the
  // in-pipeline completion path (parkTicket then runs ON the pipeline fiber, so
  // superseding would interrupt the caller itself).
  const parkTicket = (
    ticketId: TicketId,
    boardId: BoardId,
    laneKey: LaneKey,
    expectedToken: string | null,
    target: WorkflowParkTarget,
    parkOrigin: string,
    reason: string,
    pipelineRunId?: PipelineRunId,
    supersedeRunningWork?: Effect.Effect<void, WorkflowEventStoreError>,
    // Returns whether the ticket was actually parked: `true` when the in-lock
    // token+lane guard held and `TicketParked` was emitted, `false` when a
    // concurrent move/re-queue superseded the park (nothing emitted). Callers
    // that report an outcome (external event ingest) must not claim "parked"
    // when the guard lost its race.
  ): Effect.Effect<boolean, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const starts: Array<PipelineStartAction> = [];
      const parked = yield* withAdmissionLock(
        boardId,
        Effect.uninterruptible(
          Effect.gen(function* () {
            const detail = yield* read.getTicketDetail(ticketId);
            const token = detail?.ticket.currentLaneEntryToken ?? null;
            const laneNow = detail?.ticket.currentLaneKey ?? null;
            if (token !== expectedToken || laneNow !== (laneKey as string)) {
              // Superseded by a concurrent move/re-queue (token OR lane drifted)
              // — do not park.
              return false;
            }
            // Only a confirmed-fresh park may kill the ticket's running work;
            // a superseded park must have zero side effects.
            if (supersedeRunningWork !== undefined) {
              yield* supersedeRunningWork;
            }
            const label =
              target.label ?? (target.park === "issue" ? "Issue encountered" : "Waiting on you");
            yield* commit({
              type: "TicketParked",
              ticketId,
              payload: {
                substate: target.park,
                label,
                reason,
                parkOrigin,
                ...(pipelineRunId === undefined ? {} : { pipelineRunId }),
                actionsSnapshot: target.actions,
              },
            });
            starts.push(...(yield* admitNext(boardId, laneKey, lockedEmit)));
            return true;
          }),
        ),
      );
      yield* runPipelineStarts(starts);
      return parked;
    });

  // Budgets are advisory caps — clamp junk client input instead of failing.
  const normalizeTokenBudget = (value: number | null | undefined): number | null | undefined => {
    if (value === undefined || value === null) {
      return value;
    }
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return Math.floor(value);
  };

  const validateDependsOn = (
    boardId: BoardId,
    ticketId: TicketId | null,
    dependsOn: ReadonlyArray<TicketId>,
  ): Effect.Effect<ReadonlyArray<TicketId>, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const unique = [...new Set(dependsOn)];
      if (ticketId !== null && unique.some((dep) => dep === ticketId)) {
        return yield* new WorkflowEventStoreError({
          message: "a ticket cannot depend on itself",
        });
      }
      for (const dep of unique) {
        const depDetail = yield* read.getTicketDetail(dep);
        if (depDetail === null) {
          return yield* new WorkflowEventStoreError({
            message: `dependency ticket ${dep} was not found`,
          });
        }
        if (depDetail.ticket.boardId !== (boardId as string)) {
          return yield* new WorkflowEventStoreError({
            message: "dependencies must be tickets on the same board",
          });
        }
      }
      if (ticketId !== null) {
        // Walk the existing edges from each new dependency; reaching the
        // ticket itself would close a cycle and deadlock both tickets. The
        // budget exists only to bound pathological graphs — exhausting it
        // with work remaining fails closed rather than letting a deep cycle
        // slip through.
        const seen = new Set<string>();
        const stack: string[] = [...unique];
        while (stack.length > 0) {
          if (seen.size > 500) {
            return yield* new WorkflowEventStoreError({
              message: "dependency graph is too deep to validate",
            });
          }
          const current = stack.pop();
          if (current === undefined) {
            break;
          }
          if (current === (ticketId as string)) {
            return yield* new WorkflowEventStoreError({
              message: "circular ticket dependencies are not allowed",
            });
          }
          if (seen.has(current)) {
            continue;
          }
          seen.add(current);
          const currentDetail = yield* read.getTicketDetail(current as TicketId);
          stack.push(...(currentDetail?.ticket.dependsOn ?? []));
        }
      }
      return unique;
    });

  const releaseDependents = (
    resolvedTicketId: TicketId,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const dependents = yield* read.listReleasableDependents(resolvedTicketId);
      for (const dependent of dependents) {
        yield* releaseTicketIfEligible(dependent.ticketId as TicketId);
      }
    });

  // Admit a queued ticket whose dependencies are all resolved. Used when a
  // dependency edit removes the last blocker and by restart recovery —
  // unlimited lanes are never swept by admitNext, so they need a
  // direct admit.
  const releaseTicketIfEligible = (
    ticketId: TicketId,
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const detail = yield* read.getTicketDetail(ticketId);
      if (
        detail === null ||
        detail.ticket.queuedAt === null ||
        (detail.ticket.unresolvedDependencyCount ?? 0) > 0
      ) {
        return;
      }
      const boardId = detail.ticket.boardId as BoardId;
      const laneKey = detail.ticket.currentLaneKey as LaneKey;
      const lane = yield* registry.getLane(boardId, laneKey);
      if (lane === null) {
        return;
      }
      const starts = yield* withAdmissionLock(
        boardId,
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (lane.wipLimit !== undefined) {
              return yield* admitNext(boardId, laneKey);
            }
            const lockedDetail = yield* read.getTicketDetail(ticketId);
            if (
              lockedDetail === null ||
              lockedDetail.ticket.queuedAt === null ||
              (lockedDetail.ticket.unresolvedDependencyCount ?? 0) > 0
            ) {
              return [];
            }
            const laneEntryToken = yield* ids.token();
            yield* commit({
              type: "TicketAdmitted",
              ticketId,
              payload: { lane: laneKey, laneEntryToken },
            });
            const released: Array<PipelineStartAction> = [];
            collectStartAction(released, ticketId, boardId, lane, laneEntryToken);
            return released;
          }),
        ),
      );
      yield* runPipelineStarts(starts);
    });

  const createTicket: WorkflowEngineShape["createTicket"] = (input) =>
    Effect.gen(function* () {
      const dependsOn =
        input.dependsOn === undefined || input.dependsOn.length === 0
          ? []
          : yield* validateDependsOn(input.boardId, null, input.dependsOn);
      const ticketId = yield* ids.ticketId();
      const tokenBudget = normalizeTokenBudget(input.tokenBudget);
      yield* commit({
        type: "TicketCreated",
        ticketId,
        payload: {
          boardId: input.boardId,
          title: input.title,
          laneKey: input.initialLane,
          description: input.description,
          ...(tokenBudget === undefined || tokenBudget === null ? {} : { tokenBudget }),
        },
      } as UnstampedWorkflowEventInput);
      if (dependsOn.length > 0) {
        yield* commit({
          type: "TicketDependenciesSet",
          ticketId,
          payload: { dependsOn },
        });
      }
      yield* moveToLane(ticketId, input.boardId, input.initialLane, "initial");
      return ticketId;
    });

  const editTicket: WorkflowEngineShape["editTicket"] = (input) =>
    Effect.gen(function* () {
      const title = input.title === undefined ? undefined : input.title.trim();
      if (title !== undefined && title.length === 0) {
        return yield* new WorkflowEventStoreError({ message: "ticket title cannot be empty" });
      }
      if (input.dependsOn !== undefined) {
        const detail = yield* read.getTicketDetail(input.ticketId);
        if (detail === null) {
          return yield* new WorkflowEventStoreError({ message: "ticket not found" });
        }
        const boardId = detail.ticket.boardId as BoardId;
        // Validate and commit under the board's admission lock so two
        // concurrent edits cannot both validate against the old graph and
        // commit edges that only together form a cycle.
        yield* withAdmissionLock(
          boardId,
          Effect.gen(function* () {
            const dependsOn = yield* validateDependsOn(
              boardId,
              input.ticketId,
              input.dependsOn ?? [],
            );
            yield* commit({
              type: "TicketDependenciesSet",
              ticketId: input.ticketId,
              payload: { dependsOn },
            });
          }),
        );
        // Removing the last blocker must release the ticket right away —
        // there is no terminal move to trigger it otherwise.
        yield* releaseTicketIfEligible(input.ticketId).pipe(Effect.catch(() => Effect.void));
      }
      const tokenBudget = normalizeTokenBudget(input.tokenBudget);
      if (title === undefined && input.description === undefined && tokenBudget === undefined) {
        return;
      }
      yield* commit({
        type: "TicketEdited",
        ticketId: input.ticketId,
        payload: {
          ...(title === undefined ? {} : { title: title as never }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(tokenBudget === undefined ? {} : { tokenBudget }),
        },
      });
    });

  const editTicketContextPack: WorkflowEngineShape["editTicketContextPack"] = (input) =>
    Effect.gen(function* () {
      const detail = yield* read.getTicketDetail(input.ticketId);
      if (detail === null) {
        return yield* new WorkflowEventStoreError({ message: "ticket not found" });
      }
      const boardId = detail.ticket.boardId as BoardId;

      // Redact BEFORE capping: redaction can expand short values, so capping first
      // would let over-cap text reach the persisted row.
      const canonical = canonicalizeSubmittedSections(
        input.sections as ReadonlyArray<{
          readonly key: WorkflowContextPackSectionKey;
          readonly body: string;
        }>,
      );

      return yield* withAdmissionLock(
        boardId,
        Effect.gen(function* () {
          // Revalidate under the lock: a concurrent move must not let a stale edit
          // land on a lane the ticket has already left.
          const current = yield* read.getTicketDetail(input.ticketId);
          if (current === null) {
            return yield* new WorkflowEventStoreError({ message: "ticket not found" });
          }
          if (current.ticket.currentLaneKey !== input.forLane) {
            return yield* new WorkflowEventStoreError({
              message: "context pack can only be edited for the ticket's current lane",
            });
          }
          const existing = yield* read.getContextPack(input.ticketId, input.forLane);
          if (existing === null) {
            return yield* new WorkflowEventStoreError({
              message: "no context pack for this lane",
            });
          }

          if (canonical.length === 0) {
            yield* commit({
              type: "TicketContextPackEdited",
              ticketId: input.ticketId,
              payload: { forLane: input.forLane, sections: [] },
            });
            // `commit` resolves to void even when the append wrote nothing (the
            // ticket or board vanished, or the board was unregistered), so verify
            // the EFFECT rather than merely that the ticket still exists — the
            // latter is true in exactly the case this guard must catch.
            const after = yield* read.getContextPack(input.ticketId, input.forLane);
            if (after !== null) {
              return yield* new WorkflowEventStoreError({
                message: "context pack delete did not persist",
              });
            }
            return { sections: [] as ReadonlyArray<WorkflowContextPackSection> };
          }

          const priorByKey = new Map(existing.sections.map((s) => [s.key, s]));
          // Flags are decided AFTER the whole-pack cap: the cap can truncate a
          // body, and a truncated body no longer matches what the compiler wrote,
          // so it must not keep claiming to be auto-generated.
          const persisted = applyTotalCap(
            canonical.map((section) => ({
              key: section.key,
              body: redactAndCap(section.body),
              autoGenerated: false,
            })),
          ).map((section) => {
            const prior = priorByKey.get(section.key);
            // Only a section whose body actually changed flips to user-authored;
            // resubmitting an untouched section keeps its flag.
            return prior !== undefined && prior.body === section.body
              ? { ...section, autoGenerated: prior.autoGenerated }
              : section;
          });

          // A byte-identical canonical set commits nothing: an untouched Save must
          // not stamp editedAt.
          if (sectionsEqual(persisted, existing.sections)) {
            return { sections: existing.sections };
          }

          yield* commit({
            type: "TicketContextPackEdited",
            ticketId: input.ticketId,
            payload: { forLane: input.forLane, sections: persisted },
          });
          // Same read-back guard as the deletion branch, and for the same reason
          // it must compare CONTENT: a silent no-op append leaves the pre-edit
          // pack in place, which is non-null and would pass a mere existence
          // check while the caller is told its edit persisted.
          const stored = yield* read.getContextPack(input.ticketId, input.forLane);
          if (stored === null || !sectionsEqual(stored.sections, persisted)) {
            return yield* new WorkflowEventStoreError({
              message: "context pack edit did not persist",
            });
          }
          return { sections: stored.sections };
        }),
      );
    });

  const validateTicketMessageInput = (
    input: {
      readonly text?: string | undefined;
      readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
    },
    subject: "message" | "answer",
  ): Effect.Effect<
    { readonly text: string; readonly attachments: ReadonlyArray<TicketAttachment> },
    WorkflowEventStoreError
  > =>
    Effect.gen(function* () {
      const text = input.text?.trim() ?? "";
      const attachments: ReadonlyArray<TicketAttachment> = input.attachments ?? [];
      if (text.length === 0 && attachments.length === 0) {
        return yield* new WorkflowEventStoreError({
          message: `ticket ${subject} requires text or an attachment`,
        });
      }
      if (text.length > MAX_TICKET_ANSWER_BODY_LENGTH) {
        return yield* new WorkflowEventStoreError({
          message: `ticket ${subject} body exceeds ${MAX_TICKET_ANSWER_BODY_LENGTH} characters`,
        });
      }
      if (attachments.length > MAX_TICKET_ANSWER_ATTACHMENT_COUNT) {
        return yield* new WorkflowEventStoreError({
          message: `ticket ${subject} supports at most ${MAX_TICKET_ANSWER_ATTACHMENT_COUNT} attachments`,
        });
      }
      if (attachments.some((attachment) => attachment.kind !== "image")) {
        return yield* new WorkflowEventStoreError({
          message: `ticket ${subject} attachments must be images`,
        });
      }
      if (
        attachments.some(
          (attachment) =>
            attachment.kind === "image" &&
            (!SAFE_TICKET_IMAGE_MIME_TYPES.has(attachment.mimeType) ||
              !SAFE_TICKET_IMAGE_DATA_URL.test(attachment.dataUrl)),
        )
      ) {
        return yield* new WorkflowEventStoreError({
          message: `ticket ${subject} image attachments must use png, jpeg, gif, or webp data URLs`,
        });
      }
      if (ticketAnswerAttachmentBytes(attachments) > MAX_TICKET_ANSWER_ATTACHMENT_BYTES) {
        return yield* new WorkflowEventStoreError({
          message: `ticket ${subject} attachments exceed the 10 MiB encoded limit`,
        });
      }
      return { text, attachments };
    });

  const postTicketMessage: WorkflowEngineShape["postTicketMessage"] = (input) =>
    Effect.gen(function* () {
      const { text, attachments } = yield* validateTicketMessageInput(input, "message");
      const detail = yield* read.getTicketDetail(input.ticketId);
      if (!detail) {
        return yield* new WorkflowEventStoreError({ message: "ticket not found" });
      }
      const messageId = yield* ids.messageId();
      yield* commit({
        type: "TicketMessagePosted",
        ticketId: input.ticketId,
        payload: {
          messageId,
          author: "user",
          body: text,
          attachments,
          createdAt: (yield* nowIso) as never,
        },
      });
    });

  const editTicketMessage: WorkflowEngineShape["editTicketMessage"] = (input) =>
    Effect.gen(function* () {
      const detail = yield* read.getTicketDetail(input.ticketId);
      if (!detail) {
        return yield* new WorkflowEventStoreError({ message: "ticket not found" });
      }
      const { text } = yield* validateTicketMessageInput({ text: input.body }, "message");
      const target = detail.messages.find((m) => m.messageId === input.messageId);
      if (!target) {
        return yield* new WorkflowEventStoreError({ message: "message not found" });
      }
      // Only a user's own free-standing comment is editable: agent messages and
      // user answers bound to a step run (stepRunId set) carry provider-side
      // state we must not retroactively rewrite.
      if (target.author !== "user" || target.stepRunId != null) {
        return yield* new WorkflowEventStoreError({
          message: "only your own comments can be edited",
        });
      }
      yield* commit({
        type: "TicketMessageEdited",
        ticketId: input.ticketId,
        payload: {
          messageId: input.messageId,
          body: text,
          editedAt: (yield* nowIso) as never,
        },
      });
    });

  const stepSteeredExists = (messageId: string) =>
    wrapSql(sql<{
      readonly ticketId: string;
      readonly stepRunId: string;
      readonly text: string;
    }>`
      SELECT
        ticket_id AS "ticketId",
        json_extract(payload_json, '$.stepRunId') AS "stepRunId",
        json_extract(payload_json, '$.text') AS "text"
      FROM workflow_events
      WHERE event_type = 'StepSteered'
        AND json_extract(payload_json, '$.messageId') = ${messageId}
      LIMIT 1
    `).pipe(
      Effect.orElseSucceed(
        () =>
          [] as Array<{
            readonly ticketId: string;
            readonly stepRunId: string;
            readonly text: string;
          }>,
      ),
    );

  /** Append StepSteered once for a staged delivery; clear the stage after. */
  const commitStepSteeredOnce = (input: {
    readonly dispatchId: never;
    readonly ticketId: TicketId;
    readonly stepRunId: never;
    readonly messageId: never;
    readonly text: string;
    readonly outbox: {
      readonly clearStagedSteerDelivery: (
        dispatchId: never,
        messageId: never,
      ) => Effect.Effect<void, WorkflowEventStoreError>;
    };
  }) =>
    Effect.gen(function* () {
      const existing = yield* stepSteeredExists(input.messageId as string);
      if (existing[0] !== undefined) {
        yield* input.outbox.clearStagedSteerDelivery(input.dispatchId, input.messageId);
        return;
      }
      yield* commit({
        type: "StepSteered",
        ticketId: input.ticketId,
        payload: {
          stepRunId: input.stepRunId,
          messageId: input.messageId,
          text: input.text,
        },
      });
      yield* input.outbox.clearStagedSteerDelivery(input.dispatchId, input.messageId);
    });

  const steerTicketStep: WorkflowEngineShape["steerTicketStep"] = (input) =>
    Effect.gen(function* () {
      // Idempotency first (before mutable-state validation), keyed by messageId.
      // Success only when a matching StepSteered exists — not for failed receipts.
      const existingSteers = yield* stepSteeredExists(input.messageId as string);
      if (existingSteers[0] !== undefined) {
        const row = existingSteers[0];
        if (
          row.ticketId === (input.ticketId as string) &&
          row.stepRunId === (input.stepRunId as string) &&
          row.text === input.text
        ) {
          return { accepted: true as const };
        }
        return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.messageIdReuse });
      }

      // In-flight or already delivered (but StepSteered may still be pending
      // append). Failed receipts intentionally do NOT short-circuit — client
      // may retry with the same messageId after a failed delivery.
      const inFlightMarkers = yield* wrapSql(sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM (
          SELECT 1 AS x
          FROM workflow_dispatch_outbox
          WHERE steer_pending_message_id = ${input.messageId}
             OR steer_delivered_message_id = ${input.messageId}
          UNION ALL
          SELECT 1 AS x
          FROM projection_thread_activities
          WHERE kind = 'workflow.steer.delivered'
            AND (
              json_extract(payload_json, '$.messageId') = ${input.messageId}
              OR payload_json LIKE ${`%${input.messageId as string}%`}
            )
        )
      `).pipe(Effect.orElseSucceed(() => [{ n: 0 }]));
      if ((inFlightMarkers[0]?.n ?? 0) > 0) {
        return { accepted: true as const };
      }

      const detail = yield* read.getTicketDetail(input.ticketId);
      if (detail === null) {
        return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.ticketNotFound });
      }
      if (detail.ticket.status === "parked") {
        return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.parkedTicket });
      }

      const step = detail.steps.find((s) => s.stepRunId === (input.stepRunId as string));
      if (step === undefined) {
        return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.stepNotFound });
      }
      if (step.stepType !== "agent") {
        return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.notAgentStep });
      }
      if (step.status === "dispatch_requested") {
        return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.agentStarting });
      }
      if (step.status === "awaiting_user") {
        return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.awaitingUser });
      }
      if (step.status !== "running") {
        return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.stepNotRunning });
      }

      const { providerDispatches, providerTurnPort, turnStateReader } = yield* getOptionalServices;
      if (Option.isNone(providerDispatches) || Option.isNone(providerTurnPort)) {
        return yield* new WorkflowEventStoreError({
          message: STEER_REJECTION.orchestrationUnavailable,
        });
      }
      const outbox = providerDispatches.value;
      const turnPort = providerTurnPort.value;

      const target = yield* outbox.getSteerTarget(input.stepRunId);
      if (target === null) {
        return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.agentStarting });
      }
      // Turn id may lag one poll after start; still require a live running turn.
      if (target.panelSize !== null && target.panelSize >= 2) {
        return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.panelStep });
      }
      if (target.steerPendingMessageId !== null) {
        return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.steerInFlight });
      }

      if (Option.isSome(turnStateReader)) {
        const state = yield* turnStateReader.value.read(target.threadId);
        if (state._tag === "awaiting_user") {
          return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.awaitingUser });
        }
        if (state._tag === "completed" || state._tag === "failed") {
          return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.stepNotRunning });
        }
        if (state._tag !== "running") {
          // Pre-start / no projected turn yet.
          return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.agentStarting });
        }
      } else if (target.turnId === null) {
        return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.agentStarting });
      }

      const reserved = yield* outbox.markSteerPending(
        target.dispatchId,
        input.messageId,
        input.text,
      );
      if (!reserved) {
        return yield* new WorkflowEventStoreError({ message: STEER_REJECTION.steerInFlight });
      }

      const framed = frameSteerText(input.text, target.captureOutput);
      const submit = turnPort.steerTurn;
      if (submit === undefined) {
        yield* outbox.clearSteerPending(target.dispatchId, input.messageId);
        return yield* new WorkflowEventStoreError({
          message: STEER_REJECTION.orchestrationUnavailable,
        });
      }

      const exit = yield* Effect.exit(
        submit({
          threadId: target.threadId,
          messageId: input.messageId,
          text: framed,
          // Mirror the in-flight dispatch's mode: a steer adds a message to an
          // existing turn and must never change the step's permissions. Unknown
          // or legacy values fall back to the workflow default used at dispatch.
          runtimeMode:
            target.runtimeMode === "approval-required" ||
            target.runtimeMode === "auto-accept-edits" ||
            target.runtimeMode === "full-access"
              ? target.runtimeMode
              : "full-access",
        }),
      );
      if (exit._tag === "Failure") {
        yield* outbox.clearSteerPending(target.dispatchId, input.messageId);
        return yield* new WorkflowEventStoreError({
          message: "steer submit failed",
          cause: exit.cause,
        });
      }

      // Best-effort in-process reconcile. Durable path: outbox stages delivery
      // on receipt (awaitTerminal / this fiber); recovery drains staged rows
      // into StepSteered if the fiber dies.
      const reconcileSteerAck = Effect.gen(function* () {
        for (let attempt = 0; attempt < 240; attempt++) {
          yield* Effect.sleep(Duration.millis(250));
          const receipts = yield* wrapSql(sql<{ readonly kind: string }>`
            SELECT kind
            FROM projection_thread_activities
            WHERE thread_id = ${target.threadId}
              AND kind IN ('workflow.steer.delivered', 'workflow.steer.failed')
              AND (
                json_extract(payload_json, '$.messageId') = ${input.messageId}
                OR payload_json LIKE ${`%${input.messageId as string}%`}
              )
            ORDER BY created_at DESC
            LIMIT 1
          `).pipe(Effect.orElseSucceed(() => [] as Array<{ readonly kind: string }>));
          const kind = receipts[0]?.kind;
          if (kind === "workflow.steer.failed") {
            yield* outbox.clearSteerPending(target.dispatchId, input.messageId);
            return;
          }
          if (kind === "workflow.steer.delivered") {
            // Only commit StepSteered when the outbox actually staged/acks this
            // message (false = reservation superseded / tombstoned — do not
            // write an audit event the outbox refused to own).
            const staged = yield* outbox.ackSteerDelivered(target.dispatchId, input.messageId);
            if (staged) {
              yield* commitStepSteeredOnce({
                dispatchId: target.dispatchId as never,
                ticketId: input.ticketId,
                stepRunId: input.stepRunId as never,
                messageId: input.messageId as never,
                text: input.text,
                outbox: outbox as never,
              });
            }
            return;
          }
          // Staged by awaitTerminal while we were waiting.
          const staged = yield* outbox.listStagedSteerDeliveries();
          const mine = staged.find(
            (row) =>
              (row.dispatchId as string) === (target.dispatchId as string) &&
              (row.messageId as string) === (input.messageId as string),
          );
          if (mine !== undefined) {
            yield* commitStepSteeredOnce({
              dispatchId: target.dispatchId as never,
              ticketId: input.ticketId,
              stepRunId: input.stepRunId as never,
              messageId: input.messageId as never,
              text: mine.text.length > 0 ? mine.text : input.text,
              outbox: outbox as never,
            });
            return;
          }
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("workflow.steer.ack-reconcile-failed", { cause }),
        ),
      );

      yield* reconcileSteerAck.pipe(Effect.forkDetach, Effect.asVoid);

      return { accepted: true as const };
    });

  const answerTicketStep: WorkflowEngineShape["answerTicketStep"] = (input) =>
    Effect.gen(function* () {
      const { text, attachments } = yield* validateTicketMessageInput(input, "answer");
      // Provider responses are text-only, so an attachment-only answer could
      // never resume the awaiting step — reject before committing anything.
      if (text.length === 0) {
        return yield* new WorkflowEventStoreError({
          message: "answering an awaiting step requires text — add a note alongside attachments",
        });
      }

      const ticketId = yield* ticketIdForStepRun(input.stepRunId);
      if (ticketId === null) {
        // Fail (don't silently succeed): a stale/unknown stepRunId means the
        // answer would be dropped, and the client must learn its answer never
        // landed instead of seeing a void "success".
        return yield* new WorkflowEventStoreError({
          message: `step run ${input.stepRunId} not found`,
        });
      }
      // Refuse to answer a parked ticket: park and an open agent wait cannot
      // coexist by design, so a parked status here means a stale fiber's wait
      // survived a supersede. Resuming it would write StepUserResolved/running
      // over the parked row. Fail typed instead of orphaning the park.
      const parkedCheck = yield* read.getTicketDetail(ticketId);
      if (parkedCheck?.ticket.status === "parked") {
        return yield* new WorkflowEventStoreError({
          message: "ticket is parked",
        });
      }
      const awaitingState = yield* awaitingStateForStepRun(input.stepRunId);
      const pending = yield* pendingWaitFor(input.stepRunId);
      const responseKind =
        awaitingState === null
          ? pending?.payload.providerResponseKind
          : awaitingState.status === "awaiting_user"
            ? awaitingState.providerResponseKind
            : null;
      if (responseKind !== "user-input") {
        return yield* new WorkflowEventStoreError({
          message: "ticket answer requires an awaiting user-input step",
        });
      }
      yield* ensureLiveProviderUserInputWait(pending);

      // Serialized parked precondition on the message append. The early check
      // above is a fast pre-validation only; an external park can land between it
      // and this append (interrupting/cancelling the wait and nulling the token).
      // A plain re-read here would still race: the park could commit between the
      // read and the append and durably record a user answer the provider never
      // received. Instead hand the committer a precondition that re-reads the
      // ticket INSIDE the board save lock, immediately before the append — the
      // park's own TicketParked commit takes that same lock, so the two are
      // serialized. If the ticket is parked at that point the whole commit fails
      // typed with NOTHING appended: no phantom TicketMessagePosted enters the
      // stream, and the provider respond() below never runs. Residual: a park
      // landing AFTER this append commits is harmless — StepUserResolved is
      // refused by the projection on a parked row, and respond() targets a
      // provider request the park's supersede already cancelled (a no-op turn).
      const parkedAppendPrecondition = Effect.gen(function* () {
        const parkedAtAppend = yield* read.getTicketDetail(ticketId);
        if (parkedAtAppend?.ticket.status === "parked") {
          return yield* new WorkflowEventStoreError({
            message: "ticket is parked",
          });
        }
      });

      const messageId = yield* ids.messageId();
      yield* commit(
        {
          type: "TicketMessagePosted",
          ticketId,
          payload: {
            messageId,
            stepRunId: input.stepRunId,
            author: "user",
            body: text,
            attachments,
            createdAt: (yield* nowIso) as never,
          },
        },
        parkedAppendPrecondition,
      );

      const { providerResponses } = yield* getOptionalServices;
      if (
        pending?.payload.providerThreadId &&
        pending.payload.providerRequestId &&
        pending.payload.providerResponseKind === "user-input" &&
        Option.isSome(providerResponses)
      ) {
        yield* providerResponses.value.respond({
          threadId: pending.payload.providerThreadId,
          requestId: pending.payload.providerRequestId,
          responseKind: pending.payload.providerResponseKind,
          approved: true,
          ...(pending.payload.providerQuestionId === undefined
            ? {}
            : { questionId: pending.payload.providerQuestionId }),
          text,
        });
      }

      if (pending?.payload.providerResponseKind !== "user-input") {
        return;
      }
      const resumedLiveWaiter = yield* approvals.resolve(input.stepRunId, { outcome: "success" });
      if (!resumedLiveWaiter) {
        yield* continueRecoveredApproval(pending, { outcome: "success" });
      }
    });

  const moveTicket: WorkflowEngineShape["moveTicket"] = (ticketId, toLane) =>
    Effect.gen(function* () {
      const currentDetail = yield* read.getTicketDetail(ticketId);
      if (!currentDetail) {
        // Fail (don't silently succeed): a deleted/unknown ticket id must
        // surface to the caller, not look like a successful manual move.
        return yield* new WorkflowEventStoreError({
          message: `ticket ${ticketId} not found`,
        });
      }
      yield* moveToLane(ticketId, currentDetail.ticket.boardId as BoardId, toLane, "manual");
    });

  /**
   * SLA sweeper entry point. Never calls public `moveTicket` (hardcodes
   * "manual"; re-acquiring the non-reentrant admission semaphore deadlocks).
   * Lock order: admission OUTER → save-lock commit INNER. Returns:
   * - escalated / queued: breach + move/queue committed
   * - notified: notify-only breach (no target / vanished target / lifetime cap)
   * - stale: in-lock guard mismatch, no events
   */
  const escalateTicketSla = (input: {
    readonly ticketId: TicketId;
    readonly expectedLaneKey: LaneKey;
    readonly expectedEntryToken: string;
    readonly nowMs?: Effect.Effect<number>;
  }): Effect.Effect<EscalateTicketSlaResult, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const currentDetail = yield* read.getTicketDetail(input.ticketId);
      if (!currentDetail) {
        return "stale" as const;
      }
      const boardId = currentDetail.ticket.boardId as BoardId;
      const clockMs = input.nowMs ?? Clock.currentTimeMillis;

      type LockOutcome = {
        readonly result: EscalateTicketSlaResult;
        readonly starts: ReadonlyArray<PipelineStartAction>;
        readonly releaseDependentsFor?: TicketId;
        readonly releasedHoldTicketIds?: ReadonlyArray<TicketId>;
      };

      const lockOutcome = yield* withAdmissionLock(
        boardId,
        Effect.uninterruptible(
          Effect.gen(function* () {
            const detail = yield* read.getTicketDetail(input.ticketId);
            const ticket = detail?.ticket;
            if (!ticket) {
              return { result: "stale" as const, starts: [] };
            }

            // In-lock guard (projection row is authoritative).
            const status = ticket.status;
            if (
              ticket.currentLaneKey !== (input.expectedLaneKey as string) ||
              ticket.currentLaneEntryToken !== input.expectedEntryToken ||
              status === "parked" ||
              status === "queued" ||
              ticket.currentLaneEntryToken === null
            ) {
              return { result: "stale" as const, starts: [] };
            }
            // NULL-safe: already breached for this entry?
            if (ticket.slaBreachedEntryToken === input.expectedEntryToken) {
              return { result: "stale" as const, starts: [] };
            }

            // Authoritative terminal_at check (terminal tickets never breach).
            const termRows = yield* wrapSql(sql<{ readonly terminalAt: string | null }>`
              SELECT terminal_at AS "terminalAt"
              FROM projection_ticket
              WHERE ticket_id = ${input.ticketId}
            `);
            if (termRows[0]?.terminalAt !== null && termRows[0]?.terminalAt !== undefined) {
              return { result: "stale" as const, starts: [] };
            }

            const currentLane = yield* registry.getLane(boardId, input.expectedLaneKey);
            if (currentLane === null || currentLane.terminal === true) {
              return { result: "stale" as const, starts: [] };
            }
            // Lifetime cap: count escalations that actually routed (escalatedTo
            // set on TicketSlaBreached covers both moved and queued paths).
            const lifetimeRows = yield* wrapSql(sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM workflow_events
              WHERE ticket_id = ${input.ticketId}
                AND event_type = 'TicketSlaBreached'
                AND json_extract(payload_json, '$.escalatedTo') IS NOT NULL
            `);
            const lifetimeCount = lifetimeRows[0]?.count ?? 0;
            const capHit = lifetimeCount >= MAX_LIFETIME_SLA_ESCALATIONS;

            // Definition revalidation (also repeated as save-lock precondition).
            const revalidate = Effect.gen(function* () {
              const lane = yield* registry.getLane(boardId, input.expectedLaneKey);
              if (lane === null || lane.sla === undefined) {
                return yield* new WorkflowEventStoreError({
                  message: "SLA no longer configured on source lane",
                });
              }
              const budgetMs = Duration.toMillis(lane.sla.budget);
              if (
                !Number.isFinite(budgetMs) ||
                !Number.isSafeInteger(budgetMs) ||
                budgetMs < MIN_SLA_BUDGET_MS
              ) {
                return yield* new WorkflowEventStoreError({
                  message: "SLA budget no longer valid",
                });
              }
              const enteredRows = yield* wrapSql(sql<{ readonly enteredAt: string | null }>`
                SELECT current_lane_entered_at AS "enteredAt"
                FROM projection_ticket
                WHERE ticket_id = ${input.ticketId}
              `);
              const enteredIso = enteredRows[0]?.enteredAt;
              if (enteredIso === null || enteredIso === undefined) {
                return yield* new WorkflowEventStoreError({
                  message: "missing lane entry timestamp for SLA",
                });
              }
              const enteredMs = Date.parse(enteredIso);
              const now = yield* clockMs;
              if (!Number.isFinite(enteredMs) || now - enteredMs < budgetMs) {
                return yield* new WorkflowEventStoreError({
                  message: "SLA budget not exceeded",
                });
              }
              return {
                budgetMs,
                enteredIso,
                escalateTo: lane.sla.escalateTo,
              } as const;
            });

            // Expected drift (budget/SLA gone) → stale; other failures propagate.
            const plan = yield* revalidate.pipe(
              Effect.catchTag("WorkflowEventStoreError", (error) => {
                const msg = error.message;
                if (
                  msg.includes("SLA ") ||
                  msg.includes("missing lane entry") ||
                  msg.includes("SLA budget")
                ) {
                  return Effect.succeed(null);
                }
                return Effect.fail(error);
              }),
            );
            if (plan === null) {
              return { result: "stale" as const, starts: [] };
            }

            let escalateTo = plan.escalateTo;
            let notifyOnly = escalateTo === undefined || capHit;
            if (capHit && escalateTo !== undefined) {
              yield* Effect.logWarning(
                "SLA lifetime escalation cap hit — downgrading to notify-only breach",
                { ticketId: input.ticketId, lifetimeCount },
              );
            }
            let targetIsTerminal = false;
            if (escalateTo !== undefined && !notifyOnly) {
              const targetLane = yield* registry.getLane(boardId, escalateTo);
              if (targetLane === null) {
                yield* Effect.logWarning(
                  "SLA escalateTo target vanished — downgrading to notify-only breach",
                  { ticketId: input.ticketId, escalateTo },
                );
                notifyOnly = true;
                escalateTo = undefined;
              } else {
                targetIsTerminal = targetLane.terminal === true;
              }
            }

            const makeBreachEvent = (withEscalation: boolean) =>
              ({
                type: "TicketSlaBreached",
                ticketId: input.ticketId,
                payload: {
                  laneKey: input.expectedLaneKey,
                  laneEntryToken: input.expectedEntryToken as LaneEntryToken,
                  budgetMs: plan.budgetMs,
                  enteredLaneAt: plan.enteredIso as never,
                  ...(withEscalation && escalateTo !== undefined
                    ? { escalatedTo: escalateTo }
                    : {}),
                },
              }) as UnstampedWorkflowEventInput;

            if (notifyOnly) {
              // Notify-only: no supersede — ticket stays in-lane and keeps work.
              yield* commitMany([makeBreachEvent(false)], revalidate.pipe(Effect.asVoid));
              return { result: "notified" as const, starts: [] };
            }

            // Confirmed move/queue path — supersede running work now (in-lock).
            yield* supersedeRunningWorkFor(input.ticketId);

            // Prefix TicketSlaBreached only on the FIRST emit (the move/queue).
            // admitNext reuses the same emit for source-lane drain and must NOT
            // get a second breach event.
            let breachPrefixed = false;
            const breachEvent = makeBreachEvent(true);
            const prefixEmit = (
              events: ReadonlyArray<UnstampedWorkflowEventInput>,
              precondition?: Effect.Effect<void, WorkflowEventStoreError>,
            ) => {
              if (!breachPrefixed) {
                breachPrefixed = true;
                return commitMany([breachEvent, ...events], precondition);
              }
              return commitMany(events, precondition);
            };

            const targetKey = escalateTo as LaneKey;
            const coreResult = yield* enterLaneCore(input.ticketId, boardId, targetKey, "sla", {
              supersedeRunningWork: Effect.void,
              emit: prefixEmit,
              serialize: (body) => body,
              emitPrecondition: revalidate.pipe(Effect.asVoid),
            });
            const { starts, acted } = coreResult;
            // Already holding admission: apply with identity serialize (no re-lock).
            for (const deferred of coreResult.deferredForkRoutes) {
              yield* applyDeferredParentRoute(deferred, {
                emit: prefixEmit,
                serialize: (body) => body,
              });
            }

            if (acted === "none") {
              // Target refused after recheck — notify-only without escalatedTo.
              yield* commitMany([makeBreachEvent(false)], revalidate.pipe(Effect.asVoid));
              return { result: "notified" as const, starts: [] };
            }

            return {
              result: (acted === "queued" ? "queued" : "escalated") as EscalateTicketSlaResult,
              starts,
              releaseDependentsFor:
                acted === "moved" && targetIsTerminal ? input.ticketId : undefined,
              releasedHoldTicketIds: coreResult.releasedHoldTicketIds,
            };
          }),
        ),
      );

      // Post-lock starts + terminal dependent release (same as enterLane).
      if (lockOutcome.starts.length > 0) {
        yield* runPipelineStarts(lockOutcome.starts as never);
      }
      if (lockOutcome.releaseDependentsFor !== undefined) {
        yield* releaseDependents(lockOutcome.releaseDependentsFor).pipe(
          Effect.catch(() => Effect.void),
        );
      }
      if (lockOutcome.releasedHoldTicketIds !== undefined) {
        yield* resumeReleasedHolds(lockOutcome.releasedHoldTicketIds);
      }
      return lockOutcome.result;
    });

  const invokeParkAction: WorkflowEngineShape["invokeParkAction"] = (
    ticketId,
    actionIndex,
    parkedEventId,
  ) =>
    Effect.gen(function* () {
      const detail = yield* read.getTicketDetail(ticketId);
      const ticket = detail?.ticket ?? null;
      const rowParkedEventId = ticket?.parkedEventId ?? null;
      // Fast pre-lock compare-and-act (the authoritative recheck is in-lock).
      // No ticket, a non-parked status, or a null/undefined/mismatched
      // parked_event_id all report "stale": no move, no error toast storm.
      if (
        ticket === null ||
        ticket.status !== "parked" ||
        rowParkedEventId === null ||
        rowParkedEventId !== parkedEventId
      ) {
        return "stale" as const;
      }
      const originJson = ticket.parkOrigin ?? null;
      if (originJson === null) {
        return yield* new WorkflowEventStoreError({
          message: PARK_ACTION_DRIFT_MESSAGES.definitionChanged,
        });
      }
      const boardId = ticket.boardId as BoardId;
      const laneKey = ticket.currentLaneKey as LaneKey;
      // Definition-derived data is read BEFORE the lock: it is race-free relative
      // to the ticket's parked state, and only the compare-and-act needs the
      // admission lock. Actions are ALWAYS re-resolved from the CURRENT board
      // definition by `park_origin` fingerprint — the event's snapshot is never
      // executed.
      const definition = yield* registry.getDefinition(boardId);
      const actions =
        definition === null ? null : resolveParkActions(definition, laneKey, originJson);
      if (actions === null) {
        return yield* new WorkflowEventStoreError({
          message: PARK_ACTION_DRIFT_MESSAGES.definitionChanged,
        });
      }
      // The actions DID resolve from the current definition here, so an
      // out-of-range actionIndex is a stale/bogus client request, not a
      // board-definition drift — report it as such (distinct from the
      // "definition changed" copy above).
      const action = actions[actionIndex];
      if (action === undefined) {
        return yield* new WorkflowEventStoreError({
          message: PARK_ACTION_DRIFT_MESSAGES.indexOutOfRange,
        });
      }
      // The action's target lane must exist in the CURRENT definition.
      const targetLane = yield* registry.getLane(boardId, action.to);
      if (targetLane === null) {
        return yield* new WorkflowEventStoreError({
          message: `park action targets lane '${action.to}' which ${PARK_ACTION_DRIFT_MESSAGES.targetLaneMissing}`,
        });
      }
      // Re-resolution repeated IN-LOCK: a concurrent board save may install a
      // new definition between this pre-lock resolution and the admission-lock
      // acquisition below. The pre-lock read gives a fast fail path; this
      // effect re-reads the CURRENT definition inside the lock (alongside the
      // parked identity guard) and requires the SAME action (label + target
      // lane) still resolve at the SAME index. Any drift fails typed and emits
      // nothing, so an action removed/changed by a save can never execute.
      const revalidate = Effect.gen(function* () {
        const currentDefinition = yield* registry.getDefinition(boardId);
        const currentActions =
          currentDefinition === null
            ? null
            : resolveParkActions(currentDefinition, laneKey, originJson);
        const currentAction = currentActions === null ? undefined : currentActions[actionIndex];
        if (
          currentAction === undefined ||
          currentAction.to !== action.to ||
          currentAction.label !== action.label
        ) {
          return yield* new WorkflowEventStoreError({
            message: PARK_ACTION_DRIFT_MESSAGES.definitionChanged,
          });
        }
      });
      // The authoritative parked guard + the in-lock re-resolution + the manual
      // move all run together in the admission-locked serialized section. A
      // concurrent invoke/move that already unparked the ticket makes the guard
      // miss → "none" → "stale".
      const acted = yield* enterLaneWithParkedGuard(ticketId, boardId, action.to, {
        expectedParkedEventId: parkedEventId,
        revalidate,
      });
      return acted === "none" ? ("stale" as const) : acted;
    });

  // ---------------------------------------------------------------------------
  // Committer-facing UNLOCKED engine ops (Task 9 work-source syncer). EVERY one
  // of these ASSUMES the caller already holds the board save lock for the
  // ticket's board AND is inside an open `sql.withTransaction`, AND — for any op
  // that makes a WIP admit/queue decision — already holds the board ADMISSION
  // lock via `withBoardAdmissionLock` (OUTER) wrapping the save lock (INNER)
  // wrapping the transaction. They never acquire the save lock, never open a
  // transaction, and never take the admission lock themselves: the save lock is
  // taken only transiently at commit time and does NOT serialize the WIP
  // read-decide, so the committer must hold the admission lock to be WIP-safe
  // against concurrent public enterLane moves. Calling the public
  // commit/commitMany/enterLane/moveTicket from here would deadlock the
  // non-reentrant save lock or nest the transaction. Pipeline starts are forked
  // detached (non-blocking) so they merely queue behind the save lock the
  // caller still holds and run once it is released.
  // ---------------------------------------------------------------------------

  // Post-tx provider cancellation for a source-closed ticket. Does ONLY the live
  // side effects — interrupt the running pipeline fiber and cancel the provider
  // turns — and performs NO DB writes (the in-tx close already tombstoned the
  // dispatch outbox rows). Idempotent: interrupting an already-cleared fiber or
  // cancelling an absent/stopped session is a no-op. The `turns` snapshot is
  // captured by the committer INSIDE the chunk tx (before the tombstone hid the
  // pending/started rows) and replayed here after the tx commits.
  const supersedeProviderWorkForTicket: WorkflowEngineShape["supersedeProviderWorkForTicket"] = (
    ticketId,
    turns,
  ) =>
    Effect.gen(function* () {
      yield* interruptRunningPipeline(ticketId);
      yield* cancelProviderTurns(turns).pipe(Effect.catch(() => Effect.void));
    });

  const cancellableProviderTurnsForTicket: WorkflowEngineShape["cancellableProviderTurnsForTicket"] =
    (ticketId) =>
      cancellableProviderDispatchesForTicket(ticketId).pipe(
        Effect.map((rows) => rows.map((row) => ({ threadId: row.threadId, turnId: row.turnId }))),
      );

  // Snapshot the ticket's stored per-agent session thread ids. The source
  // committer captures this INSIDE the chunk tx, BEFORE
  // `closeTicketFromSourceUnlocked`'s terminal teardown deletes the rows, then
  // replays it through `stopAgentSessionsForTicket` AFTER the tx commits — so the
  // non-rollbackable live `provider.stopSession` never runs inside the chunk
  // transaction (mirrors the turn-snapshot pattern above).
  const terminalAgentSessionThreadsForTicket: WorkflowEngineShape["terminalAgentSessionThreadsForTicket"] =
    (ticketId) =>
      Effect.gen(function* () {
        const { agentSessions } = yield* getOptionalServices;
        if (Option.isNone(agentSessions)) {
          return [];
        }
        const rows = yield* agentSessions.value
          .listByTicket(ticketId)
          .pipe(Effect.orElseSucceed(() => []));
        return rows.map((row) => row.threadId);
      });

  // POST-TX best-effort stop of the agent-session threads snapshotted by
  // `terminalAgentSessionThreadsForTicket`. The in-tx teardown already deleted the
  // rows; this only fires the live `provider.stopSession` (which kills the session
  // and does its own SQL write), so it MUST run after the chunk transaction
  // commits. Best-effort: errors are swallowed.
  const stopAgentSessionsForTicket: WorkflowEngineShape["stopAgentSessionsForTicket"] = (
    threadIds,
  ) => stopAgentSessionThreads(threadIds);

  const createTicketAndEnterUnlocked: WorkflowEngineShape["createTicketAndEnterUnlocked"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const ticketId = yield* ids.ticketId();
      yield* unlockedEmit([
        {
          type: "TicketCreated",
          ticketId,
          payload: {
            boardId: input.boardId,
            title: input.title,
            laneKey: input.destinationLane,
            ...(input.description === undefined ? {} : { description: input.description }),
          },
        } as UnstampedWorkflowEventInput,
      ]);
      // Pipeline starts are intentionally DROPPED here: starting a pipeline
      // commits through the locked path, which would open a transaction while
      // the caller's chunk transaction is still open (the SQLite connection has
      // a single global transaction). The committer (Task 9) is responsible for
      // triggering auto-lane pipeline starts (e.g. recoverBoardWip) AFTER it
      // closes the chunk transaction and releases the save lock.
      const coreResult = yield* enterLaneCore(
        ticketId,
        input.boardId,
        input.destinationLane,
        "initial",
        {
          emit: unlockedEmit,
          serialize: Effect.uninterruptible,
          supersedeRunningWork: Effect.void,
          // In-tx: only the tx-safe deleteByTicket runs here; never call the live
          // provider.stopSession inside the chunk transaction.
          stopProviderSessionsOnTeardown: false,
        },
      );
      // Unlocked path already holds admission: apply with uninterruptible serialize.
      for (const deferred of coreResult.deferredForkRoutes) {
        yield* applyDeferredParentRoute(deferred, {
          emit: unlockedEmit,
          serialize: Effect.uninterruptible,
        });
      }
      yield* resumeReleasedHolds(coreResult.releasedHoldTicketIds);
      return { ticketId, outcome: coreResult.acted };
    });

  const closeTicketFromSourceUnlocked: WorkflowEngineShape["closeTicketFromSourceUnlocked"] = (
    ticketId,
    closedLane,
  ) =>
    Effect.gen(function* () {
      const detail = yield* read.getTicketDetail(ticketId);
      if (detail === null) {
        return;
      }
      const boardId = detail.ticket.boardId as BoardId;
      const fromLane = detail.ticket.currentLaneKey as LaneKey;
      const routeEvent = {
        type: "TicketRouteDecided",
        ticketId,
        payload: {
          fromLane,
          toLane: closedLane,
          source: "work_source",
          // The event schema requires contextSnapshot; a work-source close has
          // no pipeline/event context, so record an empty snapshot.
          contextSnapshot: null,
        },
      } as UnstampedWorkflowEventInput;
      // Reuse the EXTERNAL move path so the close lands via the same stale-lane
      // guard, but the supersession here is DB-ONLY: it tombstones the ticket's
      // dispatch outbox rows (tx-safe — rolls back with the chunk if a later
      // delta fails). It does NOT interrupt the running pipeline fiber or call
      // provider interruptTurn/stopSession, because those are live side effects
      // that cannot be rolled back and must not run inside the chunk
      // transaction. The committer drives the fiber-interrupt + provider-cancel
      // AFTER the chunk commits, via supersedeProviderWorkForTicket. revalidate
      // succeeds unconditionally — the work source is the authority on closing,
      // there is no stale-matcher concern. Pipeline starts the close might admit
      // in the prior lane are dropped for the same single-transaction reason as
      // createTicketAndEnterUnlocked (closed lanes are terminal in practice; the
      // committer sweeps starts after the chunk).
      const coreResult = yield* enterLaneCore(ticketId, boardId, closedLane, "external", {
        emit: unlockedEmit,
        serialize: Effect.uninterruptible,
        supersedeRunningWork: abandonTicketDispatches(ticketId).pipe(
          Effect.catch(() => Effect.void),
        ),
        externalOptions: {
          expectedFromLane: fromLane,
          routeEvent,
          revalidate: Effect.succeed(true),
        },
        // A source's closedLane is lint-required to be terminal, so this reliably
        // hits the teardown branch INSIDE the committer's chunk transaction. Only
        // the tx-safe deleteByTicket may run here; `provider.stopSession` is a
        // non-rollbackable live side effect. The committer snapshots the threads
        // via `terminalAgentSessionThreadsForTicket` BEFORE this close and stops
        // them in its post-commit phase (alongside supersedeProviderWorkForTicket).
        stopProviderSessionsOnTeardown: false,
      });
      for (const deferred of coreResult.deferredForkRoutes) {
        yield* applyDeferredParentRoute(deferred, {
          emit: unlockedEmit,
          serialize: Effect.uninterruptible,
        });
      }
      yield* resumeReleasedHolds(coreResult.releasedHoldTicketIds);
    });

  const reopenTicketFromSourceUnlocked: WorkflowEngineShape["reopenTicketFromSourceUnlocked"] = (
    ticketId,
    destinationLane,
  ) =>
    Effect.gen(function* () {
      const detail = yield* read.getTicketDetail(ticketId);
      if (detail === null) {
        return;
      }
      const boardId = detail.ticket.boardId as BoardId;
      const fromLane = detail.ticket.currentLaneKey as LaneKey;
      // Already where we'd route it (e.g. a redundant reopen) → nothing to do.
      if ((fromLane as string) === (destinationLane as string)) {
        return;
      }
      const routeEvent = {
        type: "TicketRouteDecided",
        ticketId,
        payload: {
          fromLane,
          toLane: destinationLane,
          source: "work_source",
          contextSnapshot: null,
        },
      } as UnstampedWorkflowEventInput;
      // Mirror closeTicketFromSourceUnlocked but route back to the destination
      // lane. No provider supersession (a reopen revives work, it does not cancel
      // it); the work source is authoritative so revalidate succeeds. Any auto-
      // lane pipeline start the destination admits is dropped (single-tx) and the
      // committer's post-commit recoverBoardWip sweep starts it.
      const coreResult = yield* enterLaneCore(ticketId, boardId, destinationLane, "external", {
        emit: unlockedEmit,
        serialize: Effect.uninterruptible,
        supersedeRunningWork: Effect.void,
        externalOptions: {
          expectedFromLane: fromLane,
          routeEvent,
          revalidate: Effect.succeed(true),
        },
        // A reopen target is not a terminal lane, so the teardown branch is not
        // expected to fire — but this is an in-tx caller, so never run the live
        // provider.stopSession in-band regardless (only the tx-safe deleteByTicket
        // may run inside the chunk transaction).
        stopProviderSessionsOnTeardown: false,
      });
      for (const deferred of coreResult.deferredForkRoutes) {
        yield* applyDeferredParentRoute(deferred, {
          emit: unlockedEmit,
          serialize: Effect.uninterruptible,
        });
      }
      yield* resumeReleasedHolds(coreResult.releasedHoldTicketIds);
    });

  const editTicketFieldsUnlocked: WorkflowEngineShape["editTicketFieldsUnlocked"] = (
    ticketId,
    fields,
  ) =>
    Effect.gen(function* () {
      // Mirror the locked editTicket: a whitespace-only TITLE is dropped rather
      // than written, so the projection never overwrites the stored title with
      // an empty string. (editTicket errors; here we silently OMIT the field —
      // the syncer must not blank a title and has no caller to surface an error
      // to.)
      // DESCRIPTION is treated differently: an empty-string description is a
      // VALID CLEAR (source-owned descriptions are authoritative), so when a
      // description is PROVIDED — including "" — it is emitted and written. Only
      // `undefined` (not provided) leaves the description unchanged. The guard
      // below therefore checks `=== undefined` (not falsiness) for description.
      const trimmed = fields.title === undefined ? undefined : fields.title.trim();
      const title = trimmed !== undefined && trimmed.length === 0 ? undefined : trimmed;
      if (title === undefined && fields.description === undefined) {
        return;
      }
      yield* unlockedEmit([
        {
          type: "TicketEdited",
          ticketId,
          payload: {
            ...(title === undefined ? {} : { title: title as never }),
            ...(fields.description === undefined ? {} : { description: fields.description }),
          },
        } as UnstampedWorkflowEventInput,
      ]);
    });

  const hasPipelineStartedForToken = (ticketId: TicketId, laneEntryToken: LaneEntryToken) =>
    wrapSql(sql<PipelineRunForTokenRow>`
      SELECT pipeline_run_id AS "pipelineRunId"
      FROM projection_pipeline_run
      WHERE ticket_id = ${ticketId}
        AND lane_entry_token = ${laneEntryToken}
      LIMIT 1
    `).pipe(Effect.map((rows) => rows.length > 0));

  const cancellableProviderDispatchesForBoard = (boardId: BoardId) =>
    wrapSql(sql<ActiveProviderTurnRow>`
      SELECT DISTINCT
        outbox.thread_id AS "threadId",
        outbox.turn_id AS "turnId"
      FROM workflow_dispatch_outbox AS outbox
      INNER JOIN projection_ticket AS ticket
        ON ticket.ticket_id = outbox.ticket_id
      WHERE ticket.board_id = ${boardId}
        AND outbox.status IN ('pending', 'started')
      ORDER BY outbox.thread_id ASC, outbox.turn_id ASC
    `);

  const cancellableProviderDispatchesForTicket = (ticketId: TicketId) =>
    wrapSql(sql<ActiveProviderTurnRow>`
      SELECT DISTINCT
        thread_id AS "threadId",
        turn_id AS "turnId"
      FROM workflow_dispatch_outbox
      WHERE ticket_id = ${ticketId}
        AND status IN ('pending', 'started')
      ORDER BY thread_id ASC, turn_id ASC
    `);

  const cancelProviderTurns = (turns: ReadonlyArray<ActiveProviderTurnRow>) =>
    Effect.gen(function* () {
      const { providerService } = yield* getOptionalServices;
      if (Option.isNone(providerService)) {
        return;
      }
      yield* Effect.forEach(
        turns,
        (turn) =>
          Effect.gen(function* () {
            const interruptError =
              turn.turnId === null
                ? null
                : yield* providerCleanupAttempt(
                    providerService.value.interruptTurn({
                      threadId: turn.threadId,
                      turnId: turn.turnId,
                    }),
                    "workflow provider turn interrupt failed",
                  );

            const stopError = yield* providerCleanupAttempt(
              providerService.value.stopSession({ threadId: turn.threadId }),
              "workflow provider session stop failed",
            );

            const cleanupError = interruptError ?? stopError;
            if (cleanupError !== null) {
              return yield* cleanupError;
            }
          }),
        { discard: true },
      );
    });

  const abandonTicketDispatches = (ticketId: TicketId) =>
    Effect.gen(function* () {
      const confirmedAt = yield* nowIso;
      // Confirm + tombstone only unacked pending steers. Leave steer_delivered_*
      // staged so recovery can still append StepSteered for deliveries already
      // accepted by the provider (park/move must not erase the audit event).
      yield* wrapSql(sql`
        UPDATE workflow_dispatch_outbox
        SET status = 'confirmed',
            confirmed_at = ${confirmedAt},
            steer_tombstone_message_id = COALESCE(
              steer_pending_message_id,
              steer_tombstone_message_id
            ),
            steer_pending_message_id = NULL,
            steer_pending_text = NULL
        WHERE ticket_id = ${ticketId}
          AND status IN ('pending', 'started')
      `);
    });

  const cancelActiveProviderTurns = (boardId: BoardId) =>
    Effect.gen(function* () {
      const turns = yield* cancellableProviderDispatchesForBoard(boardId);
      yield* cancelProviderTurns(turns);
    });

  const cancelActiveProviderTurnsForTicket = (ticketId: TicketId) =>
    Effect.gen(function* () {
      const turns = yield* cancellableProviderDispatchesForTicket(ticketId);
      yield* cancelProviderTurns(turns);
    });

  const recoverBoardWip: WorkflowEngineShape["recoverBoardWip"] = (boardId) =>
    Effect.gen(function* () {
      const definition = yield* registry.getDefinition(boardId);
      if (definition === null) {
        return;
      }

      for (const lane of definition.lanes) {
        yield* withAdmissionLock(boardId, Effect.uninterruptible(admitNext(boardId, lane.key)));
      }

      const tickets = yield* read.listTickets(boardId);
      // admitNext only sweeps WIP-limited lanes; a crash between a
      // dependency landing and its dependents being released would otherwise
      // strand queued tickets in unlimited auto lanes forever.
      for (const ticket of tickets) {
        if (ticket.queuedAt === null || (ticket.unresolvedDependencyCount ?? 0) > 0) {
          continue;
        }
        const lane = yield* registry.getLane(boardId, ticket.currentLaneKey as LaneKey);
        if (lane?.entry !== "auto" || lane.wipLimit !== undefined) {
          continue;
        }
        yield* releaseTicketIfEligible(ticket.ticketId as TicketId).pipe(
          Effect.catch(() => Effect.void),
        );
      }
      for (const ticket of tickets) {
        if (ticket.currentLaneEntryToken === null) {
          continue;
        }
        const lane = yield* registry.getLane(boardId, ticket.currentLaneKey as LaneKey);
        if (lane?.entry !== "auto") {
          continue;
        }
        const laneEntryToken = ticket.currentLaneEntryToken as LaneEntryToken;
        const hasStarted = yield* hasPipelineStartedForToken(
          ticket.ticketId as TicketId,
          laneEntryToken,
        );
        if (!hasStarted) {
          yield* startPipeline(ticket.ticketId as TicketId, boardId, lane, laneEntryToken);
        }
      }
    });

  const ingestExternalEvent: WorkflowEngineShape["ingestExternalEvent"] = (input) =>
    Effect.gen(function* () {
      const detail = yield* read.getTicketDetail(input.ticketId);
      if (detail === null || detail.ticket.boardId !== (input.boardId as string)) {
        return yield* new WorkflowEventStoreError({
          message: "ticket not found on this board",
          code: WorkflowEventStoreErrorCode.ticketNotOnBoard,
        });
      }
      // onEvent routing is suspended for a parked ticket in v1: a human-parked
      // outcome must not be silently overridden. Record the event as skipped
      // (history only) and do not evaluate matchers or move.
      if (detail.ticket.status === "parked") {
        yield* commit({
          type: "TicketExternalEventSkipped",
          ticketId: input.ticketId,
          payload: { eventName: input.name, reason: "parked" },
        });
        return { outcome: "skipped_parked" as const };
      }
      const fromLaneKey = detail.ticket.currentLaneKey as LaneKey;
      // Read once; revalidate reuses this snapshot — do not re-read.
      // resolveTarget closes over the eventContext built below, so the lock-guarded
      // revalidate inside enterLane re-runs the same matcher against the same pr
      // context without a second DB read (design finding #1: single read prevents
      // desync between the initial evaluation and the revalidate recheck).
      const prState = yield* read.getTicketPrState(input.ticketId);
      const eventContext = {
        event: { name: input.name, payload: input.payload ?? null },
        pr: {
          ciState: prState?.lastCiState ?? null,
          reviewDecision: prState?.lastReviewDecision ?? null,
        },
      };
      const resolveTarget = Effect.gen(function* () {
        const lane = yield* registry.getLane(input.boardId, fromLaneKey);
        for (const matcher of lane?.onEvent ?? []) {
          if ((matcher.name as string) !== input.name) {
            continue;
          }
          if (matcher.when !== undefined) {
            const evaluation = yield* predicates.evaluate(matcher.when, eventContext).pipe(
              Effect.mapError(
                (cause) =>
                  new WorkflowEventStoreError({
                    message: "external event predicate evaluation failed",
                    cause,
                  }),
              ),
            );
            if (!evaluation.result) {
              continue;
            }
          }
          return matcher.to;
        }
        return null;
      });
      const target = yield* resolveTarget;
      if (target === null) {
        return { outcome: "noop" as const };
      }

      // A matched onEvent target may park in place instead of moving lanes.
      // Never build a TicketRouteDecided from a park target — park is recorded
      // solely by TicketParked.
      //
      // An external park MUST stop the ticket's still-running pipeline fiber:
      // unlike the in-pipeline completion park (which runs ON that fiber), the
      // event ingest runs on a foreign fiber, so the pipeline would otherwise
      // continue executing every remaining step against a parked/token-null row.
      // parkTicket runs the supersede INSIDE the admission lock, only after its
      // token+lane guard confirms the park still applies — mirroring the
      // external lane-move branch in enterLaneCore.
      if (isParkTarget(target)) {
        const parked = yield* parkTicket(
          input.ticketId,
          input.boardId,
          fromLaneKey,
          detail.ticket.currentLaneEntryToken,
          target,
          buildParkOrigin({ src: "event", target, name: input.name }),
          `external event '${input.name}'`,
          undefined,
          supersedeRunningWorkFor(input.ticketId),
        );
        // Only report "parked" when the in-lock guard actually emitted
        // TicketParked. A concurrent move that superseded the park emitted
        // nothing, so this event was effectively a no-op.
        return { outcome: parked ? ("parked" as const) : ("noop" as const) };
      }

      const routeEvent = {
        type: "TicketRouteDecided",
        ticketId: input.ticketId,
        payload: {
          fromLane: fromLaneKey,
          toLane: target,
          source: "external_event",
          contextSnapshot: eventContext,
        },
      } as UnstampedWorkflowEventInput;
      const acted = yield* enterLane(input.ticketId, input.boardId, target, "external", undefined, {
        expectedFromLane: fromLaneKey,
        routeEvent,
        revalidate: Effect.gen(function* () {
          if ((yield* resolveTarget) !== target) {
            return false;
          }
          return (yield* registry.getLane(input.boardId, target)) !== null;
        }),
      });
      if (acted === "none") {
        return { outcome: "noop" as const };
      }
      return { outcome: acted, toLane: target as string };
    });

  const runLane: WorkflowEngineShape["runLane"] = (ticketId) =>
    Effect.gen(function* () {
      const currentDetail = yield* read.getTicketDetail(ticketId);
      if (!currentDetail) {
        return;
      }

      // A parked ticket is non-admitted (its lane entry token is null), so the
      // `lane && token` guard below would silently no-op. Fail typed instead so
      // a client that mistakenly offers "Run lane" surfaces the real reason
      // rather than a successful call that starts nothing.
      if (currentDetail.ticket.status === "parked") {
        return yield* new WorkflowEventStoreError({
          message: "ticket is parked — recover via park actions or move",
        });
      }

      const unresolvedDeps = currentDetail.ticket.unresolvedDependencyCount ?? 0;
      if (unresolvedDeps > 0) {
        return yield* new WorkflowEventStoreError({
          message: `ticket is waiting on ${unresolvedDeps} unresolved dependenc${
            unresolvedDeps === 1 ? "y" : "ies"
          }`,
        });
      }
      const lane = yield* registry.getLane(
        currentDetail.ticket.boardId as BoardId,
        currentDetail.ticket.currentLaneKey as LaneKey,
      );
      const token = yield* currentToken(ticketId);
      if (lane && token) {
        yield* startPipeline(
          ticketId,
          currentDetail.ticket.boardId as BoardId,
          lane,
          token as LaneEntryToken,
        );
      }
    });

  const recoveredStepContext = (
    events: ReadonlyArray<PersistedWorkflowEvent>,
    stepRunId: StepRunId,
  ) => {
    let stepStarted: StepStarted | null = null;
    let pipelineStarted: PipelineStarted | null = null;
    let ticketCreated: TicketCreated | null = null;

    for (const event of events) {
      if (event.type === "StepStarted" && event.payload.stepRunId === stepRunId) {
        stepStarted = event;
      }
    }
    if (!stepStarted) {
      return null;
    }

    for (const event of events) {
      if (event.type === "TicketCreated" && event.ticketId === stepStarted.ticketId) {
        ticketCreated = event;
      }
      if (
        event.type === "PipelineStarted" &&
        event.payload.pipelineRunId === stepStarted.payload.pipelineRunId
      ) {
        pipelineStarted = event;
      }
    }
    if (!pipelineStarted || !ticketCreated) {
      return null;
    }

    return { stepStarted, pipelineStarted, ticketCreated };
  };

  const releaseRecoveredStepClaim = (stepRunId: StepRunId) =>
    SynchronizedRef.update(recoveredStepClaims, (current) => {
      const key = stepRunId as string;
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });

  /** Mirrors the executor's cap; both paths must refuse the same round. */
  const MAX_QUESTION_ROUNDS = 5;

  type QuestionRaiseDecision =
    | {
        readonly kind: "raise";
        readonly form: CheckpointForm;
        readonly waitingReason: string;
        readonly raisedFromDispatchId: string;
      }
    /** The agent tried to ask, but the block cannot become an answerable form. */
    | { readonly kind: "unmappable"; readonly message: string }
    /** This turn already produced a wait; do not terminal the step. */
    | { readonly kind: "leave" }
    | { readonly kind: "none" };

  /**
   * Decide what a recovered, capture-complete agent turn means for questions.
   *
   * `null`   — no question in the capture; complete the step as usual.
   * `"leave"` — this turn already produced a wait; do NOT terminal the step.
   * a form   — raise the wait now (the crash window, SPEC §4.4).
   *
   * The "already produced a wait" test is exact equality on
   * `raisedFromDispatchId`, not a count of resolves: StepUserResolved is
   * committed for provider and approval waits too, so counting would decline to
   * raise on any step that had ever hit one — completing it with the question
   * as its output.
   */
  const recoverQuestionRaise = (
    stepRunId: StepRunId,
    events: ReadonlyArray<PersistedWorkflowEvent>,
    captureTurn: CaptureTurn | undefined,
  ): Effect.Effect<QuestionRaiseDecision, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const { capturedOutputs, providerDispatches } = yield* getOptionalServices;
      if (Option.isNone(capturedOutputs) || Option.isNone(providerDispatches)) {
        return { kind: "none" };
      }
      const dispatch = yield* providerDispatches.value
        .getDispatchForStep(stepRunId)
        .pipe(Effect.orElseSucceed(() => null));
      if (dispatch === null || dispatch.turnId === null) {
        return { kind: "none" };
      }
      const alreadyRaised = events.some(
        (event) =>
          event.type === "StepAwaitingUser" &&
          event.payload.stepRunId === stepRunId &&
          event.payload.questionPhase === true &&
          event.payload.raisedFromDispatchId === dispatch.dispatchId,
      );
      if (alreadyRaised) {
        return { kind: "leave" };
      }
      const turn = captureTurn ?? { threadId: dispatch.threadId, turnId: dispatch.turnId };
      const strict = yield* capturedOutputs.value
        .readFinalMessage({ stepRunId, threadId: turn.threadId, turnId: turn.turnId })
        .pipe(Effect.orElseSucceed(() => undefined));
      const raw =
        typeof strict === "object" && strict !== null && !Array.isArray(strict)
          ? (strict as Record<string, unknown>)[AGENT_QUESTIONS_KEY]
          : undefined;
      if (raw === undefined) {
        return { kind: "none" };
      }
      // The same round budget the live path enforces. The live check happens
      // AFTER the outbox confirms the turn, so a crash in between would let a
      // 6th round be raised here that the live path would have refused.
      // Counted from the wait events, which is what the spec makes canonical.
      const roundsSoFar = events.filter(
        (event) =>
          event.type === "StepAwaitingUser" &&
          event.payload.stepRunId === stepRunId &&
          event.payload.questionPhase === true,
      ).length;
      if (roundsSoFar >= MAX_QUESTION_ROUNDS) {
        return {
          kind: "unmappable",
          message: `agent asked more than ${String(MAX_QUESTION_ROUNDS)} rounds of questions`,
        };
      }
      const mapped = mapAgentQuestions(raw);
      if (!mapped.ok) {
        // The agent DID try to ask; we just cannot build an answerable form.
        // Returning null here would fall through to capture-completion, which
        // finishes the step with the raw question payload as its output — the
        // exact answer-loss this branch exists to prevent. Fail instead.
        return { kind: "unmappable", message: mapped.message };
      }
      return {
        kind: "raise",
        form: mapped.form,
        waitingReason: questionsWaitingReason(mapped.form),
        raisedFromDispatchId: dispatch.dispatchId,
      };
    });

  const completeRecoveredStepUnlocked = (
    stepRunId: StepRunId,
    result: RecoveredStepResult,
    captureTurn: { readonly threadId: ThreadId; readonly turnId: TurnId } | undefined,
    options?: { readonly allowRetry?: boolean },
  ): Effect.Effect<void, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const events = yield* readStoredEventsForStep(stepRunId);
      if (events === null) {
        return;
      }

      const recovered = recoveredStepContext(events, stepRunId);
      if (
        !recovered ||
        hasPipelineCompletedEvent(events, recovered.pipelineStarted.payload.pipelineRunId)
      ) {
        return;
      }

      const boardId = recovered.ticketCreated.payload.boardId;
      const laneEntryToken = recovered.pipelineStarted.payload.laneEntryToken;
      const pipelineRunId = recovered.pipelineStarted.payload.pipelineRunId;
      // The board definition may have changed across the restart: a missing
      // lane or step must still resolve the pipeline run, or it pins the
      // ticket's WIP slot forever.
      const supersedePipeline = commitMany([
        {
          type: "PipelineCompleted",
          ticketId: recovered.stepStarted.ticketId,
          payload: { pipelineRunId, result: "superseded" },
        },
        // Surface the dead end instead of leaving the ticket "running"; the
        // user re-routes it manually once the board matches reality again.
        {
          type: "TicketBlocked",
          ticketId: recovered.stepStarted.ticketId,
          payload: { reason: "board definition changed while this step was recovering" },
        },
      ] as ReadonlyArray<UnstampedWorkflowEventInput>);
      const lane = yield* registry.getLane(boardId, recovered.pipelineStarted.payload.laneKey);
      if (!lane) {
        yield* supersedePipeline;
        return;
      }

      const steps = lane.pipeline ?? [];
      const currentStepIndex = steps.findIndex(
        (step) => step.key === recovered.stepStarted.payload.stepKey,
      );
      if (currentStepIndex < 0) {
        yield* supersedePipeline;
        return;
      }

      const recoveredStep = steps[currentStepIndex];

      // Set when the recovered capture held a question block that cannot become
      // an answerable form; handled as an ordinary failure by the tail below.
      let questionFailure: string | null = null;

      // SPEC §4.4 — the confirm-before-await crash window.
      //
      // The outbox confirms a successful turn BEFORE the executor returns and
      // before StepAwaitingUser is committed. A crash in between leaves a
      // `running` step with all rows confirmed, which is exactly what
      // recoverConfirmedRunningSteps selects — and completing it here would
      // finish the step with the raw `__questions` block as its output.
      if (
        result._tag === "completed" &&
        result.output === undefined &&
        recoveredStep?.type === "agent" &&
        recoveredStep.allowQuestions === true
      ) {
        const outcome = yield* recoverQuestionRaise(stepRunId, events, captureTurn);
        if (outcome.kind === "leave") {
          // Either the wait is already open, or it was answered and the §4.5
          // sweep owns the continuation. Either way this must NOT terminal.
          yield* releaseRecoveredStepClaim(stepRunId);
          return;
        }
        if (outcome.kind === "unmappable") {
          // Fall through as an ordinary FAILED result rather than committing
          // StepFailed here and returning: the tail below is what runs the retry
          // decision and `completePipelineFrom`, so returning early would leave
          // a failed step in a pipeline that never routes on.failure — a ticket
          // stuck until the next restart. The live path fails through the normal
          // arm too, so both agree on what an unmappable block does.
          questionFailure = `invalid ${AGENT_QUESTIONS_KEY}: ${outcome.message}`;
        }
        if (outcome.kind === "raise") {
          yield* commitMany(
            yield* awaitingUserEvents(recovered.stepStarted.ticketId, {
              type: "StepAwaitingUser",
              ticketId: recovered.stepStarted.ticketId,
              payload: {
                stepRunId,
                waitingReason: outcome.waitingReason,
                formSnapshot: outcome.form,
                questionPhase: true,
                raisedFromDispatchId: outcome.raisedFromDispatchId,
              },
            } satisfies UnstampedWorkflowEventInput),
          );
          yield* approvals.park(stepRunId);
          // This path returns NORMALLY, so the claim taken by
          // completeRecoveredStep would never be released by its onError —
          // leaving that stepRunId a silent no-op for the process lifetime.
          yield* releaseRecoveredStepClaim(stepRunId);
          return;
        }
      }

      let terminalResult: RecoveredStepResult =
        questionFailure !== null
          ? {
              _tag: "failed",
              error: questionFailure,
              retryable: false,
              failureClass: "agent_error",
            }
          : result._tag === "completed"
            ? yield* completedResultForStep(stepRunId, recoveredStep, result.output, captureTurn)
            : result;
      if (
        terminalResult._tag !== "blocked" &&
        terminalResult.usage === undefined &&
        captureTurn !== undefined
      ) {
        const usage = yield* readStepUsage(captureTurn.threadId);
        if (usage !== undefined) {
          terminalResult = { ...terminalResult, usage };
        }
      }

      if (!hasTerminalStepEvent(events, stepRunId)) {
        if (terminalResult._tag === "completed") {
          yield* commit({
            type: "StepCompleted",
            ticketId: recovered.stepStarted.ticketId,
            payload: stepCompletedPayload(stepRunId, terminalResult.output, terminalResult.usage),
          });
        } else if (terminalResult._tag === "failed") {
          yield* commit({
            type: "StepFailed",
            ticketId: recovered.stepStarted.ticketId,
            payload: stepFailedPayload(
              stepRunId,
              terminalResult.error,
              terminalResult.usage,
              terminalResult.retryable === false ? false : undefined,
              undefined,
              terminalResult.failureClass ??
                classifyFallback(terminalResult.error, terminalResult.retryable),
            ),
          });
        } else {
          yield* commit({
            type: "StepBlocked",
            ticketId: recovered.stepStarted.ticketId,
            payload: { stepRunId, reason: terminalResult.reason },
          });
        }
      }

      // Close the recovered pipeline run as superseded and stop. Shared by every
      // token-drift guard below.
      //
      // A recovered continuation is NOT registered in `runningPipelines` (it runs
      // inline on the recovery/approval fiber, not a forked pipeline fiber), so
      // `supersedeRunningWorkFor` cannot `Fiber.interrupt` it. That is why each
      // dispatch point here RE-CHECKS the lane-entry token: an external park nulls
      // the token, so any drift means the continuation must abandon before it can
      // emit a new StepStarted or route against the parked/moved row. (Supersede
      // still cancels the ticket's in-flight provider turns, which unblocks an
      // agent step this continuation is awaiting; the token guard then trips.)
      //
      // ACCEPTED RESIDUAL (script steps): the token guard covers the REACHABLE
      // side of the dispatch — if a park has landed by the time a guard runs, no
      // step (agent or script) starts. But a park landing AFTER a guard passes and
      // BEFORE `runStep` reaches `executor.execute` lets that ONE already-dispatched
      // step complete post-park. For an AGENT step that in-flight turn is still
      // interrupted by supersede's provider-turn cancellation; a SCRIPT step has no
      // such cancellation and is not fiber-tracked, so it runs to completion. Its
      // worktree writes are the same accepted class as post-park round-trip-time
      // residuals (a live pipeline's in-flight step can likewise finish after a
      // park); the TICKET STATE stays safe because the parked projection refuses
      // every status-writing event this continuation could emit for that step.
      const abandonSuperseded = commit({
        type: "PipelineCompleted",
        ticketId: recovered.stepStarted.ticketId,
        payload: { pipelineRunId, result: "superseded" },
      });

      // Never continue a pipeline the ticket has already left: a manual move,
      // re-route, or external park invalidated this lane entry token, so running
      // more steps or routing from here would act on stale state. The terminal
      // step event above is still recorded; the pipeline run closes superseded.
      if ((yield* currentToken(recovered.stepStarted.ticketId)) !== laneEntryToken) {
        yield* abandonSuperseded;
        return;
      }

      let finalResult: StepResult =
        terminalResult._tag === "completed"
          ? "completed"
          : terminalResult._tag === "blocked"
            ? "blocked"
            : "failed";
      let recoveredParallelismHold =
        terminalResult._tag === "blocked" && isParallelismHoldReason(terminalResult.reason);
      let recoveredHoldDetail =
        terminalResult._tag === "blocked" ? terminalResult.reason : undefined;

      // Resume the retry loop across restarts via decideRetry (recovery mode:
      // never sleeps).
      if (
        finalResult === "failed" &&
        (terminalResult._tag !== "failed" || terminalResult.retryable !== false) &&
        recoveredStep !== undefined &&
        options?.allowRetry !== false
      ) {
        const maxAttempts = retryAttemptsForStep(recoveredStep);
        let attempt = recovered.stepStarted.payload.attempt ?? 1;
        let outcome: StepRunOutcome = {
          result: "failed",
          noRetry: terminalResult._tag === "failed" && terminalResult.retryable === false,
          detail: terminalResult._tag === "failed" ? terminalResult.error : undefined,
          failureClass:
            terminalResult._tag === "failed"
              ? (terminalResult.failureClass ??
                classifyFallback(terminalResult.error, terminalResult.retryable))
              : undefined,
          retryable: terminalResult._tag === "failed" ? terminalResult.retryable : undefined,
          stepRunId,
          stepKey: recovered.stepStarted.payload.stepKey,
        };
        while (outcome.result === "failed" && !outcome.noRetry) {
          const failureClass =
            outcome.failureClass ??
            classifyFallback(outcome.detail ?? "unknown", outcome.retryable);
          const byClass =
            recoveredStep.type === "agent" || recoveredStep.type === "script"
              ? recoveredStep.retry?.byClass
              : undefined;
          const decision = decideRetry({
            failureClass,
            attempt,
            maxAttempts,
            retryable: outcome.retryable,
            byClass,
            error: outcome.detail,
            stepHasEscalate:
              recoveredStep.type === "agent" && recoveredStep.retry?.escalate !== undefined,
            mode: "recovery",
          });
          if (decision.kind === "give_up") {
            break;
          }
          if ((yield* currentToken(recovered.stepStarted.ticketId)) !== laneEntryToken) {
            yield* abandonSuperseded;
            return;
          }
          attempt = decision.nextAttempt;
          const nextStep = decision.escalate
            ? stepForAttempt(recoveredStep, attempt)
            : recoveredStep;
          outcome = yield* runStep(
            recovered.stepStarted.ticketId,
            boardId,
            recovered.pipelineStarted.payload.pipelineRunId,
            nextStep,
            laneEntryToken,
            lane.key,
            steps.map((s) => s.key),
            attempt,
            // Recovery must reach the same verdict as the live path. Leaving the
            // default here dropped the handoff pack on exactly the crash-retry
            // case the feature exists for.
            nextStep.key === steps.find((s) => s.type === "agent")?.key,
          );
        }
        if (attempt > (recovered.stepStarted.payload.attempt ?? 1)) {
          finalResult = outcome.result;
          recoveredParallelismHold = outcome.parallelismHold === true;
          recoveredHoldDetail = outcome.detail;
        }
      }

      const recoveredResult: PipelineResult = pipelineResultForStep(finalResult);
      const initialRouteDecision =
        recoveredStep && !recoveredParallelismHold
          ? stepRouteDecision(recoveredStep, recoveredResult)
          : null;

      // Guard once more before handing off to completePipelineFrom: a park may
      // have landed during the retry loop's final attempt. completePipelineFrom
      // is entered non-exempt (below), so its first dispatched step also
      // token-checks; this early bail additionally covers the route-only entry
      // (no further steps) so we never route a superseded run.
      if ((yield* currentToken(recovered.stepStarted.ticketId)) !== laneEntryToken) {
        yield* abandonSuperseded;
        return;
      }

      yield* completePipelineFrom(
        recovered.stepStarted.ticketId,
        boardId,
        lane,
        laneEntryToken,
        recovered.pipelineStarted.payload.pipelineRunId,
        steps,
        initialRouteDecision === null && finalResult === "completed"
          ? currentStepIndex + 1
          : steps.length,
        recoveredResult,
        initialRouteDecision ?? undefined,
        // Recovery entry: do NOT exempt the first step from the token guard — its
        // token was read before this continuation and an external park can have
        // nulled it since.
        false,
        recoveredParallelismHold,
        recoveredHoldDetail,
      );
    });

  const completeRecoveredStep: WorkflowEngineShape["completeRecoveredStep"] = (
    stepRunId,
    result,
    captureTurn,
  ) =>
    Effect.gen(function* () {
      const claimed = yield* SynchronizedRef.modify(recoveredStepClaims, (current) => {
        const key = stepRunId as string;
        if (current.has(key)) {
          return [false, current] as const;
        }
        const next = new Set(current);
        next.add(key);
        return [true, next] as const;
      });
      if (!claimed) {
        return;
      }
      yield* completeRecoveredStepUnlocked(stepRunId, result, captureTurn).pipe(
        // Release the claim on failure so a later monitor/sweep can finish
        // what this continuation could not.
        Effect.onError(() =>
          SynchronizedRef.update(recoveredStepClaims, (current) => {
            const next = new Set(current);
            next.delete(stepRunId as string);
            return next;
          }),
        ),
      );
    });

  /**
   * Resume a question wait whose pipeline fiber died with the process.
   *
   * The live path parks on `approvals.await` and continues on the same fiber.
   * After a restart there is no such fiber, so the answer arrives here — and
   * the default recovered-approval behaviour (complete the step, resume the
   * lane) would finish the step with the QUESTION as its output and never send
   * the answers to a model. This branch runs the continuation instead.
   *
   * Forked, because an agent turn must not block the answering user's RPC, and
   * registered against the ticket so a park or move can still interrupt it —
   * an unregistered fork would be reachable only by provider cancellation.
   */
  const resumeRecoveredQuestion = (
    pending: PendingWait,
    resolution: CheckpointResolution,
    recovered: NonNullable<ReturnType<typeof recoveredStepContext>>,
  ) =>
    Effect.gen(function* () {
      const stepRunId = pending.payload.stepRunId;
      // One continuation per step run, ever.
      //
      // Two paths can reach here for the same wait: the §4.5 boot sweep, and
      // continueRecoveredApproval when a user answers a re-parked wait WHILE
      // boot recovery is still running. Without a claim both would dispatch a
      // turn on the same thread. The claim is the same one the recovery
      // completion path uses, so a continuation also cannot race a recovered
      // completion.
      const claimed = yield* SynchronizedRef.modify(recoveredStepClaims, (current) => {
        const key = stepRunId as string;
        if (current.has(key)) {
          return [false, current] as const;
        }
        const next = new Set(current);
        next.add(key);
        return [true, next] as const;
      });
      if (!claimed) {
        return;
      }
      // Released on EVERY exit — including the re-park and provider-wait paths,
      // which return normally. A leaked claim would make that stepRunId a
      // silent no-op for the rest of the process lifetime.
      yield* resumeRecoveredQuestionClaimed(pending, resolution, recovered).pipe(
        Effect.ensuring(releaseRecoveredStepClaim(stepRunId)),
      );
    });

  const resumeRecoveredQuestionClaimed = (
    pending: PendingWait,
    resolution: CheckpointResolution,
    recovered: NonNullable<ReturnType<typeof recoveredStepContext>>,
  ) =>
    Effect.gen(function* () {
      const stepRunId = pending.payload.stepRunId;
      const form = pending.payload.formSnapshot;
      if (form === undefined) {
        // A question wait without its snapshot cannot be resumed: the answers
        // were validated against a form we can no longer see. Fail closed.
        yield* completeRecoveredStepUnlocked(
          stepRunId,
          {
            _tag: "failed",
            error: "question wait lost its form snapshot",
            retryable: false,
            failureClass: "infra",
          },
          undefined,
          { allowRetry: false },
        );
        return;
      }

      const ticketId = recovered.stepStarted.ticketId;
      const lane = yield* registry.getLane(
        recovered.ticketCreated.payload.boardId,
        recovered.pipelineStarted.payload.laneKey,
      );
      const steps = lane?.pipeline ?? [];
      const step = steps.find(
        (candidate) => candidate.key === recovered.stepStarted.payload.stepKey,
      );
      if (step === undefined || step.type !== "agent") {
        yield* completeRecoveredStepUnlocked(
          stepRunId,
          {
            _tag: "failed",
            error: "question wait no longer maps to an agent step",
            retryable: false,
            failureClass: "infra",
          },
          undefined,
          { allowRetry: false },
        );
        return;
      }

      const outcome = yield* (
        executor.continueWithAnswers({
          ctx: {
            ticketId,
            boardId: recovered.ticketCreated.payload.boardId,
            pipelineRunId: recovered.pipelineStarted.payload.pipelineRunId,
            stepRunId,
            laneEntryToken: recovered.pipelineStarted.payload.laneEntryToken,
            laneKey: recovered.pipelineStarted.payload.laneKey,
            laneStepKeys: steps.map((candidate) => candidate.key),
            step,
          },
          form,
          answers: resolution.answers ?? {},
        }) as Effect.Effect<StepOutcome, WorkflowEventStoreError>
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed<StepOutcome>({ _tag: "failed", error: formatError(error) }),
        ),
      );

      if (outcome._tag === "awaiting_questions") {
        // Asked again. Re-park exactly as the live path does, and STOP — the
        // step must not terminal here.
        yield* commitMany(
          yield* awaitingUserEvents(ticketId, {
            type: "StepAwaitingUser",
            ticketId,
            payload: {
              stepRunId,
              waitingReason: outcome.waitingReason,
              formSnapshot: outcome.form,
              questionPhase: true,
              raisedFromDispatchId: outcome.raisedFromDispatchId,
            },
          } satisfies UnstampedWorkflowEventInput),
        );
        yield* approvals.park(stepRunId);
        return;
      }

      if (outcome._tag === "awaiting_user") {
        // The continuation hit a native provider prompt. Persist the wait and
        // park rather than completing: the answer path and DurableApprovalResume
        // both key off this event.
        yield* commitMany(
          yield* awaitingUserEvents(ticketId, {
            type: "StepAwaitingUser",
            ticketId,
            payload: {
              stepRunId,
              waitingReason: outcome.waitingReason,
              ...(outcome.providerThreadId === undefined
                ? {}
                : { providerThreadId: outcome.providerThreadId }),
              ...(outcome.providerRequestId === undefined
                ? {}
                : { providerRequestId: outcome.providerRequestId }),
              ...(outcome.providerResponseKind === undefined
                ? {}
                : { providerResponseKind: outcome.providerResponseKind }),
              ...(outcome.providerQuestionId === undefined
                ? {}
                : { providerQuestionId: outcome.providerQuestionId }),
            },
          } satisfies UnstampedWorkflowEventInput),
        );
        yield* approvals.park(stepRunId);
        return;
      }

      // Terminal: hand back to the SAME tail the rest of recovery uses, so the
      // step's terminal event, retry decision and lane resume stay in one place.
      if (outcome._tag === "completed") {
        yield* completeRecoveredStepUnlocked(
          stepRunId,
          {
            _tag: "completed",
            ...(outcome.output === undefined ? {} : { output: outcome.output }),
            ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
          },
          undefined,
        );
        return;
      }
      if (outcome._tag === "blocked") {
        yield* completeRecoveredStepUnlocked(
          stepRunId,
          { _tag: "blocked", reason: outcome.reason },
          undefined,
        );
        return;
      }
      if (outcome._tag === "failed") {
        yield* completeRecoveredStepUnlocked(
          stepRunId,
          {
            _tag: "failed",
            error: outcome.error,
            ...(outcome.retryable === undefined ? {} : { retryable: outcome.retryable }),
            ...(outcome.failureClass === undefined ? {} : { failureClass: outcome.failureClass }),
            ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
          },
          undefined,
        );
        return;
      }
      // awaiting_children cannot come from an agent step; fail closed rather
      // than leaving the step running forever.
      yield* completeRecoveredStepUnlocked(
        stepRunId,
        {
          _tag: "failed",
          error: "question continuation returned an unexpected outcome",
          retryable: false,
          failureClass: "infra",
        },
        undefined,
        { allowRetry: false },
      );
    });

  /**
   * SPEC §4.5 — the post-answer crash window.
   *
   * A step whose latest question wait IS answered, with no terminal event and
   * nothing dispatched since that wait, has an operator's answers stranded in
   * the event log. Re-enter the continuation for it.
   */
  const resumeAnsweredQuestions: WorkflowEngineShape["resumeAnsweredQuestions"] = () =>
    Effect.gen(function* () {
      const { providerDispatches } = yield* getOptionalServices;
      if (Option.isNone(providerDispatches)) {
        return;
      }
      const candidates = yield* wrapSql(sql<{ readonly stepRunId: string }>`
        SELECT DISTINCT json_extract(payload_json, '$.stepRunId') AS "stepRunId"
        FROM workflow_events
        WHERE event_type = 'StepAwaitingUser'
          AND json_extract(payload_json, '$.questionPhase') = 1
      `).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ readonly stepRunId: string }>));

      for (const candidate of candidates) {
        const stepRunId = candidate.stepRunId as StepRunId;
        const events = yield* readStoredEventsForStep(stepRunId);
        if (events === null || hasTerminalStepEvent(events, stepRunId)) {
          continue;
        }
        // The LATEST question wait, and whether it was answered.
        let latestWait: Extract<PersistedWorkflowEvent, { type: "StepAwaitingUser" }> | null = null;
        let answered: CheckpointResolution | null = null;
        for (const event of events) {
          if (
            event.type === "StepAwaitingUser" &&
            event.payload.stepRunId === stepRunId &&
            event.payload.questionPhase === true
          ) {
            latestWait = event;
            answered = null;
          }
          if (event.type === "StepUserResolved" && event.payload.stepRunId === stepRunId) {
            answered = {
              outcome: "success",
              ...(event.payload.decision === undefined ? {} : { decision: event.payload.decision }),
              ...(event.payload.answers === undefined ? {} : { answers: event.payload.answers }),
            };
          }
        }
        if (latestWait === null || answered === null) {
          continue;
        }
        // A cancel that crashed before its StepFailed landed must NOT resume.
        // The live path commits StepUserResolved (deliberately without an
        // outcome — the terminal normally comes from the continuation) and only
        // then StepFailed, so a crash in between leaves a resolve that looks
        // like any other. Fail CLOSED on anything that is not an explicit
        // continue: running a turn the operator declined is worse than failing
        // a step they already cancelled.
        if (answered.decision !== QUESTION_CONTINUE_VALUE) {
          yield* completeRecoveredStepUnlocked(
            stepRunId,
            {
              _tag: "failed",
              error: "cancelled at question",
              retryable: false,
              failureClass: "human_rejection",
            },
            undefined,
            { allowRetry: false },
          ).pipe(Effect.ignoreCause({ log: true }));
          continue;
        }
        // "Nothing dispatched since" is per-ROUND: anchored on the seq of the
        // dispatch that raised the wait being resumed. "No continuation row for
        // the step run" would be false the moment any earlier round ran.
        const assembly = yield* providerDispatches.value
          .getDispatchRequestForStep(stepRunId)
          .pipe(Effect.orElseSucceed(() => null));
        const raisedSeq = yield* wrapSql(sql<{ readonly seq: number | null }>`
          SELECT dispatch_seq AS "seq"
          FROM workflow_dispatch_outbox
          WHERE dispatch_id = ${latestWait.payload.raisedFromDispatchId ?? ""}
        `).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<{ readonly seq: number | null }>));
        const anchor = raisedSeq[0]?.seq ?? null;
        if (assembly === null || anchor === null) {
          continue;
        }
        // nextDispatchSeq is max(seq)+1, so max = nextDispatchSeq - 1. Anything
        // above the anchor means a continuation already exists — possibly still
        // unconfirmed, in which case recoverPending/monitorStartedDispatches own
        // it and this sweep must not start a second turn.
        if (assembly.nextDispatchSeq - 1 > anchor) {
          continue;
        }
        const recovered = recoveredStepContext(events, stepRunId);
        if (!recovered) {
          continue;
        }
        // Forked, not awaited. Boot recovery is sequential, so awaiting a full
        // agent turn here would stall startup behind every stuck question —
        // minutes each, multiplied by however many are waiting. Starting a
        // second continuation is prevented by the claim inside
        // resumeRecoveredQuestion, not by staying inline.
        const resume = resumeRecoveredQuestion(
          { ticketId: latestWait.ticketId, payload: latestWait.payload } as PendingWait,
          answered,
          recovered,
        );
        const started = yield* forkTicketWork(latestWait.ticketId, resume).pipe(
          Effect.orElseSucceed(() => false),
        );
        if (!started) {
          // The fork declined — the ticket lost its lane entry, or another fiber
          // owns its slot. The answer is already durable, so it must not be left
          // with no owner: run it here instead. Slower (this blocks the rest of
          // the sweep) but never silently stranded, and the claim inside still
          // guarantees only one continuation.
          yield* resume.pipe(Effect.ignoreCause({ log: true }));
        }
      }
    });

  const continueRecoveredApproval = (pending: PendingWait, resolution: CheckpointResolution) =>
    Effect.gen(function* () {
      const events = yield* readStoredEventsForStep(pending.payload.stepRunId);
      if (events === null || !pendingWaitInEvents(events, pending.payload.stepRunId)) {
        return;
      }

      const recovered = recoveredStepContext(events, pending.payload.stepRunId);
      if (!recovered) {
        return;
      }

      yield* commit({
        type: "StepUserResolved",
        ticketId: pending.ticketId,
        payload: {
          stepRunId: pending.payload.stepRunId,
          // Only native waits carry an outcome. A provider-originated wait gets
          // its real terminal from awaitProviderTerminalForStep below, and
          // stamping one here would let boot replay fabricate the wrong one.
          ...(pending.payload.providerThreadId === undefined
            ? { outcome: resolution.outcome }
            : {}),
          ...(resolution.decision === undefined ? {} : { decision: resolution.decision }),
          ...(resolution.answers === undefined ? {} : { answers: resolution.answers }),
        },
      });
      if (pending.payload.questionPhase === true) {
        // An agent question resumes by RUNNING A NEW TURN, never by completing.
        // Falling through would reach completeRecoveredStepUnlocked, which for a
        // wait with no providerThreadId finishes the step from its captured
        // output — i.e. with the question block itself as the step's result, and
        // the operator's answers seen by nobody.
        if (resolution.outcome !== "success") {
          yield* completeRecoveredStepUnlocked(
            pending.payload.stepRunId,
            {
              _tag: "failed",
              error: "cancelled at question",
              retryable: false,
              failureClass: "human_rejection",
            },
            undefined,
            { allowRetry: false },
          );
          return;
        }
        // Forked so a multi-minute agent turn does not block the answering
        // user's RPC, and registered against the ticket so park/move can still
        // interrupt it.
        const started = yield* forkTicketWork(
          recovered.stepStarted.ticketId,
          resumeRecoveredQuestion(pending, resolution, recovered),
        );
        if (!started) {
          // The answer is already durable, so it must not be left with no owner:
          // the ticket lost its lane entry, or another fiber holds the slot.
          // Fail the step rather than leaving it `running` forever with an
          // answer nobody will ever deliver.
          yield* completeRecoveredStepUnlocked(
            pending.payload.stepRunId,
            {
              _tag: "failed",
              error: "question answered but the step could not be resumed",
              retryable: false,
              failureClass: "infra",
            },
            undefined,
            { allowRetry: false },
          ).pipe(Effect.ignoreCause({ log: true }));
        }
        return;
      }

      if (resolution.outcome === "blocked") {
        // Must stay blocked on the recovered path too. Collapsing it into a
        // failure here would route a "hold" decision down on.failure after a
        // restart while the live path routed it down on.blocked — the same
        // decision producing two different destinations depending on whether a
        // fiber happened to survive.
        yield* completeRecoveredStepUnlocked(
          pending.payload.stepRunId,
          { _tag: "blocked", reason: resolution.decision ?? "checkpoint blocked" },
          undefined,
          { allowRetry: false },
        );
        return;
      }
      if (resolution.outcome !== "success") {
        yield* completeRecoveredStepUnlocked(
          pending.payload.stepRunId,
          {
            _tag: "failed",
            error: resolution.decision ?? "rejected",
          },
          undefined,
          { allowRetry: false },
        );
        return;
      }

      const terminalResult =
        pending.payload.providerThreadId === undefined
          ? ({ _tag: "completed" } satisfies RecoveredStepResult)
          : yield* awaitProviderTerminalForStep(
              pending.payload.stepRunId,
              pending.payload.providerThreadId,
            );
      yield* completeRecoveredStepUnlocked(pending.payload.stepRunId, terminalResult, undefined);
    });

  const cancelStep: WorkflowEngineShape["cancelStep"] = (stepRunId) =>
    scriptCancels.cancel(stepRunId);

  const cancelBoardPipelines: WorkflowEngineShape["cancelBoardPipelines"] = (boardId) =>
    Effect.gen(function* () {
      const tickets = yield* read.listTickets(boardId);
      yield* Effect.forEach(
        tickets,
        (ticket) => interruptRunningPipeline(ticket.ticketId as TicketId),
        { discard: true },
      );
      yield* cancelActiveProviderTurns(boardId);
    });

  const cancelTicketPipelines: WorkflowEngineShape["cancelTicketPipelines"] = (ticketId) =>
    Effect.gen(function* () {
      yield* interruptRunningPipeline(ticketId);
      yield* cancelActiveProviderTurnsForTicket(ticketId);
    });

  const resolveApproval: WorkflowEngineShape["resolveApproval"] = (stepRunId, submission) =>
    Effect.gen(function* () {
      const resolve = Effect.gen(function* () {
        // Refuse to resolve an approval on a parked ticket: a park cannot
        // coexist with an open approval wait by design, so a parked status here
        // means a stale fiber's wait survived a supersede. Resolving it would
        // write StepUserResolved/running over the parked row. Fail typed.
        const approvalTicketId = yield* ticketIdForStepRun(stepRunId);
        if (approvalTicketId !== null) {
          const approvalTicket = yield* read.getTicketDetail(approvalTicketId);
          if (approvalTicket?.ticket.status === "parked") {
            return yield* new WorkflowEventStoreError({
              message: "ticket is parked",
            });
          }
        }
        const pending = yield* pendingWaitFor(stepRunId);
        // Validate against the SNAPSHOT on the wait, never the current board
        // definition: the form may have been edited while the reviewer was
        // deciding, and the outcome must be the one their chosen option mapped
        // to — not one the client asserted.
        const validated = validateCheckpointSubmission(
          pending?.payload.formSnapshot,
          {
            ...(submission.decision === undefined ? {} : { decision: submission.decision }),
            ...(submission.answers === undefined ? {} : { answers: submission.answers }),
          },
          submission.approved ? "success" : "failure",
        );
        if (!validated.ok) {
          return yield* new WorkflowEventStoreError({ message: validated.message });
        }
        const resolution: CheckpointResolution = {
          outcome: validated.outcome,
          ...(validated.decision === undefined ? {} : { decision: validated.decision }),
          ...(Object.keys(validated.answers).length === 0 ? {} : { answers: validated.answers }),
        };
        const { providerResponses } = yield* getOptionalServices;
        if (pending?.payload.providerResponseKind === "user-input") {
          return yield* new WorkflowEventStoreError({
            message: "provider user-input waits must be answered with answerTicketStep",
          });
        }
        // Authoritative parked re-check immediately before the provider respond
        // (the first side effect): an external park can land between the check
        // above and here, cancelling the wait and nulling the token. Re-read so
        // we never respond into / resolve a since-parked ticket. Residual: a park
        // landing after this check is harmless — StepUserResolved is refused by
        // the projection on a parked row, and respond() targets a request the
        // park's supersede already cancelled.
        if (approvalTicketId !== null) {
          const approvalTicketNow = yield* read.getTicketDetail(approvalTicketId);
          if (approvalTicketNow?.ticket.status === "parked") {
            return yield* new WorkflowEventStoreError({
              message: "ticket is parked",
            });
          }
        }
        if (
          pending?.payload.providerThreadId &&
          pending.payload.providerRequestId &&
          pending.payload.providerResponseKind &&
          Option.isSome(providerResponses)
        ) {
          yield* providerResponses.value.respond({
            threadId: pending.payload.providerThreadId,
            requestId: pending.payload.providerRequestId,
            responseKind: pending.payload.providerResponseKind,
            // A provider permission prompt only understands yes/no.
            approved: resolution.outcome === "success",
          });
        }

        const resumedLiveWaiter = yield* approvals.resolve(stepRunId, resolution);
        if (!resumedLiveWaiter && pending) {
          yield* continueRecoveredApproval(pending, resolution);
        }
      });
      // Resolution serializes through the inner recovery path's own locking
      // (continueRecoveredApproval -> commit/completeRecoveredStepUnlocked);
      // no board-level lock is taken here, so the prior boardId lookup was a
      // dead query that only ever branched into identical effects.
      yield* resolve;
    });

  return {
    createTicket,
    editTicket,
    editTicketContextPack,
    moveTicket,
    escalateTicketSla,
    invokeParkAction,
    createTicketAndEnterUnlocked,
    closeTicketFromSourceUnlocked,
    reopenTicketFromSourceUnlocked,
    cancellableProviderTurnsForTicket,
    supersedeProviderWorkForTicket,
    terminalAgentSessionThreadsForTicket,
    stopAgentSessionsForTicket,
    editTicketFieldsUnlocked,
    withBoardAdmissionLock,
    runLane,
    ingestExternalEvent,
    resolveApproval,
    answerTicketStep,
    steerTicketStep,
    postTicketMessage,
    editTicketMessage,
    cancelStep,
    cancelBoardPipelines,
    cancelTicketPipelines,
    recoverBoardWip,
    completeRecoveredStep,
    resumeAnsweredQuestions,
  } satisfies WorkflowEngineShape;
});

export const WorkflowEngineLayer = Layer.effect(WorkflowEngine, make);
