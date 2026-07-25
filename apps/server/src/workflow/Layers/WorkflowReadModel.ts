import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  AgentSelection,
  TicketAttachment,
  WorkflowDefinition,
  WorkflowProposalValidation,
  type WorkflowBoardMetrics,
  type WorkflowBoardProposalView,
  type WorkflowDefinitionEncoded,
} from "@t3tools/contracts";

import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { TurnStateReader } from "../Services/TurnStateReader.ts";
import { parseParkOrigin, type ParkOriginSource } from "../parkOrigin.ts";
import {
  WorkflowReadModel,
  type BoardListRow,
  type BoardRow,
  type PipelineStepRunRow,
  type StepRunRow,
  type RouteDecisionStepSnapshot,
  type TicketMessageRow,
  type TicketRouteDecisionRow,
  type TicketPrStateRow,
  type TicketPrView,
  type TicketRow,
  type WorkflowCurrentLaneRow,
  type WorkflowLaneActionRow,
  type WorkflowNeedsAttentionTicketRow,
  type WorkflowReadModelShape,
  type WorkSourceMappingRow,
} from "../Services/WorkflowReadModel.ts";

const toReadModelError = (cause: unknown) =>
  new WorkflowEventStoreError({ message: "read failed", cause });

// Nearest-rank percentile over an ascending-sorted array. `p` is 0..100.
// Empty input → 0 so cycle-time metrics never produce NaN on an empty board.
export const percentileNearestRank = (sortedAscMs: ReadonlyArray<number>, p: number): number => {
  const n = sortedAscMs.length;
  if (n === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * n) - 1;
  const index = Math.min(n - 1, Math.max(0, rank));
  return sortedAscMs[index] ?? 0;
};

// Cycle-time windows the metrics dashboard exposes. windowDays is clamped to
// one of these defensively (default 7) so a malformed RPC arg cannot widen the
// scan unboundedly.
const ALLOWED_WINDOW_DAYS = new Set([1, 7, 30]);
const clampWindowDays = (windowDays: number): number =>
  ALLOWED_WINDOW_DAYS.has(windowDays) ? windowDays : 7;

const METRICS_OLDEST_CAP = 5;

const wrap = <A>(effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toReadModelError));

interface StepRunSqlRow extends Omit<StepRunRow, "output"> {
  readonly outputJson: string | null;
}

interface PipelineStepRunSqlRow extends Omit<PipelineStepRunRow, "output"> {
  readonly outputJson: string | null;
}

interface TicketMessageSqlRow extends Omit<TicketMessageRow, "attachments"> {
  readonly attachmentsJson: string;
}

// ─── Board proposal JSON codecs (module-level — safe outside Effect generators)

const decodeProposalValidationJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WorkflowProposalValidation),
);
const decodeProposalAgentJson = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentSelection));
const decodeProposalDefinitionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WorkflowDefinition),
);
const encodeProposalDefinition = Schema.encodeSync(WorkflowDefinition);
// Used to parse `TicketParked` event payloads for the routeOutcomes fold in
// getBoardMetrics — the shape is opaque (asRecord-checked field by field
// below), so UnknownFromJsonString (not a specific schema) is the right tool.
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

interface ProposalSqlRow {
  readonly proposalId: string;
  readonly boardId: string;
  readonly status: string;
  readonly rationale: string;
  readonly validationJson: string;
  readonly agentJson: string;
  readonly baseVersionHash: string;
  readonly appliedVersionHash: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

interface ProposalFullSqlRow extends ProposalSqlRow {
  readonly proposedDefJson: string;
  readonly baseDefJson: string;
}

// ─── End board proposal codec block ──────────────────────────────────────────

const decodeOutputJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeTicketAttachmentsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(TicketAttachment)),
);

const parseStepOutput = (outputJson: string | null) =>
  outputJson === null
    ? Effect.succeed(null)
    : decodeOutputJson(outputJson).pipe(Effect.mapError(toReadModelError));

const toStepRunRow = (row: StepRunSqlRow) =>
  Effect.gen(function* () {
    const { outputJson, ...step } = row;
    const output = yield* parseStepOutput(outputJson);
    return { ...step, output } satisfies StepRunRow;
  });

const toPipelineStepRunRow = (row: PipelineStepRunSqlRow) =>
  Effect.gen(function* () {
    const { outputJson, ...step } = row;
    const output = yield* parseStepOutput(outputJson);
    return { ...step, output } satisfies PipelineStepRunRow;
  });

const toTicketMessageRow = (row: TicketMessageSqlRow) =>
  decodeTicketAttachmentsJson(row.attachmentsJson).pipe(
    Effect.mapError(toReadModelError),
    Effect.map((attachments) => {
      const { attachmentsJson: _attachmentsJson, ...message } = row;
      return { ...message, attachments } satisfies TicketMessageRow;
    }),
  );

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const ROUTE_SOURCES = [
  "step_on",
  "lane_transition",
  "lane_on",
  "external_event",
  "work_source",
] as const;
const PIPELINE_RESULTS = ["success", "failure", "blocked"] as const;
const WORKFLOW_PARK_SUBSTATES = ["issue", "waiting"] as const;

// A park's `parkOrigin` records which routing site produced it, using the
// same vocabulary the engine already resolves actions by (see
// parkOrigin.ts). Route history reuses the SAME `source` literals a
// TicketRouteDecided row would carry for that site, so a park row reads
// like any other history entry rather than inventing a parallel taxonomy.
const PARK_ORIGIN_SOURCE_BY_SRC: Record<ParkOriginSource, (typeof ROUTE_SOURCES)[number]> = {
  lane_on: "lane_on",
  step: "step_on",
  transition: "lane_transition",
  event: "external_event",
};

// Route history is for explaining recent movement, not replaying a ticket's
// whole life — bound the event scan so detail polling stays cheap.
const ROUTE_DECISION_EVENT_CAP = 100;

// Snapshots can embed arbitrarily large captured outputs; route history only
// ever shows the verdict, so lift that one bounded string and drop the rest.
const ROUTE_VERDICT_MAX_LENGTH = 200;

const liftVerdict = (output: unknown): string | null => {
  const record = asRecord(output);
  const verdict = record?.["verdict"];
  return typeof verdict === "string" ? verdict.slice(0, ROUTE_VERDICT_MAX_LENGTH) : null;
};

const snapshotSteps = (
  value: unknown,
): Readonly<Record<string, RouteDecisionStepSnapshot>> | null => {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const steps: Record<string, RouteDecisionStepSnapshot> = {};
  for (const [stepKey, raw] of Object.entries(record)) {
    const step = asRecord(raw);
    if (step === null || typeof step["status"] !== "string") {
      continue;
    }
    steps[stepKey] = {
      status: step["status"],
      exitCode: typeof step["exitCode"] === "number" ? step["exitCode"] : null,
      verdict: liftVerdict(step["output"]),
    };
  }
  return Object.keys(steps).length > 0 ? steps : null;
};

// Renders a `TicketParked` event as a route-history row. The ticket never
// left its lane, so `fromLane`/`toLane` are both null (the contract's park
// variant is `toLane`-less). `substate`/`label`/`reason` come straight off
// the event payload — independent of `parkOrigin` — so a malformed or
// unparseable origin never hides them, only the `source` detail they'd
// otherwise carry.
const toParkRouteDecisionRow = (
  occurredAt: string,
  record: Record<string, unknown>,
): TicketRouteDecisionRow | null => {
  const substate = WORKFLOW_PARK_SUBSTATES.find((candidate) => candidate === record["substate"]);
  if (
    substate === undefined ||
    typeof record["label"] !== "string" ||
    typeof record["reason"] !== "string"
  ) {
    return null;
  }
  const originJson = typeof record["parkOrigin"] === "string" ? record["parkOrigin"] : null;
  const origin = originJson === null ? null : parseParkOrigin(originJson);
  // Malformed/unparseable origin: still render substate/label/reason, just
  // without the origin-derived `source` detail (falls back to "manual").
  const source = origin === null ? "manual" : PARK_ORIGIN_SOURCE_BY_SRC[origin.src];
  return {
    occurredAt,
    fromLane: null,
    toLane: null,
    source,
    matchedTransitionIndex: null,
    eventName: null,
    pipelineResult: null,
    laneRunCount: null,
    steps: null,
    park: { substate, label: record["label"], reason: record["reason"] },
    sla: null,
  };
};

/**
 * Map a routing event to a history row. The contextSnapshot is stored as
 * opaque JSON, so highlights are lifted defensively — a missing or malformed
 * snapshot degrades to just the lane movement. Returns null for events that
 * are not history entries (routed TicketMovedToLane rows duplicate their
 * TicketRouteDecided twin; initial placement is not a decision).
 */
