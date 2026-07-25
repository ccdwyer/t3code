import {
  ProviderInstanceId,
  ProviderOptionSelections,
  TrimmedNonEmptyString,
  type ModelSelection,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  ProviderDispatchOutbox,
  ProviderTurnPort,
  type DispatchRequest,
  type ProviderDispatchTerminalResult,
  type ProviderDispatchOutboxShape,
  type ProviderTurnPortShape,
  type SteerTarget,
} from "../Services/ProviderDispatchOutbox.ts";
import { TurnProjectionPort, TurnStateReader } from "../Services/TurnStateReader.ts";

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const TERMINAL_WAIT_TIMEOUT = Duration.minutes(30);
const TERMINAL_WAIT_TIMEOUT_MS = Duration.toMillis(TERMINAL_WAIT_TIMEOUT);

const toDispatchError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrapSql = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toDispatchError("dispatch op failed")));

interface DispatchStatusRow {
  readonly status: "pending" | "started" | "confirmed";
  readonly turnId: string | null;
}

interface RecoverDispatchRow extends Omit<
  DispatchRequest,
  "options" | "projectId" | "threadTitle" | "runtimeMode"
> {
  readonly status: "pending" | "started" | "confirmed";
  readonly optionsJson: string | null;
  readonly projectId: string | null;
  readonly threadTitle: string | null;
  readonly runtimeMode: string | null;
}

const dispatchOptionsJson = Schema.fromJsonString(ProviderOptionSelections);
const encodeDispatchOptionsJson = Schema.encodeEffect(dispatchOptionsJson);
const decodeDispatchOptionsJson = Schema.decodeEffect(dispatchOptionsJson);

// Tolerant decode: an unparseable/legacy row should not abort recovery of the
// remaining pending dispatches, so a decode failure degrades to "no options".
const recoverDispatchRowToRequest = (row: RecoverDispatchRow): Effect.Effect<DispatchRequest> =>
  Effect.gen(function* () {
    const options =
      row.optionsJson === null || row.optionsJson.length === 0
        ? undefined
        : yield* decodeDispatchOptionsJson(row.optionsJson).pipe(
            Effect.orElseSucceed(() => undefined),
          );
    const runtimeMode =
      row.runtimeMode === "approval-required" ||
      row.runtimeMode === "auto-accept-edits" ||
      row.runtimeMode === "full-access"
        ? row.runtimeMode
        : undefined;
    return {
      dispatchId: row.dispatchId,
      ticketId: row.ticketId,
      stepRunId: row.stepRunId,
      threadId: row.threadId,
      providerInstance: row.providerInstance,
      model: row.model,
      instruction: row.instruction,
      worktreePath: row.worktreePath,
      ...(options === undefined ? {} : { options }),
      ...(row.projectId === null ? {} : { projectId: row.projectId }),
      ...(row.threadTitle === null ? {} : { threadTitle: row.threadTitle }),
      ...(runtimeMode === undefined ? {} : { runtimeMode }),
    };
  });

interface StepDispatchRow {
  readonly dispatchId: string;
}

interface DispatchForStepRow {
  readonly threadId: string;
  readonly turnId: string | null;
}

interface SteerTargetRow {
  readonly dispatchId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly status: string;
  readonly captureOutput: number | null;
  readonly panelSize: number | null;
  readonly steerPendingMessageId: string | null;
}

interface DeadlineRow {
  readonly steerAcceptedAt: string | null;
  readonly startedAt: string | null;
  readonly createdAt: string;
  readonly steerPendingMessageId: string | null;
  readonly turnId: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const provider = yield* ProviderTurnPort;
  const turns = yield* TurnStateReader;
  // Optional: unit tests that only stub TurnStateReader still compile; live
  // wiring provides the port so awaitTerminal can single-read turn id+state.
  const turnProjection = yield* Effect.serviceOption(TurnProjectionPort);

