import {
  TicketAttachment,
  type BoardId,
  type LaneKey,
  type WorkflowEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  WorkflowProjectionPipeline,
  type WorkflowProjectionPipelineShape,
} from "../Services/WorkflowProjectionPipeline.ts";

const toProjectionError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "projection failed", cause });

const encodeOutputJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeTicketAttachmentsJson = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(TicketAttachment)),
);

const encodeStepOutput = (output: unknown) =>
  output === undefined ? Effect.succeed(null) : encodeOutputJson(output);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Shared exit-from-parked reset. Every event that moves/queues/admits a
  // ticket out of a parked state must clear ALL parked_* columns, or a
  // re-parked ticket could read stale parked_event_id/park_origin from a
  // previous park.
  // NOTE: no trailing comma on this fragment — always splice it as the final SET-clause item.
  const PARKED_CLEAR = sql`
    parked_substate = NULL,
    parked_label = NULL,
    parked_reason = NULL,
    parked_at = NULL,
    parked_event_id = NULL,
    park_origin = NULL
  `;

  // Lane-identity changes clear SLA breach columns so a sticky badge cannot
  // survive into the next lane entry (or a WIP queue).
  const SLA_BREACH_CLEAR = sql`
    sla_breached_entry_token = NULL,
    sla_breached_at = NULL,
    sla_breached_reason = NULL
  `;

  const formatSlaBudgetLabel = (budgetMs: number): string => {
    if (budgetMs > 0 && budgetMs % 3_600_000 === 0) {
      const hours = budgetMs / 3_600_000;
      return hours === 1 ? "1 hour" : `${hours} hours`;
    }
    if (budgetMs > 0 && budgetMs % 60_000 === 0) {
      const minutes = budgetMs / 60_000;
      return minutes === 1 ? "1 minute" : `${minutes} minutes`;
    }
    return Duration.format(Duration.millis(budgetMs));
  };

  const getOptionalServices = Effect.context<never>().pipe(
    Effect.map((context) => ({
      registry: Context.getOption(context as Context.Context<BoardRegistry>, BoardRegistry),
    })),
  );

  const isTerminalLane = (boardId: BoardId, laneKey: LaneKey) =>
    Effect.gen(function* () {
      const { registry } = yield* getOptionalServices;
      if (Option.isNone(registry)) {
        return false;
      }
      const lane = yield* registry.value.getLane(boardId, laneKey);
      return lane?.terminal === true;
    });

  const terminalAtForBoardLane = (boardId: BoardId, laneKey: LaneKey, occurredAt: string) =>
    isTerminalLane(boardId, laneKey).pipe(
      Effect.map((isTerminal) => (isTerminal ? occurredAt : null)),
    );

  const terminalAtForTicketLane = (ticketId: string, laneKey: LaneKey, occurredAt: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly boardId: BoardId;
        readonly currentLaneKey: LaneKey;
        readonly terminalAt: string | null;
      }>`
        SELECT
          board_id AS "boardId",
          current_lane_key AS "currentLaneKey",
          terminal_at AS "terminalAt"
        FROM projection_ticket
        WHERE ticket_id = ${ticketId}
      `;
      const row = rows[0];
      if (!row) {
        return null;
      }
      if (!(yield* isTerminalLane(row.boardId, laneKey))) {
        return null;
      }
      return row.currentLaneKey === laneKey && row.terminalAt !== null
        ? row.terminalAt
        : occurredAt;
    });

  const projectEvent: WorkflowProjectionPipelineShape["projectEvent"] = (event: WorkflowEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "TicketCreated": {
          const terminalAt = yield* terminalAtForBoardLane(
            event.payload.boardId,
            event.payload.laneKey,
            event.occurredAt,
          );
          const forkOriginJson =
            event.payload.forkOrigin === undefined
              ? null
              : JSON.stringify(event.payload.forkOrigin);
          const forkRoot =
            event.payload.forkOrigin === undefined ? null : event.payload.forkOrigin.rootTicketId;
          yield* sql`
            INSERT INTO projection_ticket (
              ticket_id,
              board_id,
              title,
              description,
              current_lane_key,
              status,
              terminal_at,
              token_budget,
              fork_origin,
              fork_root_ticket_id,
              created_at,
              updated_at
            )
            VALUES (
              ${event.ticketId},
              ${event.payload.boardId},
              ${event.payload.title},
              ${event.payload.description ?? null},
              ${event.payload.laneKey},
              'idle',
              ${terminalAt},
              ${event.payload.tokenBudget ?? null},
              ${forkOriginJson},
              ${forkRoot},
              ${event.occurredAt},
              ${event.occurredAt}
            )
            ON CONFLICT(ticket_id) DO NOTHING
          `;
          break;
        }
        case "TicketForkSpawned": {
          yield* sql`
            UPDATE projection_ticket
            SET status = 'forked',
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          yield* sql`
            UPDATE projection_step_run
            SET status = 'awaiting_children'
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          break;
        }
        case "TicketForkChildSettled": {
          // Settlement rows are written by ForkJoinCoordinator; event is audit.
          break;
        }
        case "TicketForkResolved": {
          yield* sql`
            UPDATE projection_ticket
            SET status = 'running',
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
              AND status = 'forked'
          `;
          break;
        }
        case "StepRetryScheduled": {
          // Display/audit; ticket-level retry countdown UI is residual.
          break;
        }
        case "TicketMovedToLane": {
          // Any entry into a lane invalidates that lane's pack. A routed batch
          // re-adds a fresh one via the trailing TicketContextPackCompiled, so a
          // manual/external/sla entry provably ends with no stale pack.
          yield* sql`
            DELETE FROM projection_context_pack
            WHERE ticket_id = ${event.ticketId} AND for_lane = ${event.payload.toLane}
          `;
          const terminalAt = yield* terminalAtForTicketLane(
            event.ticketId,
            event.payload.toLane,
            event.occurredAt,
          );
          yield* sql`
            UPDATE projection_ticket
            SET current_lane_key = ${event.payload.toLane},
                status = 'idle',
                attention_kind = NULL,
                attention_reason = NULL,
                current_lane_entry_token = ${event.payload.laneEntryToken},
                current_lane_entered_at = ${event.occurredAt},
                current_step_label = NULL,
                queued_at = NULL,
                terminal_at = ${terminalAt},
                updated_at = ${event.occurredAt},
                ${SLA_BREACH_CLEAR},
                ${PARKED_CLEAR}
            WHERE ticket_id = ${event.ticketId}
          `;
          yield* sql`
            UPDATE projection_step_run
            SET status = 'superseded',
                waiting_reason = NULL,
                provider_response_kind = NULL,
                finished_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
              AND status IN ('pending', 'dispatch_requested', 'running', 'awaiting_user', 'awaiting_children')
          `;
          yield* sql`
            UPDATE projection_pipeline_run
            SET status = 'superseded',
                finished_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
              AND status = 'running'
          `;
          break;
        }
        case "TicketEdited": {
          const hasTitle = Object.prototype.hasOwnProperty.call(event.payload, "title");
          const hasDescription = Object.prototype.hasOwnProperty.call(event.payload, "description");
          const hasTokenBudget = Object.prototype.hasOwnProperty.call(event.payload, "tokenBudget");
          yield* sql`
            UPDATE projection_ticket
            SET title = CASE
                  WHEN ${hasTitle ? 1 : 0} = 1 THEN ${event.payload.title ?? ""}
                  ELSE title
                END,
                description = CASE
                  WHEN ${hasDescription ? 1 : 0} = 1 THEN ${event.payload.description ?? ""}
                  ELSE description
                END,
                token_budget = CASE
                  WHEN ${hasTokenBudget ? 1 : 0} = 1 THEN ${event.payload.tokenBudget ?? null}
                  ELSE token_budget
                END,
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "TicketDependenciesSet": {
          yield* sql`
            DELETE FROM projection_ticket_dependency
            WHERE ticket_id = ${event.ticketId}
          `;
          yield* Effect.forEach(
            event.payload.dependsOn,
            (dependsOn) => sql`
              INSERT INTO projection_ticket_dependency (ticket_id, depends_on_ticket_id)
              VALUES (${event.ticketId}, ${dependsOn})
              ON CONFLICT DO NOTHING
            `,
            { discard: true },
          );
          break;
        }
        case "TicketMessagePosted": {
          const attachmentsJson = yield* encodeTicketAttachmentsJson(event.payload.attachments);
          yield* sql`
            INSERT INTO projection_ticket_message (
              message_id,
              ticket_id,
              step_run_id,
              author,
              body,
              attachments_json,
              created_at
            )
            VALUES (
              ${event.payload.messageId},
              ${event.ticketId},
              ${event.payload.stepRunId ?? null},
              ${event.payload.author},
              ${event.payload.body},
              ${attachmentsJson},
              ${event.payload.createdAt}
            )
            ON CONFLICT(message_id) DO UPDATE SET
              ticket_id = excluded.ticket_id,
              step_run_id = excluded.step_run_id,
              author = excluded.author,
              body = excluded.body,
              attachments_json = excluded.attachments_json,
              created_at = excluded.created_at
          `;
          break;
        }
        case "TicketMessageEdited": {
          yield* sql`
            UPDATE projection_ticket_message
            SET body = ${event.payload.body}, edited_at = ${event.payload.editedAt}
            WHERE message_id = ${event.payload.messageId}
          `;
          break;
        }
        case "TicketContextPackCompiled": {
          yield* sql`
            INSERT INTO projection_context_pack (
              ticket_id, for_lane, from_lane, compiled_at, edited_at, sections_json
            )
            VALUES (
              ${event.ticketId},
              ${event.payload.forLane},
              ${event.payload.fromLane},
              ${event.occurredAt},
              NULL,
              ${JSON.stringify(event.payload.sections)}
            )
            ON CONFLICT (ticket_id, for_lane) DO UPDATE SET
              from_lane = excluded.from_lane,
              compiled_at = excluded.compiled_at,
              edited_at = NULL,
              sections_json = excluded.sections_json
          `;
          break;
        }
        case "TicketContextPackEdited": {
          if (event.payload.sections.length === 0) {
            // Empty full set is the deletion gesture.
            yield* sql`
              DELETE FROM projection_context_pack
              WHERE ticket_id = ${event.ticketId} AND for_lane = ${event.payload.forLane}
            `;
            break;
          }
          // Defensive no-op when no pack row exists: a blind upsert would have to
          // invent from_lane/compiled_at (both NOT NULL) and would fail the whole
          // projection on an out-of-band stream. from_lane/compiled_at are preserved.
          yield* sql`
            UPDATE projection_context_pack
            SET sections_json = ${JSON.stringify(event.payload.sections)},
                edited_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId} AND for_lane = ${event.payload.forLane}
          `;
          break;
        }
        case "TicketQueued": {
          // Same clear-on-entry rule as TicketMovedToLane; note the payload key
          // here is `lane`, not `toLane`.
          yield* sql`
            DELETE FROM projection_context_pack
            WHERE ticket_id = ${event.ticketId} AND for_lane = ${event.payload.lane}
          `;
          yield* sql`
            UPDATE projection_ticket
            SET current_lane_key = ${event.payload.lane},
                status = 'queued',
                attention_kind = NULL,
                attention_reason = NULL,
                current_lane_entry_token = NULL,
                current_step_label = NULL,
                queued_at = ${event.occurredAt},
                terminal_at = NULL,
                updated_at = ${event.occurredAt},
                ${SLA_BREACH_CLEAR},
                ${PARKED_CLEAR}
            WHERE ticket_id = ${event.ticketId}
          `;
          yield* sql`
            UPDATE projection_step_run
            SET status = 'superseded',
                waiting_reason = NULL,
                provider_response_kind = NULL,
                finished_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
              AND status IN ('pending', 'dispatch_requested', 'running', 'awaiting_user', 'awaiting_children')
          `;
          yield* sql`
            UPDATE projection_pipeline_run
            SET status = 'superseded',
                finished_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
              AND status = 'running'
          `;
          break;
        }
        case "TicketAdmitted": {
          // Deliberately does NOT clear the context pack. Admission promotes a
          // ticket that is ALREADY in this lane (queued -> idle); the pack was
          // compiled for it at route time and must survive the WIP wait, which is
          // the whole point of it being editable while queued. Only a genuine lane
          // ENTRY (TicketMovedToLane / TicketQueued) invalidates a pack.
          const terminalAt = yield* terminalAtForTicketLane(
            event.ticketId,
            event.payload.lane,
            event.occurredAt,
          );
          yield* sql`
            UPDATE projection_ticket
            SET current_lane_key = ${event.payload.lane},
                status = 'idle',
                attention_kind = NULL,
                attention_reason = NULL,
                current_lane_entry_token = ${event.payload.laneEntryToken},
                current_lane_entered_at = ${event.occurredAt},
                queued_at = NULL,
                terminal_at = ${terminalAt},
                updated_at = ${event.occurredAt},
                ${SLA_BREACH_CLEAR},
                ${PARKED_CLEAR}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "TicketRouted": {
          const terminalAt = yield* terminalAtForTicketLane(
            event.ticketId,
            event.payload.toLane,
            event.occurredAt,
          );
          yield* sql`
            UPDATE projection_ticket
            SET current_lane_key = ${event.payload.toLane},
                terminal_at = ${terminalAt},
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "TicketBlocked": {
          // Invariant: a parked row is exited only by move/queue/admit (which
          // carry PARKED_CLEAR) or unpark — never by a status write from a stale
          // fiber. Refuse to overwrite `parked` here so a late TicketBlocked from
          // a superseded pipeline cannot orphan the parked_* columns.
          yield* sql`
            UPDATE projection_ticket
            SET status = 'blocked',
                attention_kind = 'blocked',
                attention_reason = ${event.payload.reason},
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
              AND status != 'parked'
          `;
          break;
        }
        case "PipelineStarted": {
          yield* sql`
            INSERT INTO projection_pipeline_run (
              pipeline_run_id,
              ticket_id,
              lane_key,
              lane_entry_token,
              status,
              started_at
            )
            VALUES (
              ${event.payload.pipelineRunId},
              ${event.ticketId},
              ${event.payload.laneKey},
              ${event.payload.laneEntryToken},
              'running',
              ${event.occurredAt}
            )
            ON CONFLICT(pipeline_run_id) DO NOTHING
          `;
          // Invariant: a parked row is exited only by move/queue/admit (which
          // carry PARKED_CLEAR) or unpark. A PipelineStarted from a stale fiber
          // (or replayed while the row is parked) must not flip `parked` back to
          // `running` and orphan the parked_* columns.
          yield* sql`
            UPDATE projection_ticket
            SET status = 'running',
                attention_kind = NULL,
                attention_reason = NULL,
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
              AND status != 'parked'
          `;
          break;
        }
        case "PipelineCompleted": {
          yield* sql`
            UPDATE projection_pipeline_run
            SET status = ${event.payload.result},
                finished_at = ${event.occurredAt}
            WHERE pipeline_run_id = ${event.payload.pipelineRunId}
          `;
          yield* sql`
            UPDATE projection_ticket
            SET current_step_label = NULL
            WHERE ticket_id = ${event.ticketId}
          `;
          if (event.payload.result === "superseded") {
            yield* sql`
              UPDATE projection_step_run
              SET status = 'superseded',
                  waiting_reason = NULL,
                  provider_response_kind = NULL,
                  finished_at = ${event.occurredAt}
              WHERE pipeline_run_id = ${event.payload.pipelineRunId}
                AND status IN ('pending', 'dispatch_requested', 'running', 'awaiting_user', 'awaiting_children')
            `;
          }
          break;
        }
        case "StepStarted": {
          yield* sql`
            INSERT INTO projection_step_run (
              step_run_id,
              pipeline_run_id,
              ticket_id,
              step_key,
              step_type,
              attempt,
              status,
              started_at
            )
            VALUES (
              ${event.payload.stepRunId},
              ${event.payload.pipelineRunId},
              ${event.ticketId},
              ${event.payload.stepKey},
              ${event.payload.stepType},
              ${event.payload.attempt ?? 1},
              'running',
              ${event.occurredAt}
            )
            ON CONFLICT(step_run_id) DO NOTHING
          `;
          yield* sql`
            UPDATE projection_ticket
            SET current_step_label = ${event.payload.stepKey}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "StepAwaitingUser": {
          yield* sql`
            UPDATE projection_step_run
            SET status = 'awaiting_user',
                waiting_reason = ${event.payload.waitingReason},
                provider_response_kind = ${event.payload.providerResponseKind ?? null}
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          // Invariant: a parked row is exited only by move/queue/admit (which
          // carry PARKED_CLEAR) or unpark. Park and an open agent wait cannot
          // coexist, so a StepAwaitingUser landing on a parked row is a stale
          // fiber — refuse the ticket-status write (the step-row update above
          // still proceeds) so it cannot orphan the parked_* columns.
          yield* sql`
            UPDATE projection_ticket
            SET status = 'waiting_on_user',
                attention_kind = ${event.payload.providerResponseKind === "request" ? "waiting_for_approval" : "waiting_for_input"},
                attention_reason = ${event.payload.waitingReason},
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
              AND status != 'parked'
          `;
          break;
        }
        case "StepUserResolved": {
          yield* sql`
            UPDATE projection_step_run
            SET status = 'running',
                waiting_reason = NULL,
                provider_response_kind = NULL
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          // Invariant: a parked row is exited only by move/queue/admit (which
          // carry PARKED_CLEAR) or unpark. A StepUserResolved from a stale
          // fiber must not flip `parked` back to `running` and orphan the
          // parked_* columns (the step-row update above still proceeds).
          yield* sql`
            UPDATE projection_ticket
            SET status = 'running',
                attention_kind = NULL,
                attention_reason = NULL,
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
              AND status != 'parked'
          `;
          break;
        }
        case "StepRefsCaptured": {
          yield* sql`
            UPDATE projection_step_run
            SET pre_checkpoint_ref = ${event.payload.preRef},
                post_checkpoint_ref = ${event.payload.postRef}
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          break;
        }
        case "StepCompleted": {
          const outputJson = yield* encodeStepOutput(event.payload.output);
          const usage = event.payload.usage;
          yield* sql`
            UPDATE projection_step_run
            SET status = 'completed',
                waiting_reason = NULL,
                provider_response_kind = NULL,
                output_json = ${outputJson},
                input_tokens = ${usage?.inputTokens ?? null},
                cached_input_tokens = ${usage?.cachedInputTokens ?? null},
                output_tokens = ${usage?.outputTokens ?? null},
                total_tokens = ${usage?.totalTokens ?? null},
                finished_at = ${event.occurredAt},
                output_validation_errors_json = NULL,
                output_validation_phase = NULL,
                output_repaired = ${event.payload.outputRepaired === true ? 1 : 0}
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          break;
        }
        case "StepOutputInvalid": {
          const errorsJson = JSON.stringify(event.payload.errors);
          yield* sql`
            UPDATE projection_step_run
            SET output_validation_errors_json = ${errorsJson},
                output_validation_phase = ${event.payload.phase}
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          break;
        }
        case "StepFailed": {
          const usage = event.payload.usage;
          yield* sql`
            UPDATE projection_step_run
            SET status = 'failed',
                waiting_reason = NULL,
                provider_response_kind = NULL,
                error = ${event.payload.error},
                retryable = ${event.payload.retryable === undefined ? null : event.payload.retryable ? 1 : 0},
                input_tokens = ${usage?.inputTokens ?? null},
                cached_input_tokens = ${usage?.cachedInputTokens ?? null},
                output_tokens = ${usage?.outputTokens ?? null},
                total_tokens = ${usage?.totalTokens ?? null},
                finished_at = ${event.occurredAt}
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          // Contract violations keep the error list for the drawer; others clear.
          if (event.payload.contractViolation !== true) {
            yield* sql`
              UPDATE projection_step_run
              SET output_validation_errors_json = NULL,
                  output_validation_phase = NULL
              WHERE step_run_id = ${event.payload.stepRunId}
            `;
          }
          break;
        }
        case "StepBlocked": {
          yield* sql`
            UPDATE projection_step_run
            SET status = 'blocked',
                waiting_reason = NULL,
                provider_response_kind = NULL,
                error = ${event.payload.reason},
                finished_at = ${event.occurredAt}
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          break;
        }
        case "ScriptStepStarted": {
          yield* sql`
            INSERT INTO workflow_script_run (
              script_run_id,
              step_run_id,
              ticket_id,
              script_thread_id,
              terminal_id,
              status,
              started_at
            )
            VALUES (
              ${event.payload.scriptRunId},
              ${event.payload.stepRunId},
              ${event.ticketId},
              ${event.payload.scriptThreadId},
              ${event.payload.terminalId},
              'running',
              ${event.occurredAt}
            )
            ON CONFLICT(script_run_id) DO UPDATE SET
              step_run_id = excluded.step_run_id,
              ticket_id = excluded.ticket_id,
              script_thread_id = excluded.script_thread_id,
              terminal_id = excluded.terminal_id,
              status = 'running',
              exit_code = NULL,
              signal = NULL,
              started_at = excluded.started_at,
              finished_at = NULL
          `;
          break;
        }
        case "ScriptStepExited": {
          yield* sql`
            UPDATE workflow_script_run
            SET status = ${event.payload.outcome},
                exit_code = ${event.payload.exitCode},
                signal = ${event.payload.signal},
                finished_at = ${event.occurredAt}
            WHERE script_run_id = ${event.payload.scriptRunId}
          `;
          break;
        }
        case "TicketPrOpened": {
          yield* sql`
            INSERT INTO workflow_pr_state (
              ticket_id,
              pr_number,
              pr_url,
              branch,
              remote_name,
              repo,
              pr_state,
              updated_at
            )
            VALUES (
              ${event.ticketId},
              ${event.payload.prNumber},
              ${event.payload.url},
              ${event.payload.branch},
              ${event.payload.remoteName},
              ${event.payload.repo},
              'open',
              ${event.occurredAt}
            )
            ON CONFLICT(ticket_id) DO UPDATE SET
              pr_number = excluded.pr_number,
              pr_url = excluded.pr_url,
              branch = excluded.branch,
              remote_name = excluded.remote_name,
              repo = excluded.repo,
              pr_state = 'open',
              updated_at = excluded.updated_at
          `;
          break;
        }
        case "TicketRouteDecided": {
          // History-only decision record for automatic (non-park) route moves;
          // route-history readers (listTicketRouteDecisions et al.) read it
          // directly from the event log, so no projection is needed here.
          break;
        }
        case "TicketParked": {
          yield* sql`
            UPDATE projection_ticket
            SET status = 'parked',
                parked_substate = ${event.payload.substate},
                parked_label = ${event.payload.label},
                parked_reason = ${event.payload.reason},
                parked_at = ${event.occurredAt},
                parked_event_id = ${event.eventId},
                park_origin = ${event.payload.parkOrigin},
                attention_kind = ${event.payload.substate === "issue" ? "parked_issue" : "parked_waiting"},
                attention_reason = ${event.payload.reason},
                current_lane_entry_token = NULL,
                current_step_label = NULL,
                queued_at = NULL,
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "TicketExternalEventSkipped": {
          // History-only event: an onEvent routing attempt against a parked
          // ticket is recorded but intentionally projects no ticket-state
          // change (parked-while-suspended invariant).
          break;
        }
        case "StepSteered": {
          yield* sql`
            INSERT OR IGNORE INTO projection_ticket_message (
              message_id,
              ticket_id,
              step_run_id,
              author,
              body,
              attachments_json,
              created_at,
              kind
            )
            VALUES (
              ${event.payload.messageId},
              ${event.ticketId},
              ${event.payload.stepRunId},
              'user',
              ${event.payload.text},
              '[]',
              ${event.occurredAt},
              'steering'
            )
          `;
          yield* sql`
            UPDATE projection_step_run
            SET steer_count = COALESCE(steer_count, 0) + 1,
                last_steered_at = ${event.occurredAt}
            WHERE step_run_id = ${event.payload.stepRunId}
          `;
          yield* sql`
            UPDATE projection_ticket
            SET updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
          `;
          break;
        }
        case "TicketSlaBreached": {
          // Resolve a human lane label for the reason string. Fall back to the
          // lane key when the registry is unavailable (early startup / tests).
          const { registry } = yield* getOptionalServices;
          let laneLabel: string = event.payload.laneKey as string;
          if (Option.isSome(registry)) {
            const boardRows = yield* sql<{ readonly boardId: string }>`
              SELECT board_id AS "boardId"
              FROM projection_ticket
              WHERE ticket_id = ${event.ticketId}
            `;
            const boardId = boardRows[0]?.boardId;
            if (boardId !== undefined) {
              const lane = yield* registry.value.getLane(boardId as BoardId, event.payload.laneKey);
              if (lane?.name) {
                laneLabel = lane.name;
              }
            }
          }
          const reason = `SLA breached: over ${formatSlaBudgetLabel(event.payload.budgetMs)} in ${laneLabel}`;
          // Guard on current entry token so a late/stale breach event cannot
          // stamp breach columns onto a ticket that already left the lane.
          yield* sql`
            UPDATE projection_ticket
            SET sla_breached_entry_token = ${event.payload.laneEntryToken},
                sla_breached_at = ${event.occurredAt},
                sla_breached_reason = ${reason},
                updated_at = ${event.occurredAt}
            WHERE ticket_id = ${event.ticketId}
              AND current_lane_entry_token = ${event.payload.laneEntryToken}
              AND current_lane_key = ${event.payload.laneKey}
          `;
          break;
        }
        default: {
          event satisfies never;
          break;
        }
      }
    }).pipe(Effect.mapError(toProjectionError), Effect.asVoid);

  return { projectEvent } satisfies WorkflowProjectionPipelineShape;
});

export const WorkflowProjectionPipelineLive = Layer.effect(WorkflowProjectionPipeline, make);
