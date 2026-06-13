import type {
  AgentSelection,
  BoardListEntry,
  BoardSnapshot,
  BoardTicketView,
  WorkflowIntakeResult,
  EnvironmentAuthorizationError,
  ProjectId,
  StepRunId,
  StepRunStatus,
  TicketAttachment,
  TicketId,
  TicketStatus,
  WorkflowBoardVersionSummary,
  WorkflowCreateBoardInput as WorkflowCreateBoardInputType,
  WorkflowGetBoardDefinitionResult,
  WorkflowGetBoardVersionResult,
  WorkflowLintError,
  WorkflowNeedsAttentionTicketView,
  WorkflowRenameBoardInput as WorkflowRenameBoardInputType,
  WorkflowSaveBoardDefinitionInput,
  WorkflowSaveBoardDefinitionResult,
  WorkflowStepRunView,
  WorkflowTicketDetailView,
  WorkflowDefinition as WorkflowDefinitionType,
  WorkflowDefinitionEncoded,
  WorkflowDryRunScenario,
} from "@t3tools/contracts";
import type { WorkSourceConnectionView } from "@t3tools/contracts/workSource";
import type { WorkSourceProviderName } from "@t3tools/contracts/workSource";
import {
  BoardId,
  LaneKey,
  StepKey,
  WORKFLOW_WS_METHODS,
  WorkflowCreateBoardInput,
  WorkflowDefinition,
  WorkflowRenameBoardInput,
  WorkflowRpcError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { WorkspaceFileSystemShape } from "../../workspace/Services/WorkspaceFileSystem.ts";
import { slugifyBoardName, uniqueBoardSlug } from "../boardSlug.ts";
import { defaultBoardDefinition } from "../defaultBoard.ts";
import type { BoardDiscoveryShape } from "../Services/BoardDiscovery.ts";
import type { BoardRegistryShape } from "../Services/BoardRegistry.ts";
import type { ProjectScriptTrustShape } from "../Services/ProjectScriptTrust.ts";
import type { ProjectWorkspaceResolverShape } from "../Services/ProjectWorkspaceResolver.ts";
import type { WorkflowBoardEventsShape } from "../Services/WorkflowBoardEvents.ts";
import type { WorkflowBoardSaveLocksShape } from "../Services/WorkflowBoardSaveLocks.ts";
import type {
  WorkflowBoardVersionSource,
  WorkflowBoardVersionSummaryRow,
  WorkflowBoardVersionStoreShape,
} from "../Services/WorkflowBoardVersionStore.ts";
import type { WorkflowEngineShape } from "../Services/WorkflowEngine.ts";
import type { WorkflowEventStoreShape } from "../Services/WorkflowEventStore.ts";
import type { WorkflowFileLoaderShape } from "../Services/WorkflowFileLoader.ts";
import type {
  BoardRow,
  StepRunRow,
  TicketRow,
  WorkflowReadModelShape,
} from "../Services/WorkflowReadModel.ts";
import type { TicketDiffQueryShape } from "../Services/TicketDiffQuery.ts";
import type { WorkflowIntakeShape } from "../Services/WorkflowIntake.ts";
import type { PredicateEvaluatorShape } from "../Services/PredicateEvaluator.ts";
import type { WorkflowWebhookShape } from "../Services/WorkflowWebhook.ts";
import type { WorkflowThreadJanitorShape } from "../Services/WorkflowThreadJanitor.ts";
import type { WorkflowWorktreeJanitorShape } from "../Services/WorkflowWorktreeJanitor.ts";
import type { WorkSourceConnectionStoreShape } from "../Services/WorkSourceConnectionStore.ts";
import { deleteWorkflowBoardOwnedState } from "../boardDeletion.ts";
import { simulateBoardRoute } from "../dryRun.ts";
import { sha256Hex } from "../workflowVersionHash.ts";
import { encodeWorkflowDefinitionJson, type LintError } from "../workflowFile.ts";

export interface TicketWorktreeResolverShape {
  readonly resolveForTicket: (
    ticketId: TicketId,
  ) => Effect.Effect<{ readonly cwd: string; readonly baseRef: string }, WorkflowRpcError>;
}

interface WorkflowCreateTicketInput {
  readonly boardId: BoardId;
  readonly title: string;
  readonly description?: string | undefined;
  readonly initialLane: LaneKey;
  readonly dependsOn?: ReadonlyArray<TicketId> | undefined;
  readonly tokenBudget?: number | undefined;
}

interface WorkflowEditTicketInput {
  readonly ticketId: TicketId;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly dependsOn?: ReadonlyArray<TicketId> | undefined;
  readonly tokenBudget?: number | null | undefined;
}

interface WorkflowAnswerTicketStepInput {
  readonly stepRunId: StepRunId;
  readonly text?: string | undefined;
  readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
}

interface WorkflowDeleteBoardInput {
  readonly boardId: BoardId;
}

type WorkflowCreateBoardHandlerInput = WorkflowCreateBoardInputType;
type WorkflowRenameBoardHandlerInput = WorkflowRenameBoardInputType;

interface WorkflowGetBoardDefinitionInput {
  readonly boardId: BoardId;
}

interface WorkflowGetBoardVersionInput {
  readonly boardId: BoardId;
  readonly versionId: number;
}

interface WorkflowRpcHandlerDeps {
  readonly engine: WorkflowEngineShape;
  readonly eventStore?: Pick<WorkflowEventStoreShape, "deleteForBoard">;
  readonly readModel: WorkflowReadModelShape;
  readonly boardRegistry: BoardRegistryShape;
  readonly boardDiscovery: BoardDiscoveryShape;
  readonly projectWorkspaceResolver: ProjectWorkspaceResolverShape;
  readonly workspaceFileSystem: WorkspaceFileSystemShape;
  readonly ticketDiff: TicketDiffQueryShape;
  readonly ticketWorktrees: TicketWorktreeResolverShape;
  readonly boardEvents: WorkflowBoardEventsShape;
  readonly saveLocks?: WorkflowBoardSaveLocksShape;
  readonly versionStore: WorkflowBoardVersionStoreShape;
  readonly worktreeJanitor?: Pick<WorkflowWorktreeJanitorShape, "collectBoardPlan" | "run">;
  readonly threadJanitor?: Pick<
    WorkflowThreadJanitorShape,
    "collectBoardThreads" | "deleteThreads"
  >;
  readonly intake?: WorkflowIntakeShape;
  readonly webhook?: Pick<WorkflowWebhookShape, "getConfig" | "deleteForBoard">;
  readonly predicates?: PredicateEvaluatorShape;
  readonly fileLoader: WorkflowFileLoaderShape;
  readonly projectScriptTrust: ProjectScriptTrustShape;
  readonly connectionStore: WorkSourceConnectionStoreShape;
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly observeRpcStreamEffect: <A, StreamError, StreamContext, EffectError, EffectContext>(
    method: string,
    effect: Effect.Effect<Stream.Stream<A, StreamError, StreamContext>, EffectError, EffectContext>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Stream.Stream<
    A,
    StreamError | EffectError | EnvironmentAuthorizationError,
    StreamContext | EffectContext
  >;
}

const MAX_TICKET_ARTIFACTS = 20;
const MAX_TICKET_ARTIFACT_CHARS = 64_000;
const MAX_DRY_RUN_DEFINITION_CHARS = 256_000;
const MAX_DRY_RUN_LANES = 200;
const MAX_DRY_RUN_PER_LANE = 100;

const toBoardTicketView = (ticket: TicketRow): BoardTicketView => ({
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
  ...(ticket.unresolvedDependencyCount === undefined || ticket.unresolvedDependencyCount === 0
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
  // Attention fields — present when the ticket is in a needs-attention state.
  ...(ticket.attentionKind == null ? {} : { attentionKind: ticket.attentionKind as never }),
  ...(ticket.attentionReason == null ? {} : { attentionReason: ticket.attentionReason }),
  // Current lane detail — present on detail reads (resolved from board definition).
  ...(ticket.currentLane === undefined
    ? {}
    : {
        currentLane: {
          key: ticket.currentLane.key as LaneKey,
          name: ticket.currentLane.name,
          actions: ticket.currentLane.actions.map((a) => ({
            label: a.label,
            to: a.to as LaneKey,
            ...(a.hint === undefined ? {} : { hint: a.hint }),
          })),
        },
      }),
});

const toStepUsageView = (step: StepRunRow) => {
  if (
    step.inputTokens === null &&
    step.cachedInputTokens === null &&
    step.outputTokens === null &&
    step.totalTokens === null
  ) {
    return undefined;
  }
  return {
    ...(step.inputTokens === null ? {} : { inputTokens: step.inputTokens }),
    ...(step.cachedInputTokens === null ? {} : { cachedInputTokens: step.cachedInputTokens }),
    ...(step.outputTokens === null ? {} : { outputTokens: step.outputTokens }),
    ...(step.totalTokens === null ? {} : { totalTokens: step.totalTokens }),
  };
};

const toStepRunView = (step: StepRunRow): WorkflowStepRunView => ({
  stepRunId: step.stepRunId as never,
  stepKey: step.stepKey as never,
  stepType: step.stepType as "agent" | "approval",
  ...(step.attempt === null || step.attempt === 1 ? {} : { attempt: step.attempt }),
  status: step.status as StepRunStatus,
  waitingReason: step.waitingReason,
  blockedReason: step.blockedReason,
  providerResponseKind: step.providerResponseKind,
  scriptThreadId: step.scriptThreadId as never,
  terminalId: step.terminalId,
  scriptStatus: step.scriptStatus as never,
  exitCode: step.exitCode,
  signal: step.signal,
  ...(step.output === null ? {} : { output: step.output }),
  ...(step.startedAt === null ? {} : { startedAt: step.startedAt as never }),
  ...(step.finishedAt === null ? {} : { finishedAt: step.finishedAt as never }),
  ...(toStepUsageView(step) === undefined ? {} : { usage: toStepUsageView(step) }),
  ...(step.providerThreadId === null ? {} : { providerThreadId: step.providerThreadId as never }),
});

const workflowRpcError = (message: string, cause?: unknown) =>
  new WorkflowRpcError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
const decodeWorkflowCreateBoardInput = Schema.decodeUnknownEffect(WorkflowCreateBoardInput);
const decodeWorkflowRenameBoardInput = Schema.decodeUnknownEffect(WorkflowRenameBoardInput);
const decodeWorkflowDefinitionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WorkflowDefinition),
);
const encodeWorkflowDefinition = Schema.encodeSync(WorkflowDefinition);
const WORKFLOW_BOARD_FILE_PATH_PATTERN = /^\.t3\/boards\/[A-Za-z0-9_-]+\.json$/;

const toWorkflowRpcError = (message: string) => (cause: unknown) =>
  workflowRpcError(message, cause);

const toContractLintError = (error: LintError): WorkflowLintError => ({
  code: error.code,
  message: error.message,
  ...(error.laneKey === undefined ? {} : { laneKey: LaneKey.make(error.laneKey) }),
  ...(error.stepKey === undefined ? {} : { stepKey: StepKey.make(error.stepKey) }),
  ...(error.transitionIndex === undefined ? {} : { transitionIndex: error.transitionIndex }),
});

const workflowDefinitionContentJson = (definition: WorkflowDefinitionType): string =>
  `${encodeWorkflowDefinitionJson(definition)}\n`;

const workflowDefinitionVersionHash = (definition: WorkflowDefinitionType): string =>
  sha256Hex(workflowDefinitionContentJson(definition));

const recordBoardVersionBestEffort = (
  deps: Pick<WorkflowRpcHandlerDeps, "versionStore">,
  input: {
    readonly boardId: BoardId;
    readonly versionHash: string;
    readonly contentJson: string;
    readonly source: WorkflowBoardVersionSource;
  },
): Effect.Effect<void> =>
  deps.versionStore.record(input).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to record workflow board version", {
        boardId: input.boardId,
        source: input.source,
        cause: Cause.pretty(cause),
      }),
    ),
  );

