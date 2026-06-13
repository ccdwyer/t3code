import { createHash } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type BoardListEntry,
  BoardId,
  LaneKey,
  type ProjectId,
  StepKey,
  StepRunId,
  TicketId,
  WORKFLOW_WS_METHODS,
  WorkflowDefinition,
  type WorkflowDefinition as WorkflowDefinitionType,
  type WorkflowDefinitionEncoded,
  WorkflowRpcError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { workflowRpcHandlers } from "./WorkflowRpcHandlers.ts";
import { makeWorkflowBoardSaveLocks } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowBoardVersionStoreLive } from "./WorkflowBoardVersionStore.ts";
import { defaultBoardDefinition } from "../defaultBoard.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import type { ProjectScriptTrustShape } from "../Services/ProjectScriptTrust.ts";
import type { WorkSourceConnectionStoreShape } from "../Services/WorkSourceConnectionStore.ts";
import { WorkSourceAuthError } from "../Services/WorkSourceProvider.ts";
import type {
  WorkflowBoardVersionRecordInput,
  WorkflowBoardVersionSource,
  WorkflowBoardVersionStoreShape,
} from "../Services/WorkflowBoardVersionStore.ts";
import { WorkflowBoardVersionStore } from "../Services/WorkflowBoardVersionStore.ts";
import type { WorkflowReadModelShape } from "../Services/WorkflowReadModel.ts";
import {
  encodeWorkflowDefinitionJson,
  lintWorkflowDefinition,
  type LintError,
} from "../workflowFile.ts";

const noopProjectScriptTrust = {
  isTrusted: () => Effect.succeed(false),
  setTrusted: () => Effect.void,
} satisfies ProjectScriptTrustShape;

const noopConnectionStore = {
  getToken: (connectionRef: string, _expectedProvider) =>
    Effect.fail(new WorkSourceAuthError({ connectionRef })),
  create: () => Effect.die("noopConnectionStore.create not implemented"),
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
} satisfies WorkSourceConnectionStoreShape;

const noopVersionStore = {
  record: () => Effect.void,
  list: () => Effect.succeed([]),
  get: () => Effect.succeed(null),
  deleteForBoard: () => Effect.void,
} satisfies WorkflowBoardVersionStoreShape;

const noopReadModel = {
  registerBoard: () => Effect.void,
  getBoard: () => Effect.succeed(null),
  deleteBoard: () => Effect.void,
  deleteBoardTicketState: () => Effect.void,
  deleteTicketState: () => Effect.void,
  listBoardsForProject: () => Effect.succeed([]),
  listTickets: () => Effect.succeed([]),
  countAdmittedInLane: () => Effect.succeed(0),
  oldestQueuedForLane: () => Effect.succeed(null),
  getTicketDetail: () => Effect.succeed(null),
  listTicketMessages: () => Effect.succeed([]),
  listTicketDiscussion: () => Effect.succeed([]),
  listTicketRouteDecisions: () => Effect.succeed([]),
  listReleasableDependents: () => Effect.succeed([]),
  listDependentTicketIds: () => Effect.succeed([]),
  getBoardDigest: () =>
    Effect.succeed({
      windowHours: 24,
      createdCount: 0,
      shippedCount: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      needsAttention: [],
    }),
  listNeedsAttentionTickets: () => Effect.succeed([]),
  countLanePipelineRuns: () => Effect.succeed(1),
  listStepRunsForPipeline: () => Effect.succeed([]),
  getTicketPrState: () => Effect.succeed(null),
} satisfies WorkflowReadModelShape;

const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
const decodeWorkflowDefinitionJson = Schema.decodeEffect(Schema.fromJsonString(WorkflowDefinition));
const encodeWorkflowDefinition = Schema.encodeSync(WorkflowDefinition);
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

const versionRoundTripLayer = it.layer(
  WorkflowBoardVersionStoreLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const invokeWorkflowHandler = <A>(
  handlers: ReturnType<typeof workflowRpcHandlers>,
  method: string,
  input: unknown,
): Effect.Effect<A, WorkflowRpcError> => {
  const handler = (
    handlers as unknown as Record<string, (input: unknown) => Effect.Effect<A, WorkflowRpcError>>
  )[method];
  return handler
    ? handler(input)
    : Effect.fail(new WorkflowRpcError({ message: `${method} handler is not registered` }));
};

it.effect("workflowRpcHandlers maps createTicket and subscribeBoard", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("board-1");
    const backlog = LaneKey.make("backlog");
    const review = LaneKey.make("review");
    const definition = {
      name: "Delivery",
      lanes: [
        { key: backlog, name: "Backlog", entry: "manual" },
        {
          key: review,
          name: "Review",
          entry: "manual",
          wipLimit: 2,
          pipeline: [{ key: StepKey.make("approve"), type: "approval", prompt: "Approve?" }],
        },
      ],
    } satisfies WorkflowDefinitionType;
    let editedTicket: unknown = null;
    let answeredStep: unknown = null;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.succeed(TicketId.make("ticket-created")),
        editTicket: (input) =>
          Effect.sync(() => {
            editedTicket = input;
          }),
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: (input) =>
          Effect.sync(() => {
            answeredStep = input;
          }),
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId: "project-1",
            name: "Delivery",
            workflowFilePath: ".t3/boards/delivery.json",
            workflowVersionHash: "hash",
            maxConcurrentTickets: 2,
          }),
        listTickets: () =>
          Effect.succeed([
            {
              ticketId: "ticket-1",
              boardId,
              title: "Existing",
              description: null,
              currentLaneKey: "backlog",
              currentLaneEntryToken: null,
              queuedAt: "2026-06-07T00:00:00.000Z",
              totalTokens: null,
              totalDurationMs: null,
              status: "idle",
            },
          ]),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(definition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.succeed(boardId),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/project"),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const created = yield* handlers[WORKFLOW_WS_METHODS.createTicket]({
      boardId,
      title: "New ticket",
      initialLane: backlog,
    });
    yield* handlers[WORKFLOW_WS_METHODS.editTicket]({
      ticketId: TicketId.make("ticket-1"),
      title: "Updated",
      description: "",
    });
    yield* handlers[WORKFLOW_WS_METHODS.answerTicketStep]({
      stepRunId: StepRunId.make("step-1"),
      text: "Use sandbox.",
      attachments: [],
    });
    const streamItems = Array.from(
      yield* handlers[WORKFLOW_WS_METHODS.subscribeBoard]({ boardId }).pipe(
        Stream.take(1),
        Stream.runCollect,
      ),
    );

    assert.deepEqual(created, { ticketId: "ticket-created" });
    assert.deepEqual(editedTicket, {
      ticketId: TicketId.make("ticket-1"),
      title: "Updated",
      description: "",
    });
    assert.deepEqual(answeredStep, {
      stepRunId: StepRunId.make("step-1"),
      text: "Use sandbox.",
      attachments: [],
    });
    assert.equal(streamItems[0]?.kind, "snapshot");
    if (streamItems[0]?.kind === "snapshot") {
      assert.equal(streamItems[0].snapshot.board.name, "Delivery");
      assert.equal(streamItems[0].snapshot.board.lanes[0]?.pipelineStepCount, 0);
      assert.equal(streamItems[0].snapshot.board.lanes[1]?.pipelineStepCount, 1);
      assert.equal(streamItems[0].snapshot.board.lanes[1]?.wipLimit, 2);
      assert.equal(streamItems[0].snapshot.tickets[0]?.title, "Existing");
      assert.equal(streamItems[0].snapshot.tickets[0]?.queuedAt, "2026-06-07T00:00:00.000Z");
    }
  }),
);