  const getDispatchStatus = (dispatchId: string) =>
    wrapSql(sql<DispatchStatusRow>`
      SELECT
        status,
        turn_id AS "turnId"
      FROM workflow_dispatch_outbox
      WHERE dispatch_id = ${dispatchId}
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const confirmStep: ProviderDispatchOutboxShape["confirmStep"] = (stepRunId) =>
    Effect.gen(function* () {
      const confirmedAt = yield* nowIso;
      yield* wrapSql(sql`
        UPDATE workflow_dispatch_outbox
        SET status = 'confirmed',
            confirmed_at = ${confirmedAt}
        WHERE step_run_id = ${stepRunId}
          AND status != 'confirmed'
      `);
    });

  const ensureStarted: ProviderDispatchOutboxShape["ensureStarted"] = (req) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const optionsJson =
        req.options === undefined
          ? null
          : yield* encodeDispatchOptionsJson(req.options).pipe(
              Effect.mapError(toDispatchError("dispatch options encode failed")),
            );
      yield* wrapSql(sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id,
          ticket_id,
          step_run_id,
          thread_id,
          provider_instance,
          model,
          instruction,
          worktree_path,
          options_json,
          project_id,
          thread_title,
          runtime_mode,
          capture_output,
          panel_size,
          dispatch_seq,
          status,
          created_at
        )
        VALUES (
          ${req.dispatchId},
          ${req.ticketId},
          ${req.stepRunId},
          ${req.threadId},
          ${req.providerInstance},
          ${req.model},
          ${req.instruction},
          ${req.worktreePath},
          ${optionsJson},
          ${req.projectId ?? null},
          ${req.threadTitle ?? null},
          ${req.runtimeMode ?? null},
          ${req.captureOutput === undefined ? null : req.captureOutput ? 1 : 0},
          ${req.panelSize ?? null},
          ${req.dispatchSeq ?? 0},
          'pending',
          ${createdAt}
        )
        ON CONFLICT(dispatch_id) DO NOTHING
      `);

      const status = yield* getDispatchStatus(req.dispatchId);
      if (
        (status?.status === "started" || status?.status === "confirmed") &&
        status.turnId !== null
      ) {
        return { turnId: status.turnId as never };
      }

