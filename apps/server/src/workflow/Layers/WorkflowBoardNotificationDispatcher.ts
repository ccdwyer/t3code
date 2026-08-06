import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayBoardTicketState } from "@t3tools/contracts/relay";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import {
  WorkflowBoardNotificationDispatcher,
  type WorkflowBoardNotificationDispatcherShape,
  type WorkflowBoardNotificationSweepResult,
} from "../Services/WorkflowBoardNotificationDispatcher.ts";
import { WorkflowBoardNotificationRelay } from "../Services/WorkflowBoardNotificationRelay.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { redactSensitiveText, truncateKeepingHead } from "../redactSensitiveText.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 5_000;
const DEFAULT_MAX_PER_SWEEP = 20;
const MAX_ATTEMPTS = 5;
// Push-notification body cap. Push payloads are tiny; 240 chars is a generous
// single-screen preview that still leaves room for the truncation marker.
const MAX_NOTIFICATION_BODY = 240;
const DEFAULT_BODY = "Needs your attention";

// Statuses that mean the ticket still wants a human. Anything else (running,
// idle, done, failed, or a vanished ticket) means it self-resolved before we
// notified — supersede the row so we don't buzz. "parked" covers a ticket
// parked in-place (issue or waiting substate) per the substates spec.
const NEEDS_YOU_STATUSES = new Set(["waiting_on_user", "blocked", "parked"]);

const VALID_ATTENTION_KINDS = new Set<RelayBoardTicketState["attentionKind"]>([
  "waiting_for_approval",
  "waiting_for_input",
  "blocked",
  "parked_issue",
  "parked_waiting",
]);

const SLA_OUTBOX_KIND = "sla_breached";

const normalizeAttentionKind = (raw: string | null): RelayBoardTicketState["attentionKind"] => {
  // Internal SLA outbox kind is not a wire attention kind. Map to a
  // legacy-safe domain value so old clients decode the payload; the body
  // carries the human SLA reason text.
  if (raw === SLA_OUTBOX_KIND) {
    return "waiting_for_input";
  }
  return raw !== null && VALID_ATTENTION_KINDS.has(raw as RelayBoardTicketState["attentionKind"])
    ? (raw as RelayBoardTicketState["attentionKind"])
    : "waiting_for_input";
};

interface OutboxRow {
  readonly outboxId: string;
  readonly ticketId: string;
  readonly boardId: string;
  readonly sequence: number;
  readonly status: string;
  readonly attentionKind: string | null;
  readonly attentionReason: string | null;
  readonly attemptCount: number;
}

export interface WorkflowBoardNotificationDispatcherLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly maxPerSweep?: number;
}