it.effect("workflowRpcHandlers lists and creates boards without a client path", () =>
  Effect.gen(function* () {
    const projectId = "project-rpc" as ProjectId;
    const projectRoot = "/tmp/project-rpc-root";
    const rows = new Map<
      string,
      {
        readonly boardId: string;
        readonly projectId: string;
        readonly name: string;
        readonly workflowFilePath: string;
        readonly workflowVersionHash: string;
        readonly maxConcurrentTickets: number;
      }
    >();
    const definitions = new Map<string, WorkflowDefinitionType>();
    const entries: BoardListEntry[] = [];
    const writes: Array<{
      readonly projectRoot: string;
      readonly relativePath: string;
      readonly contents: string;
    }> = [];
    const versionRecords: WorkflowBoardVersionRecordInput[] = [];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: (boardId) => Effect.succeed(rows.get(boardId as string) ?? null),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: (boardId) => Effect.succeed(definitions.get(boardId as string) ?? null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: (input) =>
          Effect.sync(() => {
            const content = writes.find(
              (write) => write.relativePath === input.relativePath,
            )?.contents;
            const definition = defaultBoardDefinition({
              name: input.relativePath.includes("-2") ? "Workflow Board" : "Workflow Board",
              agent: { instance: "codex_main", model: "gpt-5.5" },
            });
            rows.set(input.boardId as string, {
              boardId: input.boardId,
              projectId: input.projectId,
              name: definition.name,
              workflowFilePath: input.relativePath,
              workflowVersionHash: sha256Hex(content ?? ""),
              maxConcurrentTickets: 3,
            });
            definitions.set(input.boardId as string, definition);
            entries.push({
              boardId: input.boardId,
              name: definition.name,
              filePath: input.relativePath,
              error: null,
            });
            return input.boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) =>
          Effect.sync(() => {
            versionRecords.push(input);
          }),
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(null),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed(entries),
        list: () => Effect.succeed(entries),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(projectRoot),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("writeFile must not be used"),
        createFileExclusive: (input) =>
          Effect.sync(() => {
            writes.push(input);
            return { relativePath: input.relativePath };
          }),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const overlongCreate = yield* Effect.exit(
      handlers[WORKFLOW_WS_METHODS.createBoard]({
        projectId,
        name: "A".repeat(129),
        agent: { instance: "codex_main", model: "gpt-5.5" },
      }),
    );
    assert.strictEqual(overlongCreate._tag, "Failure");
    assert.deepEqual(writes, []);

    assert.deepEqual(yield* handlers[WORKFLOW_WS_METHODS.listBoards]({ projectId }), []);

    const first = yield* handlers[WORKFLOW_WS_METHODS.createBoard]({
      projectId,
      name: "Workflow Board",
      agent: { instance: "codex_main", model: "gpt-5.5" },
    });
    const second = yield* handlers[WORKFLOW_WS_METHODS.createBoard]({
      projectId,
      name: "Workflow Board",
      agent: { instance: "codex_main", model: "gpt-5.5" },
    });

    assert.equal(first.boardId, `${projectId}__workflow-board`);
    assert.equal(first.snapshot.projectId, projectId);
    assert.equal(second.boardId, `${projectId}__workflow-board-2`);
    assert.deepEqual(
      writes.map((write) => ({
        projectRoot: write.projectRoot,
        relativePath: write.relativePath,
      })),
      [
        { projectRoot, relativePath: ".t3/boards/workflow-board.json" },
        { projectRoot, relativePath: ".t3/boards/workflow-board-2.json" },
      ],
    );
    assert.deepEqual(
      versionRecords.map((record) => ({
        boardId: record.boardId,
        versionHash: record.versionHash,
        contentJson: record.contentJson,
        source: record.source,
      })),
      [
        {
          boardId: first.boardId,
          versionHash: sha256Hex(writes[0]!.contents),
          contentJson: writes[0]!.contents,
          source: "create",
        },
        {
          boardId: second.boardId,
          versionHash: sha256Hex(writes[1]!.contents),
          contentJson: writes[1]!.contents,
          source: "create",
        },
      ],
    );
    assert.deepEqual(
      (yield* handlers[WORKFLOW_WS_METHODS.listBoards]({ projectId })).map(
        (entry) => entry.boardId,
      ),
      [`${projectId}__workflow-board`, `${projectId}__workflow-board-2`],
    );
  }),
);

it.effect(
  "workflowRpcHandlers deletes the board file before clearing registration and history",
  () =>
    Effect.gen(function* () {
      const boardId = BoardId.make("project-rpc__delete-me");
      const projectId = "project-rpc" as ProjectId;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-delete-board-",
      });
      const boardFilePath = path.join(workspaceRoot, ".t3/boards/delete-me.json");
      yield* fileSystem.makeDirectory(path.join(workspaceRoot, ".t3/boards"), { recursive: true });
      yield* fileSystem.writeFileString(boardFilePath, "{}\n");
      const operations: string[] = [];
      const fileDeletes: Array<{ readonly cwd: string; readonly relativePath: string }> = [];
      const registryUnregistered: BoardId[] = [];
      const readModelDeleted: BoardId[] = [];
      const versionsDeleted: BoardId[] = [];

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: (inputBoardId) =>
            Effect.succeed(
              inputBoardId === boardId
                ? {
                    boardId,
                    projectId,
                    name: "Delete Me",
                    workflowFilePath: ".t3/boards/delete-me.json",
                    workflowVersionHash: "hash-delete-me",
                    maxConcurrentTickets: 3,
                  }
                : null,
            ),
          deleteBoard: (inputBoardId) =>
            Effect.sync(() => {
              operations.push("delete-projection");
              readModelDeleted.push(inputBoardId);
            }),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: (inputBoardId) =>
            Effect.sync(() => {
              operations.push("unregister");
              registryUnregistered.push(inputBoardId);
            }),
          getDefinition: () => Effect.succeed(null),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: () => Effect.die("unused"),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: {
          record: () => Effect.void,
          list: () => Effect.succeed([]),
          get: () => Effect.succeed(null),
          deleteForBoard: (inputBoardId) =>
            Effect.sync(() => {
              operations.push("delete-versions");
              versionsDeleted.push(inputBoardId);
            }),
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed(workspaceRoot),
        },
        workspaceFileSystem: {
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.die("unused"),
          writeFile: () => Effect.die("unused"),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: (input) =>
            Effect.gen(function* () {
              operations.push("delete-file");
              fileDeletes.push(input);
              yield* fileSystem
                .remove(path.join(input.cwd, input.relativePath), { force: true })
                .pipe(Effect.orDie);
            }),
        },
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.deleteBoard, {
        boardId,
        relativePath: "../client-supplied-escape.json",
      });

      const deletedStat = yield* fileSystem
        .stat(boardFilePath)
        .pipe(Effect.orElseSucceed(() => null));
      assert.isNull(deletedStat);
      assert.deepEqual(fileDeletes, [
        { cwd: workspaceRoot, relativePath: ".t3/boards/delete-me.json" },
      ]);
      assert.deepEqual(operations, [
        "delete-file",
        "delete-versions",
        "unregister",
        "delete-projection",
      ]);
      assert.deepEqual(registryUnregistered, [boardId]);
      assert.deepEqual(readModelDeleted, [boardId]);
      assert.deepEqual(versionsDeleted, [boardId]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "workflowRpcHandlers cascades board-owned state before deleting the board projection",
  () =>
    Effect.gen(function* () {
      const boardId = BoardId.make("project-rpc__cascade-delete");
      const projectId = "project-rpc" as ProjectId;
      const operations: string[] = [];

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: (inputBoardId: BoardId) =>
            Effect.sync(() => {
              assert.equal(inputBoardId, boardId);
              operations.push("cancel-pipelines");
            }),
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: (inputBoardId) =>
            Effect.succeed(
              inputBoardId === boardId
                ? {
                    boardId,
                    projectId,
                    name: "Cascade Delete",
                    workflowFilePath: ".t3/boards/cascade-delete.json",
                    workflowVersionHash: "hash-cascade-delete",
                    maxConcurrentTickets: 3,
                  }
                : null,
            ),
          listTickets: (inputBoardId) =>
            Effect.succeed(
              inputBoardId === boardId
                ? [
                    {
                      ticketId: "ticket-cascade-a",
                      boardId,
                      title: "A",
                      description: null,
                      currentLaneKey: "backlog",
                      currentLaneEntryToken: null,
                      queuedAt: null,
                      totalTokens: null,
                      totalDurationMs: null,
                      status: "idle",
                    },
                    {
                      ticketId: "ticket-cascade-b",
                      boardId,
                      title: "B",
                      description: null,
                      currentLaneKey: "backlog",
                      currentLaneEntryToken: null,
                      queuedAt: null,
                      totalTokens: null,
                      totalDurationMs: null,
                      status: "idle",
                    },
                  ]
                : [],
            ),
          deleteBoardTicketState: (inputBoardId: BoardId) =>
            Effect.sync(() => {
              assert.equal(inputBoardId, boardId);
              operations.push("delete-ticket-state");
            }),
          deleteBoard: (inputBoardId) =>
            Effect.sync(() => {
              assert.equal(inputBoardId, boardId);
              operations.push("delete-board");
            }),
        },
        eventStore: {
          deleteForBoard: (inputBoardId: BoardId) =>
            Effect.sync(() => {
              assert.equal(inputBoardId, boardId);
              operations.push("delete-events");
            }),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: (inputBoardId) =>
            Effect.sync(() => {
              assert.equal(inputBoardId, boardId);
              operations.push("unregister");
            }),
          getDefinition: () => Effect.succeed(null),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: () => Effect.die("unused"),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: {
          record: () => Effect.void,
          list: () => Effect.succeed([]),
          get: () => Effect.succeed(null),
          deleteForBoard: (inputBoardId) =>
            Effect.sync(() => {
              assert.equal(inputBoardId, boardId);
              operations.push("delete-versions");
            }),
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed("/workspace/project-rpc"),
        },
        workspaceFileSystem: {
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.die("unused"),
          writeFile: () => Effect.die("unused"),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () =>
            Effect.sync(() => {
              operations.push("delete-file");
            }),
        },
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.deleteBoard, { boardId });

      assert.deepEqual(operations, [
        "delete-file",
        "cancel-pipelines",
        "delete-versions",
        "delete-events",
        "delete-ticket-state",
        "unregister",
        "delete-board",
      ]);
    }),
);

it.effect("workflowRpcHandlers completes deleteBoard retry after a mid-cascade failure", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-rpc__retry-delete");
    const projectId = "project-rpc" as ProjectId;
    let boardProjectionPresent = true;
    let versionRows = 1;
    let ticketRows = 1;
    let eventRows = 1;
    let outboxRows = 1;
    let setupRows = 1;
    let failProjectionDeleteOnce = true;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: (inputBoardId) =>
          Effect.succeed(
            inputBoardId === boardId && boardProjectionPresent
              ? {
                  boardId,
                  projectId,
                  name: "Retry Delete",
                  workflowFilePath: ".t3/boards/retry-delete.json",
                  workflowVersionHash: "hash-retry-delete",
                  maxConcurrentTickets: 3,
                }
              : null,
          ),
        listTickets: (inputBoardId) =>
          Effect.succeed(
            inputBoardId === boardId && ticketRows > 0
              ? [
                  {
                    ticketId: "ticket-retry-delete",
                    boardId,
                    title: "Retry ticket",
                    description: null,
                    currentLaneKey: "backlog",
                    currentLaneEntryToken: null,
                    queuedAt: null,
                    totalTokens: null,
                    totalDurationMs: null,
                    status: "idle",
                  },
                ]
              : [],
          ),
        deleteBoardTicketState: () =>
          Effect.sync(() => {
            ticketRows = 0;
            outboxRows = 0;
            setupRows = 0;
          }),
        deleteBoard: () =>
          Effect.sync(() => {
            boardProjectionPresent = false;
          }).pipe(
            Effect.andThen(
              failProjectionDeleteOnce
                ? Effect.sync(() => {
                    failProjectionDeleteOnce = false;
                  }).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new WorkflowEventStoreError({
                          message: "simulated post-projection failure",
                        }),
                      ),
                    ),
                  )
                : Effect.void,
            ),
          ),
      },
      eventStore: {
        deleteForBoard: () =>
          Effect.sync(() => {
            eventRows = 0;
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: () => Effect.void,
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(null),
        deleteForBoard: () =>
          Effect.sync(() => {
            versionRows = 0;
          }),
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/workspace/project-rpc"),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.void,
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    let firstAttemptFailed = false;
    yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.deleteBoard, {
      boardId,
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          firstAttemptFailed = error.message === "Failed to delete workflow board state";
        }),
      ),
    );
    assert.isTrue(firstAttemptFailed);
    assert.isFalse(boardProjectionPresent);
    assert.equal(versionRows, 0);

    versionRows = 1;
    ticketRows = 1;
    eventRows = 1;
    outboxRows = 1;
    setupRows = 1;

    yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.deleteBoard, { boardId });

    assert.deepEqual(
      {
        boardProjectionPresent,
        versionRows,
        ticketRows,
        eventRows,
        outboxRows,
        setupRows,
      },
      {
        boardProjectionPresent: false,
        versionRows: 0,
        ticketRows: 0,
        eventRows: 0,
        outboxRows: 0,
        setupRows: 0,
      },
    );
  }),
);

it.effect("workflowRpcHandlers rejects deleteBoard whose derived path is not a board file", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-rpc__unsafe-delete");
    const sideEffects: string[] = [];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId: "project-rpc",
            name: "Unsafe Delete",
            workflowFilePath: ".t3/boards/../escape.json",
            workflowVersionHash: "hash-unsafe-delete",
            maxConcurrentTickets: 3,
          }),
        deleteBoard: () =>
          Effect.sync(() => {
            sideEffects.push("delete-projection");
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () =>
          Effect.sync(() => {
            sideEffects.push("unregister");
          }),
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: () => Effect.void,
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(null),
        deleteForBoard: () =>
          Effect.sync(() => {
            sideEffects.push("delete-versions");
          }),
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.die("resolve must not run for unsafe delete paths"),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () =>
          Effect.sync(() => {
            sideEffects.push("delete-file");
          }),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const result = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.deleteBoard, { boardId }),
    );

    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.isTrue(result.cause.toString().includes("not a deletable workflow board file"));
    }
    assert.deepEqual(sideEffects, []);
  }),
);

it.effect("workflowRpcHandlers includes route history in ticket detail", () =>
  Effect.gen(function* () {
    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getTicketDetail: () =>
          Effect.succeed({
            ticket: {
              ticketId: "ticket-route-rpc",
              boardId: "board-route-rpc",
              title: "Routed",
              description: null,
              currentLaneKey: "review",
              currentLaneEntryToken: null,
              queuedAt: null,
              totalTokens: null,
              totalDurationMs: null,
              status: "idle",
            },
            steps: [],
            messages: [],
          } as never),
        listTicketRouteDecisions: () =>
          Effect.succeed([
            {
              occurredAt: "2026-06-07T00:00:01.000Z",
              fromLane: "implement",
              toLane: "review",
              source: "lane_transition" as const,
              matchedTransitionIndex: 1,
              eventName: null,
              pipelineResult: "success" as const,
              laneRunCount: 2,
              steps: {
                verdict: { status: "completed", exitCode: 0, verdict: "approve" },
              },
            },
            {
              occurredAt: "2026-06-07T00:00:02.000Z",
              fromLane: null,
              toLane: "implement",
              source: "manual" as const,
              matchedTransitionIndex: null,
              eventName: null,
              pipelineResult: null,
              laneRunCount: null,
              steps: null,
            },
          ]),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/project"),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const detail = yield* handlers[WORKFLOW_WS_METHODS.getTicketDetail]({
      ticketId: TicketId.make("ticket-route-rpc"),
    });

    assert.equal(detail.routeHistory?.length, 2);
    const first = detail.routeHistory?.[0];
    assert.equal(first?.fromLane, "implement");
    assert.equal(first?.source, "lane_transition");
    assert.equal(first?.matchedTransitionIndex, 1);
    assert.equal(first?.pipelineResult, "success");
    assert.equal(first?.laneRunCount, 2);
    assert.deepEqual(first?.steps?.["verdict"], {
      status: "completed",
      exitCode: 0,
      verdict: "approve",
    });
    const second = detail.routeHistory?.[1];
    assert.equal(second?.source, "manual");
    assert.equal(second?.fromLane, undefined);
    assert.equal(second?.matchedTransitionIndex, undefined);
    assert.equal(second?.steps, undefined);
  }),
);