const recordBoardVersionRequired = (
  deps: Pick<WorkflowRpcHandlerDeps, "versionStore">,
  input: {
    readonly boardId: BoardId;
    readonly versionHash: string;
    readonly contentJson: string;
    readonly source: WorkflowBoardVersionSource;
  },
): Effect.Effect<void, WorkflowRpcError> =>
  deps.versionStore
    .record(input)
    .pipe(Effect.mapError(toWorkflowRpcError("Failed to record workflow board version")));

const boardSnapshot = (
  deps: Pick<WorkflowRpcHandlerDeps, "boardRegistry" | "readModel">,
  boardId: BoardId,
): Effect.Effect<BoardSnapshot, WorkflowRpcError> =>
  Effect.gen(function* () {
    const board = yield* deps.readModel
      .getBoard(boardId)
      .pipe(Effect.mapError((cause) => workflowRpcError("Failed to load workflow board", cause)));
    if (!board) {
      return yield* workflowRpcError(`Workflow board ${boardId} was not found`);
    }

    const definition = yield* deps.boardRegistry.getDefinition(boardId);
    if (!definition) {
      return yield* workflowRpcError(`Workflow board definition ${boardId} was not found`);
    }

    const tickets = yield* deps.readModel
      .listTickets(boardId)
      .pipe(Effect.mapError((cause) => workflowRpcError("Failed to load workflow tickets", cause)));

    return {
      projectId: board.projectId as ProjectId,
      board: {
        boardId,
        name: board.name,
        lanes: definition.lanes.map((lane) => ({
          key: lane.key,
          name: lane.name,
          entry: lane.entry,
          pipelineStepCount: lane.pipeline?.length ?? 0,
          ...(lane.wipLimit === undefined ? {} : { wipLimit: lane.wipLimit }),
          ...(lane.terminal === undefined ? {} : { terminal: lane.terminal }),
          ...(lane.actions === undefined || lane.actions.length === 0
            ? {}
            : { actions: lane.actions }),
        })),
      },
      tickets: tickets.map(toBoardTicketView),
    } satisfies BoardSnapshot;
  });