      const { turnId } = yield* provider.ensureTurnStarted(req);
      const startedAt = yield* nowIso;
      yield* wrapSql(sql`
        UPDATE workflow_dispatch_outbox
        SET status = 'started',
            turn_id = ${turnId},
            started_at = ${startedAt}
        WHERE dispatch_id = ${req.dispatchId}
      `);
      return { turnId };
    });

  const getDispatchForStep: ProviderDispatchOutboxShape["getDispatchForStep"] = (stepRunId) =>
    wrapSql(sql<DispatchForStepRow>`
      SELECT
        thread_id AS "threadId",
        turn_id AS "turnId"
      FROM workflow_dispatch_outbox
      WHERE step_run_id = ${stepRunId}
      ORDER BY dispatch_seq DESC, created_at DESC, dispatch_id DESC
      LIMIT 1
    `).pipe(
      Effect.map((rows) => {
        const row = rows[0];
        if (!row || row.turnId === null) {
          return null;
        }
        return {
          threadId: row.threadId as never,
          turnId: row.turnId as never,
        };
      }),
    );

  const getSteerTarget: ProviderDispatchOutboxShape["getSteerTarget"] = (stepRunId) =>
    wrapSql(sql<SteerTargetRow>`
      SELECT
        dispatch_id AS "dispatchId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        status,
        capture_output AS "captureOutput",
        panel_size AS "panelSize",
        steer_pending_message_id AS "steerPendingMessageId"
      FROM workflow_dispatch_outbox
      WHERE step_run_id = ${stepRunId}
      ORDER BY created_at DESC, dispatch_id DESC
      LIMIT 1
    `).pipe(
      Effect.map((rows): SteerTarget | null => {
        const row = rows[0];
        // Started dispatch is enough; turn_id may lag one poll after start.
        if (!row || row.status !== "started") {
          return null;
        }
        return {
          dispatchId: row.dispatchId as never,
          threadId: row.threadId as never,
          turnId: (row.turnId as never) ?? null,
          captureOutput: row.captureOutput === 1,
          panelSize: row.panelSize,
          steerPendingMessageId: row.steerPendingMessageId,
        };
      }),
    );

  const markSteerPending: ProviderDispatchOutboxShape["markSteerPending"] = (
    dispatchId,
    messageId,
    text,
  ) =>
    Effect.gen(function* () {
      yield* wrapSql(sql`
        UPDATE workflow_dispatch_outbox
        SET steer_pending_message_id = ${messageId},
            steer_pending_text = ${text}
        WHERE dispatch_id = ${dispatchId}
          AND status = 'started'
          AND steer_pending_message_id IS NULL
          AND steer_tombstone_message_id IS NULL
      `);
      // CAS success: we hold the reservation for this messageId (or already
      // held it from an idempotent retry that re-issued the same id).
      const rows = yield* wrapSql(sql<{ readonly pending: string | null }>`
        SELECT steer_pending_message_id AS "pending"
        FROM workflow_dispatch_outbox
        WHERE dispatch_id = ${dispatchId}
      `);
      return rows[0]?.pending === (messageId as string);
    });

  const clearSteerPending: ProviderDispatchOutboxShape["clearSteerPending"] = (
    dispatchId,
    messageId,
  ) =>
    wrapSql(sql`
      UPDATE workflow_dispatch_outbox
      SET steer_pending_message_id = NULL,
          steer_pending_text = NULL
      WHERE dispatch_id = ${dispatchId}
        AND steer_pending_message_id = ${messageId}
    `).pipe(Effect.asVoid);

  const ackSteerDelivered: ProviderDispatchOutboxShape["ackSteerDelivered"] = (
    dispatchId,
    messageId,
  ) =>
    Effect.gen(function* () {
      const acceptedAt = yield* nowIso;
      // MessageId-keyed: only the owner of the current pending reservation
      // stages the delivery and clears pending. Stages text from pending_text
      // for a durable StepSteered append (survives process exit).
      yield* wrapSql(sql`
        UPDATE workflow_dispatch_outbox
        SET steer_accepted_at = ${acceptedAt},
            steer_count = COALESCE(steer_count, 0) + 1,
            steer_delivered_message_id = ${messageId},
            steer_delivered_text = steer_pending_text,
            steer_pending_message_id = NULL,
            steer_pending_text = NULL
        WHERE dispatch_id = ${dispatchId}
          AND steer_pending_message_id = ${messageId}
          AND (
            steer_delivered_message_id IS NULL
            OR steer_delivered_message_id = ${messageId}
          )
      `);
      // Also stage when pending was already cleared by a peer but we still
      // hold a matching staged slot empty and a prior pending text is gone —
      // only report true when this message is now the staged delivery.
      const rows = yield* wrapSql(sql<{ readonly delivered: string | null }>`
        SELECT steer_delivered_message_id AS "delivered"
        FROM workflow_dispatch_outbox
        WHERE dispatch_id = ${dispatchId}
      `);
      return rows[0]?.delivered === (messageId as string);
    });

  const listStagedSteerDeliveries: ProviderDispatchOutboxShape["listStagedSteerDeliveries"] = () =>
    wrapSql(sql<{
      readonly dispatchId: string;
      readonly ticketId: string;
      readonly stepRunId: string;
      readonly threadId: string;
      readonly messageId: string;
      readonly text: string | null;
    }>`
        SELECT
          dispatch_id AS "dispatchId",
          ticket_id AS "ticketId",
          step_run_id AS "stepRunId",
          thread_id AS "threadId",
          steer_delivered_message_id AS "messageId",
          steer_delivered_text AS "text"
        FROM workflow_dispatch_outbox
        WHERE steer_delivered_message_id IS NOT NULL
          AND steer_delivered_text IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM projection_ticket AS ticket
            WHERE ticket.ticket_id = workflow_dispatch_outbox.ticket_id
          )
      `).pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          dispatchId: row.dispatchId as never,
          ticketId: row.ticketId as never,
          stepRunId: row.stepRunId as never,
          threadId: row.threadId as never,
          messageId: row.messageId as never,
          text: row.text ?? "",
        })),
      ),
    );

  const clearStagedSteerDelivery: ProviderDispatchOutboxShape["clearStagedSteerDelivery"] = (
    dispatchId,
    messageId,
  ) =>
    wrapSql(sql`
      UPDATE workflow_dispatch_outbox
      SET steer_delivered_message_id = NULL,
          steer_delivered_text = NULL
      WHERE dispatch_id = ${dispatchId}
        AND steer_delivered_message_id = ${messageId}
    `).pipe(Effect.asVoid);

  const readDeadlineBase = (dispatchId: string) =>
    wrapSql(sql<DeadlineRow>`
      SELECT
        steer_accepted_at AS "steerAcceptedAt",
        started_at AS "startedAt",
        created_at AS "createdAt",
        steer_pending_message_id AS "steerPendingMessageId",
        turn_id AS "turnId"
      FROM workflow_dispatch_outbox
      WHERE dispatch_id = ${dispatchId}
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const persistTurnIdIfChanged = (dispatchId: string, turnId: string) =>
    wrapSql(sql`
      UPDATE workflow_dispatch_outbox
      SET turn_id = ${turnId}
      WHERE dispatch_id = ${dispatchId}
        AND (turn_id IS NULL OR turn_id != ${turnId})
    `).pipe(Effect.asVoid);

  const awaitTerminal: ProviderDispatchOutboxShape["awaitTerminal"] = (dispatchId, threadId) => {
    const waitForTerminal: Effect.Effect<ProviderDispatchTerminalResult, WorkflowEventStoreError> =
      Effect.gen(function* () {
        // Rolling deadline: COALESCE(steer_accepted_at, started_at, created_at)
        // + 30m, re-read each poll so only an *acked* steer extends the wait.
        for (;;) {
          const meta = yield* readDeadlineBase(dispatchId);
          const baseIso = meta?.steerAcceptedAt ?? meta?.startedAt ?? meta?.createdAt;
          const baseMs = baseIso !== undefined ? Date.parse(baseIso) : Number.NaN;
          const nowMs = yield* Clock.currentTimeMillis;
          if (Number.isFinite(baseMs) && nowMs - baseMs >= TERMINAL_WAIT_TIMEOUT_MS) {
            break;
          }

          // Single-snapshot correlation: turn id + raw state from one projection
          // read. Awaiting_user enrichment still goes through TurnStateReader when
          // the snapshot is non-terminal.
          let latestTurnId: string | null = meta?.turnId ?? null;
          let snapshotState: string | null = null;
          let snapshotCompleted = false;
          if (Option.isSome(turnProjection)) {
            const latest = yield* turnProjection.value.getLatestTurnState(threadId);
            snapshotState = latest.state;
            snapshotCompleted = latest.completed;
            if (latest.turnId !== null) {
              latestTurnId = latest.turnId;
              yield* persistTurnIdIfChanged(dispatchId, latest.turnId);
            }
          }

          // Ack processing: stage delivered steers for durable StepSteered.
          if (meta?.steerPendingMessageId != null) {
            const pendingMessageId = meta.steerPendingMessageId;
            const receipts = yield* wrapSql(sql<{
              readonly kind: string;
            }>`
              SELECT kind
              FROM projection_thread_activities
              WHERE thread_id = ${threadId}
                AND kind IN ('workflow.steer.delivered', 'workflow.steer.failed')
                AND (
                  json_extract(payload_json, '$.messageId') = ${pendingMessageId}
                  OR payload_json LIKE ${`%${pendingMessageId}%`}
                )
              ORDER BY created_at DESC
              LIMIT 1
            `).pipe(Effect.orElseSucceed(() => [] as Array<{ readonly kind: string }>));
            const receipt = receipts[0];
            if (receipt?.kind === "workflow.steer.delivered") {
              yield* ackSteerDelivered(dispatchId as never, pendingMessageId as never);
            } else if (receipt?.kind === "workflow.steer.failed") {
              yield* clearSteerPending(dispatchId as never, pendingMessageId as never);
            }
          }

          // Terminal from the same snapshot — do not re-read turn id separately.
          if (snapshotCompleted && latestTurnId !== null) {
            const terminalTurnId = latestTurnId as never;
            const confirmedAt = yield* nowIso;
            yield* wrapSql(sql`
              UPDATE workflow_dispatch_outbox
              SET status = 'confirmed',
                  confirmed_at = ${confirmedAt},
                  turn_id = COALESCE(turn_id, ${latestTurnId})
              WHERE dispatch_id = ${dispatchId}
            `);
            return snapshotState === "completed"
              ? ({ ok: true, turnId: terminalTurnId } satisfies ProviderDispatchTerminalResult)
              : ({
                  ok: false,
                  turnId: terminalTurnId,
                  error: snapshotState ?? "turn failed",
                } satisfies ProviderDispatchTerminalResult);
          }

          const state = yield* turns.read(threadId);
          if (state._tag === "running") {
            yield* Effect.sleep("500 millis");
            continue;
          }

          if (state._tag === "awaiting_user") {
            // No grace / stop on the approval path. Clear any in-flight steer
            // reservation — the provider superseded it with a question.
            if (meta?.steerPendingMessageId != null) {
              yield* clearSteerPending(dispatchId as never, meta.steerPendingMessageId as never);
            }
            return {
              ok: false,
              awaitingUser: true,
              waitingReason: state.waitingReason,
              providerThreadId: state.providerThreadId,
              providerRequestId: state.providerRequestId,
              providerResponseKind: state.providerResponseKind,
              ...(state.providerQuestionId === undefined
                ? {}
                : { providerQuestionId: state.providerQuestionId }),
            } satisfies ProviderDispatchTerminalResult;
          }

          const terminalTurnId = (latestTurnId ?? meta?.turnId ?? "unknown-turn") as never;
          const confirmedAt = yield* nowIso;
          yield* wrapSql(sql`
            UPDATE workflow_dispatch_outbox
            SET status = 'confirmed',
                confirmed_at = ${confirmedAt},
                turn_id = COALESCE(turn_id, ${latestTurnId})
            WHERE dispatch_id = ${dispatchId}
          `);

          return state._tag === "completed"
            ? ({ ok: true, turnId: terminalTurnId } satisfies ProviderDispatchTerminalResult)
            : ({
                ok: false,
                turnId: terminalTurnId,
                error: state.error,
              } satisfies ProviderDispatchTerminalResult);
        }

        // Deadline elapsed while still running.
        const meta = yield* readDeadlineBase(dispatchId);
        const confirmedAt = yield* nowIso;
        yield* wrapSql(sql`
          UPDATE workflow_dispatch_outbox
          SET status = 'confirmed',
              confirmed_at = ${confirmedAt}
          WHERE dispatch_id = ${dispatchId}
        `);
        return {
          ok: false,
          turnId: (meta?.turnId ?? "unknown-turn") as never,
          error: "turn did not reach a terminal state before timeout",
        } satisfies ProviderDispatchTerminalResult;
      });

    return waitForTerminal;
  };

  const awaitStepTerminal: ProviderDispatchOutboxShape["awaitStepTerminal"] = (
    stepRunId,
    threadId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* wrapSql(sql<StepDispatchRow>`
        SELECT dispatch_id AS "dispatchId"
        FROM workflow_dispatch_outbox
        WHERE step_run_id = ${stepRunId}
        ORDER BY created_at DESC, dispatch_id DESC
        LIMIT 1
      `);
      const dispatchId = rows[0]?.dispatchId;
      if (!dispatchId) {
        return yield* new WorkflowEventStoreError({
          message: `dispatch not found for step ${stepRunId}`,
        });
      }
      return yield* awaitTerminal(dispatchId as never, threadId);
    });

  const deleteOrphanDispatches = wrapSql(sql`
    DELETE FROM workflow_dispatch_outbox
    WHERE NOT EXISTS (
      SELECT 1
      FROM projection_ticket AS ticket
      INNER JOIN projection_board AS board
        ON board.board_id = ticket.board_id
      WHERE ticket.ticket_id = workflow_dispatch_outbox.ticket_id
    )
  `).pipe(Effect.asVoid);

  // A dispatch row is only worth restarting while its pipeline still owns the
  // ticket: a manual move (or re-route) hands out a new lane entry token, and
  // restarting the superseded dispatch would let a stale agent mutate the
  // worktree after the user moved on.
  const tombstoneStaleDispatches = Effect.gen(function* () {
    const confirmedAt = yield* nowIso;
    yield* wrapSql(sql`
      UPDATE workflow_dispatch_outbox
      SET status = 'confirmed',
          confirmed_at = ${confirmedAt}
      WHERE status != 'confirmed'
        AND EXISTS (
          SELECT 1
          FROM projection_step_run AS step
          INNER JOIN projection_pipeline_run AS pipeline
            ON pipeline.pipeline_run_id = step.pipeline_run_id
          INNER JOIN projection_ticket AS ticket
            ON ticket.ticket_id = pipeline.ticket_id
          WHERE step.step_run_id = workflow_dispatch_outbox.step_run_id
            AND (
              ticket.current_lane_entry_token IS NULL
              OR pipeline.lane_entry_token != ticket.current_lane_entry_token
            )
        )
    `);
  });

  const recoverPending: ProviderDispatchOutboxShape["recoverPending"] = () =>
    Effect.gen(function* () {
      yield* deleteOrphanDispatches;
      yield* tombstoneStaleDispatches;
      const rows = yield* wrapSql(sql<RecoverDispatchRow>`
        SELECT
          dispatch_id AS "dispatchId",
          ticket_id AS "ticketId",
          step_run_id AS "stepRunId",
          thread_id AS "threadId",
          provider_instance AS "providerInstance",
          model,
          instruction,
          worktree_path AS "worktreePath",
          options_json AS "optionsJson",
          project_id AS "projectId",
          thread_title AS "threadTitle",
          runtime_mode AS "runtimeMode",
          status
        FROM workflow_dispatch_outbox
        WHERE status != 'confirmed'
      `);

      yield* Effect.forEach(
        rows,
        (row) =>
          row.status === "pending"
            ? recoverDispatchRowToRequest(row).pipe(Effect.flatMap(ensureStarted))
            : Effect.void,
        { discard: true },
      );
    });

  return {
    confirmStep,
    ensureStarted,
    getDispatchForStep,
    getSteerTarget,
    markSteerPending,
    clearSteerPending,
    ackSteerDelivered,
    listStagedSteerDeliveries,
    clearStagedSteerDelivery,
    awaitTerminal,
    awaitStepTerminal,
    recoverPending,
  } satisfies ProviderDispatchOutboxShape;
});

export const ProviderDispatchOutboxLive = Layer.effect(ProviderDispatchOutbox, make);

export const ProviderTurnPortLive = Layer.effect(
  ProviderTurnPort,
  Effect.gen(function* () {
    const providerSvc = yield* ProviderService;
    const turns = yield* ProjectionTurnRepository;
    const orchestration = yield* Effect.serviceOption(OrchestrationEngineService);

    // Provider runtime ingestion (and the orchestration decider behind it)
    // only accepts events for threads that exist in the orchestration domain.
    // Workflow dispatch threads are not user chat threads, so create them as
    // hidden threads through the real command path before the session starts;
    // without this every dispatch turn is invisible and never reaches a
    // terminal state from the workflow's perspective.
    const ensureHiddenThreadShell = (req: DispatchRequest, modelSelection: ModelSelection) =>
      Effect.gen(function* () {
        if (req.projectId === undefined || Option.isNone(orchestration)) {
          return;
        }
        const now = yield* nowIso;
        yield* orchestration.value
          .dispatch({
            type: "thread.create",
            commandId: `workflow-thread-${req.threadId}` as never,
            threadId: req.threadId,
            projectId: req.projectId as never,
            title: req.threadTitle ?? "Workflow dispatch",
            modelSelection,
            runtimeMode: req.runtimeMode ?? "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: req.worktreePath as never,
            createdAt: now as never,
            hidden: true,
          })
          .pipe(
            Effect.catchCause((cause) => {
              // Re-dispatch after recovery hits the already-exists invariant —
              // that one is a benign no-op. Anything else means the provider
              // session would run invisibly, so fail the dispatch loudly.
              if (
                Cause.squash(cause) instanceof Error &&
                String(Cause.squash(cause)).includes("already exists")
              ) {
                return Effect.void;
              }
              return Effect.logWarning("workflow thread create failed", { cause }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new WorkflowEventStoreError({
                      message: "workflow thread create failed",
                      cause: Cause.squash(cause),
                    }),
                  ),
                ),
              );
            }),
          );
      }).pipe(Effect.mapError(toDispatchError("workflow thread create failed")));

    const ensureTurnStarted: ProviderTurnPortShape["ensureTurnStarted"] = (req) =>
      Effect.gen(function* () {
        const existingTurns = yield* turns
          .listByThreadId({ threadId: req.threadId })
          .pipe(Effect.orElseSucceed(() => []));
        const existingTurn = existingTurns.findLast(
          (turn) => turn.turnId !== null && (turn.state === "pending" || turn.state === "running"),
        );
        // Only reuse a projected running/pending turn when a live provider
        // session still exists — a ghost projection with no session must not
        // be adopted (recovery interrupt may leave projection state behind).
        if (existingTurn?.turnId !== undefined && existingTurn.turnId !== null) {
          const sessions = yield* providerSvc.listSessions().pipe(Effect.orElseSucceed(() => []));
          const hasLiveSession = sessions.some(
            (session) => (session.threadId as string) === (req.threadId as string),
          );
          if (hasLiveSession) {
            return { turnId: existingTurn.turnId };
          }
          // Ghost projected turn: ignore it and start a fresh session/turn.
        }

        const providerInstanceId = ProviderInstanceId.make(req.providerInstance);
        const modelSelection = {
          instanceId: providerInstanceId,
          model: TrimmedNonEmptyString.make(req.model),
          ...(req.options === undefined ? {} : { options: req.options }),
        };
        yield* ensureHiddenThreadShell(req, modelSelection);
        const sessionInput = {
          threadId: req.threadId,
          providerInstanceId,
          cwd: TrimmedNonEmptyString.make(req.worktreePath),
          modelSelection,
          runtimeMode: req.runtimeMode ?? "full-access",
        } satisfies ProviderSessionStartInput;
        const sendInput = {
          threadId: req.threadId,
          input: TrimmedNonEmptyString.make(req.instruction),
          modelSelection,
        } satisfies ProviderSendTurnInput;

        yield* providerSvc.startSession(req.threadId, sessionInput);
        const turn = yield* providerSvc.sendTurn(sendInput);
        return { turnId: turn.turnId };
      }).pipe(Effect.mapError(toDispatchError("provider start failed")));

    const steerTurn: NonNullable<ProviderTurnPortShape["steerTurn"]> = (input) =>
      Effect.gen(function* () {
        if (Option.isNone(orchestration)) {
          return yield* new WorkflowEventStoreError({
            message: "orchestration engine unavailable for steer",
          });
        }
        const now = yield* nowIso;
        yield* orchestration.value
          .dispatch({
            type: "thread.turn.start",
            commandId: `workflow-steer-${input.messageId}` as never,
            threadId: input.threadId,
            message: {
              messageId: input.messageId,
              role: "user",
              text: input.text,
              attachments: [],
            },
            interactionMode: "default",
            createdAt: now as never,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new WorkflowEventStoreError({
                  message: "workflow steer dispatch failed",
                  cause,
                }),
            ),
          );
      });

    return { ensureTurnStarted, steerTurn } satisfies ProviderTurnPortShape;
  }),
);