it.effect("workflowRpcHandlers delegates project script trust updates", () =>
  Effect.gen(function* () {
    const projectId = "project-trust-rpc" as ProjectId;
    const updates: Array<{ readonly projectId: ProjectId; readonly trusted: boolean }> = [];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: noopReadModel,
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/project"),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      projectScriptTrust: {
        isTrusted: () => Effect.die("unused"),
        setTrusted: (inputProjectId, trusted) =>
          Effect.sync(() => {
            updates.push({ projectId: inputProjectId, trusted });
          }),
      },
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    yield* handlers[WORKFLOW_WS_METHODS.setProjectScriptTrust]({
      projectId,
      trusted: true,
    });

    assert.deepEqual(updates, [{ projectId, trusted: true }]);
  }),
);

it.effect("workflowRpcHandlers delegates cooperative step cancellation", () =>
  Effect.gen(function* () {
    const stepRunId = StepRunId.make("step-run-cancel-rpc");
    const cancelled: StepRunId[] = [];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        cancelStep: (inputStepRunId) =>
          Effect.sync(() => {
            cancelled.push(inputStepRunId);
          }),
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
      },
      readModel: noopReadModel,
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/project"),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("unused"),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    yield* handlers[WORKFLOW_WS_METHODS.cancelStep]({ stepRunId });

    assert.deepEqual(cancelled, [stepRunId]);
  }),
);