const toRouteDecisionRow = (
  eventType: string,
  occurredAt: string,
  payload: unknown,
): TicketRouteDecisionRow | null => {
  const record = asRecord(payload);
  if (record === null) {
    return null;
  }
  if (eventType === "TicketParked") {
    return toParkRouteDecisionRow(occurredAt, record);
  }
  if (eventType === "TicketSlaBreached") {
    const budgetMs = record["budgetMs"];
    if (typeof budgetMs !== "number" || !Number.isFinite(budgetMs)) {
      return null;
    }
    const laneKey = typeof record["laneKey"] === "string" ? record["laneKey"] : null;
    const escalatedTo = typeof record["escalatedTo"] === "string" ? record["escalatedTo"] : null;
    return {
      occurredAt,
      fromLane: laneKey,
      toLane: escalatedTo,
      source: "sla",
      matchedTransitionIndex: null,
      eventName: null,
      pipelineResult: null,
      laneRunCount: null,
      steps: null,
      park: null,
      sla: { budgetMs, escalatedTo },
    };
  }
  if (typeof record["toLane"] !== "string") {
    return null;
  }
  if (eventType === "TicketMovedToLane") {
    // routed/external/sla moves duplicate their decision twin (RouteDecided or
    // TicketSlaBreached). Only bare manual moves become history rows.
    return record["reason"] === "manual"
      ? {
          occurredAt,
          fromLane: null,
          toLane: record["toLane"],
          source: "manual",
          matchedTransitionIndex: null,
          eventName: null,
          pipelineResult: null,
          laneRunCount: null,
          steps: null,
          park: null,
          sla: null,
        }
      : null;
  }
  const source = ROUTE_SOURCES.find((candidate) => candidate === record["source"]);
  if (source === undefined) {
    return null;
  }
  const snapshot = asRecord(record["contextSnapshot"]);
  const pipeline = asRecord(snapshot?.["pipeline"]);
  const lane = asRecord(snapshot?.["lane"]);
  const runCount = lane?.["runCount"];
  const eventRecord = asRecord(snapshot?.["event"]);
  const eventName = typeof eventRecord?.["name"] === "string" ? eventRecord["name"] : null;
  return {
    occurredAt,
    fromLane: typeof record["fromLane"] === "string" ? record["fromLane"] : null,
    toLane: record["toLane"],
    source,
    matchedTransitionIndex:
      typeof record["matchedTransitionIndex"] === "number"
        ? record["matchedTransitionIndex"]
        : null,
    eventName,
    pipelineResult:
      PIPELINE_RESULTS.find((candidate) => candidate === pipeline?.["result"]) ?? null,
    laneRunCount: typeof runCount === "number" && Number.isInteger(runCount) ? runCount : null,
    steps: snapshotSteps(snapshot?.["steps"]),
    park: null,
    sla: null,
  };
};

const PR_STATES = ["open", "merged", "closed"] as const;
const CI_STATES = ["pending", "success", "failure"] as const;

const toPrView = (
  prNumber: number | null,
  prUrl: string | null,
  prState: string | null,
  lastCiState: string | null,
): TicketPrView | undefined => {
  if (prNumber === null || prUrl === null || prState === null) {
    return undefined;
  }
  const state = PR_STATES.find((s) => s === prState);
  if (state === undefined) {
    return undefined;
  }
  const ciState = CI_STATES.find((s) => s === lastCiState);
  const view: TicketPrView = { number: prNumber, url: prUrl, state };
  if (ciState !== undefined) {
    return { ...view, ciState };
  }
  return view;
};

interface TicketDependencySqlRow extends TicketRow {
  readonly dependsOnJson?: string | null;
  // PR columns from the workflow_pr_state LEFT JOIN — null when no row exists.
  readonly prNumber?: number | null;
  readonly prUrl?: string | null;
  readonly prState?: string | null;
  readonly prCiState?: string | null;
  // Work-source columns from the work_source_mapping LEFT JOIN — null when no mapping row exists.
  readonly sourceMetadataJson?: string | null;
}

// pr_state is NOT NULL DEFAULT 'open' and only our code writes it, so an
// unrecognized value is an invariant violation — surface it once per query
// instead of silently dropping the pr view without a trace.
const warnUnrecognizedPrStates = (rows: ReadonlyArray<TicketDependencySqlRow>) => {
  const ticketIds = rows
    .filter(
      (row) => typeof row.prState === "string" && !PR_STATES.some((state) => state === row.prState),
    )
    .map((row) => row.ticketId);
  return ticketIds.length === 0
    ? Effect.void
    : Effect.logWarning("workflow ticket pr_state unrecognized", { ticketIds });
};