const ticketDetail = (
  deps: Pick<WorkflowRpcHandlerDeps, "readModel">,
  ticketId: TicketId,
): Effect.Effect<WorkflowTicketDetailView, WorkflowRpcError> =>
  Effect.gen(function* () {
    const detail = yield* deps.readModel
      .getTicketDetail(ticketId)
      .pipe(
        Effect.mapError((cause) =>
          workflowRpcError("Failed to load workflow ticket detail", cause),
        ),
      );
    if (!detail) {
      return yield* workflowRpcError(`Workflow ticket ${ticketId} was not found`);
    }
    const routeDecisions = yield* deps.readModel
      .listTicketRouteDecisions(ticketId)
      .pipe(
        Effect.mapError((cause) =>
          workflowRpcError("Failed to load workflow ticket route history", cause),
        ),
      );

    return {
      routeHistory: routeDecisions.map((decision) => ({
        occurredAt: decision.occurredAt as never,
        ...(decision.fromLane === null ? {} : { fromLane: decision.fromLane as never }),
        toLane: decision.toLane as never,
        source: decision.source,
        ...(decision.matchedTransitionIndex === null
          ? {}
          : { matchedTransitionIndex: decision.matchedTransitionIndex }),
        ...(decision.eventName === null ? {} : { eventName: decision.eventName }),
        ...(decision.pipelineResult === null ? {} : { pipelineResult: decision.pipelineResult }),
        ...(decision.laneRunCount === null ? {} : { laneRunCount: decision.laneRunCount }),
        ...(decision.steps === null
          ? {}
          : {
              steps: Object.fromEntries(
                Object.entries(decision.steps).map(([stepKey, step]) => [
                  stepKey,
                  {
                    status: step.status,
                    ...(step.exitCode === null ? {} : { exitCode: step.exitCode }),
                    ...(step.verdict === null ? {} : { verdict: step.verdict }),
                  },
                ]),
              ),
            }),
      })),
      ticket: toBoardTicketView(detail.ticket),
      steps: detail.steps.map(toStepRunView),
      messages: detail.messages.map((message) => ({
        messageId: message.messageId,
        ticketId: message.ticketId,
        ...(message.stepRunId === null ? {} : { stepRunId: message.stepRunId }),
        author: message.author,
        body: message.body,
        attachments: [...message.attachments],
        createdAt: message.createdAt,
      })),
      ...(detail.syncedSource !== undefined ? { syncedSource: detail.syncedSource } : {}),
    } satisfies WorkflowTicketDetailView;
  });

const slugFromBoardEntry = (entry: BoardListEntry): string | null => {
  const fileName = entry.filePath.split("/").at(-1);
  return fileName?.endsWith(".json") ? fileName.slice(0, -".json".length) : null;
};

const createBoard = (
  deps: Pick<
    WorkflowRpcHandlerDeps,
    | "boardDiscovery"
    | "projectWorkspaceResolver"
    | "workspaceFileSystem"
    | "fileLoader"
    | "boardRegistry"
    | "readModel"
    | "saveLocks"
    | "versionStore"
  >,
  input: WorkflowCreateBoardHandlerInput,
): Effect.Effect<
  { readonly boardId: BoardId; readonly snapshot: BoardSnapshot },
  WorkflowRpcError
> =>
  decodeWorkflowCreateBoardInput(input).pipe(
    Effect.mapError(toWorkflowRpcError("workflow board create input decode failed")),
    Effect.flatMap((decoded) =>
      Effect.gen(function* () {
        const workspaceRoot = yield* deps.projectWorkspaceResolver
          .resolve(decoded.projectId)
          .pipe(Effect.mapError(toWorkflowRpcError("Failed to resolve workflow project root")));
        const existingEntries = yield* deps.boardDiscovery.discover(decoded.projectId);
        const existingSlugs = new Set(
          existingEntries.flatMap((entry) => {
            const slug = slugFromBoardEntry(entry);
            return slug === null ? [] : [slug];
          }),
        );
        const slug = uniqueBoardSlug(slugifyBoardName(decoded.name), existingSlugs);
        const boardId = BoardId.make(`${decoded.projectId}__${slug}`);
        const relativePath = `.t3/boards/${slug}.json`;
        const definition = defaultBoardDefinition({ name: decoded.name, agent: decoded.agent });
        const contentJson = workflowDefinitionContentJson(definition);

        return yield* (deps.saveLocks?.withSaveLock ?? ((_boardId, effect) => effect))(
          boardId,
          Effect.gen(function* () {
            yield* deps.workspaceFileSystem
              .createFileExclusive({
                projectRoot: workspaceRoot,
                relativePath,
                contents: contentJson,
              })
              .pipe(Effect.mapError(toWorkflowRpcError("Failed to create workflow board file")));
            yield* deps.fileLoader
              .loadAndRegister({
                boardId,
                projectId: decoded.projectId,
                workspaceRoot,
                relativePath,
              })
              .pipe(
                Effect.mapError(toWorkflowRpcError("Failed to register created workflow board")),
              );

            const createdBoard = yield* deps.readModel
              .getBoard(boardId)
              .pipe(Effect.mapError(toWorkflowRpcError("Failed to load created workflow board")));
            if (!createdBoard) {
              return yield* workflowRpcError(
                `Workflow board ${boardId} was not found after create`,
              );
            }
            yield* recordBoardVersionBestEffort(deps, {
              boardId,
              versionHash: createdBoard.workflowVersionHash,
              contentJson,
              source: "create",
            });

            const snapshot = yield* boardSnapshot(deps, boardId);
            return { boardId, snapshot };
          }),
        );
      }),
    ),
  );