it.effect("workflowRpcHandlers gets and saves encoded board definitions", () =>
  Effect.gen(function* () {
    const projectId = "project-editor-rpc" as ProjectId;
    const boardId = BoardId.make("project-editor-rpc__delivery");
    const workspaceRoot = "/tmp/editor-rpc-project";
    const workflowFilePath = ".t3/boards/delivery.json";
    const originalDefinition = yield* decodeWorkflowDefinition({
      name: "Delivery",
      lanes: [
        {
          key: "run",
          name: "Run",
          entry: "auto",
          pipeline: [{ key: "smoke", type: "script", run: "pnpm test", timeout: "5 minutes" }],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    const editedDefinition = yield* decodeWorkflowDefinition({
      name: "Delivery Edited",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual", wipLimit: 2 },
        {
          key: "run",
          name: "Run",
          entry: "auto",
          pipeline: [{ key: "smoke", type: "script", run: "pnpm test", timeout: "5 minutes" }],
          transitions: [{ when: { var: "pipeline.result" }, to: "done" }],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    const editedDefinitionEncoded = encodeWorkflowDefinition(editedDefinition);
    const originalRaw = `${encodeWorkflowDefinitionJson(originalDefinition)}\n`;
    const originalHash = sha256Hex(originalRaw);
    let fileContents = originalRaw;
    let registryDefinition = originalDefinition;
    let boardRow = {
      boardId,
      projectId,
      name: originalDefinition.name,
      workflowFilePath,
      workflowVersionHash: originalHash,
      maxConcurrentTickets: 3,
    };
    const writes: Array<{
      readonly cwd: string;
      readonly relativePath: string;
      readonly contents: string;
    }> = [];
    const versionRecords: WorkflowBoardVersionRecordInput[] = [];
    let failNextVersionRecord = false;
    let failedVersionRecordAttempts = 0;
    const lintedDefinitions: WorkflowDefinitionType[] = [];
    const loadedBoards: Array<{
      readonly boardId: BoardId;
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly relativePath: string;
    }> = [];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () => Effect.succeed(boardRow),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(registryDefinition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: (input) =>
          Effect.sync(() => {
            lintedDefinitions.push(input.definition);
            return [];
          }),
        loadAndRegister: (input) =>
          Effect.sync(() => {
            loadedBoards.push(input);
            registryDefinition = editedDefinition;
            boardRow = {
              ...boardRow,
              name: editedDefinition.name,
              workflowVersionHash: sha256Hex(fileContents),
            };
            return input.boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) =>
          failNextVersionRecord
            ? Effect.sync(() => {
                failNextVersionRecord = false;
                failedVersionRecordAttempts += 1;
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new WorkflowEventStoreError({ message: "version record unavailable" }),
                  ),
                ),
              )
            : Effect.sync(() => {
                versionRecords.push(input);
              }),
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(null),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: (input) =>
          Effect.sync(() => {
            assert.deepEqual(input, { cwd: workspaceRoot, relativePath: workflowFilePath });
            return fileContents;
          }),
        writeFile: (input) =>
          Effect.sync(() => {
            writes.push(input);
            fileContents = input.contents;
            return { relativePath: input.relativePath };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const loaded = yield* invokeWorkflowHandler<{
      readonly definition: unknown;
      readonly versionHash: string;
    }>(handlers, WORKFLOW_WS_METHODS.getBoardDefinition, { boardId });
    assert.equal(loaded.versionHash, originalHash);
    const loadedStep = (
      (loaded.definition as { readonly lanes: readonly unknown[] }).lanes[0] as {
        readonly pipeline?: readonly unknown[];
      }
    ).pipeline?.[0] as { readonly timeout?: unknown } | undefined;
    assert.isDefined(loadedStep);
    assert.isString(loadedStep.timeout);

    const saved = yield* invokeWorkflowHandler<
      | {
          readonly ok: true;
          readonly definition: unknown;
          readonly versionHash: string;
          readonly snapshot: { readonly board: { readonly name: string } };
        }
      | { readonly ok: false; readonly lintErrors: readonly unknown[] }
    >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: editedDefinitionEncoded,
      expectedVersionHash: originalHash,
      workflowFilePath: ".t3/boards/client-supplied.json",
    });

    assert.equal(saved.ok, true);
    if (saved.ok !== true) {
      assert.fail("expected successful save");
    }
    assert.equal(saved.versionHash, sha256Hex(writes[0]!.contents));
    assert.equal(saved.snapshot.board.name, "Delivery Edited");
    assert.equal(lintedDefinitions[0]?.name, "Delivery Edited");
    assert.deepEqual(
      versionRecords.map((record) => ({
        boardId: record.boardId,
        versionHash: record.versionHash,
        contentJson: record.contentJson,
        source: record.source,
      })),
      [
        {
          boardId,
          versionHash: sha256Hex(writes[0]!.contents),
          contentJson: writes[0]!.contents,
          source: "save",
        },
      ],
    );
    assert.deepEqual(
      writes.map((write) => ({
        cwd: write.cwd,
        relativePath: write.relativePath,
      })),
      [{ cwd: workspaceRoot, relativePath: workflowFilePath }],
    );
    const writtenDefinition = yield* decodeWorkflowDefinitionJson(writes[0]!.contents);
    assert.equal(writtenDefinition.name, "Delivery Edited");
    const writtenStep = writtenDefinition.lanes[1]?.pipeline?.[0];
    assert.isDefined(writtenStep);
    assert.equal(writtenStep.type, "script");
    assert.deepEqual(loadedBoards, [
      { boardId, projectId, workspaceRoot, relativePath: workflowFilePath },
    ]);
    const savedStep = (
      (saved.definition as { readonly lanes: readonly unknown[] }).lanes[1] as {
        readonly pipeline?: readonly unknown[];
      }
    ).pipeline?.[0] as { readonly timeout?: unknown } | undefined;
    assert.isDefined(savedStep);
    assert.isString(savedStep.timeout);

    const revertedDefinition = yield* decodeWorkflowDefinition({
      name: "Delivery Reverted",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    const reverted = yield* invokeWorkflowHandler<
      | {
          readonly ok: true;
          readonly definition: unknown;
          readonly versionHash: string;
        }
      | { readonly ok: false; readonly lintErrors: readonly unknown[] }
    >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: encodeWorkflowDefinition(revertedDefinition),
      expectedVersionHash: saved.versionHash,
      source: "revert",
    });
    assert.equal(reverted.ok, true);
    if (reverted.ok !== true) {
      assert.fail("expected successful revert save");
    }
    assert.equal(versionRecords.at(-1)?.source, "revert");
    assert.equal(versionRecords.at(-1)?.contentJson, writes.at(-1)?.contents);

    const afterBestEffortFailureDefinition = yield* decodeWorkflowDefinition({
      name: "Delivery After History Failure",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    failNextVersionRecord = true;
    const savedDespiteHistoryFailure = yield* invokeWorkflowHandler<
      | { readonly ok: true; readonly versionHash: string }
      | { readonly ok: false; readonly lintErrors: readonly unknown[] }
    >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: encodeWorkflowDefinition(afterBestEffortFailureDefinition),
      expectedVersionHash: reverted.versionHash,
    });
    assert.equal(savedDespiteHistoryFailure.ok, true);
    assert.equal(failedVersionRecordAttempts, 1);
  }),
);

it.effect(
  "workflowRpcHandlers renames a board display name in file, projection, registry, and history",
  () =>
    Effect.gen(function* () {
      const projectId = "project-rename-rpc" as ProjectId;
      const boardId = BoardId.make("project-rename-rpc__delivery");
      const workspaceRoot = "/tmp/rename-rpc-project";
      const workflowFilePath = ".t3/boards/delivery.json";
      const originalDefinition = yield* decodeWorkflowDefinition({
        name: "Delivery",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      let fileContents = `${encodeWorkflowDefinitionJson(originalDefinition)}\n`;
      let registryDefinition = originalDefinition;
      let boardRow = {
        boardId,
        projectId,
        name: originalDefinition.name,
        workflowFilePath,
        workflowVersionHash: sha256Hex(fileContents),
        maxConcurrentTickets: 3,
      };
      const writes: Array<{
        readonly cwd: string;
        readonly relativePath: string;
        readonly contents: string;
      }> = [];
      const versionRecords: WorkflowBoardVersionRecordInput[] = [];
      const lintedDefinitions: WorkflowDefinitionType[] = [];
      const loadedBoards: Array<{
        readonly boardId: BoardId;
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
        readonly relativePath: string;
      }> = [];

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: () => Effect.succeed(boardRow),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(registryDefinition),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
        },
        fileLoader: {
          lintDefinition: (input) =>
            Effect.sync(() => {
              lintedDefinitions.push(input.definition);
              return [];
            }),
          loadAndRegister: (input) =>
            Effect.gen(function* () {
              loadedBoards.push(input);
              const definition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
                Effect.orDie,
              );
              registryDefinition = definition;
              boardRow = {
                ...boardRow,
                name: definition.name,
                workflowVersionHash: sha256Hex(fileContents),
              };
              return input.boardId;
            }),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: {
          record: (input) =>
            Effect.sync(() => {
              versionRecords.push(input);
            }),
          list: () => Effect.succeed([]),
          get: () => Effect.succeed(null),
          deleteForBoard: () => Effect.void,
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed(workspaceRoot),
        },
        workspaceFileSystem: {
          listFiles: () => Effect.succeed([]),
          readFileString: (input) =>
            Effect.sync(() => {
              assert.deepEqual(input, { cwd: workspaceRoot, relativePath: workflowFilePath });
              return fileContents;
            }),
          writeFile: (input) =>
            Effect.sync(() => {
              writes.push(input);
              fileContents = input.contents;
              return { relativePath: input.relativePath };
            }),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () => Effect.die("unused"),
        },
        saveLocks: yield* makeWorkflowBoardSaveLocks,
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.renameBoard, {
        boardId,
        name: "Delivery Renamed",
      });

      assert.equal(boardRow.name, "Delivery Renamed");
      assert.equal(registryDefinition.name, "Delivery Renamed");
      assert.equal(lintedDefinitions[0]?.name, "Delivery Renamed");
      assert.deepEqual(
        writes.map((write) => ({
          cwd: write.cwd,
          relativePath: write.relativePath,
        })),
        [{ cwd: workspaceRoot, relativePath: workflowFilePath }],
      );
      const writtenDefinition = yield* decodeWorkflowDefinitionJson(writes[0]!.contents);
      assert.equal(writtenDefinition.name, "Delivery Renamed");
      assert.deepEqual(loadedBoards, [
        { boardId, projectId, workspaceRoot, relativePath: workflowFilePath },
      ]);
      assert.deepEqual(
        versionRecords.map((record) => ({
          boardId: record.boardId,
          versionHash: record.versionHash,
          contentJson: record.contentJson,
          source: record.source,
        })),
        [
          {
            boardId,
            versionHash: sha256Hex(writes[0]!.contents),
            contentJson: writes[0]!.contents,
            source: "rename",
          },
        ],
      );
    }),
);

it.effect(
  "workflowRpcHandlers repairs a same-name retry after registration failed post-write",
  () =>
    Effect.gen(function* () {
      const projectId = "project-rename-rpc" as ProjectId;
      const boardId = BoardId.make("project-rename-rpc__retry");
      const workspaceRoot = "/tmp/rename-rpc-retry";
      const workflowFilePath = ".t3/boards/retry.json";
      const originalDefinition = yield* decodeWorkflowDefinition({
        name: "Delivery",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      let fileContents = `${encodeWorkflowDefinitionJson(originalDefinition)}\n`;
      let registryDefinition = originalDefinition;
      let boardRow = {
        boardId,
        projectId,
        name: originalDefinition.name,
        workflowFilePath,
        workflowVersionHash: sha256Hex(fileContents),
        maxConcurrentTickets: 3,
      };
      let failNextRegistration = true;
      const writes: Array<{
        readonly cwd: string;
        readonly relativePath: string;
        readonly contents: string;
      }> = [];
      const loadedBoards: Array<{
        readonly boardId: BoardId;
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
        readonly relativePath: string;
      }> = [];
      const versionRecords: WorkflowBoardVersionRecordInput[] = [];

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: () => Effect.succeed(boardRow),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(registryDefinition),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: (input) =>
            Effect.gen(function* () {
              loadedBoards.push(input);
              if (failNextRegistration) {
                failNextRegistration = false;
                return yield* new WorkflowRpcError({ message: "registration unavailable" });
              }

              const definition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
                Effect.orDie,
              );
              registryDefinition = definition;
              boardRow = {
                ...boardRow,
                name: definition.name,
                workflowVersionHash: sha256Hex(fileContents),
              };
              return input.boardId;
            }),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: {
          record: (input) =>
            Effect.sync(() => {
              versionRecords.push(input);
            }),
          list: () =>
            Effect.succeed(
              versionRecords.map((record, index) => ({
                versionId: versionRecords.length - index,
                versionHash: record.versionHash,
                source: record.source,
                createdAt: `2026-06-08T00:00:0${index}.000Z`,
              })),
            ),
          get: () => Effect.succeed(null),
          deleteForBoard: () => Effect.void,
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed(workspaceRoot),
        },
        workspaceFileSystem: {
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.succeed(fileContents),
          writeFile: (input) =>
            Effect.sync(() => {
              writes.push(input);
              fileContents = input.contents;
              return { relativePath: input.relativePath };
            }),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () => Effect.die("unused"),
        },
        saveLocks: yield* makeWorkflowBoardSaveLocks,
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      const failed = yield* Effect.exit(
        invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.renameBoard, {
          boardId,
          name: "Delivery Renamed",
        }),
      );
      assert.strictEqual(failed._tag, "Failure");
      assert.equal(boardRow.name, "Delivery");
      assert.equal(registryDefinition.name, "Delivery");
      const failedWrite = yield* decodeWorkflowDefinitionJson(writes[0]!.contents);
      assert.equal(failedWrite.name, "Delivery Renamed");

      yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.renameBoard, {
        boardId,
        name: "Delivery Renamed",
      });

      assert.equal(boardRow.name, "Delivery Renamed");
      assert.equal(registryDefinition.name, "Delivery Renamed");
      assert.deepEqual(
        writes.map((write) => write.relativePath),
        [workflowFilePath],
      );
      assert.deepEqual(
        loadedBoards.map((loaded) => loaded.relativePath),
        [workflowFilePath, workflowFilePath],
      );
      assert.deepEqual(
        versionRecords.map((record) => ({
          boardId: record.boardId,
          versionHash: record.versionHash,
          contentJson: record.contentJson,
          source: record.source,
        })),
        [
          {
            boardId,
            versionHash: sha256Hex(fileContents),
            contentJson: fileContents,
            source: "rename",
          },
        ],
      );
    }),
);

it.effect("workflowRpcHandlers rejects blank board rename names before touching the file", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-rename-rpc__blank");
    const sideEffects: string[] = [];
    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.sync(() => {
            sideEffects.push("get-board");
            return null;
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () =>
          Effect.sync(() => {
            sideEffects.push("lint");
            return [];
          }),
        loadAndRegister: () =>
          Effect.sync(() => {
            sideEffects.push("load");
            return boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () =>
          Effect.sync(() => {
            sideEffects.push("resolve");
            return "/tmp/blank-rename";
          }),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () =>
          Effect.sync(() => {
            sideEffects.push("read");
            return "{}";
          }),
        writeFile: () =>
          Effect.sync(() => {
            sideEffects.push("write");
            return { relativePath: ".t3/boards/blank.json" };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const blank = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.renameBoard, {
        boardId,
        name: "   ",
      }),
    );

    assert.strictEqual(blank._tag, "Failure");
    assert.deepEqual(sideEffects, []);

    const overlong = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.renameBoard, {
        boardId,
        name: "A".repeat(129),
      }),
    );
    assert.strictEqual(overlong._tag, "Failure");
    assert.deepEqual(sideEffects, []);
  }),
);

it.effect("workflowRpcHandlers treats unchanged board rename names as a no-op", () =>
  Effect.gen(function* () {
    const projectId = "project-rename-rpc" as ProjectId;
    const boardId = BoardId.make("project-rename-rpc__unchanged");
    const workspaceRoot = "/tmp/rename-rpc-unchanged";
    const workflowFilePath = ".t3/boards/unchanged.json";
    const definition = yield* decodeWorkflowDefinition({
      name: "Delivery",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const fileContents = `${encodeWorkflowDefinitionJson(definition)}\n`;
    const sideEffects: string[] = [];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId,
            name: "Delivery",
            workflowFilePath,
            workflowVersionHash: sha256Hex(fileContents),
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(definition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () =>
          Effect.sync(() => {
            sideEffects.push("lint");
            return [];
          }),
        loadAndRegister: () =>
          Effect.sync(() => {
            sideEffects.push("load");
            return boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: () =>
          Effect.sync(() => {
            sideEffects.push("version");
          }),
        list: () =>
          Effect.succeed([
            {
              versionId: 1,
              versionHash: sha256Hex(fileContents),
              source: "rename",
              createdAt: "2026-06-08T00:00:00.000Z",
            },
          ]),
        get: () => Effect.succeed(null),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(fileContents),
        writeFile: () =>
          Effect.sync(() => {
            sideEffects.push("write");
            return { relativePath: workflowFilePath };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      saveLocks: yield* makeWorkflowBoardSaveLocks,
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    yield* invokeWorkflowHandler<void>(handlers, WORKFLOW_WS_METHODS.renameBoard, {
      boardId,
      name: "Delivery",
    });

    assert.deepEqual(sideEffects, []);
  }),
);

it.effect("workflowRpcHandlers reports missing boards during rename without writing", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-rename-rpc__missing");
    const sideEffects: string[] = [];
    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: noopReadModel,
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(null),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () =>
          Effect.sync(() => {
            sideEffects.push("lint");
            return [];
          }),
        loadAndRegister: () =>
          Effect.sync(() => {
            sideEffects.push("load");
            return boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () =>
          Effect.sync(() => {
            sideEffects.push("resolve");
            return "/tmp/missing-rename";
          }),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () =>
          Effect.sync(() => {
            sideEffects.push("read");
            return "{}";
          }),
        writeFile: () =>
          Effect.sync(() => {
            sideEffects.push("write");
            return { relativePath: ".t3/boards/missing.json" };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      saveLocks: yield* makeWorkflowBoardSaveLocks,
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const result = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.renameBoard, {
        boardId,
        name: "Missing renamed",
      }),
    );

    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.isTrue(result.cause.toString().includes(`Workflow board ${boardId} was not found`));
    }
    assert.deepEqual(sideEffects, []);
  }),
);

it.effect(
  "workflowRpcHandlers serializes rename racing delete without resurrecting board state",
  () =>
    Effect.gen(function* () {
      const projectId = "project-rename-rpc" as ProjectId;
      const boardId = BoardId.make("project-rename-rpc__race-delete");
      const workspaceRoot = "/tmp/rename-rpc-race-delete";
      const workflowFilePath = ".t3/boards/race-delete.json";
      const originalDefinition = yield* decodeWorkflowDefinition({
        name: "Race Delete",
        lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
      });
      let filePresent = true;
      let fileContents = `${encodeWorkflowDefinitionJson(originalDefinition)}\n`;
      let registryDefinition: WorkflowDefinitionType | null = originalDefinition;
      let boardProjectionPresent = true;
      let boardRow = {
        boardId,
        projectId,
        name: originalDefinition.name,
        workflowFilePath,
        workflowVersionHash: sha256Hex(fileContents),
        maxConcurrentTickets: 3,
      };
      const versionRecords: WorkflowBoardVersionRecordInput[] = [];
      const renameWriteStarted = yield* Deferred.make<void>();
      const allowRenameWrite = yield* Deferred.make<void>();
      const saveLocks = yield* makeWorkflowBoardSaveLocks;

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: () => Effect.succeed(boardProjectionPresent ? boardRow : null),
          deleteBoard: () =>
            Effect.sync(() => {
              boardProjectionPresent = false;
            }),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () =>
            Effect.sync(() => {
              registryDefinition = null;
            }),
          getDefinition: () => Effect.succeed(registryDefinition),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: (input) =>
            Effect.gen(function* () {
              const definition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
                Effect.orDie,
              );
              registryDefinition = definition;
              boardRow = {
                ...boardRow,
                name: definition.name,
                workflowVersionHash: sha256Hex(fileContents),
              };
              boardProjectionPresent = true;
              return input.boardId;
            }),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: {
          record: (input) =>
            Effect.sync(() => {
              versionRecords.push(input);
            }),
          list: () => Effect.succeed([]),
          get: () => Effect.succeed(null),
          deleteForBoard: () =>
            Effect.sync(() => {
              versionRecords.splice(0, versionRecords.length);
            }),
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed(workspaceRoot),
        },
        workspaceFileSystem: {
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.succeed(fileContents),
          writeFile: (input) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(renameWriteStarted, undefined);
              yield* Deferred.await(allowRenameWrite);
              filePresent = true;
              fileContents = input.contents;
              return { relativePath: input.relativePath };
            }),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () =>
            Effect.sync(() => {
              filePresent = false;
            }),
        },
        saveLocks,
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      const renameFiber = yield* invokeWorkflowHandler<void>(
        handlers,
        WORKFLOW_WS_METHODS.renameBoard,
        {
          boardId,
          name: "Race Delete Renamed",
        },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(renameWriteStarted);
      const deleteFiber = yield* invokeWorkflowHandler<void>(
        handlers,
        WORKFLOW_WS_METHODS.deleteBoard,
        {
          boardId,
        },
      ).pipe(Effect.forkChild);
      yield* Deferred.succeed(allowRenameWrite, undefined);

      yield* Fiber.join(renameFiber);
      yield* Fiber.join(deleteFiber);

      assert.isFalse(filePresent);
      assert.isFalse(boardProjectionPresent);
      assert.isNull(registryDefinition);
      assert.deepEqual(versionRecords, []);
    }),
);

it.effect("workflowRpcHandlers lists board versions and lazy-imports missing history", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-version-rpc__delivery");
    const otherBoardId = BoardId.make("project-version-rpc__other");
    const projectId = "project-version-rpc" as ProjectId;
    const workspaceRoot = "/tmp/project-version-rpc-root";
    const workflowFilePath = ".t3/boards/delivery.json";
    const importedDefinition = yield* decodeWorkflowDefinition({
      name: "Imported Delivery",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    const savedDefinition = yield* decodeWorkflowDefinition({
      name: "Saved Delivery",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual" },
        { key: "review", name: "Review", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    const importedRaw = `${encodeWorkflowDefinitionJson(importedDefinition)}\n`;
    const savedRaw = `${encodeWorkflowDefinitionJson(savedDefinition)}\n`;
    const importedHash = sha256Hex(importedRaw);
    const savedHash = sha256Hex(savedRaw);
    const recorded: WorkflowBoardVersionRecordInput[] = [];
    const versions: Array<{
      readonly boardId: BoardId;
      readonly versionId: number;
      readonly versionHash: string;
      readonly contentJson: string;
      readonly source: WorkflowBoardVersionSource;
      readonly createdAt: string;
    }> = [];
    let nextVersionId = 1;

    const addVersion = (input: WorkflowBoardVersionRecordInput, createdAt: string) => {
      versions.push({
        boardId: input.boardId,
        versionId: nextVersionId,
        versionHash: input.versionHash,
        contentJson: input.contentJson,
        source: input.source,
        createdAt,
      });
      nextVersionId += 1;
    };

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: (inputBoardId) =>
          Effect.succeed(
            inputBoardId === boardId
              ? {
                  boardId,
                  projectId,
                  name: "Imported Delivery",
                  workflowFilePath,
                  workflowVersionHash: importedHash,
                  maxConcurrentTickets: 3,
                }
              : null,
          ),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.die("unused"),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () => Effect.die("unused"),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) =>
          Effect.sync(() => {
            recorded.push(input);
            addVersion(input, "2026-06-08T12:00:00.000Z");
          }),
        list: (inputBoardId) =>
          Effect.succeed(
            versions
              .filter((version) => version.boardId === inputBoardId)
              .toSorted((left, right) => right.versionId - left.versionId)
              .map(({ contentJson: _contentJson, boardId: _boardId, ...summary }) => summary),
          ),
        get: (inputBoardId, versionId) =>
          Effect.succeed(
            versions.find(
              (version) => version.boardId === inputBoardId && version.versionId === versionId,
            ) ?? null,
          ),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: (inputProjectId) =>
          Effect.sync(() => {
            assert.equal(inputProjectId, projectId);
            return workspaceRoot;
          }),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: (input) =>
          Effect.sync(() => {
            assert.deepEqual(input, { cwd: workspaceRoot, relativePath: workflowFilePath });
            return importedRaw;
          }),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const importedVersions = yield* invokeWorkflowHandler<
      ReadonlyArray<{
        readonly versionId: number;
        readonly versionHash: string;
        readonly source: string;
        readonly createdAt: string;
        readonly isCurrent: boolean;
      }>
    >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });

    assert.deepEqual(recorded, [
      {
        boardId,
        versionHash: importedHash,
        contentJson: importedRaw,
        source: "import",
      },
    ]);
    assert.deepEqual(importedVersions, [
      {
        versionId: 1,
        versionHash: importedHash,
        source: "import",
        createdAt: "2026-06-08T12:00:00.000Z",
        isCurrent: true,
      },
    ]);
    assert.equal("contentJson" in importedVersions[0]!, false);

    addVersion(
      {
        boardId,
        versionHash: savedHash,
        contentJson: savedRaw,
        source: "save",
      },
      "2026-06-08T12:05:00.000Z",
    );
    const listedVersions = yield* invokeWorkflowHandler<
      ReadonlyArray<{
        readonly versionId: number;
        readonly versionHash: string;
        readonly source: string;
        readonly createdAt: string;
        readonly isCurrent: boolean;
      }>
    >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });
    assert.deepEqual(listedVersions, [
      {
        versionId: 2,
        versionHash: savedHash,
        source: "save",
        createdAt: "2026-06-08T12:05:00.000Z",
        isCurrent: true,
      },
      {
        versionId: 1,
        versionHash: importedHash,
        source: "import",
        createdAt: "2026-06-08T12:00:00.000Z",
        isCurrent: false,
      },
    ]);

    const importedVersion = yield* invokeWorkflowHandler<{
      readonly versionId: number;
      readonly definition: unknown;
      readonly versionHash: string;
      readonly source: string;
      readonly createdAt: string;
    }>(handlers, WORKFLOW_WS_METHODS.getBoardVersion, { boardId, versionId: 1 });
    assert.equal(importedVersion.versionId, 1);
    assert.equal(
      (importedVersion.definition as { readonly name: string }).name,
      "Imported Delivery",
    );
    assert.equal(importedVersion.versionHash, importedHash);
    assert.equal(importedVersion.source, "import");
    assert.equal(importedVersion.createdAt, "2026-06-08T12:00:00.000Z");

    const missingVersion = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.getBoardVersion, {
        boardId,
        versionId: 999,
      }),
    );
    assert.strictEqual(missingVersion._tag, "Failure");

    const wrongBoardVersion = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.getBoardVersion, {
        boardId: otherBoardId,
        versionId: 1,
      }),
    );
    assert.strictEqual(wrongBoardVersion._tag, "Failure");
  }),
);

it.effect("workflowRpcHandlers records only one lazy import for concurrent history opens", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-version-rpc__concurrent-import");
    const projectId = "project-version-rpc" as ProjectId;
    const workspaceRoot = "/tmp/project-version-rpc-root";
    const workflowFilePath = ".t3/boards/concurrent-import.json";
    const importedDefinition = yield* decodeWorkflowDefinition({
      name: "Concurrent Import",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const importedRaw = `${encodeWorkflowDefinitionJson(importedDefinition)}\n`;
    const importedHash = sha256Hex(importedRaw);
    const recorded: WorkflowBoardVersionRecordInput[] = [];
    const versions: Array<{
      readonly boardId: BoardId;
      readonly versionId: number;
      readonly versionHash: string;
      readonly contentJson: string;
      readonly source: WorkflowBoardVersionSource;
      readonly createdAt: string;
    }> = [];
    let nextVersionId = 1;
    let initialListCalls = 0;
    const initialListsEntered = yield* Deferred.make<void>();
    const saveLocks = yield* makeWorkflowBoardSaveLocks;

    const addVersion = (input: WorkflowBoardVersionRecordInput) => {
      versions.push({
        boardId: input.boardId,
        versionId: nextVersionId,
        versionHash: input.versionHash,
        contentJson: input.contentJson,
        source: input.source,
        createdAt: "2026-06-08T12:00:00.000Z",
      });
      nextVersionId += 1;
    };

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId,
            name: importedDefinition.name,
            workflowFilePath,
            workflowVersionHash: importedHash,
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.die("unused"),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      saveLocks,
      fileLoader: {
        lintDefinition: () => Effect.die("unused"),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) =>
          Effect.sync(() => {
            recorded.push(input);
            addVersion(input);
          }),
        list: (inputBoardId) =>
          Effect.gen(function* () {
            const snapshot = versions
              .filter((version) => version.boardId === inputBoardId)
              .toSorted((left, right) => right.versionId - left.versionId)
              .map(({ contentJson: _contentJson, boardId: _boardId, ...summary }) => summary);
            if (initialListCalls < 2) {
              initialListCalls += 1;
              if (initialListCalls === 2) {
                yield* Deferred.succeed(initialListsEntered, undefined);
              } else {
                yield* Deferred.await(initialListsEntered);
              }
            }
            return snapshot;
          }),
        get: () => Effect.succeed(null),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(importedRaw),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const listVersions = invokeWorkflowHandler<
      ReadonlyArray<{
        readonly source: string;
        readonly isCurrent: boolean;
      }>
    >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });

    const first = yield* listVersions.pipe(Effect.forkChild);
    const second = yield* listVersions.pipe(Effect.forkChild);
    const results = [yield* Fiber.join(first), yield* Fiber.join(second)];

    assert.deepEqual(recorded, [
      {
        boardId,
        versionHash: importedHash,
        contentJson: importedRaw,
        source: "import",
      },
    ]);
    assert.deepEqual(
      results.map((result) => result.map((version) => version.source)),
      [["import"], ["import"]],
    );
  }),
);

it.effect("workflowRpcHandlers serializes createBoard against lazy history import", () =>
  Effect.gen(function* () {
    const projectId = "project-create-import-race" as ProjectId;
    const boardId = BoardId.make(`${projectId}__race-board`);
    const workspaceRoot = "/tmp/project-create-import-race-root";
    const saveLocks = yield* makeWorkflowBoardSaveLocks;
    const createdBoardRegistered = yield* Deferred.make<void>();
    const versions: Array<{
      readonly boardId: BoardId;
      readonly versionId: number;
      readonly versionHash: string;
      readonly contentJson: string;
      readonly source: WorkflowBoardVersionSource;
      readonly createdAt: string;
    }> = [];
    let nextVersionId = 1;
    let fileContents = "";
    let registryDefinition: WorkflowDefinitionType | null = null;
    let boardRow: {
      readonly boardId: BoardId;
      readonly projectId: ProjectId;
      readonly name: string;
      readonly workflowFilePath: string;
      readonly workflowVersionHash: string;
      readonly maxConcurrentTickets: number;
    } | null = null;

    const versionSummaries = (inputBoardId: BoardId) =>
      versions
        .filter((version) => version.boardId === inputBoardId)
        .toSorted((left, right) => right.versionId - left.versionId)
        .map(({ contentJson: _contentJson, boardId: _boardId, ...summary }) => summary);

    const recordVersion = (input: WorkflowBoardVersionRecordInput) => {
      const newest = versionSummaries(input.boardId)[0];
      if (newest?.versionHash === input.versionHash) {
        return;
      }
      versions.push({
        boardId: input.boardId,
        versionId: nextVersionId,
        versionHash: input.versionHash,
        contentJson: input.contentJson,
        source: input.source,
        createdAt: "2026-06-08T12:00:00.000Z",
      });
      nextVersionId += 1;
    };

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: (inputBoardId) => Effect.succeed(inputBoardId === boardId ? boardRow : null),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(registryDefinition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      saveLocks,
      fileLoader: {
        lintDefinition: () => Effect.die("unused"),
        loadAndRegister: (input) =>
          Effect.gen(function* () {
            registryDefinition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
              Effect.orDie,
            );
            boardRow = {
              boardId: input.boardId,
              projectId: input.projectId,
              name: registryDefinition.name,
              workflowFilePath: input.relativePath,
              workflowVersionHash: sha256Hex(fileContents),
              maxConcurrentTickets: 3,
            };
            yield* Deferred.succeed(createdBoardRegistered, undefined);
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            return input.boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) => Effect.sync(() => recordVersion(input)),
        list: (inputBoardId) => Effect.sync(() => versionSummaries(inputBoardId)),
        get: () => Effect.succeed(null),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(fileContents),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: (input) =>
          Effect.sync(() => {
            fileContents = input.contents;
            return { relativePath: input.relativePath };
          }),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const createFiber = yield* invokeWorkflowHandler<{
      readonly boardId: BoardId;
    }>(handlers, WORKFLOW_WS_METHODS.createBoard, {
      projectId,
      name: "Race Board",
      agent: { instance: "codex_main", model: "gpt-5.5" },
    }).pipe(Effect.forkChild);

    yield* Deferred.await(createdBoardRegistered);
    const listFiber = yield* invokeWorkflowHandler<
      ReadonlyArray<{
        readonly source: string;
        readonly isCurrent: boolean;
      }>
    >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId }).pipe(Effect.forkChild);

    const created = yield* Fiber.join(createFiber);
    const listed = yield* Fiber.join(listFiber);

    assert.equal(created.boardId, boardId);
    assert.deepEqual(
      versions.map((version) => version.source),
      ["create"],
    );
    assert.deepEqual(
      listed.map((version) => ({ source: version.source, isCurrent: version.isCurrent })),
      [{ source: "create", isCurrent: true }],
    );
  }),
);

it.effect("workflowRpcHandlers skips lazy import when history appears after an empty read", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-version-rpc__history-populated");
    const projectId = "project-version-rpc" as ProjectId;
    const workspaceRoot = "/tmp/project-version-rpc-root";
    const workflowFilePath = ".t3/boards/history-populated.json";
    const importedDefinition = yield* decodeWorkflowDefinition({
      name: "Imported Before Existing Save",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const savedDefinition = yield* decodeWorkflowDefinition({
      name: "Existing Save",
      lanes: [
        { key: "queue", name: "Queue", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ],
    });
    const importedRaw = `${encodeWorkflowDefinitionJson(importedDefinition)}\n`;
    const savedRaw = `${encodeWorkflowDefinitionJson(savedDefinition)}\n`;
    const importedHash = sha256Hex(importedRaw);
    const savedHash = sha256Hex(savedRaw);
    const recorded: WorkflowBoardVersionRecordInput[] = [];
    const versions: Array<{
      readonly boardId: BoardId;
      readonly versionId: number;
      readonly versionHash: string;
      readonly contentJson: string;
      readonly source: WorkflowBoardVersionSource;
      readonly createdAt: string;
    }> = [
      {
        boardId,
        versionId: 1,
        versionHash: savedHash,
        contentJson: savedRaw,
        source: "save",
        createdAt: "2026-06-08T12:05:00.000Z",
      },
    ];
    let nextVersionId = 2;
    let listCalls = 0;
    const saveLocks = yield* makeWorkflowBoardSaveLocks;

    const addVersion = (input: WorkflowBoardVersionRecordInput) => {
      versions.push({
        boardId: input.boardId,
        versionId: nextVersionId,
        versionHash: input.versionHash,
        contentJson: input.contentJson,
        source: input.source,
        createdAt: "2026-06-08T12:00:00.000Z",
      });
      nextVersionId += 1;
    };

    const versionSummaries = (inputBoardId: BoardId) =>
      versions
        .filter((version) => version.boardId === inputBoardId)
        .toSorted((left, right) => right.versionId - left.versionId)
        .map(({ contentJson: _contentJson, boardId: _boardId, ...summary }) => summary);

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId,
            name: importedDefinition.name,
            workflowFilePath,
            workflowVersionHash: importedHash,
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(importedDefinition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      saveLocks,
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) =>
          Effect.sync(() => {
            recorded.push(input);
            addVersion(input);
          }),
        list: (inputBoardId) =>
          Effect.sync(() => {
            listCalls += 1;
            return listCalls === 1 ? [] : versionSummaries(inputBoardId);
          }),
        get: () => Effect.succeed(null),
        deleteForBoard: () => Effect.void,
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(importedRaw),
        writeFile: () => Effect.die("unused"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const listedVersions = yield* invokeWorkflowHandler<
      ReadonlyArray<{
        readonly source: string;
        readonly isCurrent: boolean;
      }>
    >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });
    assert.deepEqual(recorded, []);
    assert.deepEqual(
      listedVersions.map((version) => ({
        source: version.source,
        isCurrent: version.isCurrent,
      })),
      [{ source: "save", isCurrent: true }],
    );
  }),
);

versionRoundTripLayer("workflowRpcHandlers version history round trip", (it) => {
  it.effect("imports, saves, loads, and re-saves a reverted board version", () =>
    Effect.gen(function* () {
      const versionStore = yield* WorkflowBoardVersionStore;
      const boardId = BoardId.make("project-version-round-trip__delivery");
      const projectId = "project-version-round-trip" as ProjectId;
      const workspaceRoot = "/tmp/project-version-round-trip-root";
      const workflowFilePath = ".t3/boards/delivery.json";
      const importedDefinition = yield* decodeWorkflowDefinition({
        name: "Imported Delivery",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      const savedDefinition = yield* decodeWorkflowDefinition({
        name: "Saved Delivery",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual" },
          { key: "review", name: "Review", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      const currentDefinition = yield* decodeWorkflowDefinition({
        name: "Current Delivery",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual" },
          { key: "review", name: "Review", entry: "auto" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      let fileContents = `${encodeWorkflowDefinitionJson(importedDefinition)}\n`;
      let registryDefinition = importedDefinition;
      let boardRow = {
        boardId,
        projectId,
        name: importedDefinition.name,
        workflowFilePath,
        workflowVersionHash: sha256Hex(fileContents),
        maxConcurrentTickets: 3,
      };

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: (inputBoardId) => Effect.succeed(inputBoardId === boardId ? boardRow : null),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(registryDefinition),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: (input) =>
            Effect.gen(function* () {
              const definition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
                Effect.mapError(
                  (cause) =>
                    new WorkflowRpcError({
                      message: "round-trip workflow definition decode failed",
                      cause,
                    }),
                ),
              );
              registryDefinition = definition;
              boardRow = {
                ...boardRow,
                name: definition.name,
                workflowVersionHash: sha256Hex(fileContents),
              };
              return input.boardId;
            }),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore,
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed(workspaceRoot),
        },
        workspaceFileSystem: {
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.succeed(fileContents),
          writeFile: (input) =>
            Effect.sync(() => {
              fileContents = input.contents;
              return { relativePath: input.relativePath };
            }),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () => Effect.die("unused"),
        },
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      const importedVersions = yield* invokeWorkflowHandler<
        ReadonlyArray<{
          readonly versionId: number;
          readonly source: string;
          readonly isCurrent: boolean;
        }>
      >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });
      assert.deepEqual(
        importedVersions.map((version) => ({
          source: version.source,
          isCurrent: version.isCurrent,
        })),
        [{ source: "import", isCurrent: true }],
      );

      const firstSave = yield* invokeWorkflowHandler<
        | { readonly ok: true; readonly versionHash: string }
        | { readonly ok: false; readonly lintErrors: readonly unknown[] }
      >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: encodeWorkflowDefinition(savedDefinition),
        expectedVersionHash: boardRow.workflowVersionHash,
      });
      assert.equal(firstSave.ok, true);
      if (firstSave.ok !== true) {
        assert.fail("expected first save to succeed");
      }

      const secondSave = yield* invokeWorkflowHandler<
        | { readonly ok: true; readonly versionHash: string }
        | { readonly ok: false; readonly lintErrors: readonly unknown[] }
      >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: encodeWorkflowDefinition(currentDefinition),
        expectedVersionHash: firstSave.versionHash,
      });
      assert.equal(secondSave.ok, true);
      if (secondSave.ok !== true) {
        assert.fail("expected second save to succeed");
      }

      const versionsBeforeRevert = yield* invokeWorkflowHandler<
        ReadonlyArray<{
          readonly versionId: number;
          readonly versionHash: string;
          readonly source: string;
          readonly isCurrent: boolean;
        }>
      >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });
      assert.deepEqual(
        versionsBeforeRevert.map((version) => ({
          source: version.source,
          isCurrent: version.isCurrent,
        })),
        [
          { source: "save", isCurrent: true },
          { source: "save", isCurrent: false },
          { source: "import", isCurrent: false },
        ],
      );

      const importVersion = versionsBeforeRevert.at(-1);
      assert.isDefined(importVersion);
      const loadedImport = yield* invokeWorkflowHandler<{
        readonly versionId: number;
        readonly definition: WorkflowDefinitionEncoded;
        readonly versionHash: string;
        readonly source: string;
      }>(handlers, WORKFLOW_WS_METHODS.getBoardVersion, {
        boardId,
        versionId: importVersion.versionId,
      });
      assert.equal(loadedImport.source, "import");
      assert.equal(loadedImport.definition.name, "Imported Delivery");

      const revertSave = yield* invokeWorkflowHandler<
        | { readonly ok: true; readonly versionHash: string }
        | { readonly ok: false; readonly lintErrors: readonly unknown[] }
      >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: loadedImport.definition,
        expectedVersionHash: secondSave.versionHash,
        source: "revert",
      });
      assert.equal(revertSave.ok, true);

      const versionsAfterRevert = yield* invokeWorkflowHandler<
        ReadonlyArray<{
          readonly versionHash: string;
          readonly source: string;
          readonly isCurrent: boolean;
        }>
      >(handlers, WORKFLOW_WS_METHODS.listBoardVersions, { boardId });
      assert.deepEqual(
        versionsAfterRevert.map((version) => ({
          versionHash: version.versionHash,
          source: version.source,
          isCurrent: version.isCurrent,
        })),
        [
          {
            versionHash: loadedImport.versionHash,
            source: "revert",
            isCurrent: true,
          },
          {
            versionHash: secondSave.versionHash,
            source: "save",
            isCurrent: false,
          },
          {
            versionHash: firstSave.versionHash,
            source: "save",
            isCurrent: false,
          },
          {
            versionHash: loadedImport.versionHash,
            source: "import",
            isCurrent: false,
          },
        ],
      );
    }),
  );
});