const makeWorkflowBoardNotificationDispatcher = (
  options?: WorkflowBoardNotificationDispatcherLiveOptions,
) =>
  Effect.gen(function* () {
    const relay = yield* WorkflowBoardNotificationRelay;
    const readModel = yield* WorkflowReadModel;
    const serverEnvironment = yield* ServerEnvironment;
    const sql = yield* SqlClient.SqlClient;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const maxPerSweep = Math.max(1, Math.floor(options?.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP));

    const buildBody = (reason: string | null): string => {
      // Keep the START of the reason for a notification preview — the meaningful
      // content (e.g. "Approve deploy to prod?") leads; trailing log noise is
      // what should be dropped on overflow.
      const redacted = truncateKeepingHead(
        redactSensitiveText(reason ?? ""),
        MAX_NOTIFICATION_BODY,
      );
      return redacted.trim().length === 0 ? DEFAULT_BODY : redacted;
    };

    const markState = (outboxId: string, deliveryState: string, attemptCount?: number) =>
      attemptCount === undefined
        ? sql`UPDATE workflow_notification_outbox SET delivery_state = ${deliveryState} WHERE outbox_id = ${outboxId}`
        : sql`UPDATE workflow_notification_outbox SET delivery_state = ${deliveryState}, attempt_count = ${attemptCount} WHERE outbox_id = ${outboxId}`;

    // Atomic claim, run immediately before relay.publishTicket. Flips a
    // 'pending' row to 'publishing' and returns whether THIS call performed
    // the transition. The committer (WorkflowEventCommitter) can concurrently
    // flip the same row to 'superseded' — guarded on `delivery_state IN
    // ('pending', 'publishing')` on its side — when a newer needs-you
    // transition for the same ticket commits between our SELECT and this
    // claim, or even after this claim while the row sits in 'publishing'
    // (see the committer's supersede comment for the gate-1 re-gate
    // residual this closes). Closes the stale-delivery race: without this,
    // the relevance recheck above only looks at the ticket's CURRENT status,
    // which for a re-parked ticket still passes (`parked` is itself a
    // needs-you status) even though the committer already superseded THIS
    // row in favor of a fresh one — the old unconditional publish +
    // unconditional `markState(..., 'sent')` would then both deliver the
    // stale row's content AND clobber the committer's 'superseded' write.
    // Claiming atomically makes the check indivisible from the act: a claim
    // rowcount of 0 means the row left 'pending' before we could act on it,
    // so the row is superseded and must NOT be published.
    const claimRow = (outboxId: string) =>
      sql<{ readonly outboxId: string }>`
        UPDATE workflow_notification_outbox
        SET delivery_state = 'publishing'
        WHERE outbox_id = ${outboxId} AND delivery_state = 'pending'
        RETURNING outbox_id AS "outboxId"
      `.pipe(Effect.map((rows) => rows.length > 0));

    // Conditional re-mark for the retry path. A claimed row sits in
    // 'publishing' for the duration of the publish call, and the committer's
    // supersede guard now ALSO matches 'publishing' (see its comment), so a
    // row can legitimately leave 'publishing' for 'superseded' while we're
    // mid-flight. Guarding this re-mark on `delivery_state = 'publishing'`
    // makes it a no-op once that's happened, preventing a lost-update /
    // resurrection: without this guard, a failed publish on a since-
    // superseded row would flip it back to 'pending' and a later sweep would
    // re-deliver a stale notification even though a fresh row already exists
    // for the ticket. Terminal re-marks ('sent'/'failed') need the identical
    // guard for the same reason — see markSent and the give-up path below.
    const rescheduleRetry = (outboxId: string, attemptCount: number) =>
      sql`UPDATE workflow_notification_outbox SET delivery_state = 'pending', attempt_count = ${attemptCount} WHERE outbox_id = ${outboxId} AND delivery_state = 'publishing'`;

    // CAS give-up mark for the attempt-ceiling path. Same guard reasoning as
    // rescheduleRetry: if the committer superseded this row mid-flight, the
    // give-up write must be a no-op (else it would clobber 'superseded' with
    // 'failed', losing the fact that a fresh row already exists for the
    // ticket).
    const markGivenUp = (outboxId: string, attemptCount: number) =>
      sql`UPDATE workflow_notification_outbox SET delivery_state = 'failed', attempt_count = ${attemptCount} WHERE outbox_id = ${outboxId} AND delivery_state = 'publishing'`;

    // CAS success mark. Returns whether THIS call's write landed. A rowcount
    // of 0 means the committer's supersede beat us to it WHILE our publish
    // call was in flight (the widened 'publishing' guard on its side, see
    // WorkflowEventCommitter.ts) — the row is already 'superseded' and this
    // must not clobber it back to 'sent'. This is the one case where the push
    // already went out over the relay before we could observe the supersede:
    // once relay.publishTicket's call started, nothing server-side can
    // un-send it. That is the documented, unavoidable RTT residual — the push
    // itself is stale, but the bookkeeping stays correct (the row correctly
    // ends 'superseded', not 'sent', so nothing downstream mistakes it for
    // the canonical delivery).
    const markSent = (outboxId: string) =>
      sql<{ readonly outboxId: string }>`
        UPDATE workflow_notification_outbox
        SET delivery_state = 'sent'
        WHERE outbox_id = ${outboxId} AND delivery_state = 'publishing'
        RETURNING outbox_id AS "outboxId"
      `.pipe(Effect.map((rows) => rows.length > 0));

    // Un-claim back to 'superseded' for the pre-publish latest-sequence check
    // below. Guarded on 'publishing' so it only ever affects the row THIS
    // call's claim owns.
    const unclaimSuperseded = (outboxId: string) =>
      sql`UPDATE workflow_notification_outbox SET delivery_state = 'superseded' WHERE outbox_id = ${outboxId} AND delivery_state = 'publishing'`;

    // NEW-4 closure: if anything after a successful claim fails OUTSIDE the
    // publish Result branch above (i.e. reaches the catchCause handler below
    // with the row still 'publishing'), this un-claims it back to 'pending'
    // instead of leaving it stranded until the next sweep's
    // reclaimStalePublishing bulk pass. Guarded on 'publishing' so it is a
    // no-op for failures that happened before a claim (row still 'pending')
    // or after a terminal/superseded resolution already landed. Attempt count
    // is left untouched — the failure reason here is unknown (not a relay
    // failure, which already has its own counted retry path above), so this
    // just makes the row eligible for the very next sweep with the same
    // delayed-retry semantics as rescheduleRetry.
    const unclaimToPending = (outboxId: string) =>
      sql`UPDATE workflow_notification_outbox SET delivery_state = 'pending' WHERE outbox_id = ${outboxId} AND delivery_state = 'publishing'`;

    // Process a single row. Returns the outcome category for the sweep summary.
    // Per-row errors are caught here so one bad row can't abort the sweep.
    const processRow = (
      row: OutboxRow,
      envId: EnvironmentId,
    ): Effect.Effect<"sent" | "superseded" | "failed"> =>
      Effect.gen(function* () {
        const detail = yield* readModel.getTicketDetail(row.ticketId as never);

        // Relevance recheck. Classic needs-you rows revalidate status.
        // SLA rows revalidate the breach token (idle/running tickets stay
        // relevant until lane exit clears the projected breach).
        if (detail === null) {
          yield* markState(row.outboxId, "superseded");
          return "superseded" as const;
        }
        if (row.attentionKind === SLA_OUTBOX_KIND) {
          const token = detail.ticket.currentLaneEntryToken;
          const breachToken = detail.ticket.slaBreachedEntryToken ?? null;
          if (
            token === null ||
            breachToken === null ||
            token !== breachToken ||
            detail.ticket.slaBreachedAt == null
          ) {
            yield* markState(row.outboxId, "superseded");
            return "superseded" as const;
          }
        } else if (!NEEDS_YOU_STATUSES.has(detail.ticket.status)) {
          yield* markState(row.outboxId, "superseded");
          return "superseded" as const;
        }

        // The relay decodes title as TrimmedNonEmptyString; a blank/whitespace
        // ticket title would be rejected → retries → lost notification. Fall
        // back to a non-empty default.
        const safeTitle =
          detail.ticket.title.trim().length > 0
            ? detail.ticket.title
            : "Ticket needs your attention";

        const state: RelayBoardTicketState = {
          environmentId: envId,
          boardId: row.boardId,
          ticketId: row.ticketId,
          attentionKind: normalizeAttentionKind(row.attentionKind),
          title: safeTitle,
          body: buildBody(row.attentionReason),
          // Canonical push deep-link format: `/tickets/{env}/{board}/{ticket}`.
          // This is the ONLY consumer of this field — it flows relay → APNs →
          // mobile (`normalizeTicketDeepLink` in
          // apps/mobile/src/features/agent-awareness/notificationPayload.ts), which
          // rejects query-string forms (`?`/`#`). The web in-app `/{env}/board?...`
          // route is a separate concern and never reads this field. Keep this path
          // shape in sync with mobile's `encodeTicketDeepLink`.
          deepLink: `/tickets/${encodeURIComponent(envId)}/${encodeURIComponent(
            row.boardId,
          )}/${encodeURIComponent(row.ticketId)}`,
          transitionId: String(row.sequence),
        };

        // Atomic claim, immediately before the publish call. If the committer
        // superseded this row between our SELECT and here (see claimRow's
        // doc comment), the claim's rowcount is 0 and we must NOT publish the
        // now-stale `state` built above — the fresh row the committer inserted
        // for the same ticket will be picked up, correctly, on a later sweep.
        const claimed = yield* claimRow(row.outboxId);
        if (!claimed) {
          return "superseded" as const;
        }

        // Pre-publish latest-sequence check (Grok's option 2, gate-1 re-gate
        // NEW-1 closure). Narrows the unavoidable RTT residual: right after
        // claiming and before making the network call, check whether a newer
        // needs-you transition for this ticket has already landed in the
        // outbox. A newer row means the committer's own supersede (widened to
        // also match 'publishing', see WorkflowEventCommitter.ts) either
        // already superseded this row or is about to — either way, publishing
        // this row's content now would be a stale push we can still avoid by
        // simply not making the call. This does NOT close the residual
        // entirely: if the relay call is already in flight by the time a
        // newer row is inserted, this check ran too early to see it — that
        // remaining sliver is caught by the post-publish CAS (markSent)
        // below, and if the publish itself has already gone out over the
        // wire by then, that push is the documented unavoidable RTT residual.
        const latest = yield* sql<{ readonly maxSequence: number | null }>`
          SELECT MAX(sequence) AS "maxSequence"
          FROM workflow_notification_outbox
          WHERE ticket_id = ${row.ticketId}
        `;
        if ((latest[0]?.maxSequence ?? row.sequence) > row.sequence) {
          yield* unclaimSuperseded(row.outboxId);
          return "superseded" as const;
        }

        const published = yield* relay
          .publishTicket({
            environmentId: envId,
            boardId: row.boardId,
            ticketId: row.ticketId,
            state,
          })
          .pipe(Effect.result);

        if (Result.isSuccess(published)) {
          const sent = yield* markSent(row.outboxId);
          // CAS loss here means the committer's widened supersede guard beat
          // us to it while the publish call was in flight — see markSent's
          // doc comment for the residual this represents.
          return sent ? ("sent" as const) : ("superseded" as const);
        }

        const nextAttempt = row.attemptCount + 1;
        if (nextAttempt >= MAX_ATTEMPTS) {
          yield* Effect.logError("workflow.board-notification.give-up", {
            outboxId: row.outboxId,
            ticketId: row.ticketId,
            sequence: row.sequence,
            attemptCount: nextAttempt,
            error: published.failure,
          });
          yield* markGivenUp(row.outboxId, nextAttempt);
          return "failed" as const;
        }
        yield* rescheduleRetry(row.outboxId, nextAttempt);
        return "failed" as const;
      }).pipe(
        Effect.catchCause((cause) =>
          // Re-raise defects (programming bugs) so the sweep-level catchDefect
          // guard surfaces them; only swallow expected/transient failures as a
          // per-row "failed" so one bad row can't abort the whole sweep.
          // Re-dying with the squashed cause keeps the error channel `never`.
          Cause.hasDies(cause) || Cause.hasInterrupts(cause)
            ? Effect.die(Cause.squash(cause))
            : Effect.gen(function* () {
                // Best-effort un-claim: a failure here must not itself abort
                // the sweep or mask the original cause logged below.
                yield* unclaimToPending(row.outboxId).pipe(Effect.catchCause(() => Effect.void));
                yield* Effect.logWarning("workflow.board-notification.row-failed", {
                  outboxId: row.outboxId,
                  ticketId: row.ticketId,
                  cause,
                });
                return "failed" as const;
              }),
        ),
      );

    // Reclaim rows stranded 'publishing' by a crash (after claimRow, before
    // markState('sent'/'failed') or rescheduleRetry landed). Row processing
    // within a sweep is sequential and synchronous (the `for` loop below,
    // one row at a time, no forking) and every path out of processRow
    // resolves a claimed row to a terminal state or back to 'pending' before
    // the sweep's effect returns — so the ONLY way a 'publishing' row can
    // still exist the next time this runs is that the process died (or threw
    // a defect that unwound past the claim) mid-publish for that row. Running
    // this at the top of every sweep (not just at start()) means recovery
    // doesn't wait for a restart: the very next sweep, at most sweepIntervalMs
    // later, un-sticks it. A select/UPDATE failure here is logged and
    // swallowed — it must not block the rest of the sweep.
    // Safe under the single serially-scheduled dispatcher fiber; concurrent
    // dispatcher processes would double-deliver in-flight rows.
    const reclaimStalePublishing = sql`
      UPDATE workflow_notification_outbox
      SET delivery_state = 'pending'
      WHERE delivery_state = 'publishing'
    `.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("workflow.board-notification.reclaim-stale-publishing-failed", {
          cause,
        }),
      ),
    );

    const sweep: WorkflowBoardNotificationDispatcherShape["sweep"] = () =>
      Effect.gen(function* () {
        yield* reclaimStalePublishing;

        const rows = yield* sql<OutboxRow>`
          SELECT
            outbox_id AS "outboxId",
            ticket_id AS "ticketId",
            board_id AS "boardId",
            sequence,
            status,
            attention_kind AS "attentionKind",
            attention_reason AS "attentionReason",
            attempt_count AS "attemptCount"
          FROM workflow_notification_outbox
          WHERE delivery_state = 'pending'
          ORDER BY created_at ASC
          LIMIT ${maxPerSweep}
        `.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("workflow.board-notification.select-failed", {
              cause,
            }).pipe(Effect.as([] as ReadonlyArray<OutboxRow>)),
          ),
        );

        let claimed = 0;
        let sent = 0;
        let superseded = 0;
        let failed = 0;

        if (rows.length === 0) {
          return { claimed, sent, superseded, failed };
        }

        // Resolve the environment id once per sweep.
        const envId = yield* serverEnvironment.getEnvironmentId;

        for (const row of rows) {
          claimed += 1;
          const outcome = yield* processRow(row, envId);
          if (outcome === "sent") sent += 1;
          else if (outcome === "superseded") superseded += 1;
          else if (outcome === "failed") failed += 1;
        }

        if (claimed > 0) {
          yield* Effect.logInfo("workflow.board-notification.sweep-complete", {
            claimed,
            sent,
            superseded,
            failed,
          });
        }

        return {
          claimed,
          sent,
          superseded,
          failed,
        } satisfies WorkflowBoardNotificationSweepResult;
      });

    const start: WorkflowBoardNotificationDispatcherShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep().pipe(
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("workflow.board-notification.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("workflow.board-notification.started", {
          sweepIntervalMs,
        });
      });

    return { sweep, start } satisfies WorkflowBoardNotificationDispatcherShape;
  });

export const makeWorkflowBoardNotificationDispatcherLive = (
  options?: WorkflowBoardNotificationDispatcherLiveOptions,
) =>
  Layer.effect(
    WorkflowBoardNotificationDispatcher,
    makeWorkflowBoardNotificationDispatcher(options),
  );

export const WorkflowBoardNotificationDispatcherLive =
  makeWorkflowBoardNotificationDispatcherLive();
