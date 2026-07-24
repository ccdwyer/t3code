import type {
  BoardId,
  BoardTicketView,
  LaneKey,
  TicketId,
  TicketStatus,
  WorkflowTicketAttentionKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { WorkflowBoardEvents } from "../Services/WorkflowBoardEvents.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { PredicateEvaluator } from "../Services/PredicateEvaluator.ts";
import {
  OUTBOUND_EVENT_TYPES,
  buildOutboundContext,
  contextForRule,
  matchesTrigger,
} from "../outbound/outboundEventContext.ts";
import {
  WorkflowEventCommitter,
  type WorkflowEventCommitterShape,
} from "../Services/WorkflowEventCommitter.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { WorkflowEventStore, type PersistedWorkflowEvent } from "../Services/WorkflowEventStore.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { WorkflowProjectionPipeline } from "../Services/WorkflowProjectionPipeline.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { toParkedTicketView } from "../parkActions.ts";

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

// Statuses that mean "a human needs to act". Crossing INTO one of these (and only
// into — not staying) emits exactly one durable notification outbox row.
// "parked" is included per the substates spec: a ticket parked in-place (issue or
// waiting) is a deliberate behavior change from today's silent parking lanes — it
// now notifies, same as waiting_on_user/blocked.
const NEEDS_YOU_STATUSES = new Set(["waiting_on_user", "blocked", "parked"]);

// Only these event types can ever project a needs-you status (per the projection
// audit: StepAwaitingUser → waiting_on_user, TicketBlocked → blocked, TicketParked
// → parked). Every other event skips the status-diff reads entirely, keeping the
// hot step loop (StepStarted/StepCompleted/StepRefsCaptured/PipelineStarted/...)
// free of the two extra projection_ticket point-reads.
const NOTIFIABLE_EVENT_TYPES = new Set([
  "StepAwaitingUser",
  "TicketBlocked",
  "TicketParked",
  "TicketSlaBreached",
]);

// Events that move a ticket OUT of a needs-you status but are NOT already read by
// the notifiable/outbound gates. Crossing OUT of needs-you must supersede any
// obsolete in-flight (pending/publishing) attention row, independent of inserting
// a replacement (gate-1 round-3 NEW-2). TicketMovedToLane and TicketAdmitted
// already flow through the status-diff reads via OUTBOUND_EVENT_TYPES, so they get
// the leave-supersede for free; these are the remaining resolution events that
// otherwise hit the fast path: waiting_on_user → running (answer/approval via
// StepUserResolved) and parked/blocked → queued (unpark/unblock via TicketQueued).
// The hot step-loop events (StepStarted/PipelineStarted → running) only reach a
// needs-you row AFTER a preceding move/admit that already superseded it, so they
// stay on the fast path.
const RESOLVES_NEEDS_YOU_EVENT_TYPES = new Set(["StepUserResolved", "TicketQueued"]);

// Lane-identity events that must supersede SLA outbox rows even when the ticket
// was never in a classic needs-you status (notify-only SLA can be idle).
const LANE_EXIT_EVENT_TYPES = new Set(["TicketMovedToLane", "TicketQueued", "TicketAdmitted"]);

const SLA_OUTBOX_KIND = "sla_breached";

const isWorkflowEventStoreError = Schema.is(WorkflowEventStoreError);
const toCommitterError = (cause: unknown) =>
  isWorkflowEventStoreError(cause)
    ? cause
    : new WorkflowEventStoreError({ message: "workflow commit transaction failed", cause });

const boardNotRegistered = (boardId: BoardId) =>
  new WorkflowEventStoreError({ message: `Workflow board ${boardId} is no longer registered` });

const make = Effect.gen(function* () {
  const store = yield* WorkflowEventStore;
  const pipeline = yield* WorkflowProjectionPipeline;
  const readModel = yield* WorkflowReadModel;
  const registry = yield* BoardRegistry;
  const predicates = yield* PredicateEvaluator;
  const saveLocks = yield* WorkflowBoardSaveLocks;
  const ids = yield* WorkflowIds;
  const sql = yield* SqlClient.SqlClient;
  type CommitEvent = Parameters<WorkflowEventCommitterShape["commit"]>[0];
  interface ResolvedCommitEvent {
    readonly event: CommitEvent;
    readonly boardId: BoardId | undefined;
  }
  interface RecheckedCommitEvent extends ResolvedCommitEvent {
    readonly shouldCommit: boolean;
  }

  const getOptionalServices = Effect.context<never>().pipe(
    Effect.map((context) => ({
      boardEvents: Context.getOption(
        context as Context.Context<WorkflowBoardEvents>,
        WorkflowBoardEvents,
      ),
    })),
  );

  const resolveBoardId = (event: CommitEvent) =>
    Effect.gen(function* () {
      if (event.type === "TicketCreated") {
        return event.payload.boardId;
      }
      const detail = yield* readModel.getTicketDetail(event.ticketId);
      return detail?.ticket.boardId as BoardId | undefined;
    });

  const recheckRegisteredBoard = (boardId: BoardId, event: CommitEvent) =>
    Effect.gen(function* () {
      const definitionExit = yield* Effect.exit(registry.getDefinition(boardId));
      if (Exit.isSuccess(definitionExit) && definitionExit.value === null) {
        if (event.type === "TicketCreated") {
          return yield* boardNotRegistered(boardId);
        }
        return false;
      }
      if (event.type === "TicketCreated") {
        return true;
      }
      const detail = yield* readModel.getTicketDetail(event.ticketId);
      return detail?.ticket.boardId === boardId;
    });

  // Shared by both commit paths. Runs inside a transaction (single-commit wraps it
  // in sql.withTransaction; commitMany wraps the whole batch). Diffs the ticket
  // status across the projection and, when the event crosses INTO a needs-you
  // status, writes one durable outbox row keyed by the event sequence (UNIQUE).
  const appendAndProjectUnlocked = (event: CommitEvent) =>
    Effect.gen(function* () {
      const isSlaBreach = event.type === "TicketSlaBreached";
      // Escalation breaches do not push — the move produces ordinary destination
      // signals. Only notify-only (no escalatedTo) inserts an outbox row.
      const slaNotifyOnly =
        isSlaBreach &&
        (event.payload as { escalatedTo?: string | undefined }).escalatedTo === undefined;
      const needsNotification =
        NOTIFIABLE_EVENT_TYPES.has(event.type) && (!isSlaBreach || slaNotifyOnly);
      const needsOutbound = OUTBOUND_EVENT_TYPES.has(event.type);
      const needsLeaveSupersede = RESOLVES_NEEDS_YOU_EVENT_TYPES.has(event.type);
      const needsSlaLaneExitSupersede = LANE_EXIT_EVENT_TYPES.has(event.type);
      // Fast path: events that can never notify, fire an outbound rule, nor resolve
      // a needs-you status skip the two projection_ticket point-reads and the
      // insert(s)/supersede entirely.
      if (
        !needsNotification &&
        !needsOutbound &&
        !needsLeaveSupersede &&
        !needsSlaLaneExitSupersede
      ) {
        const persisted = yield* store.append(event);
        yield* pipeline.projectEvent(persisted);
        return persisted;
      }
      // PREV-state read (before projection): status drives the notification diff,
      // current_lane_key is the outbound `fromLane` snapshot.
      const prevRows = yield* sql<{
        readonly status: string;
        readonly currentLaneKey: string;
      }>`
        SELECT status, current_lane_key AS "currentLaneKey"
        FROM projection_ticket WHERE ticket_id = ${event.ticketId}
      `;
      const prevStatus = prevRows[0]?.status ?? null;
      const prevLane = prevRows[0]?.currentLaneKey ?? null;
      const persisted = yield* store.append(event);
      yield* pipeline.projectEvent(persisted);
      const nextRows = yield* sql<{
        readonly status: string;
        readonly boardId: string;
        readonly title: string;
        readonly attentionKind: string | null;
        readonly attentionReason: string | null;
        readonly slaBreachedReason: string | null;
      }>`
        SELECT status, board_id AS "boardId", title,
               attention_kind AS "attentionKind", attention_reason AS "attentionReason",
               sla_breached_reason AS "slaBreachedReason"
        FROM projection_ticket WHERE ticket_id = ${event.ticketId}
      `;
      const next = nextRows[0];
      // SLA notify-only: insert regardless of ticket status (idle/running ok).
      // Kind-scoped: only supersede prior SLA rows, never parked/waiting rows.
      if (needsNotification && slaNotifyOnly && next !== undefined) {
        const outboxId = yield* ids.eventId();
        const createdAt = yield* nowIso;
        const notificationReason =
          next.slaBreachedReason ??
          (typeof (event.payload as { laneKey?: string }).laneKey === "string"
            ? `SLA breached in ${(event.payload as { laneKey: string }).laneKey}`
            : "SLA breached");
        yield* sql`
          UPDATE workflow_notification_outbox
          SET delivery_state = 'superseded'
          WHERE ticket_id = ${event.ticketId}
            AND delivery_state IN ('pending', 'publishing')
            AND sequence != ${persisted.sequence}
            AND attention_kind = ${SLA_OUTBOX_KIND}
        `;
        yield* sql`
          INSERT OR IGNORE INTO workflow_notification_outbox (
            outbox_id, ticket_id, board_id, sequence, status,
            attention_kind, attention_reason, delivery_state, attempt_count, created_at
          ) VALUES (
            ${outboxId}, ${event.ticketId}, ${next.boardId}, ${persisted.sequence}, ${next.status},
            ${SLA_OUTBOX_KIND}, ${notificationReason}, 'pending', 0, ${createdAt}
          )
        `;
      } else if (
        needsNotification &&
        !isSlaBreach &&
        next !== undefined &&
        NEEDS_YOU_STATUSES.has(next.status) &&
        next.status !== prevStatus
      ) {
        const outboxId = yield* ids.eventId();
        const createdAt = yield* nowIso;
        // StepAwaitingUser/TicketBlocked carry a single free-form reason, projected
        // verbatim into attention_reason and used as-is. TicketParked's payload
        // splits into an issue-substate `reason` and a waiting-substate `label`, so
        // the notification copy is composed here per the spec's "hit an issue" /
        // "is waiting on you" wording rather than reusing the raw projected value.
        // The push TITLE is already the ticket title (see the dispatcher's
        // buildBody caller) — the body must NOT re-embed it or the title doubles.
        const notificationReason =
          event.type === "TicketParked"
            ? event.payload.substate === "issue"
              ? `Hit an issue: ${event.payload.reason}`
              : `Waiting on you: ${event.payload.label}`
            : next.attentionReason;
        // Kind-scoped: do not supersede SLA outbox rows (parallel track).
        yield* sql`
          UPDATE workflow_notification_outbox
          SET delivery_state = 'superseded'
          WHERE ticket_id = ${event.ticketId}
            AND delivery_state IN ('pending', 'publishing')
            AND sequence != ${persisted.sequence}
            AND (attention_kind IS NULL OR attention_kind != ${SLA_OUTBOX_KIND})
        `;
        yield* sql`
          INSERT OR IGNORE INTO workflow_notification_outbox (
            outbox_id, ticket_id, board_id, sequence, status,
            attention_kind, attention_reason, delivery_state, attempt_count, created_at
          ) VALUES (
            ${outboxId}, ${event.ticketId}, ${next.boardId}, ${persisted.sequence}, ${next.status},
            ${next.attentionKind}, ${notificationReason}, 'pending', 0, ${createdAt}
          )
        `;
      }
      // Leaving needs-you supersedes obsolete classic attention rows (not SLA).
      if (
        next !== undefined &&
        prevStatus !== null &&
        NEEDS_YOU_STATUSES.has(prevStatus) &&
        !NEEDS_YOU_STATUSES.has(next.status)
      ) {
        yield* sql`
          UPDATE workflow_notification_outbox
          SET delivery_state = 'superseded'
          WHERE ticket_id = ${event.ticketId}
            AND delivery_state IN ('pending', 'publishing')
            AND sequence != ${persisted.sequence}
            AND (attention_kind IS NULL OR attention_kind != ${SLA_OUTBOX_KIND})
        `;
      }
      // Lane exit always supersedes SLA outbox rows (idle breach + move).
      if (needsSlaLaneExitSupersede && next !== undefined) {
        yield* sql`
          UPDATE workflow_notification_outbox
          SET delivery_state = 'superseded'
          WHERE ticket_id = ${event.ticketId}
            AND delivery_state IN ('pending', 'publishing')
            AND sequence != ${persisted.sequence}
            AND attention_kind = ${SLA_OUTBOX_KIND}
        `;
      }
      // Outbound delivery: for the broader OUTBOUND_EVENT_TYPES gate, evaluate the
      // board's outbound rules against a bounded context and write one durable
      // delivery row per surviving rule. Mirrors the notification block: bounded,
      // pure, in-tx — the network happens later in the dispatcher. This block must
      // never be able to fail the commit on outbound-specific causes: a missing def
      // → no-op; a predicate-eval error → that rule is skipped + logged.
      if (needsOutbound && next !== undefined) {
        // The registry load must never fail the commit (mirrors recheckRegisteredBoard,
        // which also wraps getDefinition in Effect.exit): a failed/dying registry or a
        // null definition → no outbound work.
        const definitionExit = yield* Effect.exit(registry.getDefinition(next.boardId as BoardId));
        const def = Exit.isSuccess(definitionExit) ? definitionExit.value : null;
        const rules = def?.outbound ?? [];
        if (rules.length > 0) {
          const toLane =
            event.type === "TicketMovedToLane"
              ? (event.payload.toLane as string)
              : event.type === "TicketAdmitted"
                ? (event.payload.lane as string)
                : null;
          const isTerminal =
            toLane !== null && def?.lanes?.find((lane) => lane.key === toLane)?.terminal === true;
          const reason =
            event.type === "TicketBlocked"
              ? event.payload.reason
              : event.type === "TicketMovedToLane"
                ? event.payload.reason
                : event.type === "TicketParked"
                  ? event.payload.reason
                  : undefined;
          // Row created_at is commit time; the context carries the event's OWN
          // occurrence time (persisted.occurredAt) so replayed/batched/delayed
          // events render with when they actually happened, not when committed.
          const createdAt = yield* nowIso;
          const ctx = buildOutboundContext({
            eventType: event.type,
            ticketId: event.ticketId as string,
            boardId: next.boardId,
            title: next.title,
            fromLane: prevLane,
            toLane,
            postStatus: next.status,
            // Only TicketParked's trigger depends on the payload — split by
            // substate into the blocked-family (issue) or needs_attention-family
            // (waiting) outbound category per the spec.
            ...(event.type === "TicketParked" ? { parkSubstate: event.payload.substate } : {}),
            isTerminal,
            reason,
            occurredAt: persisted.occurredAt,
          });
          for (const rule of rules) {
            if (!rule.enabled) {
              continue;
            }
            // matchesTrigger gates against the BASE ctx (its `done` case checks
            // lane_entered && isTerminal). Only AFTER a match do we derive the
            // rule-specific context: a `done` match carries trigger="done".
            if (!matchesTrigger(rule, ctx)) {
              continue;
            }
            const ruleCtx = contextForRule(rule, ctx);
            if (rule.when !== undefined) {
              // Predicate-eval errors must NEVER fail the commit: capture the exit,
              // skip the rule, and log a warning. Effect.exit (not Effect.either)
              // is the repo idiom used elsewhere in this committer for in-tx
              // best-effort sub-effects (see recheckRegisteredBoard).
              const evaluationExit = yield* Effect.exit(predicates.evaluate(rule.when, ruleCtx));
              if (Exit.isFailure(evaluationExit)) {
                yield* Effect.logWarning(
                  `outbound rule ${rule.id} predicate evaluation failed; skipping`,
                ).pipe(Effect.annotateLogs({ ruleId: rule.id, ticketId: event.ticketId }));
                continue;
              }
              if (!evaluationExit.value.result) {
                continue;
              }
            }
            // Serialize the rule-specific OutboundEventContext into the delivery
            // row's TEXT column for the dispatcher to read back.
            // @effect-diagnostics-next-line preferSchemaOverJson:off - OutboundEventContext is a fixed, validated shape serialized verbatim into context_json.
            const contextJson = JSON.stringify(ruleCtx);
            const deliveryId = `dlv-${persisted.sequence}-${rule.id}`;
            yield* sql`
              INSERT OR IGNORE INTO workflow_outbound_delivery (
                delivery_id, board_id, ticket_id, rule_id, event_sequence,
                connection_ref, formatter, context_json, delivery_state, attempt_count,
                next_attempt_at, created_at
              ) VALUES (
                ${deliveryId}, ${next.boardId}, ${event.ticketId}, ${rule.id}, ${persisted.sequence},
                ${rule.to}, ${rule.as}, ${contextJson}, 'pending', 0,
                ${null}, ${createdAt}
              )
            `;
          }
        }
      }
      return persisted;
    });

  const appendAndProject = (
    event: CommitEvent,
    precondition?: Effect.Effect<void, WorkflowEventStoreError>,
  ): Effect.Effect<PersistedWorkflowEvent | null, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const boardId = yield* resolveBoardId(event);
      if (boardId === undefined) {
        return null;
      }
      return yield* saveLocks.withSaveLock(
        boardId,
        Effect.gen(function* () {
          // Definition-drift recheck IN-LOCK, before any registration check or
          // append: a concurrent save's `register` also holds this save lock, so
          // running the precondition here serializes it against the install. A
          // typed failure aborts the whole commit with nothing appended.
          if (precondition !== undefined) {
            yield* precondition;
          }
          const isRegistered = yield* recheckRegisteredBoard(boardId, event);
          if (!isRegistered) {
            return null;
          }
          // Lock OUTSIDE, transaction INSIDE. appendAndProjectUnlocked never opens
          // its own transaction, so commitMany (which already wraps the batch in a
          // single withTransaction) does not nest.
          return yield* sql
            .withTransaction(appendAndProjectUnlocked(event))
            .pipe(Effect.mapError(toCommitterError));
        }),
      );
    });

  const resolveBatchBoardIds = (events: ReadonlyArray<CommitEvent>) =>
    Effect.gen(function* () {
      const ticketBoardIds = new Map<string, BoardId>();
      const resolved: Array<ResolvedCommitEvent> = [];

      for (const event of events) {
        let boardId: BoardId | undefined;
        if (event.type === "TicketCreated") {
          boardId = event.payload.boardId;
        } else {
          boardId = ticketBoardIds.get(event.ticketId as string);
          if (boardId === undefined) {
            boardId = yield* resolveBoardId(event);
          }
        }

        if (boardId !== undefined) {
          ticketBoardIds.set(event.ticketId as string, boardId);
        }
        resolved.push({ event, boardId });
      }

      return resolved;
    });

  const distinctSortedBoardIds = (events: ReadonlyArray<ResolvedCommitEvent>) =>
    Array.from(
      new Set(events.flatMap(({ boardId }) => (boardId === undefined ? [] : [boardId]))),
    ).sort((left, right) => (left as string).localeCompare(right as string));

  const withBoardSaveLocks = <A, E, R>(
    boardIds: ReadonlyArray<BoardId>,
    effect: Effect.Effect<A, E, R>,
  ) =>
    boardIds.reduceRight(
      (lockedEffect, boardId) => saveLocks.withSaveLock(boardId, lockedEffect),
      effect,
    );

  const recheckRegisteredBoards = (
    resolved: ReadonlyArray<ResolvedCommitEvent>,
    boardIds: ReadonlyArray<BoardId>,
  ) =>
    Effect.gen(function* () {
      const registeredBoards = new Map<string, boolean>();

      for (const boardId of boardIds) {
        const definitionExit = yield* Effect.exit(registry.getDefinition(boardId));
        const isRegistered = !(Exit.isSuccess(definitionExit) && definitionExit.value === null);
        if (
          !isRegistered &&
          resolved.some(
            ({ boardId: eventBoardId, event }) =>
              eventBoardId === boardId && event.type === "TicketCreated",
          )
        ) {
          return yield* boardNotRegistered(boardId);
        }
        registeredBoards.set(boardId as string, isRegistered);
      }

      return registeredBoards;
    });

  const recheckBatchTickets = (
    resolved: ReadonlyArray<ResolvedCommitEvent>,
    registeredBoards: ReadonlyMap<string, boolean>,
  ) =>
    Effect.gen(function* () {
      const createdTicketIds = new Set<string>();
      const rechecked: Array<RecheckedCommitEvent> = [];

      for (const resolvedEvent of resolved) {
        const { event, boardId } = resolvedEvent;
        const ticketId = event.ticketId as string;

        if (boardId === undefined || registeredBoards.get(boardId as string) !== true) {
          rechecked.push({ ...resolvedEvent, shouldCommit: false });
          continue;
        }

        if (event.type === "TicketCreated") {
          createdTicketIds.add(ticketId);
          rechecked.push({ ...resolvedEvent, shouldCommit: true });
          continue;
        }

        if (createdTicketIds.has(ticketId)) {
          rechecked.push({ ...resolvedEvent, shouldCommit: true });
          continue;
        }

        const detail = yield* readModel.getTicketDetail(event.ticketId);
        rechecked.push({
          ...resolvedEvent,
          shouldCommit: detail?.ticket.boardId === boardId,
        });
      }

      return rechecked;
    });

  const publishTicketView = (ticketId: PersistedWorkflowEvent["ticketId"]) =>
    Effect.gen(function* () {
      const detail = yield* readModel.getTicketDetail(ticketId);
      const { boardEvents } = yield* getOptionalServices;
      if (detail && Option.isSome(boardEvents)) {
        const ticket = detail.ticket;
        const definition = yield* registry.getDefinition(ticket.boardId as BoardId);
        const parked = toParkedTicketView(ticket, definition);
        yield* boardEvents.value.publish({
          ticketId: ticket.ticketId as TicketId,
          boardId: ticket.boardId as BoardId,
          title: ticket.title,
          ...(ticket.description === null ? {} : { description: ticket.description }),
          currentLaneKey: ticket.currentLaneKey as LaneKey,
          status: ticket.status as TicketStatus,
          ...(ticket.queuedAt === null ? {} : { queuedAt: ticket.queuedAt }),
          ...(ticket.dependsOn === undefined || ticket.dependsOn.length === 0
            ? {}
            : { dependsOn: ticket.dependsOn as ReadonlyArray<TicketId> }),
          ...(ticket.unresolvedDependencyCount === undefined ||
          ticket.unresolvedDependencyCount === 0
            ? {}
            : { unresolvedDependencyCount: ticket.unresolvedDependencyCount }),
          ...(typeof ticket.tokenBudget === "number" ? { tokenBudget: ticket.tokenBudget } : {}),
          ...(ticket.updatedAt === undefined ? {} : { updatedAt: ticket.updatedAt }),
          ...(typeof ticket.totalTokens === "number" && ticket.totalTokens > 0
            ? { totalTokens: ticket.totalTokens }
            : {}),
          ...(typeof ticket.totalDurationMs === "number" && ticket.totalDurationMs > 0
            ? { totalDurationMs: ticket.totalDurationMs }
            : {}),
          ...(ticket.pr === undefined ? {} : { pr: ticket.pr }),
          // Attention fields are populated when the ticket is waiting_on_user /
          // blocked — exactly the states a publish is triggered for — so the
          // live BoardTicketView carries the same attention detail as a refetch.
          ...(ticket.attentionKind === undefined || ticket.attentionKind === null
            ? {}
            : { attentionKind: ticket.attentionKind as WorkflowTicketAttentionKind }),
          ...(ticket.attentionReason === undefined || ticket.attentionReason === null
            ? {}
            : { attentionReason: ticket.attentionReason }),
          // What the agent is currently doing, for running tickets.
          ...(ticket.currentStepLabel === undefined || ticket.currentStepLabel === null
            ? {}
            : { currentStepLabel: ticket.currentStepLabel }),
          // Park-in-place details — present while status is "parked".
          ...(parked === undefined ? {} : { parked }),
          // SLA breach badge — live stream must match snapshot/refetch.
          ...(ticket.slaBreachedAt == null ? {} : { slaBreachedAt: ticket.slaBreachedAt }),
        } satisfies BoardTicketView);
      }
    });

  const publishTicket = (persisted: PersistedWorkflowEvent) =>
    Effect.gen(function* () {
      yield* publishTicketView(persisted.ticketId);
      // Lane moves can change dependents' unresolved counts (terminal entry
      // resolves them, leaving a terminal lane un-resolves them) — republish
      // every dependent so waiting badges stay live.
      if (persisted.type === "TicketMovedToLane" || persisted.type === "TicketDependenciesSet") {
        const dependents = yield* readModel
          .listDependentTicketIds(persisted.ticketId)
          .pipe(Effect.orElseSucceed(() => []));
        yield* Effect.forEach(dependents, (dependent) => publishTicketView(dependent as never), {
          discard: true,
        });
      }
    });

  const commit: WorkflowEventCommitterShape["commit"] = (event, precondition) =>
    appendAndProject(event, precondition).pipe(
      Effect.flatMap((persisted) => (persisted === null ? Effect.void : publishTicket(persisted))),
    );

  const commitMany: WorkflowEventCommitterShape["commitMany"] = (events, precondition) =>
    Effect.gen(function* () {
      const resolved = yield* resolveBatchBoardIds(events);
      const boardIds = distinctSortedBoardIds(resolved);
      if (boardIds.length === 0) {
        return;
      }

      const persisted = yield* withBoardSaveLocks(
        boardIds,
        Effect.gen(function* () {
          // Definition-drift recheck IN-LOCK before append (see appendAndProject):
          // serialized against a concurrent save's `register`, which holds these
          // same board save locks. A typed failure aborts with nothing appended.
          if (precondition !== undefined) {
            yield* precondition;
          }
          const registeredBoards = yield* recheckRegisteredBoards(resolved, boardIds);
          const rechecked = yield* recheckBatchTickets(resolved, registeredBoards);
          return yield* sql
            .withTransaction(
              Effect.forEach(
                rechecked,
                ({ event, shouldCommit }) =>
                  !shouldCommit ? Effect.succeed(null) : appendAndProjectUnlocked(event),
                { concurrency: 1 },
              ),
            )
            .pipe(Effect.mapError(toCommitterError));
        }),
      );
      yield* Effect.forEach(
        persisted,
        (event) => (event === null ? Effect.void : publishTicket(event)),
        { discard: true },
      );
    });

  // CALLER MUST already hold the board save lock for every affected board AND be
  // inside an open sql.withTransaction. This intentionally does NOT take the lock
  // or open a transaction (it would deadlock / nest) and does NOT publish ticket
  // views — it only appends+projects each event in order, returning the persisted
  // rows for the caller to publish after releasing the lock.
  const appendManyUnlocked: WorkflowEventCommitterShape["appendManyUnlocked"] = (events) =>
    Effect.forEach(events, (event) => appendAndProjectUnlocked(event), {
      concurrency: 1,
    }).pipe(Effect.mapError(toCommitterError));

  // Public, post-lock ticket-view publish for batch syncers driving
  // appendManyUnlocked (which does NOT publish). Mirrors publishTicket: emits the
  // ticket's current view and, when requested (a terminal/lane move), republishes
  // dependents so waiting badges stay live.
  const publishTicketView_: WorkflowEventCommitterShape["publishTicketView"] = (
    ticketId,
    options,
  ) =>
    Effect.gen(function* () {
      yield* publishTicketView(ticketId);
      if (options?.republishDependents === true) {
        const dependents = yield* readModel
          .listDependentTicketIds(ticketId)
          .pipe(Effect.orElseSucceed(() => []));
        yield* Effect.forEach(dependents, (dependent) => publishTicketView(dependent as never), {
          discard: true,
        });
      }
    });

  return {
    commit,
    commitMany,
    appendManyUnlocked,
    publishTicketView: publishTicketView_,
  } satisfies WorkflowEventCommitterShape;
});

// The committer evaluates outbound `when` predicates with the SAME JSONLogic
// evaluator routing/onEvent use, so PredicateEvaluator is a real RIn dependency
// (mirroring WorkflowEngine). Prod wires PredicateEvaluatorLive in the same merge
// (WorkflowRuntimeLive / WorkflowEngineLive). Tests provide PredicateEvaluatorLive
// — or a failing stub to exercise eval-error isolation.
export const WorkflowEventCommitterLive = Layer.effect(WorkflowEventCommitter, make);