const deleteBoard = (
  deps: Pick<
    WorkflowRpcHandlerDeps,
    | "readModel"
    | "engine"
    | "eventStore"
    | "boardRegistry"
    | "versionStore"
    | "saveLocks"
    | "projectWorkspaceResolver"
    | "workspaceFileSystem"
    | "worktreeJanitor"
    | "threadJanitor"
    | "webhook"
  >,
  input: WorkflowDeleteBoardInput,
): Effect.Effect<void, WorkflowRpcError> =>
  (deps.saveLocks?.withSaveLock ?? ((_boardId, effect) => effect))(
    input.boardId,
    Effect.gen(function* () {
      const board = yield* deps.readModel
        .getBoard(input.boardId)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow board")));

      if (board) {
        if (!WORKFLOW_BOARD_FILE_PATH_PATTERN.test(board.workflowFilePath)) {
          return yield* workflowRpcError(
            `Workflow board ${input.boardId} is not a deletable workflow board file`,
          );
        }

        const workspaceRoot = yield* deps.projectWorkspaceResolver
          .resolve(board.projectId as ProjectId)
          .pipe(Effect.mapError(toWorkflowRpcError("Failed to resolve workflow project root")));

        yield* deps.workspaceFileSystem
          .deleteFile({
            cwd: workspaceRoot,
            relativePath: board.workflowFilePath,
          })
          .pipe(Effect.mapError(toWorkflowRpcError("Failed to delete workflow board file")));
      }

      yield* deleteWorkflowBoardOwnedState(
        {
          boardRegistry: deps.boardRegistry,
          engine: deps.engine,
          eventStore: deps.eventStore ?? { deleteForBoard: () => Effect.void },
          readModel: deps.readModel,
          versionStore: deps.versionStore,
          ...(deps.worktreeJanitor === undefined ? {} : { worktreeJanitor: deps.worktreeJanitor }),
          ...(deps.threadJanitor === undefined ? {} : { threadJanitor: deps.threadJanitor }),
          ...(deps.webhook === undefined ? {} : { webhook: deps.webhook }),
        },
        input.boardId,
      ).pipe(Effect.mapError(toWorkflowRpcError("Failed to delete workflow board state")));
    }),
  );

