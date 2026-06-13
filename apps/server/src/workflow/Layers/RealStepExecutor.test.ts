import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { StepExecutionContext } from "../Services/StepExecutor.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { CapturedStepOutputReader } from "../Services/CapturedStepOutputReader.ts";
import {
  ProviderDispatchOutbox,
  ProviderTurnPort,
  type ProviderDispatchTerminalResult,
} from "../Services/ProviderDispatchOutbox.ts";
import { ProjectScriptTrust } from "../Services/ProjectScriptTrust.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { ScriptCommandRunner, type ScriptCommandResult } from "../Services/ScriptCommandRunner.ts";
import { SetupRunService } from "../Services/SetupRunService.ts";
import { StepExecutor } from "../Services/StepExecutor.ts";
import { TicketCheckpointService } from "../Services/TicketCheckpointService.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorktreePort } from "../Services/WorktreePort.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorktreeLeaseServiceLive } from "./WorktreeLeaseService.ts";
import { ProviderDispatchOutboxLive } from "./ProviderDispatchOutbox.ts";
import { RealStepExecutorLive } from "./RealStepExecutor.ts";
import { ScriptStepExecutorLive } from "./ScriptStepExecutor.ts";
import { TurnStateReader } from "../Services/TurnStateReader.ts";
import { TicketMergeService } from "../Services/TicketMergeService.ts";
import { TicketPullRequestService } from "../Services/TicketPullRequestService.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { ticketBaseRef } from "../ticketRefs.ts";

const context: StepExecutionContext = {
  ticketId: "ticket-1" as never,
  boardId: "board-1" as never,
  pipelineRunId: "pipeline-run-1" as never,
  stepRunId: "step-run-1" as never,
  laneEntryToken: "lane-token-1" as never,
  step: {
    key: "agent-step" as never,
    type: "agent",
    agent: {
      instance: "codex" as never,
      model: "gpt-5.5" as never,
    },
    instruction: "Implement the ticket",
  },
};

const optionSelections = [
  { id: "reasoningEffort", value: "high" },
  { id: "fastMode", value: true },
];

const optionsContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-options" as never,
  stepRunId: "step-run-options" as never,
  step: {
    key: "agent-step" as never,
    type: "agent",
    agent: {
      instance: "codex" as never,
      model: "gpt-5.5" as never,
      options: optionSelections as never,
    },
    instruction: "Implement the ticket",
  },
};

const fileInstructionContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-file-instruction" as never,
  stepRunId: "step-run-file-instruction" as never,
  step: {
    key: "agent-step" as never,
    type: "agent",
    agent: {
      instance: "codex" as never,
      model: "gpt-5.5" as never,
    },
    instruction: { file: "missing-instruction.md" },
  },
};

const unsafeFileInstructionContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-unsafe-file-instruction" as never,
  stepRunId: "step-run-unsafe-file-instruction" as never,
  step: {
    key: "agent-step" as never,
    type: "agent",
    agent: {
      instance: "codex" as never,
      model: "gpt-5.5" as never,
    },
    instruction: { file: "../t3-unsafe-instruction-escape.md" },
  },
};

const symlinkFileInstructionContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-symlink-file-instruction" as never,
  stepRunId: "step-run-symlink-file-instruction" as never,
  step: {
    key: "agent-step" as never,
    type: "agent",
    agent: {
      instance: "codex" as never,
      model: "gpt-5.5" as never,
    },
    instruction: { file: "symlink-instruction.md" },
  },
};

const normalFileInstructionContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-normal-file-instruction" as never,
  stepRunId: "step-run-normal-file-instruction" as never,
  step: {
    key: "agent-step" as never,
    type: "agent",
    agent: {
      instance: "codex" as never,
      model: "gpt-5.5" as never,
    },
    instruction: { file: "instructions/normal.md" },
  },
};

const canonicalFileInstructionContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-canonical-file-instruction" as never,
  stepRunId: "step-run-canonical-file-instruction" as never,
  step: {
    key: "agent-step" as never,
    type: "agent",
    agent: {
      instance: "codex" as never,
      model: "gpt-5.5" as never,
    },
    instruction: { file: "instructions/link.md" },
  },
};

const templateContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-template" as never,
  stepRunId: "step-run-template" as never,
  step: {
    key: "agent-step" as never,
    type: "agent",
    agent: {
      instance: "codex" as never,
      model: "gpt-5.5" as never,
    },
    instruction:
      "Work on {{ticket.title}} ({{ticket.id}}). Diff base: {{ ticket.baseRef }}. Desc:[{{ticket.description}}] Keep {{ticket.unknown}} and {{other}}.",
  },
};

const discussionContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-discussion" as never,
  stepRunId: "step-run-discussion" as never,
  step: {
    key: "agent-step" as never,
    type: "agent",
    agent: {
      instance: "codex" as never,
      model: "gpt-5.5" as never,
    },
    instruction: "Implement the ticket",
  },
};

const discussionPlaceholderContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-discussion-placeholder" as never,
  stepRunId: "step-run-discussion-placeholder" as never,
  step: {
    key: "agent-step" as never,
    type: "agent",
    agent: {
      instance: "codex" as never,
      model: "gpt-5.5" as never,
    },
    instruction: "Implement the ticket.\nDiscussion:\n{{ticket.discussion}}",
  },
};

const scriptContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-script" as never,
  stepRunId: "step-run-script" as never,
  step: {
    key: "script-step" as never,
    type: "script",
    run: "echo ready",
  },
};

const captureContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-capture" as never,
  stepRunId: "step-run-capture" as never,
  step: {
    ...context.step,
    captureOutput: true,
  } as never,
};

const checkpointCalls: Array<string> = [];
const setupCalls: Array<string> = [];
const capturedReadInputs: Array<unknown> = [];
const dispatchStartInputs: Array<unknown> = [];
const preRef = "refs/t3/tickets/dC0x/steps/c3RlcC1ydW4tMQ/pre";
const postRef = "refs/t3/tickets/dC0x/steps/c3RlcC1ydW4tMQ/post";

const mergeServiceCalls: Array<unknown> = [];
const StubTicketMergeServiceLayer = Layer.succeed(TicketMergeService, {
  merge: (input) =>
    Effect.sync(() => {
      mergeServiceCalls.push(input);
      return { _tag: "completed" } as const;
    }),
});

const mergeContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-merge-step" as never,
  stepRunId: "step-run-merge-step" as never,
  step: {
    key: "land" as never,
    type: "merge",
    target: "main" as never,
  },
};

const pullRequestServiceCalls: Array<{ readonly action: string; readonly input: unknown }> = [];
const StubTicketPullRequestServiceLayer = Layer.succeed(TicketPullRequestService, {
  open: (input) =>
    Effect.sync(() => {
      pullRequestServiceCalls.push({ action: "open", input });
      return { _tag: "completed", output: { prNumber: 1, url: "https://example/pull/1" } } as const;
    }),
  land: (input) =>
    Effect.sync(() => {
      pullRequestServiceCalls.push({ action: "land", input });
      return { _tag: "completed" } as const;
    }),
});

const openPrContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-open-pr" as never,
  stepRunId: "step-run-open-pr" as never,
  step: {
    key: "open-pr" as never,
    type: "pullRequest",
    action: "open" as never,
  },
};

const landPrContext: StepExecutionContext = {
  ...context,
  ticketId: "ticket-land-pr" as never,
  stepRunId: "step-run-land-pr" as never,
  step: {
    key: "land-pr" as never,
    type: "pullRequest",
    action: "land" as never,
  },
};

const realStepExecutorTestSupport = WorkflowFoundationLive.pipe(
  Layer.provideMerge(DeterministicWorkflowIds),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(MigrationsLive),
  Layer.provideMerge(SqlitePersistenceMemory),
);