it.effect("workflowRpcHandlers rejects lint-invalid board saves without writing", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-editor-rpc__invalid");
    const definition = yield* decodeWorkflowDefinition({
      name: "Invalid",
      lanes: [{ key: "queue", name: "Queue", entry: "manual", wipLimit: 0 }],
    });
    const definitionEncoded = encodeWorkflowDefinition(definition);
    const currentRaw = `${encodeWorkflowDefinitionJson(definition)}\n`;
    const currentHash = sha256Hex(currentRaw);
    let writeCount = 0;
    const lintErrors: ReadonlyArray<LintError> = [
      {
        code: "invalid_wip_limit",
        message: "Lane queue wipLimit must be at least 1",
        laneKey: "queue",
      },
    ];

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId: "project-editor-rpc",
            name: "Invalid",
            workflowFilePath: ".t3/boards/invalid.json",
            workflowVersionHash: currentHash,
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(definition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed(lintErrors),
        loadAndRegister: () => Effect.die("loadAndRegister must not run after lint failure"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/editor-rpc-project"),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(currentRaw),
        writeFile: () =>
          Effect.sync(() => {
            writeCount += 1;
            return { relativePath: ".t3/boards/invalid.json" };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const saved = yield* invokeWorkflowHandler<{
      readonly ok: false;
      readonly lintErrors: ReadonlyArray<{
        readonly code: string;
        readonly message: string;
        readonly laneKey?: string;
      }>;
    }>(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: definitionEncoded,
      expectedVersionHash: currentHash,
    });

    assert.equal(saved.ok, false);
    assert.deepEqual(saved.lintErrors, lintErrors);
    assert.equal(writeCount, 0);
  }),
);

it.effect("workflowRpcHandlers rejects stale board saves without writing", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-editor-rpc__stale");
    const definition = yield* decodeWorkflowDefinition({
      name: "Stale",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const definitionEncoded = encodeWorkflowDefinition(definition);
    const currentRaw = `${encodeWorkflowDefinitionJson(definition)}\n`;
    const currentHash = sha256Hex(currentRaw);
    const workspaceRoot = "/tmp/editor-rpc-project";
    let writeCount = 0;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId: "project-editor-rpc",
            name: "Stale",
            workflowFilePath: ".t3/boards/stale.json",
            workflowVersionHash: currentHash,
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(definition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () => Effect.die("lintDefinition must not run after version conflict"),
        loadAndRegister: () => Effect.die("loadAndRegister must not run after version conflict"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: (input) =>
          Effect.sync(() => {
            assert.deepEqual(input, {
              cwd: workspaceRoot,
              relativePath: ".t3/boards/stale.json",
            });
            return currentRaw;
          }),
        writeFile: () =>
          Effect.sync(() => {
            writeCount += 1;
            return { relativePath: ".t3/boards/stale.json" };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const saved = yield* invokeWorkflowHandler<
      | { readonly ok: true; readonly versionHash: string }
      | { readonly ok: false; readonly lintErrors: readonly unknown[] }
      | { readonly ok: false; readonly conflict: true; readonly currentVersionHash: string }
    >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: definitionEncoded,
      expectedVersionHash: "hash-stale",
    });

    assert.deepEqual(saved, {
      ok: false,
      conflict: true,
      currentVersionHash: currentHash,
    });
    assert.equal(writeCount, 0);
  }),
);

it.effect("workflowRpcHandlers rejects saves when the board file changed on disk", () =>
  Effect.gen(function* () {
    const projectId = "project-editor-rpc" as ProjectId;
    const boardId = BoardId.make("project-editor-rpc__external-edit");
    const workspaceRoot = "/tmp/editor-rpc-project";
    const workflowFilePath = ".t3/boards/external-edit.json";
    const originalDefinition = yield* decodeWorkflowDefinition({
      name: "External Edit",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const editedDefinition = yield* decodeWorkflowDefinition({
      name: "External Edit Saved",
      lanes: [{ key: "queue", name: "Queue Saved", entry: "manual" }],
    });
    const externalDefinition = yield* decodeWorkflowDefinition({
      name: "External Edit Hand Edited",
      lanes: [{ key: "queue", name: "Queue Hand Edited", entry: "manual" }],
    });
    const originalRaw = `${encodeWorkflowDefinitionJson(originalDefinition)}\n`;
    const externalRaw = `${encodeWorkflowDefinitionJson(externalDefinition)}\n`;
    const originalHash = sha256Hex(originalRaw);
    const externalHash = sha256Hex(externalRaw);
    let fileContents = originalRaw;
    let writeCount = 0;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId,
            name: "External Edit",
            workflowFilePath,
            workflowVersionHash: originalHash,
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(originalDefinition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: () => Effect.die("loadAndRegister must not run after on-disk conflict"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: (input) =>
          Effect.sync(() => {
            assert.deepEqual(input, { cwd: workspaceRoot, relativePath: workflowFilePath });
            return fileContents;
          }),
        writeFile: (input) =>
          Effect.sync(() => {
            writeCount += 1;
            fileContents = input.contents;
            return { relativePath: input.relativePath };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const loaded = yield* invokeWorkflowHandler<{
      readonly versionHash: string;
    }>(handlers, WORKFLOW_WS_METHODS.getBoardDefinition, { boardId });
    fileContents = externalRaw;

    const saved = yield* invokeWorkflowHandler<
      | { readonly ok: true; readonly versionHash: string }
      | { readonly ok: false; readonly lintErrors: readonly unknown[] }
      | { readonly ok: false; readonly conflict: true; readonly currentVersionHash: string }
    >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: encodeWorkflowDefinition(editedDefinition),
      expectedVersionHash: loaded.versionHash,
    });

    assert.deepEqual(saved, {
      ok: false,
      conflict: true,
      currentVersionHash: externalHash,
    });
    assert.equal(writeCount, 0);
    assert.equal(fileContents, externalRaw);
  }),
);

it.effect("workflowRpcHandlers serializes same-base board saves so only one succeeds", () =>
  Effect.gen(function* () {
    const projectId = "project-editor-rpc" as ProjectId;
    const boardId = BoardId.make("project-editor-rpc__concurrent");
    const workspaceRoot = "/tmp/editor-rpc-project";
    const workflowFilePath = ".t3/boards/concurrent.json";
    const baseDefinition = yield* decodeWorkflowDefinition({
      name: "Concurrent",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const firstDefinition = yield* decodeWorkflowDefinition({
      name: "Concurrent First",
      lanes: [{ key: "queue", name: "Queue First", entry: "manual" }],
    });
    const secondDefinition = yield* decodeWorkflowDefinition({
      name: "Concurrent Second",
      lanes: [{ key: "queue", name: "Queue Second", entry: "manual" }],
    });
    const baseRaw = `${encodeWorkflowDefinitionJson(baseDefinition)}\n`;
    const baseHash = sha256Hex(baseRaw);
    let fileContents = baseRaw;
    let registryDefinition = baseDefinition;
    let boardRow = {
      boardId,
      projectId,
      name: baseDefinition.name,
      workflowFilePath,
      workflowVersionHash: baseHash,
      maxConcurrentTickets: 3,
    };
    let writeCount = 0;
    const firstWriteEntered = yield* Deferred.make<void>();
    const saveLocks = yield* makeWorkflowBoardSaveLocks;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () => Effect.succeed(boardRow),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(registryDefinition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      saveLocks,
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: (input) =>
          Effect.gen(function* () {
            registryDefinition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
              Effect.orDie,
            );
            boardRow = {
              ...boardRow,
              name: registryDefinition.name,
              workflowVersionHash: sha256Hex(fileContents),
            };
            return input.boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(fileContents),
        writeFile: (input) =>
          Effect.gen(function* () {
            writeCount += 1;
            if (writeCount === 1) {
              yield* Deferred.succeed(firstWriteEntered, undefined);
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
              yield* Effect.yieldNow;
            }
            fileContents = input.contents;
            return { relativePath: input.relativePath };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const save = (definition: WorkflowDefinitionType) =>
      invokeWorkflowHandler<
        | { readonly ok: true; readonly versionHash: string }
        | { readonly ok: false; readonly lintErrors: readonly unknown[] }
        | { readonly ok: false; readonly conflict: true; readonly currentVersionHash: string }
      >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: encodeWorkflowDefinition(definition),
        expectedVersionHash: baseHash,
      });

    const first = yield* save(firstDefinition).pipe(Effect.forkChild);
    yield* Deferred.await(firstWriteEntered);
    const second = yield* save(secondDefinition).pipe(Effect.forkChild);

    const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
    assert.equal(results.filter((result) => result.ok === true).length, 1);
    const conflict = results.find((result) => result.ok === false && "conflict" in result);
    assert.deepEqual(conflict, {
      ok: false,
      conflict: true,
      currentVersionHash: sha256Hex(fileContents),
    });
    assert.equal(writeCount, 1);
  }),
);

it.effect("workflowRpcHandlers serializes deleteBoard with an in-flight save", () =>
  Effect.gen(function* () {
    const projectId = "project-editor-rpc" as ProjectId;
    const boardId = BoardId.make("project-editor-rpc__delete-save-race");
    const workspaceRoot = "/tmp/editor-rpc-project";
    const workflowFilePath = ".t3/boards/delete-save-race.json";
    const baseDefinition = yield* decodeWorkflowDefinition({
      name: "Delete Save Race",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const savedDefinition = yield* decodeWorkflowDefinition({
      name: "Delete Save Race Saved",
      lanes: [{ key: "queue", name: "Queue Saved", entry: "manual" }],
    });
    const baseRaw = `${encodeWorkflowDefinitionJson(baseDefinition)}\n`;
    const baseHash = sha256Hex(baseRaw);
    let fileContents = baseRaw;
    let registryDefinition: WorkflowDefinitionType | null = baseDefinition;
    let boardRow: {
      readonly boardId: BoardId;
      readonly projectId: ProjectId;
      readonly name: string;
      readonly workflowFilePath: string;
      readonly workflowVersionHash: string;
      readonly maxConcurrentTickets: number;
    } | null = {
      boardId,
      projectId,
      name: baseDefinition.name,
      workflowFilePath,
      workflowVersionHash: baseHash,
      maxConcurrentTickets: 3,
    };
    const versions: WorkflowBoardVersionRecordInput[] = [];
    const saveWriteEntered = yield* Deferred.make<void>();
    const saveLocks = yield* makeWorkflowBoardSaveLocks;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: (inputBoardId) => Effect.succeed(inputBoardId === boardId ? boardRow : null),
        deleteBoard: (inputBoardId) =>
          Effect.sync(() => {
            if (inputBoardId === boardId) {
              boardRow = null;
            }
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: (inputBoardId) =>
          Effect.sync(() => {
            if (inputBoardId === boardId) {
              registryDefinition = null;
            }
          }),
        getDefinition: () => Effect.succeed(registryDefinition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      saveLocks,
      fileLoader: {
        lintDefinition: () => Effect.succeed([]),
        loadAndRegister: (input) =>
          Effect.gen(function* () {
            registryDefinition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
              Effect.orDie,
            );
            boardRow = {
              boardId: input.boardId,
              projectId: input.projectId,
              name: registryDefinition.name,
              workflowFilePath: input.relativePath,
              workflowVersionHash: sha256Hex(fileContents),
              maxConcurrentTickets: 3,
            };
            return input.boardId;
          }),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: {
        record: (input) =>
          Effect.sync(() => {
            versions.push(input);
          }),
        list: () => Effect.succeed([]),
        get: () => Effect.succeed(null),
        deleteForBoard: (inputBoardId) =>
          Effect.sync(() => {
            for (let index = versions.length - 1; index >= 0; index -= 1) {
              if (versions[index]?.boardId === inputBoardId) {
                versions.splice(index, 1);
              }
            }
          }),
      },
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed(workspaceRoot),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(fileContents),
        writeFile: (input) =>
          Effect.gen(function* () {
            fileContents = input.contents;
            yield* Deferred.succeed(saveWriteEntered, undefined);
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            return { relativePath: input.relativePath };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: (input) =>
          Effect.sync(() => {
            assert.deepEqual(input, { cwd: workspaceRoot, relativePath: workflowFilePath });
            fileContents = "";
          }),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const saveFiber = yield* invokeWorkflowHandler<{
      readonly ok: true;
      readonly versionHash: string;
    }>(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: encodeWorkflowDefinition(savedDefinition),
      expectedVersionHash: baseHash,
    }).pipe(Effect.forkChild);

    yield* Deferred.await(saveWriteEntered);
    const deleteFiber = yield* invokeWorkflowHandler<void>(
      handlers,
      WORKFLOW_WS_METHODS.deleteBoard,
      { boardId },
    ).pipe(Effect.forkChild);

    const saved = yield* Fiber.join(saveFiber);
    yield* Fiber.join(deleteFiber);

    assert.equal(saved.ok, true);
    assert.equal(boardRow, null);
    assert.equal(registryDefinition, null);
    assert.deepEqual(versions, []);
  }),
);

it.effect("workflowRpcHandlers rejects unsafe instruction paths without writing", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-editor-rpc__unsafe-instruction");
    const definition = yield* decodeWorkflowDefinition({
      name: "Unsafe Instruction",
      lanes: [
        {
          key: "run",
          name: "Run",
          entry: "auto",
          pipeline: [
            {
              key: "agent",
              type: "agent",
              agent: { instance: "codex_main", model: "gpt-5.5" },
              instruction: { file: "../escape.md" },
            },
          ],
        },
      ],
    });
    const definitionEncoded = encodeWorkflowDefinition(definition);
    const currentRaw = `${encodeWorkflowDefinitionJson(definition)}\n`;
    const currentHash = sha256Hex(currentRaw);
    let writeCount = 0;

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId: "project-editor-rpc",
            name: "Unsafe Instruction",
            workflowFilePath: ".t3/boards/unsafe-instruction.json",
            workflowVersionHash: currentHash,
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(definition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: (input) =>
          Effect.succeed(
            lintWorkflowDefinition(input.definition, {
              providerInstanceExists: () => true,
              instructionFileExists: () => true,
            }),
          ),
        loadAndRegister: () => Effect.die("loadAndRegister must not run after lint failure"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/editor-rpc-project"),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.succeed(currentRaw),
        writeFile: () =>
          Effect.sync(() => {
            writeCount += 1;
            return { relativePath: ".t3/boards/unsafe-instruction.json" };
          }),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const saved = yield* invokeWorkflowHandler<{
      readonly ok: false;
      readonly lintErrors: ReadonlyArray<{ readonly code: string; readonly message: string }>;
    }>(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
      boardId,
      definition: definitionEncoded,
      expectedVersionHash: currentHash,
    });

    assert.equal(saved.ok, false);
    assert.deepEqual(
      saved.lintErrors.map((error) => error.code),
      ["unsafe_instruction_path"],
    );
    assert.equal(writeCount, 0);
  }),
);

it.effect("workflowRpcHandlers rejects board saves whose derived path is not a board file", () =>
  Effect.gen(function* () {
    const boardId = BoardId.make("project-editor-rpc__unsafe");
    const definition = yield* decodeWorkflowDefinition({
      name: "Unsafe",
      lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
    });
    const definitionEncoded = encodeWorkflowDefinition(definition);

    const handlers = workflowRpcHandlers({
      engine: {
        createTicket: () => Effect.die("unused"),
        editTicket: () => Effect.void,
        moveTicket: () => Effect.void,
        createTicketAndEnterUnlocked: () => Effect.die("unused"),
        closeTicketFromSourceUnlocked: () => Effect.die("unused"),
        cancellableProviderTurnsForTicket: () => Effect.die("unused"),
        supersedeProviderWorkForTicket: () => Effect.die("unused"),
        editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
        runLane: () => Effect.void,
        ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
        resolveApproval: () => Effect.void,
        answerTicketStep: () => Effect.void,
        postTicketMessage: () => Effect.void,
        cancelStep: () => Effect.void,
        cancelBoardPipelines: () => Effect.void,
        cancelTicketPipelines: () => Effect.void,
        recoverBoardWip: () => Effect.void,
        completeRecoveredStep: () => Effect.void,
      },
      readModel: {
        ...noopReadModel,
        getBoard: () =>
          Effect.succeed({
            boardId,
            projectId: "project-editor-rpc",
            name: "Unsafe",
            workflowFilePath: ".t3/boards/../unsafe.json",
            workflowVersionHash: "hash-before",
            maxConcurrentTickets: 3,
          }),
      },
      boardRegistry: {
        register: () => Effect.die("unused"),
        unregister: () => Effect.void,
        getDefinition: () => Effect.succeed(definition),
        listDefinitions: () => Effect.succeed([]),
        getLane: () => Effect.succeed(null),
      },
      ticketDiff: {
        getTicketDiff: () => Effect.die("unused"),
      },
      ticketWorktrees: {
        resolveForTicket: () => Effect.die("unused"),
      },
      boardEvents: {
        publish: () => Effect.void,
        stream: () => Stream.empty,
      },
      fileLoader: {
        lintDefinition: () => Effect.die("lintDefinition must not run for unsafe path"),
        loadAndRegister: () => Effect.die("unused"),
      },
      projectScriptTrust: noopProjectScriptTrust,
      connectionStore: noopConnectionStore,
      versionStore: noopVersionStore,
      boardDiscovery: {
        discover: () => Effect.succeed([]),
        list: () => Effect.succeed([]),
      },
      projectWorkspaceResolver: {
        resolve: () => Effect.succeed("/tmp/editor-rpc-project"),
      },
      workspaceFileSystem: {
        listFiles: () => Effect.succeed([]),
        readFileString: () => Effect.die("readFileString must not run for unsafe path"),
        writeFile: () => Effect.die("writeFile must not run for unsafe path"),
        createFileExclusive: () => Effect.die("unused"),
        deleteFile: () => Effect.die("unused"),
      },
      observeRpcEffect: (_method, effect) => effect,
      observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
    });

    const result = yield* Effect.exit(
      invokeWorkflowHandler(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: definitionEncoded,
        expectedVersionHash: "hash-before",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.isTrue(result.cause.toString().includes("not a writable workflow board file"));
    }
  }),
);

it.effect(
  "workflowRpcHandlers round-trips saved board definitions and preserves invalid files",
  () =>
    Effect.gen(function* () {
      const projectId = "project-editor-roundtrip" as ProjectId;
      const boardId = BoardId.make("project-editor-roundtrip__delivery");
      const workspaceRoot = "/tmp/editor-roundtrip-project";
      const workflowFilePath = ".t3/boards/delivery.json";
      const initialDefinition = yield* decodeWorkflowDefinition({
        name: "Round Trip",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      let fileContents = `${encodeWorkflowDefinitionJson(initialDefinition)}\n`;
      const initialHash = sha256Hex(fileContents);
      let registryDefinition = initialDefinition;
      let boardRow = {
        boardId,
        projectId,
        name: registryDefinition.name,
        workflowFilePath,
        workflowVersionHash: initialHash,
        maxConcurrentTickets: 3,
      };

      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getBoard: () => Effect.succeed(boardRow),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(registryDefinition),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
        },
        fileLoader: {
          lintDefinition: (input) =>
            Effect.sync(() =>
              input.definition.lanes.some(
                (lane) => lane.wipLimit !== undefined && lane.wipLimit < 1,
              )
                ? [
                    {
                      code: "invalid_wip_limit" as const,
                      message: "wipLimit must be at least 1",
                      laneKey: "queue",
                    },
                  ]
                : [],
            ),
          loadAndRegister: (input) =>
            Effect.gen(function* () {
              registryDefinition = yield* decodeWorkflowDefinitionJson(fileContents).pipe(
                Effect.orDie,
              );
              boardRow = {
                ...boardRow,
                name: registryDefinition.name,
                workflowVersionHash: sha256Hex(fileContents),
              };
              return input.boardId;
            }),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: noopVersionStore,
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed(workspaceRoot),
        },
        workspaceFileSystem: {
          listFiles: () => Effect.succeed([]),
          readFileString: (input) =>
            Effect.sync(() => {
              assert.deepEqual(input, { cwd: workspaceRoot, relativePath: workflowFilePath });
              return fileContents;
            }),
          writeFile: (input) =>
            Effect.sync(() => {
              assert.equal(input.cwd, workspaceRoot);
              assert.equal(input.relativePath, workflowFilePath);
              fileContents = input.contents;
              return { relativePath: input.relativePath };
            }),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () => Effect.die("unused"),
        },
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      const loadedBefore = yield* invokeWorkflowHandler<{
        readonly definition: { readonly name: string };
        readonly versionHash: string;
      }>(handlers, WORKFLOW_WS_METHODS.getBoardDefinition, { boardId });
      assert.equal(loadedBefore.definition.name, "Round Trip");
      assert.equal(loadedBefore.versionHash, initialHash);

      const editedDefinition = yield* decodeWorkflowDefinition({
        name: "Round Trip Edited",
        lanes: [
          { key: "queue", name: "Queue Updated", entry: "manual", wipLimit: 2 },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      const saved = yield* invokeWorkflowHandler<
        | {
            readonly ok: true;
            readonly definition: { readonly name: string };
            readonly versionHash: string;
          }
        | { readonly ok: false; readonly lintErrors: readonly unknown[] }
      >(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: encodeWorkflowDefinition(editedDefinition),
        expectedVersionHash: initialHash,
      });
      assert.equal(saved.ok, true);
      if (saved.ok !== true) {
        assert.fail("expected successful save");
      }
      assert.equal(saved.versionHash, sha256Hex(fileContents));

      const loadedAfter = yield* invokeWorkflowHandler<{
        readonly definition: {
          readonly name: string;
          readonly lanes: ReadonlyArray<{ readonly name: string }>;
        };
        readonly versionHash: string;
      }>(handlers, WORKFLOW_WS_METHODS.getBoardDefinition, { boardId });
      assert.equal(loadedAfter.definition.name, "Round Trip Edited");
      assert.equal(loadedAfter.definition.lanes[0]?.name, "Queue Updated");
      assert.equal(loadedAfter.versionHash, saved.versionHash);

      const fileContentsAfterValidSave = fileContents;
      const invalidDefinition = yield* decodeWorkflowDefinition({
        name: "Round Trip Invalid",
        lanes: [
          { key: "queue", name: "Queue", entry: "manual", wipLimit: 0 },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      const rejected = yield* invokeWorkflowHandler<{
        readonly ok: false;
        readonly lintErrors: ReadonlyArray<{ readonly code: string }>;
      }>(handlers, WORKFLOW_WS_METHODS.saveBoardDefinition, {
        boardId,
        definition: encodeWorkflowDefinition(invalidDefinition),
        expectedVersionHash: saved.versionHash,
      });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.lintErrors[0]?.code, "invalid_wip_limit");
      assert.equal(fileContents, fileContentsAfterValidSave);
    }),
);

it.effect(
  "workflowRpcHandlers listNeedsAttentionTickets returns real query rows (not the placeholder [])",
  () =>
    Effect.gen(function* () {
      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          listNeedsAttentionTickets: () =>
            Effect.succeed([
              {
                ticketId: "ticket-attention-1",
                boardId: "board-attention-1",
                boardName: "Delivery Board",
                title: "Deploy hotfix",
                status: "waiting_on_user",
                currentLaneKey: "review",
                attentionKind: "waiting_for_input" as const,
                attentionReason: "Please confirm the deploy target",
                updatedAt: "2026-06-13T10:00:00.000Z",
              },
              // A second ticket with status "running" — should NOT appear because the
              // read model filters; we verify the handler passes through exactly what
              // the read model returns (the model already filters), so we give it only
              // the attention row.
            ]),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(null),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: () => Effect.die("unused"),
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed("/tmp/project"),
        },
        workspaceFileSystem: {
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.die("unused"),
          writeFile: () => Effect.die("unused"),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () => Effect.die("unused"),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: noopVersionStore,
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      const rows = yield* invokeWorkflowHandler<
        ReadonlyArray<{
          readonly ticketId: string;
          readonly boardName: string;
          readonly attentionKind: string | null;
          readonly attentionReason: string | null;
        }>
      >(handlers, WORKFLOW_WS_METHODS.listNeedsAttentionTickets, {});

      assert.equal(rows.length, 1, "should return the one attention row, not an empty placeholder");
      assert.equal(rows[0]?.ticketId, "ticket-attention-1");
      assert.equal(rows[0]?.boardName, "Delivery Board");
      assert.equal(rows[0]?.attentionKind, "waiting_for_input");
      assert.equal(rows[0]?.attentionReason, "Please confirm the deploy target");
    }),
);

it.effect(
  "workflowRpcHandlers getTicketDetail surfaces attentionKind, attentionReason, and currentLane.actions",
  () =>
    Effect.gen(function* () {
      const handlers = workflowRpcHandlers({
        engine: {
          createTicket: () => Effect.die("unused"),
          editTicket: () => Effect.void,
          moveTicket: () => Effect.void,
          createTicketAndEnterUnlocked: () => Effect.die("unused"),
          closeTicketFromSourceUnlocked: () => Effect.die("unused"),
          cancellableProviderTurnsForTicket: () => Effect.die("unused"),
          supersedeProviderWorkForTicket: () => Effect.die("unused"),
          editTicketFieldsUnlocked: () => Effect.die("unused"),
          withBoardAdmissionLock: (_boardId, effect) => effect,
          runLane: () => Effect.void,
          ingestExternalEvent: () => Effect.succeed({ outcome: "noop" as const }),
          resolveApproval: () => Effect.void,
          answerTicketStep: () => Effect.void,
          postTicketMessage: () => Effect.void,
          cancelStep: () => Effect.void,
          cancelBoardPipelines: () => Effect.void,
          cancelTicketPipelines: () => Effect.void,
          recoverBoardWip: () => Effect.void,
          completeRecoveredStep: () => Effect.void,
        },
        readModel: {
          ...noopReadModel,
          getTicketDetail: () =>
            Effect.succeed({
              ticket: {
                ticketId: "ticket-detail-attention",
                boardId: "board-detail-1",
                title: "Review PR",
                description: null,
                currentLaneKey: "review",
                currentLaneEntryToken: null,
                queuedAt: null,
                totalTokens: null,
                totalDurationMs: null,
                status: "waiting_on_user",
                attentionKind: "waiting_for_input",
                attentionReason: "Awaiting human review",
                currentLane: {
                  key: "review",
                  name: "Review",
                  actions: [{ label: "Approve", to: "done", hint: "Looks good" }],
                },
              },
              steps: [],
              messages: [],
            } as never),
          listTicketRouteDecisions: () => Effect.succeed([]),
        },
        boardRegistry: {
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          getDefinition: () => Effect.succeed(null),
          listDefinitions: () => Effect.succeed([]),
          getLane: () => Effect.succeed(null),
        },
        ticketDiff: {
          getTicketDiff: () => Effect.die("unused"),
        },
        ticketWorktrees: {
          resolveForTicket: () => Effect.die("unused"),
        },
        boardEvents: {
          publish: () => Effect.void,
          stream: () => Stream.empty,
        },
        fileLoader: {
          lintDefinition: () => Effect.succeed([]),
          loadAndRegister: () => Effect.die("unused"),
        },
        boardDiscovery: {
          discover: () => Effect.succeed([]),
          list: () => Effect.succeed([]),
        },
        projectWorkspaceResolver: {
          resolve: () => Effect.succeed("/tmp/project"),
        },
        workspaceFileSystem: {
          listFiles: () => Effect.succeed([]),
          readFileString: () => Effect.die("unused"),
          writeFile: () => Effect.die("unused"),
          createFileExclusive: () => Effect.die("unused"),
          deleteFile: () => Effect.die("unused"),
        },
        projectScriptTrust: noopProjectScriptTrust,
        connectionStore: noopConnectionStore,
        versionStore: noopVersionStore,
        observeRpcEffect: (_method, effect) => effect,
        observeRpcStreamEffect: (_method, effect) => Stream.unwrap(effect),
      });

      const detail = yield* handlers[WORKFLOW_WS_METHODS.getTicketDetail]({
        ticketId: TicketId.make("ticket-detail-attention"),
      });

      assert.equal(
        detail.ticket.attentionKind,
        "waiting_for_input",
        "attentionKind must pass through from read-model row",
      );
      assert.equal(
        detail.ticket.attentionReason,
        "Awaiting human review",
        "attentionReason must pass through from read-model row",
      );
      assert.isDefined(detail.ticket.currentLane, "currentLane must be present in detail view");
      assert.equal(detail.ticket.currentLane?.key, "review");
      assert.equal(detail.ticket.currentLane?.name, "Review");
      assert.equal(detail.ticket.currentLane?.actions.length, 1);
      assert.equal(detail.ticket.currentLane?.actions[0]?.label, "Approve");
      assert.equal(detail.ticket.currentLane?.actions[0]?.to, "done");
      assert.equal(detail.ticket.currentLane?.actions[0]?.hint, "Looks good");
    }),
);