const getBoardDefinition = (
  deps: Pick<WorkflowRpcHandlerDeps, "boardRegistry" | "readModel">,
  input: WorkflowGetBoardDefinitionInput,
): Effect.Effect<WorkflowGetBoardDefinitionResult, WorkflowRpcError> =>
  Effect.gen(function* () {
    const definition = yield* deps.boardRegistry.getDefinition(input.boardId);
    if (!definition) {
      return yield* workflowRpcError(`Workflow board definition ${input.boardId} was not found`);
    }

    const board = yield* deps.readModel
      .getBoard(input.boardId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow board")));
    if (!board) {
      return yield* workflowRpcError(`Workflow board ${input.boardId} was not found`);
    }

    return {
      definition: encodeWorkflowDefinition(definition),
      versionHash: board.workflowVersionHash,
    };
  });

const toBoardVersionSummary = (
  version: WorkflowBoardVersionSummaryRow,
  index: number,
): WorkflowBoardVersionSummary => ({
  versionId: version.versionId,
  versionHash: version.versionHash,
  source: version.source,
  createdAt: version.createdAt,
  isCurrent: index === 0,
});

const backfillImportedBoardVersion = (
  deps: Pick<
    WorkflowRpcHandlerDeps,
    "readModel" | "projectWorkspaceResolver" | "workspaceFileSystem" | "versionStore"
  >,
  boardId: BoardId,
): Effect.Effect<void, WorkflowRpcError> =>
  Effect.gen(function* () {
    const board = yield* deps.readModel
      .getBoard(boardId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow board")));
    if (!board) {
      return yield* workflowRpcError(`Workflow board ${boardId} was not found`);
    }

    const projectId = board.projectId as ProjectId;
    const workspaceRoot = yield* deps.projectWorkspaceResolver
      .resolve(projectId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to resolve workflow project root")));
    const contentJson = yield* deps.workspaceFileSystem
      .readFileString({
        cwd: workspaceRoot,
        relativePath: board.workflowFilePath,
      })
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to read workflow board file")));
    const versionHash = sha256Hex(contentJson);
    if (versionHash !== board.workflowVersionHash) {
      yield* Effect.logWarning("Skipping workflow board version import for stale projection", {
        boardId,
        projectedVersionHash: board.workflowVersionHash,
        fileVersionHash: versionHash,
      });
      return;
    }

    yield* deps.versionStore
      .record({
        boardId,
        versionHash,
        contentJson,
        source: "import",
      })
      .pipe(
        Effect.mapError(toWorkflowRpcError("Failed to record imported workflow board version")),
      );
  });

const listBoardVersions = (
  deps: Pick<
    WorkflowRpcHandlerDeps,
    "readModel" | "projectWorkspaceResolver" | "workspaceFileSystem" | "versionStore" | "saveLocks"
  >,
  input: WorkflowGetBoardDefinitionInput,
): Effect.Effect<ReadonlyArray<WorkflowBoardVersionSummary>, WorkflowRpcError> =>
  Effect.gen(function* () {
    const existing = yield* deps.versionStore
      .list(input.boardId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to list workflow board versions")));
    if (existing.length > 0) {
      return existing.map(toBoardVersionSummary);
    }

    yield* (deps.saveLocks?.withSaveLock ?? ((_boardId, effect) => effect))(
      input.boardId,
      Effect.gen(function* () {
        const lockedExisting = yield* deps.versionStore
          .list(input.boardId)
          .pipe(Effect.mapError(toWorkflowRpcError("Failed to list workflow board versions")));
        if (lockedExisting.length > 0) {
          return;
        }
        yield* backfillImportedBoardVersion(deps, input.boardId);
      }),
    );
    const imported = yield* deps.versionStore
      .list(input.boardId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to list workflow board versions")));
    return imported.map(toBoardVersionSummary);
  });

const getBoardVersion = (
  deps: Pick<WorkflowRpcHandlerDeps, "versionStore">,
  input: WorkflowGetBoardVersionInput,
): Effect.Effect<WorkflowGetBoardVersionResult, WorkflowRpcError> =>
  Effect.gen(function* () {
    const version = yield* deps.versionStore
      .get(input.boardId, input.versionId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow board version")));
    if (!version) {
      return yield* workflowRpcError(
        `Workflow board version ${input.versionId} was not found for board ${input.boardId}`,
      );
    }

    const definition = yield* decodeWorkflowDefinitionJson(version.contentJson).pipe(
      Effect.mapError(toWorkflowRpcError("workflow board version decode failed")),
    );
    return {
      versionId: version.versionId,
      definition: encodeWorkflowDefinition(definition),
      versionHash: version.versionHash,
      source: version.source,
      createdAt: version.createdAt,
    };
  });

interface WritableWorkflowBoardFile {
  readonly board: BoardRow;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly currentRaw: string;
}

interface PersistedWorkflowBoardDefinition {
  readonly _tag: "persisted";
  readonly definition: WorkflowDefinitionEncoded;
  readonly versionHash: string;
  readonly contentJson: string;
}

interface WorkflowBoardDefinitionLintFailure {
  readonly _tag: "lintErrors";
  readonly lintErrors: ReadonlyArray<WorkflowLintError>;
}

type PersistWorkflowBoardDefinitionResult =
  | PersistedWorkflowBoardDefinition
  | WorkflowBoardDefinitionLintFailure;

const loadWritableWorkflowBoardFile = (
  deps: Pick<
    WorkflowRpcHandlerDeps,
    "readModel" | "projectWorkspaceResolver" | "workspaceFileSystem"
  >,
  boardId: BoardId,
): Effect.Effect<WritableWorkflowBoardFile, WorkflowRpcError> =>
  Effect.gen(function* () {
    const board = yield* deps.readModel
      .getBoard(boardId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow board")));
    if (!board) {
      return yield* workflowRpcError(`Workflow board ${boardId} was not found`);
    }

    if (!WORKFLOW_BOARD_FILE_PATH_PATTERN.test(board.workflowFilePath)) {
      return yield* workflowRpcError(
        `Workflow board ${boardId} is not a writable workflow board file`,
      );
    }

    const projectId = board.projectId as ProjectId;
    const workspaceRoot = yield* deps.projectWorkspaceResolver
      .resolve(projectId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to resolve workflow project root")));
    const currentRaw = yield* deps.workspaceFileSystem
      .readFileString({
        cwd: workspaceRoot,
        relativePath: board.workflowFilePath,
      })
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to read workflow board file")));

    return {
      board,
      projectId,
      workspaceRoot,
      currentRaw,
    };
  });

const persistWorkflowBoardDefinition = (
  deps: Pick<
    WorkflowRpcHandlerDeps,
    "readModel" | "fileLoader" | "workspaceFileSystem" | "versionStore"
  >,
  input: {
    readonly boardId: BoardId;
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly relativePath: string;
    readonly definition: WorkflowDefinitionType;
    readonly source: WorkflowBoardVersionSource;
    readonly notFoundAfterWriteMessage: string;
    readonly versionRecording?: "best-effort" | "required";
  },
): Effect.Effect<PersistWorkflowBoardDefinitionResult, WorkflowRpcError> =>
  Effect.gen(function* () {
    const lintErrors = yield* deps.fileLoader
      .lintDefinition({
        definition: input.definition,
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
      })
      .pipe(Effect.mapError(toWorkflowRpcError("workflow lint failed")));
    if (lintErrors.length > 0) {
      return { _tag: "lintErrors", lintErrors: lintErrors.map(toContractLintError) };
    }

    const contentJson = workflowDefinitionContentJson(input.definition);
    yield* deps.workspaceFileSystem
      .writeFile({
        cwd: input.workspaceRoot,
        relativePath: input.relativePath,
        contents: contentJson,
      })
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to write workflow board file")));

    yield* deps.fileLoader
      .loadAndRegister({
        boardId: input.boardId,
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
        relativePath: input.relativePath,
      })
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to register saved workflow board")));

    const updatedBoard = yield* deps.readModel
      .getBoard(input.boardId)
      .pipe(Effect.mapError(toWorkflowRpcError("Failed to load saved workflow board")));
    if (!updatedBoard) {
      return yield* workflowRpcError(input.notFoundAfterWriteMessage);
    }
    const versionRecordInput = {
      boardId: input.boardId,
      versionHash: updatedBoard.workflowVersionHash,
      contentJson,
      source: input.source,
    };
    if (input.versionRecording === "required") {
      yield* recordBoardVersionRequired(deps, versionRecordInput);
    } else {
      yield* recordBoardVersionBestEffort(deps, versionRecordInput);
    }

    return {
      _tag: "persisted",
      definition: encodeWorkflowDefinition(input.definition),
      versionHash: updatedBoard.workflowVersionHash,
      contentJson,
    };
  });

const saveBoardDefinition = (
  deps: Pick<
    WorkflowRpcHandlerDeps,
    | "readModel"
    | "boardRegistry"
    | "projectWorkspaceResolver"
    | "fileLoader"
    | "workspaceFileSystem"
    | "saveLocks"
    | "versionStore"
  >,
  input: WorkflowSaveBoardDefinitionInput,
): Effect.Effect<WorkflowSaveBoardDefinitionResult, WorkflowRpcError> =>
  (deps.saveLocks?.withSaveLock ?? ((_boardId, effect) => effect))(
    input.boardId,
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(input.definition).pipe(
        Effect.mapError(toWorkflowRpcError("workflow definition decode failed")),
      );
      const boardFile = yield* loadWritableWorkflowBoardFile(deps, input.boardId);
      const currentVersionHash = sha256Hex(boardFile.currentRaw);
      if (currentVersionHash !== input.expectedVersionHash) {
        return {
          ok: false,
          conflict: true,
          currentVersionHash,
        };
      }

      const persisted = yield* persistWorkflowBoardDefinition(deps, {
        boardId: input.boardId,
        projectId: boardFile.projectId,
        workspaceRoot: boardFile.workspaceRoot,
        relativePath: boardFile.board.workflowFilePath,
        definition,
        source: input.source ?? "save",
        notFoundAfterWriteMessage: `Workflow board ${input.boardId} was not found after save`,
      });
      if (persisted._tag === "lintErrors") {
        return { ok: false, lintErrors: persisted.lintErrors };
      }

      const snapshot = yield* boardSnapshot(deps, input.boardId);
      return {
        ok: true,
        definition: persisted.definition,
        versionHash: persisted.versionHash,
        snapshot,
      };
    }),
  );

const renameBoard = (
  deps: Pick<
    WorkflowRpcHandlerDeps,
    | "readModel"
    | "boardRegistry"
    | "projectWorkspaceResolver"
    | "fileLoader"
    | "workspaceFileSystem"
    | "saveLocks"
    | "versionStore"
  >,
  input: WorkflowRenameBoardHandlerInput,
): Effect.Effect<void, WorkflowRpcError> =>
  decodeWorkflowRenameBoardInput(input).pipe(
    Effect.mapError(toWorkflowRpcError("workflow board rename input decode failed")),
    Effect.flatMap((decoded) =>
      (deps.saveLocks?.withSaveLock ?? ((_boardId, effect) => effect))(
        decoded.boardId,
        Effect.gen(function* () {
          const boardFile = yield* loadWritableWorkflowBoardFile(deps, decoded.boardId);
          const currentDefinition = yield* decodeWorkflowDefinitionJson(boardFile.currentRaw).pipe(
            Effect.mapError(toWorkflowRpcError("workflow board file decode failed")),
          );
          if (currentDefinition.name === decoded.name) {
            const fileVersionHash = sha256Hex(boardFile.currentRaw);
            const registeredDefinition = yield* deps.boardRegistry.getDefinition(decoded.boardId);
            const registeredDefinitionHash =
              registeredDefinition === null
                ? null
                : workflowDefinitionVersionHash(registeredDefinition);
            const currentDefinitionHash = workflowDefinitionVersionHash(currentDefinition);
            const versions = yield* deps.versionStore
              .list(decoded.boardId)
              .pipe(Effect.mapError(toWorkflowRpcError("Failed to list workflow board versions")));
            const projectionIsCurrent = boardFile.board.workflowVersionHash === fileVersionHash;
            const registryIsCurrent = registeredDefinitionHash === currentDefinitionHash;
            const historyIsCurrent = versions[0]?.versionHash === fileVersionHash;
            if (projectionIsCurrent && registryIsCurrent && historyIsCurrent) {
              return;
            }

            if (!projectionIsCurrent || !registryIsCurrent) {
              yield* deps.fileLoader
                .loadAndRegister({
                  boardId: decoded.boardId,
                  projectId: boardFile.projectId,
                  workspaceRoot: boardFile.workspaceRoot,
                  relativePath: boardFile.board.workflowFilePath,
                })
                .pipe(
                  Effect.mapError(toWorkflowRpcError("Failed to register saved workflow board")),
                );

              const updatedBoard = yield* deps.readModel
                .getBoard(decoded.boardId)
                .pipe(Effect.mapError(toWorkflowRpcError("Failed to load saved workflow board")));
              if (!updatedBoard) {
                return yield* workflowRpcError(
                  `Workflow board ${decoded.boardId} was not found after rename`,
                );
              }
            }

            if (!historyIsCurrent) {
              yield* recordBoardVersionRequired(deps, {
                boardId: decoded.boardId,
                versionHash: fileVersionHash,
                contentJson: boardFile.currentRaw,
                source: "rename",
              });
            }
            return;
          }

          const persisted = yield* persistWorkflowBoardDefinition(deps, {
            boardId: decoded.boardId,
            projectId: boardFile.projectId,
            workspaceRoot: boardFile.workspaceRoot,
            relativePath: boardFile.board.workflowFilePath,
            definition: { ...currentDefinition, name: decoded.name },
            source: "rename",
            notFoundAfterWriteMessage: `Workflow board ${decoded.boardId} was not found after rename`,
            versionRecording: "required",
          });
          if (persisted._tag === "lintErrors") {
            return yield* workflowRpcError(
              `Workflow lint failed: ${persisted.lintErrors.map((error) => error.code).join(", ")}`,
            );
          }
        }),
      ),
    ),
  );

export const workflowRpcHandlers = (deps: WorkflowRpcHandlerDeps) => ({
  [WORKFLOW_WS_METHODS.listBoards]: (input: { readonly projectId: ProjectId }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.listBoards,
      deps.boardDiscovery.discover(input.projectId),
      { "rpc.aggregate": "workflow" },
    ),
  [WORKFLOW_WS_METHODS.createBoard]: (input: WorkflowCreateBoardHandlerInput) =>
    deps.observeRpcEffect(WORKFLOW_WS_METHODS.createBoard, createBoard(deps, input), {
      "rpc.aggregate": "workflow",
    }),
  [WORKFLOW_WS_METHODS.deleteBoard]: (input: WorkflowDeleteBoardInput) =>
    deps.observeRpcEffect(WORKFLOW_WS_METHODS.deleteBoard, deleteBoard(deps, input), {
      "rpc.aggregate": "workflow",
    }),
  [WORKFLOW_WS_METHODS.renameBoard]: (input: WorkflowRenameBoardHandlerInput) =>
    deps.observeRpcEffect(WORKFLOW_WS_METHODS.renameBoard, renameBoard(deps, input), {
      "rpc.aggregate": "workflow",
    }),
  [WORKFLOW_WS_METHODS.getBoard]: (input: { readonly boardId: BoardId }) =>
    deps.observeRpcEffect(WORKFLOW_WS_METHODS.getBoard, boardSnapshot(deps, input.boardId), {
      "rpc.aggregate": "workflow",
    }),
  [WORKFLOW_WS_METHODS.getBoardDefinition]: (input: WorkflowGetBoardDefinitionInput) =>
    deps.observeRpcEffect(WORKFLOW_WS_METHODS.getBoardDefinition, getBoardDefinition(deps, input), {
      "rpc.aggregate": "workflow",
    }),
  [WORKFLOW_WS_METHODS.saveBoardDefinition]: (input: WorkflowSaveBoardDefinitionInput) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.saveBoardDefinition,
      saveBoardDefinition(deps, input),
      { "rpc.aggregate": "workflow" },
    ),
  [WORKFLOW_WS_METHODS.listBoardVersions]: (input: WorkflowGetBoardDefinitionInput) =>
    deps.observeRpcEffect(WORKFLOW_WS_METHODS.listBoardVersions, listBoardVersions(deps, input), {
      "rpc.aggregate": "workflow",
    }),
  [WORKFLOW_WS_METHODS.getBoardVersion]: (input: WorkflowGetBoardVersionInput) =>
    deps.observeRpcEffect(WORKFLOW_WS_METHODS.getBoardVersion, getBoardVersion(deps, input), {
      "rpc.aggregate": "workflow",
    }),
  [WORKFLOW_WS_METHODS.subscribeBoard]: (input: { readonly boardId: BoardId }) =>
    deps.observeRpcStreamEffect(
      WORKFLOW_WS_METHODS.subscribeBoard,
      boardSnapshot(deps, input.boardId).pipe(
        Effect.map((snapshot) =>
          Stream.concat(
            Stream.make({ kind: "snapshot" as const, snapshot }),
            deps.boardEvents
              .stream(input.boardId)
              .pipe(Stream.map((ticket) => ({ kind: "ticket" as const, ticket }))),
          ),
        ),
      ),
      { "rpc.aggregate": "workflow" },
    ),
  [WORKFLOW_WS_METHODS.createTicket]: (input: WorkflowCreateTicketInput) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.createTicket,
      deps.engine
        .createTicket({
          boardId: input.boardId,
          title: input.title,
          initialLane: input.initialLane,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
          ...(input.tokenBudget === undefined ? {} : { tokenBudget: input.tokenBudget }),
        })
        .pipe(
          Effect.mapError(toWorkflowRpcError("Failed to create workflow ticket")),
          Effect.map((ticketId) => ({ ticketId })),
        ),
      { "rpc.aggregate": "workflow" },
    ),
  [WORKFLOW_WS_METHODS.editTicket]: (input: WorkflowEditTicketInput) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.editTicket,
      deps.engine
        .editTicket(input)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to edit workflow ticket"))),
      { "rpc.aggregate": "workflow" },
    ),
  [WORKFLOW_WS_METHODS.moveTicket]: (input: {
    readonly ticketId: TicketId;
    readonly toLane: LaneKey;
  }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.moveTicket,
      deps.engine
        .moveTicket(input.ticketId, input.toLane)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to move workflow ticket"))),
      { "rpc.aggregate": "workflow" },
    ),
  [WORKFLOW_WS_METHODS.runLane]: (input: { readonly ticketId: TicketId }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.runLane,
      deps.engine
        .runLane(input.ticketId)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to run workflow lane"))),
      {
        "rpc.aggregate": "workflow",
      },
    ),
  [WORKFLOW_WS_METHODS.resolveApproval]: (input: {
    readonly stepRunId: StepRunId;
    readonly approved: boolean;
  }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.resolveApproval,
      deps.engine
        .resolveApproval(input.stepRunId, input.approved)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to resolve workflow approval"))),
      { "rpc.aggregate": "workflow" },
    ),
  [WORKFLOW_WS_METHODS.answerTicketStep]: (input: WorkflowAnswerTicketStepInput) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.answerTicketStep,
      deps.engine
        .answerTicketStep(input)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to answer workflow ticket step"))),
      { "rpc.aggregate": "workflow" },
    ),
  [WORKFLOW_WS_METHODS.postTicketMessage]: (input: {
    readonly ticketId: TicketId;
    readonly text?: string | undefined;
    readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
  }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.postTicketMessage,
      deps.engine
        .postTicketMessage(input)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to post workflow ticket message"))),
      { "rpc.aggregate": "workflow" },
    ),
  [WORKFLOW_WS_METHODS.setProjectScriptTrust]: (input: {
    readonly projectId: ProjectId;
    readonly trusted: boolean;
  }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.setProjectScriptTrust,
      deps.projectScriptTrust
        .setTrusted(input.projectId, input.trusted)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to update project script trust"))),
      { "rpc.aggregate": "workflow" },
    ),
  [WORKFLOW_WS_METHODS.cancelStep]: (input: { readonly stepRunId: StepRunId }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.cancelStep,
      deps.engine
        .cancelStep(input.stepRunId)
        .pipe(Effect.mapError(toWorkflowRpcError("Failed to cancel workflow step"))),
      { "rpc.aggregate": "workflow" },
    ),
  [WORKFLOW_WS_METHODS.getTicketDetail]: (input: { readonly ticketId: TicketId }) =>
    deps.observeRpcEffect(WORKFLOW_WS_METHODS.getTicketDetail, ticketDetail(deps, input.ticketId), {
      "rpc.aggregate": "workflow",
    }),
  [WORKFLOW_WS_METHODS.getTicketDiff]: (input: { readonly ticketId: TicketId }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.getTicketDiff,
      deps.ticketWorktrees
        .resolveForTicket(input.ticketId)
        .pipe(
          Effect.flatMap(({ cwd, baseRef }) =>
            deps.ticketDiff
              .getTicketDiff(input.ticketId, cwd, baseRef)
              .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow ticket diff"))),
          ),
        ),
      { "rpc.aggregate": "workflow" },
    ),

  [WORKFLOW_WS_METHODS.listTicketArtifacts]: (input: { readonly ticketId: TicketId }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.listTicketArtifacts,
      Effect.gen(function* () {
        const worktree = yield* deps.ticketWorktrees.resolveForTicket(input.ticketId);
        const scratchDir = `.t3/ticket/${input.ticketId}`;
        const names = yield* deps.workspaceFileSystem
          .listFiles({ cwd: worktree.cwd, relativePath: scratchDir })
          .pipe(Effect.mapError(toWorkflowRpcError("Failed to list ticket artifacts")));
        const artifacts: Array<{
          readonly name: string;
          readonly content: string;
          readonly truncated?: boolean;
        }> = [];
        for (const name of names.slice(0, MAX_TICKET_ARTIFACTS)) {
          const content = yield* deps.workspaceFileSystem
            .readFileString({ cwd: worktree.cwd, relativePath: `${scratchDir}/${name}` })
            .pipe(Effect.mapError(toWorkflowRpcError("Failed to read ticket artifact")));
          artifacts.push({
            name,
            content: content.slice(0, MAX_TICKET_ARTIFACT_CHARS),
            ...(content.length > MAX_TICKET_ARTIFACT_CHARS ? { truncated: true } : {}),
          });
        }
        return { artifacts };
      }),
      { "rpc.aggregate": "workflow" },
    ),

  [WORKFLOW_WS_METHODS.getBoardDigest]: (input: {
    readonly boardId: BoardId;
    readonly windowHours?: number | undefined;
  }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.getBoardDigest,
      Effect.gen(function* () {
        const windowHours =
          input.windowHours === undefined || !Number.isFinite(input.windowHours)
            ? 24
            : Math.min(24 * 7, Math.max(1, Math.floor(input.windowHours)));
        const digest = yield* deps.readModel
          .getBoardDigest(input.boardId, windowHours)
          .pipe(Effect.mapError(toWorkflowRpcError("Failed to compute board digest")));
        return {
          windowHours: digest.windowHours,
          createdCount: digest.createdCount,
          shippedCount: digest.shippedCount,
          totalTokens: digest.totalTokens,
          totalDurationMs: digest.totalDurationMs,
          needsAttention: digest.needsAttention.map((row) => ({
            ticketId: row.ticketId as TicketId,
            title: row.title,
            status: row.status,
            laneKey: row.laneKey as LaneKey,
            sinceMs: Math.max(0, Math.floor(row.sinceMs)),
          })),
        };
      }),
      { "rpc.aggregate": "workflow" },
    ),

  [WORKFLOW_WS_METHODS.dryRunBoard]: (input: {
    readonly definition: WorkflowDefinitionEncoded;
    readonly startLane: LaneKey;
    readonly scenario: WorkflowDryRunScenario;
  }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.dryRunBoard,
      Effect.gen(function* () {
        const predicates = deps.predicates;
        if (predicates === undefined) {
          return yield* workflowRpcError("Dry run is not available on this server");
        }
        // Read-scoped callers send arbitrary definitions — bound the work
        // before decoding so a huge payload cannot burn CPU/memory.
        if (
          // @effect-diagnostics-next-line preferSchemaOverJson:off — pure size probe, not parsing
          JSON.stringify(input.definition).length > MAX_DRY_RUN_DEFINITION_CHARS ||
          input.definition.lanes.length > MAX_DRY_RUN_LANES ||
          input.definition.lanes.some(
            (lane) =>
              (lane.pipeline?.length ?? 0) > MAX_DRY_RUN_PER_LANE ||
              (lane.transitions?.length ?? 0) > MAX_DRY_RUN_PER_LANE ||
              (lane.onEvent?.length ?? 0) > MAX_DRY_RUN_PER_LANE,
          )
        ) {
          return yield* workflowRpcError("Workflow definition is too large to dry-run");
        }
        const definition = yield* Schema.decodeUnknownEffect(WorkflowDefinition)(
          input.definition,
        ).pipe(Effect.mapError(toWorkflowRpcError("Workflow definition is invalid")));
        if (
          !definition.lanes.some((lane) => (lane.key as string) === (input.startLane as string))
        ) {
          return yield* workflowRpcError(`Start lane "${input.startLane}" was not found`);
        }
        return yield* simulateBoardRoute({
          definition,
          startLane: input.startLane,
          scenario: input.scenario,
          evaluator: predicates,
        });
      }),
      { "rpc.aggregate": "workflow" },
    ),

  [WORKFLOW_WS_METHODS.getWebhookConfig]: (input: {
    readonly boardId: BoardId;
    readonly rotate?: boolean | undefined;
  }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.getWebhookConfig,
      Effect.gen(function* () {
        const webhook = deps.webhook;
        if (webhook === undefined) {
          return yield* workflowRpcError("Webhooks are not available on this server");
        }
        const board = yield* deps.readModel
          .getBoard(input.boardId)
          .pipe(Effect.mapError(toWorkflowRpcError("Failed to load workflow board")));
        if (board === null) {
          return yield* workflowRpcError(`Workflow board ${input.boardId} was not found`);
        }
        const config = yield* webhook
          .getConfig(input.boardId, input.rotate === true)
          .pipe(Effect.mapError(toWorkflowRpcError("Failed to load webhook config")));
        return {
          path: config.path,
          hasToken: config.hasToken,
          ...(config.tokenPrefix === undefined ? {} : { tokenPrefix: config.tokenPrefix }),
          ...(config.token === undefined ? {} : { token: config.token }),
        };
      }),
      { "rpc.aggregate": "workflow" },
    ),

  [WORKFLOW_WS_METHODS.listNeedsAttentionTickets]: (_input: Record<string, never>) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.listNeedsAttentionTickets,
      Effect.gen(function* () {
        const rows = yield* deps.readModel
          .listNeedsAttentionTickets()
          .pipe(Effect.mapError(toWorkflowRpcError("Failed to list needs-attention tickets")));
        return rows.map(
          (row): WorkflowNeedsAttentionTicketView => ({
            ticketId: row.ticketId as never,
            boardId: row.boardId as never,
            boardName: row.boardName,
            title: row.title,
            status: row.status as never,
            currentLaneKey: row.currentLaneKey as never,
            attentionKind: row.attentionKind as never,
            attentionReason: row.attentionReason,
            updatedAt: row.updatedAt,
          }),
        );
      }),
      { "rpc.aggregate": "workflow" },
    ),

  [WORKFLOW_WS_METHODS.intakeTickets]: (input: {
    readonly boardId: BoardId;
    readonly braindump: string;
    readonly agent: AgentSelection;
  }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.intakeTickets,
      Effect.gen(function* () {
        const intake = deps.intake;
        if (intake === undefined) {
          return yield* workflowRpcError("Ticket intake is not available on this server");
        }
        const proposals = yield* intake
          .proposeTickets(input)
          .pipe(Effect.mapError(toWorkflowRpcError("Failed to propose tickets from braindump")));
        return { proposals: [...proposals] } satisfies WorkflowIntakeResult;
      }),
      { "rpc.aggregate": "workflow" },
    ),

  [WORKFLOW_WS_METHODS.listWorkSourceConnections]: (_input: Record<string, never>) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.listWorkSourceConnections,
      Effect.gen(function* () {
        return yield* deps.connectionStore
          .list()
          .pipe(
            Effect.mapError(toWorkflowRpcError("Failed to list work-source connections")),
          );
      }),
      { "rpc.aggregate": "workflow" },
    ),

  [WORKFLOW_WS_METHODS.createWorkSourceConnection]: (input: {
    readonly provider: WorkSourceProviderName;
    readonly displayName: string;
    readonly token: string;
  }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.createWorkSourceConnection,
      Effect.gen(function* () {
        const view = yield* deps.connectionStore
          .create(input)
          .pipe(
            Effect.mapError(toWorkflowRpcError("Failed to create work-source connection")),
          );
        return view satisfies WorkSourceConnectionView;
      }),
      { "rpc.aggregate": "workflow" },
    ),

  [WORKFLOW_WS_METHODS.deleteWorkSourceConnection]: (input: { readonly connectionRef: string }) =>
    deps.observeRpcEffect(
      WORKFLOW_WS_METHODS.deleteWorkSourceConnection,
      Effect.gen(function* () {
        yield* deps.connectionStore
          .remove(input.connectionRef)
          .pipe(
            Effect.mapError(toWorkflowRpcError("Failed to delete work-source connection")),
          );
      }),
      { "rpc.aggregate": "workflow" },
    ),
});