const mk = (
  terminal: ProviderDispatchTerminalResult,
  options: {
    readonly projectTrusted?: boolean;
    readonly scriptCommandResult?: ScriptCommandResult;
    readonly fileSystemLayer?: Layer.Layer<FileSystem.FileSystem>;
    readonly capturedOutputForRead?: (input: { readonly threadId: string }) => unknown;
  } = {},
) =>
  it.layer(
    RealStepExecutorLive.pipe(
      Layer.provideMerge(
        Layer.succeed(WorktreePort, {
          ensureWorktree: () =>
            Effect.succeed({
              repoRoot: "/tmp/repo-ticket-1",
              worktreeRef: "wt-ticket-1",
              path: "/tmp/wt-ticket-1",
            }),
        }),
      ),
      Layer.provideMerge(WorktreeLeaseServiceLive),
      Layer.provideMerge(
        Layer.succeed(SetupRunService, {
          runSetup: (_ticketId, _worktreeRef, worktreePath) =>
            Effect.sync(() => {
              setupCalls.push(worktreePath);
              return { status: "completed", exitCode: 0 } as const;
            }),
        }),
      ),
      Layer.provideMerge(ScriptStepExecutorLive),
      Layer.provideMerge(
        Layer.succeed(ScriptCancelRegistry, {
          register: () => Effect.void,
          unregister: () => Effect.void,
          cancel: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProjectScriptTrust, {
          isTrusted: () => Effect.succeed(options.projectTrusted ?? true),
          setTrusted: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ScriptCommandRunner, {
          run: () =>
            Effect.succeed(
              options.scriptCommandResult ?? { outcome: "exited", exitCode: 0, signal: null },
            ),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(TicketCheckpointService, {
          hasBaseline: (_ticketId, cwd) =>
            Effect.sync(() => {
              checkpointCalls.push(`hasBaseline:${cwd}`);
              return false;
            }),
          captureBaseline: (_ticketId, cwd) =>
            Effect.sync(() => {
              checkpointCalls.push(`captureBaseline:${cwd}`);
              return "refs/t3/tickets/dC0x/base";
            }),
          captureStep: (_ticketId, stepRunId, cwd, kind) =>
            Effect.sync(() => {
              checkpointCalls.push(`captureStep:${stepRunId}:${cwd}:${kind}`);
              return kind === "pre" ? preRef : postRef;
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProviderDispatchOutbox, {
          confirmStep: () => Effect.void,
          ensureStarted: (input) =>
            Effect.sync(() => {
              dispatchStartInputs.push(input);
              return { turnId: "turn-stub" as never };
            }),
          getDispatchForStep: () => Effect.succeed(null),
          awaitTerminal: () => Effect.succeed(terminal),
          awaitStepTerminal: () => Effect.succeed(terminal),
          recoverPending: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(CapturedStepOutputReader, {
          read: (input) =>
            options.capturedOutputForRead === undefined
              ? Effect.void
              : Effect.sync(() =>
                  options.capturedOutputForRead?.({ threadId: input.threadId as string }),
                ),
        }),
      ),
      Layer.provideMerge(StubTicketMergeServiceLayer),
      Layer.provideMerge(StubTicketPullRequestServiceLayer),
      Layer.provideMerge(WorkflowEventCommitterLive),
      Layer.provideMerge(BoardRegistryLive),
      Layer.provideMerge(WorkflowBoardSaveLocksLive),
      Layer.provideMerge(realStepExecutorTestSupport),
      Layer.provideMerge(options.fileSystemLayer ?? Layer.empty),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

const captureLayer = (capturedOutput: unknown | undefined) =>
  it.layer(
    RealStepExecutorLive.pipe(
      Layer.provideMerge(
        Layer.succeed(WorktreePort, {
          ensureWorktree: () =>
            Effect.succeed({
              repoRoot: "/tmp/repo-ticket-1",
              worktreeRef: "wt-ticket-1",
              path: "/tmp/wt-ticket-1",
            }),
        }),
      ),
      Layer.provideMerge(WorktreeLeaseServiceLive),
      Layer.provideMerge(
        Layer.succeed(SetupRunService, {
          runSetup: () => Effect.succeed({ status: "completed", exitCode: 0 }),
        }),
      ),
      Layer.provideMerge(ScriptStepExecutorLive),
      Layer.provideMerge(
        Layer.succeed(ScriptCancelRegistry, {
          register: () => Effect.void,
          unregister: () => Effect.void,
          cancel: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ProjectScriptTrust, {
          isTrusted: () => Effect.succeed(true),
          setTrusted: () => Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ScriptCommandRunner, {
          run: () => Effect.succeed({ outcome: "exited", exitCode: 0, signal: null }),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(TicketCheckpointService, {
          hasBaseline: () => Effect.succeed(false),
          captureBaseline: () => Effect.succeed("refs/t3/tickets/dC0x/base"),
          captureStep: (_ticketId, _stepRunId, _cwd, kind) =>
            Effect.succeed(kind === "pre" ? preRef : postRef),
        }),
      ),
      Layer.provideMerge(ProviderDispatchOutboxLive),
      Layer.provideMerge(
        Layer.effect(
          ProviderTurnPort,
          Effect.gen(function* () {
            const turns = yield* ProjectionTurnRepository;
            const messages = yield* ProjectionThreadMessageRepository;
            return ProviderTurnPort.of({
              ensureTurnStarted: (req) =>
                Effect.gen(function* () {
                  yield* turns.upsertByTurnId({
                    threadId: req.threadId,
                    turnId: "turn-capture" as never,
                    pendingMessageId: null,
                    sourceProposedPlanThreadId: null,
                    sourceProposedPlanId: null,
                    assistantMessageId: "message-capture" as never,
                    state: "completed",
                    requestedAt: "2026-06-07T00:00:00.000Z" as never,
                    startedAt: "2026-06-07T00:00:00.000Z" as never,
                    completedAt: "2026-06-07T00:00:01.000Z" as never,
                    checkpointTurnCount: null,
                    checkpointRef: null,
                    checkpointStatus: null,
                    checkpointFiles: [],
                  });
                  yield* messages.upsert({
                    messageId: "message-capture" as never,
                    threadId: req.threadId,
                    turnId: "turn-capture" as never,
                    role: "assistant",
                    text: "unused structured output fixture",
                    isStreaming: false,
                    createdAt: "2026-06-07T00:00:01.000Z" as never,
                    updatedAt: "2026-06-07T00:00:01.000Z" as never,
                  });
                  return { turnId: "turn-capture" as never };
                }).pipe(
                  Effect.mapError(
                    (cause) => new WorkflowEventStoreError({ message: "seed turn failed", cause }),
                  ),
                ),
            });
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(TurnStateReader, {
          read: () => Effect.succeed({ _tag: "completed" as const }),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(CapturedStepOutputReader, {
          read: (input) =>
            Effect.sync(() => {
              capturedReadInputs.push(input);
              return capturedOutput;
            }),
        }),
      ),
      Layer.provideMerge(StubTicketMergeServiceLayer),
      Layer.provideMerge(StubTicketPullRequestServiceLayer),
      Layer.provideMerge(WorkflowEventCommitterLive),
      Layer.provideMerge(BoardRegistryLive),
      Layer.provideMerge(WorkflowBoardSaveLocksLive),
      Layer.provideMerge(realStepExecutorTestSupport),
      Layer.provideMerge(NodeServices.layer),
    ),
  );

const seedBoardAndTicket = (ctx: StepExecutionContext) =>
  Effect.gen(function* () {
    const registry = yield* BoardRegistry;
    const read = yield* WorkflowReadModel;
    const sql = yield* SqlClient.SqlClient;
    yield* registry.register(ctx.boardId, {
      name: "Executor board",
      lanes: [{ key: "impl", name: "Impl", entry: "manual" }],
    });
    yield* read.registerBoard({
      boardId: ctx.boardId,
      projectId: "project-script" as never,
      name: "Script board",
      workflowFilePath: ".t3/boards/script.json",
      workflowVersionHash: "hash",
      maxConcurrentTickets: 1,
    });
    yield* sql`
      INSERT INTO projection_ticket (
        ticket_id,
        board_id,
        title,
        current_lane_key,
        status,
        created_at,
        updated_at
      )
      VALUES (
        ${ctx.ticketId},
        ${ctx.boardId},
        'Executor ticket',
        'impl',
        'running',
        '2026-06-07T00:00:00.000Z',
        '2026-06-07T00:00:00.000Z'
      )
      ON CONFLICT(ticket_id) DO NOTHING
    `;
  });

const seedTicketMessages = (
  ctx: StepExecutionContext,
  messages: ReadonlyArray<{
    readonly author: "agent" | "user";
    readonly body: string;
    readonly attachments: number;
  }>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.forEach(messages, (message, index) => {
      const attachments = Array.from({ length: message.attachments }, (_, i) => ({
        kind: "image" as const,
        id: `attachment-${index}-${i}`,
        name: `attachment-${index}-${i}.png`,
        mimeType: "image/png" as const,
        sizeBytes: 4,
        dataUrl: "data:image/png;base64,AAAA",
      }));
      return sql`
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
          ${`message-${ctx.ticketId}-${index}`},
          ${ctx.ticketId},
          NULL,
          ${message.author},
          ${message.body},
          ${JSON.stringify(attachments)},
          ${`2026-06-07T00:0${index}:00.000Z`}
        )
      `;
    });
  });

const seedStepStartedFor = (ctx: StepExecutionContext, eventId: string) =>
  Effect.gen(function* () {
    const committer = yield* WorkflowEventCommitter;
    yield* seedBoardAndTicket(ctx);
    yield* committer.commit({
      type: "StepStarted",
      eventId: eventId as never,
      ticketId: ctx.ticketId,
      occurredAt: "2026-06-07T00:00:00.000Z" as never,
      payload: {
        pipelineRunId: ctx.pipelineRunId,
        stepRunId: ctx.stepRunId,
        stepKey: ctx.step.key,
        stepType: ctx.step.type,
      },
    });
  });

const seedStepStarted = seedStepStartedFor(context, "event-step-started");

const seedBoard = seedBoardAndTicket(context);

const assertProjectedStepRefs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* sql<{ readonly type: string }>`
    SELECT event_type AS "type"
    FROM workflow_events
    WHERE ticket_id = ${context.ticketId}
      AND event_type = 'StepRefsCaptured'
  `;
  const rows = yield* sql<{
    readonly preCheckpointRef: string | null;
    readonly postCheckpointRef: string | null;
  }>`
    SELECT
      pre_checkpoint_ref AS "preCheckpointRef",
      post_checkpoint_ref AS "postCheckpointRef"
    FROM projection_step_run
    WHERE step_run_id = ${context.stepRunId}
  `;

  assert.equal(events.length, 1);
  assert.equal(rows[0]?.preCheckpointRef, preRef);
  assert.equal(rows[0]?.postCheckpointRef, postRef);
});

const seedFileInstructionStepStarted = seedStepStartedFor(
  fileInstructionContext,
  "event-step-started-file-instruction",
);
const seedUnsafeFileInstructionStepStarted = seedStepStartedFor(
  unsafeFileInstructionContext,
  "event-step-started-unsafe-file-instruction",
);
const seedSymlinkFileInstructionStepStarted = seedStepStartedFor(
  symlinkFileInstructionContext,
  "event-step-started-symlink-file-instruction",
);
const seedNormalFileInstructionStepStarted = seedStepStartedFor(
  normalFileInstructionContext,
  "event-step-started-normal-file-instruction",
);
const seedCanonicalFileInstructionStepStarted = seedStepStartedFor(
  canonicalFileInstructionContext,
  "event-step-started-canonical-file-instruction",
);

const canonicalInstructionReadPaths: string[] = [];
const CanonicalInstructionFileSystemLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      ...fileSystem,
      realPath: (filePath) =>
        Effect.sync(() => {
          const value = String(filePath);
          if (value === "/tmp/repo-ticket-1/instructions/link.md") {
            return "/tmp/repo-ticket-1/instructions/target.md";
          }
          return value;
        }),
      readFileString: (filePath) =>
        Effect.sync(() => {
          const value = String(filePath);
          canonicalInstructionReadPaths.push(value);
          return value === "/tmp/repo-ticket-1/instructions/target.md"
            ? "Canonical instruction"
            : "Original path instruction";
        }),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

mk({ ok: true })("RealStepExecutor success", (it) => {
  it.effect("completes an agent step and releases the worktree lease", () =>
    Effect.gen(function* () {
      checkpointCalls.length = 0;
      const executor = yield* StepExecutor;
      const sql = yield* SqlClient.SqlClient;
      yield* seedStepStarted;

      const outcome = yield* executor.execute(context);

      assert.equal(outcome._tag, "completed");
      const rows = yield* sql<{ readonly ownerKind: string }>`
        SELECT owner_kind AS "ownerKind"
        FROM worktree_lease
        WHERE worktree_ref = 'wt-ticket-1'
      `;
      assert.equal(rows[0]?.ownerKind, "released");
      assert.deepEqual(checkpointCalls, [
        "hasBaseline:/tmp/wt-ticket-1",
        "captureBaseline:/tmp/wt-ticket-1",
        "captureStep:step-run-1:/tmp/wt-ticket-1:pre",
        "captureStep:step-run-1:/tmp/wt-ticket-1:post",
      ]);
      yield* assertProjectedStepRefs;
    }),
  );

  it.effect("runs merge steps through the merge service without project setup", () =>
    Effect.gen(function* () {
      mergeServiceCalls.length = 0;
      setupCalls.length = 0;
      const executor = yield* StepExecutor;
      const sql = yield* SqlClient.SqlClient;
      yield* seedStepStartedFor(mergeContext, "event-step-started-merge-step");

      const outcome = yield* executor.execute(mergeContext);

      assert.deepEqual(outcome, { _tag: "completed" });
      assert.deepEqual(setupCalls, []);
      assert.equal(mergeServiceCalls.length, 1);
      const call = mergeServiceCalls[0] as {
        readonly repoRoot: string;
        readonly worktreeRef: string;
        readonly step: { readonly target?: string };
      };
      assert.equal(call.repoRoot, "/tmp/repo-ticket-1");
      assert.equal(call.worktreeRef, "wt-ticket-1");
      assert.equal(call.step.target, "main");
      const rows = yield* sql<{ readonly ownerKind: string }>`
        SELECT owner_kind AS "ownerKind"
        FROM worktree_lease
        WHERE worktree_ref = 'wt-ticket-1'
      `;
      assert.equal(rows[0]?.ownerKind, "released");
    }),
  );

  it.effect("routes a pullRequest open step through the PR service without project setup", () =>
    Effect.gen(function* () {
      pullRequestServiceCalls.length = 0;
      setupCalls.length = 0;
      const executor = yield* StepExecutor;
      yield* seedStepStartedFor(openPrContext, "event-step-started-open-pr");

      const outcome = yield* executor.execute(openPrContext);

      assert.deepEqual(outcome, {
        _tag: "completed",
        output: { prNumber: 1, url: "https://example/pull/1" },
      });
      assert.deepEqual(setupCalls, []);
      assert.equal(pullRequestServiceCalls.length, 1);
      const call = pullRequestServiceCalls[0] as {
        readonly action: string;
        readonly input: {
          readonly ticketId: string;
          readonly stepRunId: string;
          readonly repoRoot: string;
          readonly worktreePath: string;
          readonly worktreeRef: string;
          readonly step: { readonly action: string };
        };
      };
      assert.equal(call.action, "open");
      assert.equal(call.input.ticketId, "ticket-open-pr");
      assert.equal(call.input.stepRunId, "step-run-open-pr");
      assert.equal(call.input.repoRoot, "/tmp/repo-ticket-1");
      assert.equal(call.input.worktreePath, "/tmp/wt-ticket-1");
      assert.equal(call.input.worktreeRef, "wt-ticket-1");
      assert.equal(call.input.step.action, "open");
    }),
  );

  it.effect("routes a pullRequest land step through the PR service", () =>
    Effect.gen(function* () {
      pullRequestServiceCalls.length = 0;
      setupCalls.length = 0;
      const executor = yield* StepExecutor;
      yield* seedStepStartedFor(landPrContext, "event-step-started-land-pr");

      const outcome = yield* executor.execute(landPrContext);

      assert.deepEqual(outcome, { _tag: "completed" });
      assert.deepEqual(setupCalls, []);
      assert.equal(pullRequestServiceCalls.length, 1);
      const call = pullRequestServiceCalls[0] as {
        readonly action: string;
        readonly input: { readonly worktreeRef: string };
      };
      assert.equal(call.action, "land");
      assert.equal(call.input.worktreeRef, "wt-ticket-1");
    }),
  );

  it.effect("blocks agent steps once the ticket's token budget is reached", () =>
    Effect.gen(function* () {
      dispatchStartInputs.length = 0;
      const executor = yield* StepExecutor;
      const sql = yield* SqlClient.SqlClient;
      const budgetContext = {
        ...context,
        ticketId: "ticket-budget" as never,
        stepRunId: "step-run-budget" as never,
      };
      yield* seedStepStartedFor(budgetContext, "event-step-started-budget");
      yield* sql`
        UPDATE projection_ticket
        SET token_budget = 1000
        WHERE ticket_id = ${budgetContext.ticketId}
      `;
      yield* sql`
        INSERT INTO projection_step_run (
          step_run_id, pipeline_run_id, ticket_id, step_key, step_type,
          status, started_at, finished_at, total_tokens
        )
        VALUES (
          'step-run-budget-spent', 'pipeline-budget', ${budgetContext.ticketId}, 'prior', 'agent',
          'completed', '2026-06-07T00:00:00.000Z', '2026-06-07T00:01:00.000Z', 1500
        )
      `;

      const outcome = yield* executor.execute(budgetContext);

      assert.equal(outcome._tag, "blocked");
      if (outcome._tag === "blocked") {
        assert.include(outcome.reason, "token budget reached");
        assert.include(outcome.reason, "1,500");
        assert.include(outcome.reason, "1,000");
      }
      // No provider dispatch may have started.
      assert.equal(dispatchStartInputs.length, 0);
    }),
  );

  it.effect("substitutes ticket template placeholders into the dispatched instruction", () =>
    Effect.gen(function* () {
      dispatchStartInputs.length = 0;
      const executor = yield* StepExecutor;
      yield* seedStepStartedFor(templateContext, "event-step-started-template");

      const outcome = yield* executor.execute(templateContext);

      assert.equal(outcome._tag, "completed");
      const dispatched = dispatchStartInputs[0] as { readonly instruction: string };
      assert.equal(
        dispatched.instruction,
        `Work on Executor ticket (ticket-template). Diff base: ${ticketBaseRef(
          "ticket-template" as never,
        )}. Desc:[] Keep {{ticket.unknown}} and {{other}}.`,
      );
    }),
  );

  it.effect("appends the ticket discussion to the dispatched instruction", () =>
    Effect.gen(function* () {
      dispatchStartInputs.length = 0;
      const executor = yield* StepExecutor;
      yield* seedStepStartedFor(discussionContext, "event-step-started-discussion");
      yield* seedTicketMessages(discussionContext, [
        { author: "user", body: "Use the existing retry helper", attachments: 0 },
        { author: "agent", body: "Understood", attachments: 1 },
      ]);

      const outcome = yield* executor.execute(discussionContext);

      assert.equal(outcome._tag, "completed");
      const dispatched = dispatchStartInputs[0] as { readonly instruction: string };
      assert.match(dispatched.instruction, /^Implement the ticket\n\n## Ticket discussion\n\n/);
      assert.include(dispatched.instruction, "### User — ");
      assert.include(dispatched.instruction, "Use the existing retry helper");
      assert.include(dispatched.instruction, "### Agent — ");
      assert.include(dispatched.instruction, "[1 attachment omitted]");
    }),
  );

  it.effect("substitutes the discussion placeholder without appending a second section", () =>
    Effect.gen(function* () {
      dispatchStartInputs.length = 0;
      const executor = yield* StepExecutor;
      yield* seedStepStartedFor(
        discussionPlaceholderContext,
        "event-step-started-discussion-placeholder",
      );
      yield* seedTicketMessages(discussionPlaceholderContext, [
        { author: "user", body: "Ship it", attachments: 0 },
      ]);

      const outcome = yield* executor.execute(discussionPlaceholderContext);

      assert.equal(outcome._tag, "completed");
      const dispatched = dispatchStartInputs[0] as { readonly instruction: string };
      assert.match(dispatched.instruction, /^Implement the ticket\.\nDiscussion:\n### User — /);
      assert.include(dispatched.instruction, "Ship it");
      assert.notInclude(dispatched.instruction, "## Ticket discussion");
      assert.notInclude(dispatched.instruction, "{{ticket.discussion}}");
    }),
  );

  it.effect("substitutes an empty-discussion marker when there are no messages", () =>
    Effect.gen(function* () {
      dispatchStartInputs.length = 0;
      const executor = yield* StepExecutor;
      yield* seedStepStartedFor(
        { ...discussionPlaceholderContext, ticketId: "ticket-discussion-empty" as never },
        "event-step-started-discussion-empty",
      );

      const outcome = yield* executor.execute({
        ...discussionPlaceholderContext,
        ticketId: "ticket-discussion-empty" as never,
      });

      assert.equal(outcome._tag, "completed");
      const dispatched = dispatchStartInputs[0] as { readonly instruction: string };
      assert.include(dispatched.instruction, "Discussion:\n(no discussion yet)");
    }),
  );

  it.effect("runs a trusted script step through the shared prepared worktree path", () =>
    Effect.gen(function* () {
      checkpointCalls.length = 0;
      setupCalls.length = 0;
      const fileSystem = yield* FileSystem.FileSystem;
      const executor = yield* StepExecutor;
      const sql = yield* SqlClient.SqlClient;
      yield* fileSystem.makeDirectory("/tmp/wt-ticket-1", { recursive: true });
      yield* seedBoard;
      yield* seedStepStartedFor(scriptContext, "event-step-started-script");

      const outcome = yield* executor.execute(scriptContext);

      assert.deepEqual(outcome, { _tag: "completed" });
      assert.deepEqual(setupCalls, ["/tmp/wt-ticket-1"]);
      const rows = yield* sql<{ readonly ownerKind: string }>`
        SELECT owner_kind AS "ownerKind"
        FROM worktree_lease
        WHERE worktree_ref = 'wt-ticket-1'
      `;
      assert.equal(rows[0]?.ownerKind, "released");
      assert.deepEqual(checkpointCalls, [
        "hasBaseline:/tmp/wt-ticket-1",
        "captureBaseline:/tmp/wt-ticket-1",
        "captureStep:step-run-script:/tmp/wt-ticket-1:pre",
        "captureStep:step-run-script:/tmp/wt-ticket-1:post",
      ]);
    }),
  );

  it.effect("releases the worktree lease when instruction file resolution fails", () =>
    Effect.gen(function* () {
      const executor = yield* StepExecutor;
      const sql = yield* SqlClient.SqlClient;
      yield* seedFileInstructionStepStarted;

      const outcome = yield* executor.execute(fileInstructionContext);

      assert.equal(outcome._tag, "failed");
      assert.match((outcome as { readonly error: string }).error, /^executor error: /);
      const rows = yield* sql<{ readonly ownerKind: string }>`
        SELECT owner_kind AS "ownerKind"
        FROM worktree_lease
        WHERE worktree_ref = 'wt-ticket-1'
      `;
      assert.equal(rows[0]?.ownerKind, "released");
    }),
  );

  it.effect("fails unsafe instruction file paths without reading escaped files", () =>
    Effect.gen(function* () {
      const escapePath = "/tmp/t3-unsafe-instruction-escape.md";
      const fileSystem = yield* FileSystem.FileSystem;
      const executor = yield* StepExecutor;
      yield* fileSystem.writeFileString(escapePath, "Escaped instruction");
      yield* seedUnsafeFileInstructionStepStarted;

      const outcome = yield* executor.execute(unsafeFileInstructionContext);

      assert.equal(outcome._tag, "failed");
      assert.match((outcome as { readonly error: string }).error, /^executor error: /);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem
            .remove("/tmp/t3-unsafe-instruction-escape.md")
            .pipe(Effect.catch(() => Effect.void));
        }),
      ),
    ),
  );

  it.effect("fails symlinked instruction files that resolve outside the repo root", () =>
    Effect.gen(function* () {
      dispatchStartInputs.length = 0;
      const repoRoot = "/tmp/repo-ticket-1";
      const escapePath = "/tmp/t3-symlink-instruction-escape.md";
      const fileSystem = yield* FileSystem.FileSystem;
      const executor = yield* StepExecutor;
      yield* fileSystem.makeDirectory(repoRoot, { recursive: true });
      yield* fileSystem.writeFileString(escapePath, "Escaped symlink instruction");
      yield* fileSystem.symlink(escapePath, `${repoRoot}/symlink-instruction.md`);
      yield* seedSymlinkFileInstructionStepStarted;

      const outcome = yield* executor.execute(symlinkFileInstructionContext);

      assert.deepEqual(outcome, {
        _tag: "failed",
        error: 'Instruction file resolves outside the project root: "symlink-instruction.md"',
      });
      assert.deepEqual(dispatchStartInputs, []);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem
            .remove("/tmp/repo-ticket-1/symlink-instruction.md")
            .pipe(Effect.catch(() => Effect.void));
          yield* fileSystem
            .remove("/tmp/t3-symlink-instruction-escape.md")
            .pipe(Effect.catch(() => Effect.void));
        }),
      ),
    ),
  );

  it.effect("forwards agent option selections to the provider dispatch", () =>
    Effect.gen(function* () {
      dispatchStartInputs.length = 0;
      const executor = yield* StepExecutor;
      yield* seedStepStartedFor(optionsContext, "event-step-started-options");

      const outcome = yield* executor.execute(optionsContext);

      assert.equal(outcome._tag, "completed");
      assert.deepEqual(
        (dispatchStartInputs[0] as { readonly options?: unknown } | undefined)?.options,
        optionSelections,
      );
    }),
  );

  it.effect("reads normal instruction files that resolve inside the repo root", () =>
    Effect.gen(function* () {
      dispatchStartInputs.length = 0;
      const repoRoot = "/tmp/repo-ticket-1";
      const instructionPath = `${repoRoot}/instructions/normal.md`;
      const fileSystem = yield* FileSystem.FileSystem;
      const executor = yield* StepExecutor;
      yield* fileSystem.makeDirectory(`${repoRoot}/instructions`, { recursive: true });
      yield* fileSystem.writeFileString(instructionPath, "Normal in-repo instruction");
      yield* seedNormalFileInstructionStepStarted;

      const outcome = yield* executor.execute(normalFileInstructionContext);

      assert.deepEqual(outcome, { _tag: "completed" });
      assert.equal(
        (dispatchStartInputs[0] as { readonly instruction?: string } | undefined)?.instruction,
        "Normal in-repo instruction",
      );
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem
            .remove("/tmp/repo-ticket-1/instructions/normal.md")
            .pipe(Effect.catch(() => Effect.void));
        }),
      ),
    ),
  );
});

mk({ ok: true }, { fileSystemLayer: CanonicalInstructionFileSystemLayer })(
  "RealStepExecutor canonical instruction read",
  (it) => {
    it.effect("reads the canonical real instruction path after validation", () =>
      Effect.gen(function* () {
        dispatchStartInputs.length = 0;
        canonicalInstructionReadPaths.length = 0;
        const executor = yield* StepExecutor;
        yield* seedCanonicalFileInstructionStepStarted;

        const outcome = yield* executor.execute(canonicalFileInstructionContext);

        assert.deepEqual(outcome, { _tag: "completed" });
        assert.deepEqual(canonicalInstructionReadPaths, [
          "/tmp/repo-ticket-1/instructions/target.md",
        ]);
        assert.equal(
          (dispatchStartInputs[0] as { readonly instruction?: string } | undefined)?.instruction,
          "Canonical instruction",
        );
      }),
    );
  },
);

captureLayer({ verdict: "pass", score: 0.98 })("RealStepExecutor output capture", (it) => {
  it.effect("appends the capture instruction, persists it, and returns the last JSON block", () =>
    Effect.gen(function* () {
      capturedReadInputs.length = 0;
      const executor = yield* StepExecutor;
      const sql = yield* SqlClient.SqlClient;
      yield* seedStepStartedFor(captureContext, "event-step-started-capture");

      const outcome = yield* executor.execute(captureContext);

      assert.deepEqual(outcome, {
        _tag: "completed",
        output: { verdict: "pass", score: 0.98 },
      });

      const rows = yield* sql<{ readonly instruction: string }>`
        SELECT instruction
        FROM workflow_dispatch_outbox
        WHERE step_run_id = ${captureContext.stepRunId}
      `;
      assert.include(rows[0]?.instruction ?? "", "Implement the ticket");
      assert.include(
        rows[0]?.instruction ?? "",
        "End your final message with a single fenced ```json block containing your result object.",
      );
    }),
  );

  it.effect("passes the exact started thread and turn to the output reader", () =>
    Effect.gen(function* () {
      capturedReadInputs.length = 0;
      const executor = yield* StepExecutor;
      const sql = yield* SqlClient.SqlClient;
      yield* seedStepStartedFor(captureContext, "event-step-started-capture-exact-turn");

      const outcome = yield* executor.execute(captureContext);

      assert.equal(outcome._tag, "completed");
      const rows = yield* sql<{ readonly threadId: string; readonly turnId: string | null }>`
        SELECT thread_id AS "threadId", turn_id AS "turnId"
        FROM workflow_dispatch_outbox
        WHERE step_run_id = ${captureContext.stepRunId}
      `;
      const capturedInput = capturedReadInputs[0] as
        | { readonly stepRunId: string; readonly threadId: string; readonly turnId: string | null }
        | undefined;
      const row = rows.find((candidate) => candidate.threadId === capturedInput?.threadId);
      assert.deepEqual(capturedReadInputs, [
        {
          stepRunId: captureContext.stepRunId,
          threadId: row?.threadId,
          turnId: row?.turnId,
        },
      ]);
    }),
  );
});

captureLayer(undefined)("RealStepExecutor missing output capture", (it) => {
  it.effect("fails a captureOutput step when the assistant message has no valid JSON block", () =>
    Effect.gen(function* () {
      const executor = yield* StepExecutor;
      yield* seedStepStartedFor(captureContext, "event-step-started-capture-missing");

      const outcome = yield* executor.execute(captureContext);

      assert.deepEqual(outcome, {
        _tag: "failed",
        error: "missing or invalid structured output",
      });
    }),
  );
});

const panelVerdictQueue: unknown[] = [];
mk(
  { ok: true },
  {
    capturedOutputForRead: () => panelVerdictQueue.shift(),
  },
)("RealStepExecutor review panel", (it) => {
  it.effect("takes the strict-majority verdict across panel reviewers", () =>
    Effect.gen(function* () {
      dispatchStartInputs.length = 0;
      panelVerdictQueue.length = 0;
      panelVerdictQueue.push(
        { verdict: "approve", notes: "ok" },
        { verdict: "revise" },
        { verdict: "approve" },
      );
      const executor = yield* StepExecutor;
      const panelContext: StepExecutionContext = {
        ...context,
        ticketId: "ticket-panel" as never,
        stepRunId: "step-run-panel" as never,
        step: {
          key: "review" as never,
          type: "agent",
          agent: { instance: "codex" as never, model: "gpt-5.5" as never },
          instruction: "Review the work",
          captureOutput: true,
          panel: 3,
        } as never,
      };
      yield* seedStepStartedFor(panelContext, "event-step-started-panel");

      const outcome = yield* executor.execute(panelContext);

      assert.equal(outcome._tag, "completed");
      if (outcome._tag === "completed") {
        const output = outcome.output as {
          readonly verdict: string;
          readonly votes: ReadonlyArray<{ readonly verdict: string | null }>;
        };
        assert.equal(output.verdict, "approve");
        assert.equal(output.votes.length, 3);
        assert.deepEqual(
          output.votes.map((vote) => vote.verdict),
          ["approve", "revise", "approve"],
        );
      }
      assert.equal(dispatchStartInputs.length, 3);
      const titles = dispatchStartInputs.map(
        (input) => (input as { readonly threadTitle?: string }).threadTitle ?? "",
      );
      assert.isTrue(titles.some((title) => title.includes("reviewer 1/3")));
      // Each member must run on its own dispatch thread.
      const threads = new Set(
        dispatchStartInputs.map((input) => (input as { readonly threadId: string }).threadId),
      );
      assert.equal(threads.size, 3);
    }),
  );

  it.effect("fails without a strict majority", () =>
    Effect.gen(function* () {
      dispatchStartInputs.length = 0;
      panelVerdictQueue.length = 0;
      panelVerdictQueue.push({ verdict: "approve" }, { verdict: "revise" });
      const executor = yield* StepExecutor;
      const panelContext: StepExecutionContext = {
        ...context,
        ticketId: "ticket-panel-split" as never,
        stepRunId: "step-run-panel-split" as never,
        step: {
          key: "review" as never,
          type: "agent",
          agent: { instance: "codex" as never, model: "gpt-5.5" as never },
          instruction: "Review the work",
          captureOutput: true,
          panel: 2,
        } as never,
      };
      yield* seedStepStartedFor(panelContext, "event-step-started-panel-split");

      const outcome = yield* executor.execute(panelContext);

      assert.equal(outcome._tag, "failed");
      if (outcome._tag === "failed") {
        assert.include(outcome.error, "did not reach a majority");
      }
    }),
  );
});

mk({ ok: true }, { projectTrusted: false })("RealStepExecutor untrusted script", (it) => {
  it.effect("blocks before setup, lease, checkpoints, or command execution", () =>
    Effect.gen(function* () {
      checkpointCalls.length = 0;
      setupCalls.length = 0;
      const executor = yield* StepExecutor;
      const sql = yield* SqlClient.SqlClient;
      yield* seedBoard;
      yield* seedStepStartedFor(scriptContext, "event-step-started-untrusted-script");

      const outcome = yield* executor.execute(scriptContext);

      assert.deepEqual(outcome, {
        _tag: "blocked",
        reason: "Project not trusted to run scripts",
      });
      assert.deepEqual(setupCalls, []);
      assert.deepEqual(checkpointCalls, [
        "hasBaseline:/tmp/wt-ticket-1",
        "captureBaseline:/tmp/wt-ticket-1",
      ]);
      const rows = yield* sql<{ readonly ownerKind: string }>`
        SELECT owner_kind AS "ownerKind"
        FROM worktree_lease
        WHERE worktree_ref = 'wt-ticket-1'
      `;
      assert.deepEqual(rows, []);
    }),
  );
});

mk({ ok: false, error: "provider failed" })("RealStepExecutor failure", (it) => {
  it.effect("fails an agent step when provider dispatch fails", () =>
    Effect.gen(function* () {
      checkpointCalls.length = 0;
      const executor = yield* StepExecutor;
      yield* seedStepStarted;

      const outcome = yield* executor.execute(context);

      assert.deepEqual(outcome, { _tag: "failed", error: "provider failed" });
      assert.deepEqual(checkpointCalls, [
        "hasBaseline:/tmp/wt-ticket-1",
        "captureBaseline:/tmp/wt-ticket-1",
        "captureStep:step-run-1:/tmp/wt-ticket-1:pre",
        "captureStep:step-run-1:/tmp/wt-ticket-1:post",
      ]);
      yield* assertProjectedStepRefs;
    }),
  );
});

const preCheckpointFailureLayer = it.layer(
  RealStepExecutorLive.pipe(
    Layer.provideMerge(
      Layer.succeed(WorktreePort, {
        ensureWorktree: () =>
          Effect.succeed({
            repoRoot: "/tmp/repo-ticket-1",
            worktreeRef: "wt-ticket-1",
            path: "/tmp/wt-ticket-1",
          }),
      }),
    ),
    Layer.provideMerge(WorktreeLeaseServiceLive),
    Layer.provideMerge(
      Layer.succeed(SetupRunService, {
        runSetup: () => Effect.succeed({ status: "completed", exitCode: 0 }),
      }),
    ),
    Layer.provideMerge(ScriptStepExecutorLive),
    Layer.provideMerge(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectScriptTrust, {
        isTrusted: () => Effect.succeed(true),
        setTrusted: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ScriptCommandRunner, {
        run: () => Effect.succeed({ outcome: "exited", exitCode: 0, signal: null }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(TicketCheckpointService, {
        hasBaseline: () => Effect.succeed(true),
        captureBaseline: () => Effect.succeed("refs/t3/tickets/dC0x/base"),
        captureStep: (_ticketId, _stepRunId, _cwd, kind) =>
          kind === "pre"
            ? Effect.fail(new WorkflowEventStoreError({ message: "pre checkpoint failed" }))
            : Effect.succeed(postRef),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderDispatchOutbox, {
        confirmStep: () => Effect.void,
        ensureStarted: () => Effect.succeed({ turnId: "turn-stub" as never }),
        getDispatchForStep: () => Effect.succeed(null),
        awaitTerminal: () => Effect.succeed({ ok: true }),
        awaitStepTerminal: () => Effect.succeed({ ok: true }),
        recoverPending: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(CapturedStepOutputReader, {
        read: () => Effect.void,
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(StubTicketMergeServiceLayer, StubTicketPullRequestServiceLayer, WorkflowEventCommitterLive)),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

preCheckpointFailureLayer("RealStepExecutor pre-dispatch failure", (it) => {
  it.effect("releases the worktree lease when pre-step checkpoint capture fails", () =>
    Effect.gen(function* () {
      const executor = yield* StepExecutor;
      const sql = yield* SqlClient.SqlClient;
      yield* seedStepStarted;

      const outcome = yield* executor.execute(context);

      assert.equal(outcome._tag, "failed");
      assert.match((outcome as { readonly error: string }).error, /^executor error: /);
      const rows = yield* sql<{ readonly ownerKind: string }>`
        SELECT owner_kind AS "ownerKind"
        FROM worktree_lease
        WHERE worktree_ref = 'wt-ticket-1'
      `;
      assert.equal(rows[0]?.ownerKind, "released");
    }),
  );
});

const providerSessionCalls: Array<string> = [];
const timeoutDispatchInputs: Array<unknown> = [];

const terminalTimeoutLayer = it.layer(
  RealStepExecutorLive.pipe(
    Layer.provideMerge(
      Layer.succeed(WorktreePort, {
        ensureWorktree: () =>
          Effect.succeed({
            repoRoot: "/tmp/repo-ticket-1",
            worktreeRef: "wt-ticket-1",
            path: "/tmp/wt-ticket-1",
          }),
      }),
    ),
    Layer.provideMerge(WorktreeLeaseServiceLive),
    Layer.provideMerge(
      Layer.succeed(SetupRunService, {
        runSetup: () => Effect.succeed({ status: "completed", exitCode: 0 }),
      }),
    ),
    Layer.provideMerge(ScriptStepExecutorLive),
    Layer.provideMerge(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectScriptTrust, {
        isTrusted: () => Effect.succeed(true),
        setTrusted: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ScriptCommandRunner, {
        run: () => Effect.succeed({ outcome: "exited", exitCode: 0, signal: null }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(TicketCheckpointService, {
        hasBaseline: () => Effect.succeed(true),
        captureBaseline: () => Effect.succeed("refs/t3/tickets/dC0x/base"),
        captureStep: (_ticketId, _stepRunId, _cwd, kind) =>
          Effect.succeed(kind === "pre" ? preRef : postRef),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderDispatchOutbox, {
        confirmStep: () => Effect.void,
        ensureStarted: (input) =>
          Effect.sync(() => {
            timeoutDispatchInputs.push(input);
            return { turnId: "turn-stub" as never };
          }),
        getDispatchForStep: () => Effect.succeed(null),
        awaitTerminal: () =>
          Effect.succeed({
            ok: false,
            error: "turn did not reach a terminal state before timeout",
          }),
        awaitStepTerminal: () =>
          Effect.succeed({
            ok: false,
            error: "turn did not reach a terminal state before timeout",
          }),
        recoverPending: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderService, {
        startSession: () => Effect.die("unused startSession"),
        sendTurn: () => Effect.die("unused sendTurn"),
        interruptTurn: (input) =>
          Effect.sync(() => {
            providerSessionCalls.push(`interrupt:${input.threadId as string}:${input.turnId as string}`);
          }),
        respondToRequest: () => Effect.die("unused respondToRequest"),
        respondToUserInput: () => Effect.die("unused respondToUserInput"),
        stopSession: (input) =>
          Effect.sync(() => {
            providerSessionCalls.push(`stop:${input.threadId as string}`);
          }),
        listSessions: () => Effect.succeed([]),
        getCapabilities: () => Effect.die("unused getCapabilities"),
        getInstanceInfo: () => Effect.die("unused getInstanceInfo"),
        rollbackConversation: () => Effect.die("unused rollbackConversation"),
        streamEvents: Stream.empty,
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(CapturedStepOutputReader, {
        read: () => Effect.void,
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(StubTicketMergeServiceLayer, StubTicketPullRequestServiceLayer, WorkflowEventCommitterLive)),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(realStepExecutorTestSupport),
    Layer.provideMerge(NodeServices.layer),
  ),
);

terminalTimeoutLayer("RealStepExecutor terminal-wait timeout", (it) => {
  it.effect("stops the provider session when the turn never reached a terminal state", () =>
    Effect.gen(function* () {
      providerSessionCalls.length = 0;
      timeoutDispatchInputs.length = 0;
      const executor = yield* StepExecutor;
      yield* seedStepStarted;

      const outcome = yield* executor.execute(context);

      assert.deepEqual(outcome, {
        _tag: "failed",
        error: "turn did not reach a terminal state before timeout",
      });
      // The still-live agent must be interrupted and its session stopped so
      // it cannot keep mutating the worktree after the pipeline routed on.
      const threadId = (timeoutDispatchInputs[0] as { readonly threadId: string }).threadId;
      assert.deepEqual(providerSessionCalls, [
        `interrupt:${threadId}:turn-stub`,
        `stop:${threadId}`,
      ]);
    }),
  );
});