function withDependencyFields(row: TicketDependencySqlRow): TicketRow;
function withDependencyFields(row: TicketDependencySqlRow | null): TicketRow | null;
function withDependencyFields(row: TicketDependencySqlRow | null): TicketRow | null {
  if (row === null) {
    return null;
  }
  const {
    dependsOnJson,
    prNumber,
    prUrl,
    prState,
    prCiState,
    sourceMetadataJson: _sm,
    ...ticket
  } = row;
  let dependsOn: ReadonlyArray<string> = [];
  if (typeof dependsOnJson === "string" && dependsOnJson.length > 0) {
    try {
      const parsed: unknown = JSON.parse(dependsOnJson);
      if (Array.isArray(parsed)) {
        dependsOn = parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      // Malformed aggregate degrades to "no dependencies" rather than failing
      // the whole board read.
    }
  }
  const pr = toPrView(prNumber ?? null, prUrl ?? null, prState ?? null, prCiState ?? null);
  return {
    ...ticket,
    dependsOn,
    unresolvedDependencyCount: ticket.unresolvedDependencyCount ?? 0,
    ...(pr !== undefined ? { pr } : {}),
  };
}

/**
 * Parse `source_metadata_json` from a `work_source_mapping` row into the
 * `syncedSource` shape expected by `TicketDetail` / `WorkflowTicketDetailView`.
 *
 * Returns `undefined` when:
 *  - the column is null/undefined (no mapping row)
 *  - JSON is malformed
 *  - the parsed object lacks the required `provider` or `url` fields
 */
function parseSyncedSource(raw: string | null | undefined):
  | {
      provider: "github" | "asana" | "jira";
      url: string;
      assignees?: ReadonlyArray<string>;
      labels?: ReadonlyArray<string>;
    }
  | undefined {
  if (raw == null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const obj = parsed as Record<string, unknown>;
    const provider = obj["provider"];
    const url = obj["url"];
    if (
      (provider !== "github" && provider !== "asana" && provider !== "jira") ||
      typeof url !== "string" ||
      url === ""
    )
      return undefined;
    const result: {
      provider: "github" | "asana" | "jira";
      url: string;
      assignees?: ReadonlyArray<string>;
      labels?: ReadonlyArray<string>;
    } = { provider, url };
    if (Array.isArray(obj["assignees"])) {
      result.assignees = obj["assignees"].filter((v): v is string => typeof v === "string");
    }
    if (Array.isArray(obj["labels"])) {
      result.labels = obj["labels"].filter((v): v is string => typeof v === "string");
    }
    return result;
  } catch {
    return undefined;
  }
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const boardRegistry = yield* BoardRegistry;

  // Resolve the ticket's current lane (name + human actions) from the board
  // definition. A board with no registered definition (e.g. a stale or
  // unregistered board) degrades to a key-only lane with no actions rather
  // than failing the detail read.
  const resolveCurrentLane = (
    boardId: string,
    currentLaneKey: string,
  ): Effect.Effect<WorkflowCurrentLaneRow> =>
    Effect.gen(function* () {
      const definition = yield* boardRegistry.getDefinition(boardId as never);
      const lane = definition?.lanes.find((candidate) => candidate.key === currentLaneKey);
      if (lane === undefined) {
        yield* Effect.logDebug("workflow current lane definition unresolved", {
          boardId,
          currentLaneKey,
        });
        return { key: currentLaneKey, name: currentLaneKey, actions: [] };
      }
      const actions: ReadonlyArray<WorkflowLaneActionRow> = (lane.actions ?? []).map((action) => ({
        label: action.label,
        to: action.to as string,
        ...(action.hint === undefined ? {} : { hint: action.hint }),
      }));
      return { key: lane.key as string, name: lane.name, actions };
    });

  const registerBoard: WorkflowReadModelShape["registerBoard"] = (board) =>
    wrap(sql`
      INSERT INTO projection_board (
        board_id,
        project_id,
        name,
        workflow_file_path,
        workflow_version_hash,
        max_concurrent_tickets
      )
      VALUES (
        ${board.boardId},
        ${board.projectId},
        ${board.name},
        ${board.workflowFilePath},
        ${board.workflowVersionHash},
        ${board.maxConcurrentTickets}
      )
      ON CONFLICT(board_id) DO UPDATE SET
        project_id = excluded.project_id,
        name = excluded.name,
        workflow_file_path = excluded.workflow_file_path,
        workflow_version_hash = excluded.workflow_version_hash,
        max_concurrent_tickets = excluded.max_concurrent_tickets
    `).pipe(Effect.asVoid);

  const getBoard: WorkflowReadModelShape["getBoard"] = (boardId) =>
    wrap(sql<BoardRow>`
      SELECT
        board_id AS "boardId",
        project_id AS "projectId",
        name,
        workflow_file_path AS "workflowFilePath",
        workflow_version_hash AS "workflowVersionHash",
        max_concurrent_tickets AS "maxConcurrentTickets"
      FROM projection_board
      WHERE board_id = ${boardId}
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const deleteBoard: WorkflowReadModelShape["deleteBoard"] = (boardId) =>
    wrap(sql`
      DELETE FROM projection_board
      WHERE board_id = ${boardId}
    `).pipe(Effect.asVoid);

  const deleteBoardTicketState: WorkflowReadModelShape["deleteBoardTicketState"] = (boardId) =>
    wrap(sql`
      DELETE FROM workflow_dispatch_outbox
      WHERE ticket_id IN (
        SELECT ticket_id
        FROM projection_ticket
        WHERE board_id = ${boardId}
      )
    `).pipe(
      Effect.andThen(
        wrap(sql`
          DELETE FROM workflow_setup_run
          WHERE ticket_id IN (
            SELECT ticket_id
            FROM projection_ticket
            WHERE board_id = ${boardId}
          )
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM workflow_script_run
          WHERE ticket_id IN (
            SELECT ticket_id
            FROM projection_ticket
            WHERE board_id = ${boardId}
          )
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM projection_step_run
          WHERE ticket_id IN (
            SELECT ticket_id
            FROM projection_ticket
            WHERE board_id = ${boardId}
          )
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM projection_pipeline_run
          WHERE ticket_id IN (
            SELECT ticket_id
            FROM projection_ticket
            WHERE board_id = ${boardId}
          )
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM projection_ticket_message
          WHERE ticket_id IN (
            SELECT ticket_id
            FROM projection_ticket
            WHERE board_id = ${boardId}
          )
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM projection_ticket_dependency
          WHERE ticket_id IN (
            SELECT ticket_id
            FROM projection_ticket
            WHERE board_id = ${boardId}
          )
             OR depends_on_ticket_id IN (
            SELECT ticket_id
            FROM projection_ticket
            WHERE board_id = ${boardId}
          )
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM workflow_pr_observation
          WHERE ticket_id IN (
            SELECT ticket_id
            FROM projection_ticket
            WHERE board_id = ${boardId}
          )
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM workflow_pr_state
          WHERE ticket_id IN (
            SELECT ticket_id
            FROM projection_ticket
            WHERE board_id = ${boardId}
          )
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM workflow_notification_outbox
          WHERE ticket_id IN (
            SELECT ticket_id
            FROM projection_ticket
            WHERE board_id = ${boardId}
          )
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM work_source_mapping
          WHERE ticket_id IN (
            SELECT ticket_id
            FROM projection_ticket
            WHERE board_id = ${boardId}
          )
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM work_source_state
          WHERE board_id = ${boardId}
        `),
      ),
      Effect.andThen(
        // Outbound deliveries are board-scoped — cascade them. Outbound
        // CONNECTIONS are global (not board-scoped), so they are intentionally
        // NOT deleted here; a dangling connection ref is allowed.
        wrap(sql`
          DELETE FROM workflow_outbound_delivery
          WHERE board_id = ${boardId}
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM workflow_board_proposal
          WHERE board_id = ${boardId}
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM projection_ticket
          WHERE board_id = ${boardId}
        `),
      ),
      Effect.asVoid,
    );

  const deleteTicketState: WorkflowReadModelShape["deleteTicketState"] = (ticketId) =>
    wrap(sql`
      DELETE FROM workflow_dispatch_outbox
      WHERE ticket_id = ${ticketId}
    `).pipe(
      Effect.andThen(
        wrap(sql`
          DELETE FROM workflow_setup_run
          WHERE ticket_id = ${ticketId}
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM workflow_script_run
          WHERE ticket_id = ${ticketId}
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM projection_step_run
          WHERE ticket_id = ${ticketId}
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM projection_pipeline_run
          WHERE ticket_id = ${ticketId}
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM projection_ticket_message
          WHERE ticket_id = ${ticketId}
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM projection_ticket_dependency
          WHERE ticket_id = ${ticketId}
             OR depends_on_ticket_id = ${ticketId}
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM workflow_pr_observation
          WHERE ticket_id = ${ticketId}
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM workflow_pr_state
          WHERE ticket_id = ${ticketId}
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM workflow_notification_outbox
          WHERE ticket_id = ${ticketId}
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM work_source_mapping
          WHERE ticket_id = ${ticketId}
        `),
      ),
      Effect.andThen(
        wrap(sql`
          DELETE FROM projection_ticket
          WHERE ticket_id = ${ticketId}
        `),
      ),
      Effect.asVoid,
    );

  const listBoardsForProject: WorkflowReadModelShape["listBoardsForProject"] = (projectId) =>
    wrap(sql<BoardListRow>`
      SELECT
        board_id AS "boardId",
        name,
        workflow_file_path AS "filePath"
      FROM projection_board
      WHERE project_id = ${projectId}
      ORDER BY name COLLATE NOCASE ASC, board_id ASC
    `);

  const listTickets: WorkflowReadModelShape["listTickets"] = (boardId) =>
    wrap(sql<TicketDependencySqlRow>`
      SELECT
        projection_ticket.ticket_id AS "ticketId",
        board_id AS "boardId",
        title,
        description,
        current_lane_key AS "currentLaneKey",
        current_lane_entry_token AS "currentLaneEntryToken",
        queued_at AS "queuedAt",
        token_budget AS "tokenBudget",
        projection_ticket.updated_at AS "updatedAt",
        (
          SELECT SUM(step.total_tokens)
          FROM projection_step_run AS step
          WHERE step.ticket_id = projection_ticket.ticket_id
        ) AS "totalTokens",
        (
          SELECT CAST(
            SUM((julianday(step.finished_at) - julianday(step.started_at)) * 86400000.0)
            AS INTEGER
          )
          FROM projection_step_run AS step
          WHERE step.ticket_id = projection_ticket.ticket_id
            AND step.started_at IS NOT NULL
            AND step.finished_at IS NOT NULL
        ) AS "totalDurationMs",
        (
          SELECT COUNT(*)
          FROM projection_ticket_dependency AS dep
          LEFT JOIN projection_ticket AS dep_ticket
            ON dep_ticket.ticket_id = dep.depends_on_ticket_id
          WHERE dep.ticket_id = projection_ticket.ticket_id
            AND dep_ticket.ticket_id IS NOT NULL
            AND dep_ticket.terminal_at IS NULL
        ) AS "unresolvedDependencyCount",
        (
          SELECT json_group_array(dep.depends_on_ticket_id)
          FROM projection_ticket_dependency AS dep
          WHERE dep.ticket_id = projection_ticket.ticket_id
        ) AS "dependsOnJson",
        pr.pr_number AS "prNumber",
        pr.pr_url AS "prUrl",
        pr.pr_state AS "prState",
        pr.last_ci_state AS "prCiState",
        status,
        attention_kind AS "attentionKind",
        attention_reason AS "attentionReason",
        parked_substate AS "parkedSubstate",
        parked_label AS "parkedLabel",
        parked_reason AS "parkedReason",
        parked_at AS "parkedAt",
        parked_event_id AS "parkedEventId",
        park_origin AS "parkOrigin",
        current_step_label AS "currentStepLabel",
        sla_breached_at AS "slaBreachedAt",
        sla_breached_reason AS "slaBreachedReason",
        sla_breached_entry_token AS "slaBreachedEntryToken"
      FROM projection_ticket
      LEFT JOIN workflow_pr_state AS pr
        ON pr.ticket_id = projection_ticket.ticket_id
      WHERE board_id = ${boardId}
      ORDER BY created_at ASC
    `).pipe(
      Effect.tap(warnUnrecognizedPrStates),
      Effect.map((rows) => rows.map((row) => withDependencyFields(row))),
    );

  const clearSlaBreachesForLanesWithoutSla: WorkflowReadModelShape["clearSlaBreachesForLanesWithoutSla"] =
    (boardId, lanesWithSla) =>
      // Do not bump updated_at — this is a maintenance clear, not an event, and
      // aging clocks (Needs You "waiting for N hours") must stay event-driven.
      Effect.gen(function* () {
        if (lanesWithSla.length === 0) {
          yield* wrap(sql`
            UPDATE projection_ticket
            SET sla_breached_entry_token = NULL,
                sla_breached_at = NULL,
                sla_breached_reason = NULL
            WHERE board_id = ${boardId}
              AND sla_breached_entry_token IS NOT NULL
          `);
          return;
        }
        const keep = new Set(lanesWithSla.map(String));
        const breached = yield* wrap(sql<{
          readonly ticketId: string;
          readonly currentLaneKey: string;
        }>`
          SELECT ticket_id AS "ticketId", current_lane_key AS "currentLaneKey"
          FROM projection_ticket
          WHERE board_id = ${boardId}
            AND sla_breached_entry_token IS NOT NULL
        `);
        const toClear = breached
          .filter((row) => !keep.has(row.currentLaneKey))
          .map((row) => row.ticketId);
        if (toClear.length === 0) {
          return;
        }
        // Board-scoped clear under one transaction so a partial failure cannot
        // leave some rows cleared and others stuck.
        yield* wrap(
          sql.withTransaction(
            Effect.forEach(
              toClear,
              (ticketId) => sql`
                UPDATE projection_ticket
                SET sla_breached_entry_token = NULL,
                    sla_breached_at = NULL,
                    sla_breached_reason = NULL
                WHERE ticket_id = ${ticketId}
              `,
              { discard: true },
            ),
          ),
        );
      });

  const countAdmittedInLane: WorkflowReadModelShape["countAdmittedInLane"] = (boardId, laneKey) =>
    wrap(sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM projection_ticket
      WHERE board_id = ${boardId}
        AND current_lane_key = ${laneKey}
        AND current_lane_entry_token IS NOT NULL
    `).pipe(Effect.map((rows) => rows[0]?.count ?? 0));

  const oldestQueuedForLane: WorkflowReadModelShape["oldestQueuedForLane"] = (boardId, laneKey) =>
    wrap(sql<TicketRow>`
      SELECT
        ticket_id AS "ticketId",
        board_id AS "boardId",
        title,
        description,
        current_lane_key AS "currentLaneKey",
        current_lane_entry_token AS "currentLaneEntryToken",
        queued_at AS "queuedAt",
        token_budget AS "tokenBudget",
        updated_at AS "updatedAt",
        (
          SELECT SUM(step.total_tokens)
          FROM projection_step_run AS step
          WHERE step.ticket_id = projection_ticket.ticket_id
        ) AS "totalTokens",
        (
          SELECT CAST(
            SUM((julianday(step.finished_at) - julianday(step.started_at)) * 86400000.0)
            AS INTEGER
          )
          FROM projection_step_run AS step
          WHERE step.ticket_id = projection_ticket.ticket_id
            AND step.started_at IS NOT NULL
            AND step.finished_at IS NOT NULL
        ) AS "totalDurationMs",
        (
          SELECT COUNT(*)
          FROM projection_ticket_dependency AS dep
          LEFT JOIN projection_ticket AS dep_ticket
            ON dep_ticket.ticket_id = dep.depends_on_ticket_id
          WHERE dep.ticket_id = projection_ticket.ticket_id
            AND dep_ticket.ticket_id IS NOT NULL
            AND dep_ticket.terminal_at IS NULL
        ) AS "unresolvedDependencyCount",
        (
          SELECT json_group_array(dep.depends_on_ticket_id)
          FROM projection_ticket_dependency AS dep
          WHERE dep.ticket_id = projection_ticket.ticket_id
        ) AS "dependsOnJson",
        status,
        parked_substate AS "parkedSubstate",
        parked_label AS "parkedLabel",
        parked_reason AS "parkedReason",
        parked_at AS "parkedAt",
        parked_event_id AS "parkedEventId",
        park_origin AS "parkOrigin",
        current_step_label AS "currentStepLabel"
      FROM projection_ticket
      WHERE board_id = ${boardId}
        AND current_lane_key = ${laneKey}
        AND queued_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM projection_ticket_dependency AS dep
          INNER JOIN projection_ticket AS dep_ticket
            ON dep_ticket.ticket_id = dep.depends_on_ticket_id
          WHERE dep.ticket_id = projection_ticket.ticket_id
            AND dep_ticket.terminal_at IS NULL
        )
      ORDER BY queued_at ASC, ticket_id ASC
      LIMIT 1
    `).pipe(Effect.map((rows) => withDependencyFields(rows[0] ?? null)));

  const getTicketDetail: WorkflowReadModelShape["getTicketDetail"] = (ticketId) =>
    Effect.gen(function* () {
      const ticketRows = yield* wrap(sql<TicketDependencySqlRow>`
        SELECT
          projection_ticket.ticket_id AS "ticketId",
          projection_ticket.board_id AS "boardId",
          title,
          description,
          current_lane_key AS "currentLaneKey",
          current_lane_entry_token AS "currentLaneEntryToken",
          queued_at AS "queuedAt",
          token_budget AS "tokenBudget",
          projection_ticket.updated_at AS "updatedAt",
          (
            SELECT SUM(step.total_tokens)
            FROM projection_step_run AS step
            WHERE step.ticket_id = projection_ticket.ticket_id
          ) AS "totalTokens",
          (
            SELECT CAST(
              SUM((julianday(step.finished_at) - julianday(step.started_at)) * 86400000.0)
              AS INTEGER
            )
            FROM projection_step_run AS step
            WHERE step.ticket_id = projection_ticket.ticket_id
              AND step.started_at IS NOT NULL
              AND step.finished_at IS NOT NULL
          ) AS "totalDurationMs",
          (
            SELECT COUNT(*)
            FROM projection_ticket_dependency AS dep
            LEFT JOIN projection_ticket AS dep_ticket
              ON dep_ticket.ticket_id = dep.depends_on_ticket_id
            WHERE dep.ticket_id = projection_ticket.ticket_id
              AND dep_ticket.ticket_id IS NOT NULL
              AND dep_ticket.terminal_at IS NULL
          ) AS "unresolvedDependencyCount",
          (
            SELECT json_group_array(dep.depends_on_ticket_id)
            FROM projection_ticket_dependency AS dep
            WHERE dep.ticket_id = projection_ticket.ticket_id
          ) AS "dependsOnJson",
          pr.pr_number AS "prNumber",
          pr.pr_url AS "prUrl",
          pr.pr_state AS "prState",
          pr.last_ci_state AS "prCiState",
          status,
          attention_kind AS "attentionKind",
          attention_reason AS "attentionReason",
          parked_substate AS "parkedSubstate",
          parked_label AS "parkedLabel",
          parked_reason AS "parkedReason",
          parked_at AS "parkedAt",
          parked_event_id AS "parkedEventId",
          park_origin AS "parkOrigin",
          current_step_label AS "currentStepLabel",
          sla_breached_at AS "slaBreachedAt",
          sla_breached_reason AS "slaBreachedReason",
          sla_breached_entry_token AS "slaBreachedEntryToken",
          fork_origin AS "forkOriginJson",
          fork_root_ticket_id AS "forkRootTicketId",
          wsm.source_metadata_json AS "sourceMetadataJson"
        FROM projection_ticket
        LEFT JOIN workflow_pr_state AS pr
          ON pr.ticket_id = projection_ticket.ticket_id
        LEFT JOIN work_source_mapping AS wsm
          ON wsm.ticket_id = projection_ticket.ticket_id
        WHERE projection_ticket.ticket_id = ${ticketId}
      `);
      const rawTicket = ticketRows[0] as
        | (TicketDependencySqlRow & {
            readonly forkOriginJson?: string | null;
            readonly forkRootTicketId?: string | null;
          })
        | undefined;
      if (!rawTicket) {
        return null;
      }
      yield* warnUnrecognizedPrStates(ticketRows);
      const currentLane = yield* resolveCurrentLane(rawTicket.boardId, rawTicket.currentLaneKey);
      let forkOrigin: TicketRow["forkOrigin"] = null;
      if (typeof rawTicket.forkOriginJson === "string" && rawTicket.forkOriginJson.length > 0) {
        try {
          const parsed = JSON.parse(rawTicket.forkOriginJson) as TicketRow["forkOrigin"];
          if (
            parsed &&
            typeof parsed.parentTicketId === "string" &&
            typeof parsed.forkDepth === "number" &&
            typeof parsed.rootTicketId === "string"
          ) {
            forkOrigin = parsed;
          }
        } catch {
          forkOrigin = null;
        }
      }
      const ticket: TicketRow = {
        ...withDependencyFields(rawTicket),
        currentLane,
        forkOrigin,
        forkRootTicketId: rawTicket.forkRootTicketId ?? null,
      };

      const syncedSource = parseSyncedSource(rawTicket.sourceMetadataJson);

      const stepRows = yield* wrap(sql<StepRunSqlRow>`
        SELECT
          step.step_run_id AS "stepRunId",
          step.step_key AS "stepKey",
          step.step_type AS "stepType",
          step.attempt,
          step.status,
          step.waiting_reason AS "waitingReason",
          step.provider_response_kind AS "providerResponseKind",
          CASE
            WHEN step.status = 'blocked' THEN step.error
            ELSE NULL
          END AS "blockedReason",
          step.error,
          script.script_thread_id AS "scriptThreadId",
          script.terminal_id AS "terminalId",
          script.status AS "scriptStatus",
          script.exit_code AS "exitCode",
          script.signal,
          step.output_json AS "outputJson",
          step.started_at AS "startedAt",
          step.finished_at AS "finishedAt",
          (
            SELECT outbox.thread_id
            FROM workflow_dispatch_outbox AS outbox
            WHERE outbox.step_run_id = step.step_run_id
            ORDER BY outbox.rowid DESC
            LIMIT 1
          ) AS "providerThreadId",
          (
            SELECT outbox.steer_pending_message_id
            FROM workflow_dispatch_outbox AS outbox
            WHERE outbox.step_run_id = step.step_run_id
            ORDER BY outbox.rowid DESC
            LIMIT 1
          ) AS "steerPendingMessageId",
          (
            SELECT outbox.panel_size
            FROM workflow_dispatch_outbox AS outbox
            WHERE outbox.step_run_id = step.step_run_id
            ORDER BY outbox.rowid DESC
            LIMIT 1
          ) AS "panelSize",
          step.steer_count AS "steerCount",
          step.last_steered_at AS "lastSteeredAt",
          step.input_tokens AS "inputTokens",
          step.cached_input_tokens AS "cachedInputTokens",
          step.output_tokens AS "outputTokens",
          step.total_tokens AS "totalTokens"
        FROM projection_step_run AS step
        LEFT JOIN workflow_script_run AS script
          ON script.step_run_id = step.step_run_id
        WHERE step.ticket_id = ${ticketId}
        ORDER BY step.started_at ASC, step.rowid ASC
      `);
      let steps = yield* Effect.forEach(stepRows, toStepRunRow);
      // SQL-first canSteer gates + single TurnStateReader probe for the active agent.
      const activeAgent = steps.find(
        (s) => s.stepType === "agent" && s.status === "running" && s.providerThreadId !== null,
      );
      if (activeAgent !== undefined) {
        let canSteer = true;
        let steerBlockedReason: "awaiting_user" | "delivering" | null = null;
        if ((activeAgent.panelSize ?? 0) >= 2) {
          canSteer = false;
        } else if (activeAgent.steerPendingMessageId != null) {
          canSteer = false;
          steerBlockedReason = "delivering";
        } else {
          const turnStateReader = yield* Effect.serviceOption(TurnStateReader);
          if (Option.isSome(turnStateReader) && activeAgent.providerThreadId !== null) {
            const state = yield* turnStateReader.value
              .read(activeAgent.providerThreadId as never)
              .pipe(Effect.orElseSucceed(() => ({ _tag: "running" as const })));
            if (state._tag === "awaiting_user") {
              canSteer = false;
              steerBlockedReason = "awaiting_user";
            } else if (state._tag !== "running") {
              canSteer = false;
            }
          }
        }
        steps = steps.map((s) =>
          s.stepRunId === activeAgent.stepRunId
            ? { ...s, canSteer, steerBlockedReason }
            : { ...s, canSteer: false, steerBlockedReason: null },
        );
      } else {
        steps = steps.map((s) => ({ ...s, canSteer: false, steerBlockedReason: null }));
      }
      const messages = yield* listTicketMessages(ticketId);
      return { ticket, steps, messages, ...(syncedSource !== undefined ? { syncedSource } : {}) };
    });

  const listTicketMessages: WorkflowReadModelShape["listTicketMessages"] = (ticketId) =>
    Effect.gen(function* () {
      const rows = yield* wrap(sql<TicketMessageSqlRow>`
        SELECT
          message_id AS "messageId",
          ticket_id AS "ticketId",
          step_run_id AS "stepRunId",
          author,
          body,
          attachments_json AS "attachmentsJson",
          created_at AS "createdAt",
          edited_at AS "editedAt",
          kind
        FROM projection_ticket_message
        WHERE ticket_id = ${ticketId}
        ORDER BY created_at ASC, message_id ASC
      `);
      return yield* Effect.forEach(rows, toTicketMessageRow);
    });

  const listTicketDiscussion: WorkflowReadModelShape["listTicketDiscussion"] = (ticketId, limit) =>
    Effect.gen(function* () {
      const rows = yield* wrap(sql<{
        readonly author: "agent" | "user";
        readonly body: string;
        readonly createdAt: string;
        readonly attachmentCount: number;
      }>`
        SELECT
          author,
          body,
          created_at AS "createdAt",
          json_array_length(attachments_json) AS "attachmentCount"
        FROM projection_ticket_message
        WHERE ticket_id = ${ticketId}
        ORDER BY created_at DESC, message_id DESC
        LIMIT ${limit}
      `);
      return [...rows].toReversed();
    });

  const listReleasableDependents: WorkflowReadModelShape["listReleasableDependents"] = (ticketId) =>
    wrap(sql<{ readonly ticketId: string; readonly boardId: string; readonly laneKey: string }>`
      SELECT
        dependent.ticket_id AS "ticketId",
        dependent.board_id AS "boardId",
        dependent.current_lane_key AS "laneKey"
      FROM projection_ticket_dependency AS dep
      INNER JOIN projection_ticket AS dependent
        ON dependent.ticket_id = dep.ticket_id
      WHERE dep.depends_on_ticket_id = ${ticketId}
        AND dependent.queued_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM projection_ticket_dependency AS other
          INNER JOIN projection_ticket AS other_ticket
            ON other_ticket.ticket_id = other.depends_on_ticket_id
          WHERE other.ticket_id = dependent.ticket_id
            AND other_ticket.terminal_at IS NULL
        )
      ORDER BY dependent.queued_at ASC, dependent.ticket_id ASC
    `);

  const listDependentTicketIds: WorkflowReadModelShape["listDependentTicketIds"] = (ticketId) =>
    wrap(sql<{ readonly ticketId: string }>`
      SELECT ticket_id AS "ticketId"
      FROM projection_ticket_dependency
      WHERE depends_on_ticket_id = ${ticketId}
      ORDER BY ticket_id ASC
    `).pipe(Effect.map((rows) => rows.map((row) => row.ticketId)));

  const getBoardDigest: WorkflowReadModelShape["getBoardDigest"] = (boardId, windowHours) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const sinceIso = DateTime.formatIso(DateTime.subtract(now, { hours: windowHours }));
      const counts = yield* wrap(sql<{
        readonly createdCount: number;
        readonly shippedCount: number;
      }>`
        SELECT
          SUM(CASE WHEN created_at >= ${sinceIso} THEN 1 ELSE 0 END) AS "createdCount",
          SUM(CASE WHEN terminal_at IS NOT NULL AND terminal_at >= ${sinceIso} THEN 1 ELSE 0 END) AS "shippedCount"
        FROM projection_ticket
        WHERE board_id = ${boardId}
      `);
      const usage = yield* wrap(sql<{
        readonly totalTokens: number | null;
        readonly totalDurationMs: number | null;
      }>`
        SELECT
          SUM(step.total_tokens) AS "totalTokens",
          CAST(
            SUM((julianday(step.finished_at) - julianday(step.started_at)) * 86400000.0)
            AS INTEGER
          ) AS "totalDurationMs"
        FROM projection_step_run AS step
        INNER JOIN projection_ticket AS ticket ON ticket.ticket_id = step.ticket_id
        WHERE ticket.board_id = ${boardId}
          AND step.finished_at IS NOT NULL
          AND step.finished_at >= ${sinceIso}
      `);
      const attention = yield* wrap(sql<{
        readonly ticketId: string;
        readonly title: string;
        readonly status: string;
        readonly laneKey: string;
        readonly attentionKind: string | null;
        readonly parkedAt: string | null;
        readonly updatedAt: string;
      }>`
        SELECT
          ticket_id AS "ticketId",
          title,
          status,
          current_lane_key AS "laneKey",
          attention_kind AS "attentionKind",
          parked_at AS "parkedAt",
          updated_at AS "updatedAt"
        FROM projection_ticket
        WHERE board_id = ${boardId}
          AND status IN ('waiting_on_user', 'blocked', 'parked')
        ORDER BY updated_at ASC
        LIMIT 20
      `);
      return {
        windowHours,
        createdCount: counts[0]?.createdCount ?? 0,
        shippedCount: counts[0]?.shippedCount ?? 0,
        totalTokens: usage[0]?.totalTokens ?? 0,
        totalDurationMs: usage[0]?.totalDurationMs ?? 0,
        needsAttention: attention.map((row) => {
          // Parked rows age from their own park timestamp — `updated_at` is
          // bumped on any edit, which would reset the digest clock to "just
          // now". Non-parked rows have no park timestamp and keep updated_at.
          const sinceSource =
            row.status === "parked" && row.parkedAt !== null ? row.parkedAt : row.updatedAt;
          return {
            ticketId: row.ticketId,
            title: row.title,
            status: row.status,
            laneKey: row.laneKey,
            attentionKind: row.attentionKind,
            parkedAt: row.parkedAt,
            sinceMs: Math.max(0, nowMs - Date.parse(sinceSource)),
          };
        }),
      };
    });

  const getBoardMetrics: WorkflowReadModelShape["getBoardMetrics"] = (boardId, windowDaysRaw) =>
    Effect.gen(function* () {
      const windowDays = clampWindowDays(windowDaysRaw);
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const generatedAt = DateTime.formatIso(now);
      const sinceIso = DateTime.formatIso(DateTime.subtract(now, { days: windowDays }));

      // 1. throughput — board-scoped counts within the window.
      const throughput = yield* wrap(sql<{
        readonly created: number;
        readonly shipped: number;
      }>`
        SELECT
          SUM(CASE WHEN created_at >= ${sinceIso} THEN 1 ELSE 0 END) AS "created",
          SUM(CASE WHEN terminal_at IS NOT NULL AND terminal_at >= ${sinceIso} THEN 1 ELSE 0 END) AS "shipped"
        FROM projection_ticket
        WHERE board_id = ${boardId}
      `);

      // 2. cycleTime — fetch raw durations and percentile in TS (no SQLite
      // PERCENTILE_CONT). Only fully-shipped tickets within the window.
      const cycleRows = yield* wrap(sql<{ readonly durationMs: number }>`
        SELECT
          CAST((julianday(terminal_at) - julianday(created_at)) * 86400000.0 AS INTEGER) AS "durationMs"
        FROM projection_ticket
        WHERE board_id = ${boardId}
          AND terminal_at IS NOT NULL
          AND terminal_at >= ${sinceIso}
          AND created_at IS NOT NULL
      `);
      const durations = cycleRows.map((row) => row.durationMs).sort((a, b) => a - b);
      const cycleCount = durations.length;
      const cycleTime =
        cycleCount === 0
          ? { count: 0, p50Ms: 0, p90Ms: 0, avgMs: 0 }
          : {
              count: cycleCount,
              p50Ms: percentileNearestRank(durations, 50),
              p90Ms: percentileNearestRank(durations, 90),
              avgMs: Math.round(durations.reduce((sum, d) => sum + d, 0) / cycleCount),
            };

      // 3. wipByLane — non-terminal tickets only; admitted (has entry token) vs
      // queued (queued but not yet admitted).
      const wipRows = yield* wrap(sql<{
        readonly laneKey: string;
        readonly admitted: number;
        readonly queued: number;
      }>`
        SELECT
          current_lane_key AS "laneKey",
          SUM(CASE WHEN current_lane_entry_token IS NOT NULL THEN 1 ELSE 0 END) AS "admitted",
          SUM(CASE WHEN queued_at IS NOT NULL AND current_lane_entry_token IS NULL THEN 1 ELSE 0 END) AS "queued"
        FROM projection_ticket
        WHERE board_id = ${boardId}
          AND terminal_at IS NULL
        GROUP BY current_lane_key
        ORDER BY current_lane_key ASC
      `);
      const wipByLane = wipRows.map((row) => ({
        laneKey: row.laneKey,
        admitted: row.admitted,
        queued: row.queued,
      }));

      // 4. statusBreakdown — terminal tickets bucket as 'done' regardless of
      // their raw status (which stays 'idle' after a terminal move).
      const statusRows = yield* wrap(sql<{
        readonly eff: string;
        readonly count: number;
      }>`
        SELECT
          CASE WHEN terminal_at IS NOT NULL THEN 'done' ELSE status END AS "eff",
          COUNT(*) AS "count"
        FROM projection_ticket
        WHERE board_id = ${boardId}
        GROUP BY eff
      `);
      const statusBreakdown: Record<string, number> = {};
      for (const row of statusRows) {
        statusBreakdown[row.eff] = row.count;
      }

      // 5. attention — blocked / waiting_on_user counts (non-terminal) plus the
      // oldest tickets by time in current lane.
      const attentionCounts = yield* wrap(sql<{
        readonly blocked: number;
        readonly waitingOnUser: number;
        readonly parked: number;
      }>`
        SELECT
          SUM(CASE WHEN status = 'blocked' AND terminal_at IS NULL THEN 1 ELSE 0 END) AS "blocked",
          SUM(CASE WHEN status = 'waiting_on_user' AND terminal_at IS NULL THEN 1 ELSE 0 END) AS "waitingOnUser",
          SUM(CASE WHEN status = 'parked' AND terminal_at IS NULL THEN 1 ELSE 0 END) AS "parked"
        FROM projection_ticket
        WHERE board_id = ${boardId}
      `);
      const oldestRows = yield* wrap(sql<{
        readonly ticketId: string;
        readonly title: string;
        readonly laneKey: string | null;
        readonly enteredAt: string;
      }>`
        SELECT
          ticket_id AS "ticketId",
          title,
          current_lane_key AS "laneKey",
          COALESCE(current_lane_entered_at, queued_at) AS "enteredAt"
        FROM projection_ticket
        WHERE board_id = ${boardId}
          AND terminal_at IS NULL
          AND COALESCE(current_lane_entered_at, queued_at) IS NOT NULL
      `);
      const oldest = oldestRows
        .map((row) => ({
          ticketId: row.ticketId,
          title: row.title,
          laneKey: row.laneKey,
          ageMs: Math.max(0, nowMs - Date.parse(row.enteredAt)),
        }))
        .sort((a, b) => b.ageMs - a.ageMs)
        .slice(0, METRICS_OLDEST_CAP);
      const attention = {
        blocked: attentionCounts[0]?.blocked ?? 0,
        waitingOnUser: attentionCounts[0]?.waitingOnUser ?? 0,
        parked: attentionCounts[0]?.parked ?? 0,
        oldest,
      };

      // 6. routeOutcomes — grouped TicketRouteDecided within window. The
      // pipeline verdict lives at contextSnapshot.pipeline.result; sources
      // without one (work_source / external_event) get 'n/a'.
      const routeRows = yield* wrap(sql<{
        readonly fromLane: string | null;
        readonly toLane: string | null;
        readonly source: string;
        readonly result: string | null;
        readonly count: number;
      }>`
        SELECT
          json_extract(payload_json, '$.fromLane') AS "fromLane",
          json_extract(payload_json, '$.toLane') AS "toLane",
          json_extract(payload_json, '$.source') AS "source",
          json_extract(payload_json, '$.contextSnapshot.pipeline.result') AS "result",
          COUNT(*) AS "count"
        FROM workflow_events
        WHERE event_type = 'TicketRouteDecided'
          AND occurred_at >= ${sinceIso}
          AND ticket_id IN (SELECT ticket_id FROM projection_ticket WHERE board_id = ${boardId})
        GROUP BY "fromLane", "toLane", "source", "result"
      `);
      // 6b. Park outcomes — TicketParked events within the same window, folded
      // into routeOutcomes as their own rows (Gate 1 gap: parks previously
      // never appeared in the metric at all, even though they are as much an
      // "outcome" of routing as a TicketRouteDecided row). parkOrigin is JSON,
      // not a scalar column, so — unlike the query above — grouping can't be
      // pushed into SQL via json_extract + GROUP BY; each row is parsed and
      // grouped here in JS, reusing the exact substate/origin parsing
      // toParkRouteDecisionRow uses so the two renderings stay consistent.
      // The row shape has no dedicated "substate" field, so — mirroring how a
      // park has no toLane — the substate is rendered through the `toLane`
      // slot (the row's "target"); `result` has no pipeline-verdict
      // equivalent for a park, so it takes the same 'n/a' fallback the
      // work_source/external_event sources already use above.
      const parkEventRows = yield* wrap(sql<{
        readonly payloadJson: string;
      }>`
        SELECT payload_json AS "payloadJson"
        FROM workflow_events
        WHERE event_type = 'TicketParked'
          AND occurred_at >= ${sinceIso}
          AND ticket_id IN (SELECT ticket_id FROM projection_ticket WHERE board_id = ${boardId})
      `);
      const parkOutcomeCounts = new Map<
        string,
        { readonly source: string; readonly substate: string; count: number }
      >();
      for (const parkRow of parkEventRows) {
        const payload = yield* decodeUnknownJsonString(parkRow.payloadJson).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (payload === null) {
          continue;
        }
        const record = asRecord(payload);
        if (record === null) {
          continue;
        }
        const substate = WORKFLOW_PARK_SUBSTATES.find(
          (candidate) => candidate === record["substate"],
        );
        if (substate === undefined) {
          continue;
        }
        const originJson = typeof record["parkOrigin"] === "string" ? record["parkOrigin"] : null;
        const origin = originJson === null ? null : parseParkOrigin(originJson);
        const source = origin === null ? "manual" : PARK_ORIGIN_SOURCE_BY_SRC[origin.src];
        const key = `${source}::${substate}`;
        const existing = parkOutcomeCounts.get(key);
        if (existing === undefined) {
          parkOutcomeCounts.set(key, { source, substate, count: 1 });
        } else {
          existing.count += 1;
        }
      }
      const routeOutcomes = [
        ...routeRows.map((row) => ({
          fromLane: row.fromLane,
          toLane: row.toLane,
          source: row.source,
          result: row.result ?? "n/a",
          count: row.count,
        })),
        ...[...parkOutcomeCounts.values()].map((park) => ({
          fromLane: null,
          toLane: park.substate,
          source: park.source,
          result: "n/a",
          count: park.count,
        })),
      ];

      // 7. manualMoveCount — TicketMovedToLane with reason=manual in window.
      const manualMove = yield* wrap(sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count"
        FROM workflow_events
        WHERE event_type = 'TicketMovedToLane'
          AND occurred_at >= ${sinceIso}
          AND json_extract(payload_json, '$.reason') = 'manual'
          AND ticket_id IN (SELECT ticket_id FROM projection_ticket WHERE board_id = ${boardId})
      `);

      // 8. stepStats — lane-aware grouping over finished step runs within
      // window. The projection writes 'completed' for success and 'failed' for
      // failure (confirmed in WorkflowProjectionPipeline). AVG over no rows is
      // NULL → coalesced to 0 by the row-level ?? below.
      const stepRows = yield* wrap(sql<{
        readonly laneKey: string;
        readonly stepKey: string;
        readonly stepType: string;
        readonly succeeded: number;
        readonly failed: number;
        readonly retries: number;
        readonly totalTokens: number;
        readonly avgDurationMs: number | null;
      }>`
        SELECT
          pr.lane_key AS "laneKey",
          sr.step_key AS "stepKey",
          sr.step_type AS "stepType",
          SUM(CASE WHEN sr.status = 'completed' THEN 1 ELSE 0 END) AS "succeeded",
          SUM(CASE WHEN sr.status = 'failed' THEN 1 ELSE 0 END) AS "failed",
          SUM(CASE WHEN COALESCE(sr.attempt, 1) > 1 THEN 1 ELSE 0 END) AS "retries",
          SUM(COALESCE(sr.total_tokens, 0)) AS "totalTokens",
          CAST(AVG((julianday(sr.finished_at) - julianday(sr.started_at)) * 86400000.0) AS INTEGER) AS "avgDurationMs"
        FROM projection_step_run AS sr
        INNER JOIN projection_pipeline_run AS pr ON pr.pipeline_run_id = sr.pipeline_run_id
        WHERE sr.ticket_id IN (SELECT ticket_id FROM projection_ticket WHERE board_id = ${boardId})
          AND sr.finished_at IS NOT NULL
          AND sr.finished_at >= ${sinceIso}
        GROUP BY pr.lane_key, sr.step_key, sr.step_type
      `);
      const stepStats = stepRows.map((row) => ({
        laneKey: row.laneKey,
        stepKey: row.stepKey,
        stepType: row.stepType,
        succeeded: row.succeeded,
        failed: row.failed,
        retries: row.retries,
        totalTokens: row.totalTokens,
        avgDurationMs: row.avgDurationMs ?? 0,
      }));

      return {
        windowDays,
        generatedAt,
        throughput: {
          created: throughput[0]?.created ?? 0,
          shipped: throughput[0]?.shipped ?? 0,
        },
        cycleTime,
        wipByLane,
        statusBreakdown,
        attention,
        routeOutcomes,
        manualMoveCount: manualMove[0]?.count ?? 0,
        stepStats,
      } satisfies WorkflowBoardMetrics;
    });

  // No environment filter is needed: each t3 server process owns exactly one
  // SQLite database file, and that file is already environment-scoped at the
  // process / WebSocket-connection level. There is no multi-environment-per-DB
  // path (projection_board carries project_id, not an environment_id, and the
  // server never shares one DB across environments). Confirmed in T8 Part C.
  const listNeedsAttentionTickets: WorkflowReadModelShape["listNeedsAttentionTickets"] = () =>
    wrap(sql<WorkflowNeedsAttentionTicketRow>`
      SELECT
        pt.ticket_id AS "ticketId",
        pt.board_id AS "boardId",
        pb.name AS "boardName",
        pt.title,
        pt.status,
        pt.current_lane_key AS "currentLaneKey",
        pt.attention_kind AS "attentionKind",
        pt.attention_reason AS "attentionReason",
        pt.updated_at AS "updatedAt",
        pt.parked_at AS "parkedAt",
        pt.sla_breached_at AS "slaBreachedAt",
        pt.sla_breached_reason AS "slaBreachedReason"
      FROM projection_ticket AS pt
      INNER JOIN projection_board AS pb
        ON pb.board_id = pt.board_id
      WHERE pt.status IN ('waiting_on_user', 'blocked', 'parked')
         OR (
           pt.sla_breached_entry_token IS NOT NULL
           AND pt.sla_breached_entry_token = pt.current_lane_entry_token
           AND pt.terminal_at IS NULL
         )
      ORDER BY
        CASE
          WHEN pt.status IN ('waiting_on_user', 'blocked', 'parked') THEN pt.updated_at
          ELSE COALESCE(pt.sla_breached_at, pt.updated_at)
        END ASC
    `);

  const listTicketRouteDecisions: WorkflowReadModelShape["listTicketRouteDecisions"] = (ticketId) =>
    Effect.gen(function* () {
      // Newest events first with a hard cap — looping tickets accumulate
      // routing events forever and detail is polled while steps run.
      const rows = yield* wrap(sql<{
        readonly eventType: string;
        readonly occurredAt: string;
        readonly payloadJson: string;
      }>`
        SELECT "eventType", "occurredAt", "payloadJson"
        FROM (
          SELECT
            sequence,
            event_type AS "eventType",
            occurred_at AS "occurredAt",
            payload_json AS "payloadJson"
          FROM workflow_events
          WHERE ticket_id = ${ticketId}
            AND event_type IN (
              'TicketRouteDecided',
              'TicketMovedToLane',
              'TicketParked',
              'TicketSlaBreached'
            )
          ORDER BY sequence DESC
          LIMIT ${ROUTE_DECISION_EVENT_CAP}
        )
        ORDER BY sequence ASC
      `);
      const decisions: TicketRouteDecisionRow[] = [];
      for (const row of rows) {
        const payload = yield* decodeOutputJson(row.payloadJson).pipe(
          Effect.mapError(toReadModelError),
        );
        const decision = toRouteDecisionRow(row.eventType, row.occurredAt, payload);
        if (decision !== null) {
          decisions.push(decision);
        }
      }
      return decisions;
    });

  // Counts the CURRENT streak of pipeline runs in the lane, not all-time
  // visits: a pipeline run in another lane or a manual move resets the count,
  // so a human pulling a ticket back into a looping lane gets a fresh budget.
  // Computed over the totally-ordered event log (sequence) so same-instant
  // timestamps cannot blur the reset boundary.
  const countLanePipelineRuns: WorkflowReadModelShape["countLanePipelineRuns"] = (pipelineRunId) =>
    wrap(sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM workflow_events AS started
      INNER JOIN projection_pipeline_run AS current
        ON current.pipeline_run_id = ${pipelineRunId}
      WHERE started.ticket_id = current.ticket_id
        AND started.event_type = 'PipelineStarted'
        AND json_extract(started.payload_json, '$.laneKey') = current.lane_key
        AND started.sequence > COALESCE(
          (
            SELECT MAX(reset.sequence)
            FROM workflow_events AS reset
            WHERE reset.ticket_id = current.ticket_id
              AND (
                (
                  reset.event_type = 'TicketMovedToLane'
                  AND json_extract(reset.payload_json, '$.reason') = 'manual'
                )
                OR (
                  reset.event_type = 'PipelineStarted'
                  AND json_extract(reset.payload_json, '$.laneKey') != current.lane_key
                )
              )
          ),
          0
        )
    `).pipe(Effect.map((rows) => rows[0]?.count ?? 0));

  const listStepRunsForPipeline: WorkflowReadModelShape["listStepRunsForPipeline"] = (
    pipelineRunId,
  ) =>
    Effect.gen(function* () {
      const stepRows = yield* wrap(sql<PipelineStepRunSqlRow>`
        SELECT
          step.step_key AS "stepKey",
          step.step_type AS "stepType",
          step.status,
          script.exit_code AS "exitCode",
          step.output_json AS "outputJson"
        FROM projection_step_run AS step
        LEFT JOIN workflow_script_run AS script
          ON script.step_run_id = step.step_run_id
        WHERE step.pipeline_run_id = ${pipelineRunId}
        ORDER BY step.started_at ASC, step.rowid ASC
      `);
      return yield* Effect.forEach(stepRows, toPipelineStepRunRow);
    });

  const getTicketPrState: WorkflowReadModelShape["getTicketPrState"] = (ticketId) =>
    wrap(sql<TicketPrStateRow>`
      SELECT
        pr_number AS "prNumber",
        pr_url AS "prUrl",
        branch,
        remote_name AS "remoteName",
        repo,
        pr_state AS "prState",
        last_head_sha AS "lastHeadSha",
        last_ci_state AS "lastCiState",
        last_review_decision AS "lastReviewDecision",
        last_comment_cursor AS "lastCommentCursor"
      FROM workflow_pr_state
      WHERE ticket_id = ${ticketId}
    `).pipe(Effect.map((rows) => rows[0] ?? null));

  const recordBoardProposal: WorkflowReadModelShape["recordBoardProposal"] = (proposal) =>
    wrap(sql`
      INSERT INTO workflow_board_proposal (
        proposal_id,
        board_id,
        base_version_hash,
        base_def_json,
        agent_json,
        proposed_def_json,
        rationale,
        validation_json,
        status,
        created_at
      )
      VALUES (
        ${proposal.proposalId},
        ${proposal.boardId},
        ${proposal.baseVersionHash},
        ${proposal.baseDefJson},
        ${proposal.agentJson},
        ${proposal.proposedDefJson},
        ${proposal.rationale},
        ${proposal.validationJson},
        ${proposal.status},
        ${proposal.createdAt}
      )
    `).pipe(Effect.asVoid);

  // ─── board proposal read helpers ─────────────────────────────────────────

  // Map a raw DB row to a WorkflowBoardProposalView. `currentVersionHash` is
  // the board's current workflow_version_hash (used to derive `outdated`).
  const toProposalView = (row: ProposalSqlRow, currentVersionHash: string) =>
    Effect.gen(function* () {
      const validation = yield* decodeProposalValidationJson(row.validationJson);
      const agent = yield* decodeProposalAgentJson(row.agentJson);
      const view: WorkflowBoardProposalView = {
        proposalId: row.proposalId,
        boardId: row.boardId as never,
        status: row.status as WorkflowBoardProposalView["status"],
        rationale: row.rationale,
        validation,
        baseVersionHash: row.baseVersionHash,
        appliedVersionHash: row.appliedVersionHash,
        outdated: row.baseVersionHash !== currentVersionHash,
        agent,
        createdAt: row.createdAt,
        resolvedAt: row.resolvedAt,
      };
      return view;
    }).pipe(Effect.mapError(toReadModelError));

  const listBoardProposals: WorkflowReadModelShape["listBoardProposals"] = (boardId) =>
    Effect.gen(function* () {
      // Get the board's current versionHash so we can compute `outdated`.
      const board = yield* getBoard(boardId);
      const currentVersionHash = board?.workflowVersionHash ?? "";

      const rows = yield* wrap(sql<ProposalSqlRow>`
        SELECT
          proposal_id          AS "proposalId",
          board_id             AS "boardId",
          status,
          rationale,
          validation_json      AS "validationJson",
          agent_json           AS "agentJson",
          base_version_hash    AS "baseVersionHash",
          applied_version_hash AS "appliedVersionHash",
          created_at           AS "createdAt",
          resolved_at          AS "resolvedAt"
        FROM workflow_board_proposal
        WHERE board_id = ${boardId}
        ORDER BY
          CASE WHEN status = 'pending' THEN 0 ELSE 1 END ASC,
          created_at DESC
      `);

      return yield* Effect.forEach(rows, (row) => toProposalView(row, currentVersionHash));
    });

  const getBoardProposal: WorkflowReadModelShape["getBoardProposal"] = (proposalId) =>
    Effect.gen(function* () {
      const rows = yield* wrap(sql<ProposalFullSqlRow>`
        SELECT
          proposal_id          AS "proposalId",
          board_id             AS "boardId",
          status,
          rationale,
          validation_json      AS "validationJson",
          agent_json           AS "agentJson",
          base_version_hash    AS "baseVersionHash",
          applied_version_hash AS "appliedVersionHash",
          created_at           AS "createdAt",
          resolved_at          AS "resolvedAt",
          proposed_def_json    AS "proposedDefJson",
          base_def_json        AS "baseDefJson"
        FROM workflow_board_proposal
        WHERE proposal_id = ${proposalId}
      `);

      const row = rows[0];
      if (!row) {
        return null;
      }

      // Get the board's current versionHash for the outdated computation.
      const board = yield* getBoard(row.boardId as never);
      const currentVersionHash = board?.workflowVersionHash ?? "";

      const view = yield* toProposalView(row, currentVersionHash);

      // Decode both defs as encoded (round-trip through decode→encode to get
      // the canonical WorkflowDefinitionEncoded shape).
      const proposedDef = yield* decodeProposalDefinitionJson(row.proposedDefJson).pipe(
        Effect.mapError(toReadModelError),
      );
      const baseDef = yield* decodeProposalDefinitionJson(row.baseDefJson).pipe(
        Effect.mapError(toReadModelError),
      );

      return {
        view,
        proposedDefinition: encodeProposalDefinition(proposedDef) as WorkflowDefinitionEncoded,
        baseDefinition: encodeProposalDefinition(baseDef) as WorkflowDefinitionEncoded,
      };
    });

  // Lanes holding live work. Three arms:
  //   1. admitted, non-terminal tickets (entry token set)
  //   2. queued, non-terminal tickets (TicketQueued nulls the entry token + sets
  //      status='queued'; the admitted arm misses them, but applying a proposal
  //      that restructures the lane — flips entry to manual, or drops/changes the
  //      wipLimit — would admit them under rules they were never gated against, or
  //      strand them in the queue, so they must block an apply)
  //   3. lanes with a running pipeline
  const listLiveOccupiedLanes: WorkflowReadModelShape["listLiveOccupiedLanes"] = (boardId) =>
    wrap(sql<{ readonly laneKey: string }>`
      SELECT current_lane_key AS "laneKey"
      FROM projection_ticket
      WHERE board_id = ${boardId}
        AND terminal_at IS NULL
        AND current_lane_entry_token IS NOT NULL
      UNION
      SELECT current_lane_key AS "laneKey"
      FROM projection_ticket
      WHERE board_id = ${boardId}
        AND status = 'queued'
        AND queued_at IS NOT NULL
        AND terminal_at IS NULL
      UNION
      SELECT run.lane_key AS "laneKey"
      FROM projection_pipeline_run AS run
      INNER JOIN projection_ticket AS t ON t.ticket_id = run.ticket_id
      WHERE t.board_id = ${boardId}
        AND run.status = 'running'
    `).pipe(Effect.map((rows) => rows.map((row) => row.laneKey)));

  const resolveBoardProposalStatus: WorkflowReadModelShape["resolveBoardProposalStatus"] = (
    input,
  ) =>
    sql
      .withTransaction(
        sql<{ readonly proposalId: string }>`
          UPDATE workflow_board_proposal
          SET
            status = ${input.status},
            resolved_at = ${input.resolvedAt},
            applied_version_hash = ${input.appliedVersionHash ?? null}
          WHERE proposal_id = ${input.proposalId}
            ${input.fromStatus === undefined ? sql`` : sql`AND status = ${input.fromStatus}`}
          RETURNING proposal_id AS "proposalId"
        `,
      )
      .pipe(
        Effect.map((rows) => rows.length),
        Effect.mapError(toReadModelError),
      );

  const listWorkSourceMappingsForBoard: WorkflowReadModelShape["listWorkSourceMappingsForBoard"] = (
    boardId,
  ) =>
    wrap(sql<WorkSourceMappingRow>`
      SELECT m.provider          AS "provider",
             m.source_id         AS "sourceId",
             m.external_id       AS "externalId",
             m.ticket_id         AS "ticketId",
             t.current_lane_key  AS "currentLaneKey"
      FROM work_source_mapping m
      JOIN projection_ticket t ON t.ticket_id = m.ticket_id
      WHERE m.board_id = ${boardId}
    `);

  return {
    registerBoard,
    getBoard,
    deleteBoard,
    deleteBoardTicketState,
    deleteTicketState,
    listBoardsForProject,
    listTickets,
    clearSlaBreachesForLanesWithoutSla,
    countAdmittedInLane,
    oldestQueuedForLane,
    getTicketDetail,
    countLanePipelineRuns,
    listTicketMessages,
    listTicketDiscussion,
    listTicketRouteDecisions,
    listReleasableDependents,
    listDependentTicketIds,
    getBoardDigest,
    getBoardMetrics,
    listNeedsAttentionTickets,
    listStepRunsForPipeline,
    getTicketPrState,
    recordBoardProposal,
    listBoardProposals,
    getBoardProposal,
    listLiveOccupiedLanes,
    resolveBoardProposalStatus,
    listWorkSourceMappingsForBoard,
  } satisfies WorkflowReadModelShape;
});

export const WorkflowReadModelLive = Layer.effect(WorkflowReadModel, make);
