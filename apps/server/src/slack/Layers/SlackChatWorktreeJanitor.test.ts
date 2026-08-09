import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import { SlackAgentRunStore } from "../../workflow/Services/SlackAgentRunStore.ts";
import { SlackChatWorktreeJanitor } from "../Services/SlackChatWorktreeJanitor.ts";
import { SlackChatWorktreeCoordinatorLive } from "./SlackChatWorktreeCoordinator.ts";
import {
  SlackChatWorktreeJanitorLive,
  makeSlackChatWorktreeJanitorLive,
} from "./SlackChatWorktreeJanitor.ts";

const projectId = ProjectId.make("project-slack-janitor");
const threadId = ThreadId.make("thread-slack-janitor");
const worktreePath = "/tmp/worktrees/slack-janitor";

const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/tmp/project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00.000Z" as never,
  updatedAt: "2026-07-01T00:00:00.000Z" as never,
};

const thread = (overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell => ({
  id: threadId,
  projectId,
  title: "Slack work",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.5",
  },
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: "t3code/slack-janitor",
  worktreePath,
  latestTurn: null,
  createdAt: "2026-07-01T00:00:00.000Z" as never,
  updatedAt: "2026-07-01T00:00:00.000Z" as never,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  titleRegeneration: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const snapshot = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot => ({
  snapshotSequence: 1,
  projects: [project],
  threads,
  updatedAt: "2026-08-09T00:00:00.000Z" as never,
});

const emptySnapshot = snapshot([]);

const localStatus = (dirty: boolean) => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "t3code/slack-janitor",
  hasWorkingTreeChanges: dirty,
  workingTree: {
    files: dirty ? [{ path: "changed.ts", insertions: 1, deletions: 0 }] : [],
    insertions: dirty ? 1 : 0,
    deletions: 0,
  },
});

const makeLayer = (input: {
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly dirty?: boolean;
  readonly activeTerminalThreadIds?: ReadonlyArray<string>;
  readonly bufferedTerminalUpsertThreadIds?: ReadonlyArray<string>;
  readonly slackThreadIds?: ReadonlyArray<string>;
  readonly removed: Array<unknown>;
  readonly commands: Array<OrchestrationCommand>;
  readonly retentionDays?: number | null;
}) =>
  makeSlackChatWorktreeJanitorLive({
    nowMs: Effect.succeed(Date.parse("2026-08-09T00:00:00.000Z")),
    sweepIntervalMs: 60_000,
  }).pipe(
    Layer.provideMerge(SlackChatWorktreeCoordinatorLive),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery, {
        getShellSnapshot: () => Effect.succeed(snapshot(input.threads ?? [thread()])),
        getArchivedShellSnapshot: () => Effect.succeed(emptySnapshot),
      } as unknown as ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(
      Layer.mock(SlackAgentRunStore)({
        findChatByThreadId: (candidateThreadId) =>
          Effect.succeed(
            (input.slackThreadIds ?? [threadId]).includes(candidateThreadId)
              ? ({ runId: "slackrun-janitor" } as never)
              : null,
          ),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(GitWorkflowService)({
        localStatus: () => Effect.succeed(localStatus(input.dirty ?? false)),
        removeWorktree: (removeInput) =>
          Effect.sync(() => {
            input.removed.push(removeInput);
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            input.commands.push(command);
            return { sequence: 1 };
          }),
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(TerminalManager)({
        subscribeMetadata: (listener) =>
          listener({
            type: "snapshot",
            terminals: (input.activeTerminalThreadIds ?? []).map((activeThreadId) => ({
              threadId: activeThreadId,
              terminalId: "terminal-1",
              cwd: worktreePath,
              worktreePath,
              status: "running" as const,
              pid: 123,
              exitCode: null,
              exitSignal: null,
              hasRunningSubprocess: true,
              label: "setup",
              updatedAt: "2026-08-09T00:00:00.000Z",
            })),
          }).pipe(
            Effect.andThen(
              Effect.forEach(input.bufferedTerminalUpsertThreadIds ?? [], (activeThreadId) =>
                listener({
                  type: "upsert",
                  terminal: {
                    threadId: activeThreadId,
                    terminalId: "terminal-buffered",
                    cwd: worktreePath,
                    worktreePath,
                    status: "running" as const,
                    pid: 456,
                    exitCode: null,
                    exitSignal: null,
                    hasRunningSubprocess: true,
                    label: "buffered setup",
                    updatedAt: "2026-08-09T00:00:00.000Z",
                  },
                }),
              ),
            ),
            Effect.as(() => undefined),
          ),
      }),
    ),
    Layer.provideMerge(
      ServerSettings.layerTest({
        slackWorktreeRetentionDays: input.retentionDays === undefined ? 14 : input.retentionDays,
      }),
    ),
  );

it.effect("removes only the clean checkout and preserves the durable branch", () => {
  const removed: Array<unknown> = [];
  const commands: Array<OrchestrationCommand> = [];
  return Effect.gen(function* () {
    const janitor = yield* SlackChatWorktreeJanitor;

    const result = yield* janitor.sweep();

    assert.deepStrictEqual(result, {
      enabled: true,
      candidateCount: 1,
      removedCount: 1,
      dirtyCount: 0,
      inUseCount: 0,
      failedCount: 0,
    });
    assert.deepStrictEqual(removed, [
      { cwd: project.workspaceRoot, path: worktreePath, force: false },
    ]);
    assert.deepStrictEqual(commands, [
      {
        type: "thread.runtime-mode.set",
        commandId: commands[0]?.commandId ?? CommandId.make("missing-runtime"),
        threadId,
        runtimeMode: "approval-required",
        createdAt: "2026-08-09T00:00:00.000Z",
      },
      {
        type: "thread.meta.update",
        commandId: commands[1]?.commandId ?? CommandId.make("missing-meta"),
        threadId,
        worktreePath: null,
      },
    ]);
    assert.ok(!("branch" in (commands[1] ?? {})));
  }).pipe(Effect.provide(makeLayer({ removed, commands })));
});

it.effect("skips dirty checkouts", () => {
  const removed: Array<unknown> = [];
  const commands: Array<OrchestrationCommand> = [];
  return Effect.gen(function* () {
    const dirtyJanitor = yield* SlackChatWorktreeJanitor;
    const dirtyResult = yield* dirtyJanitor.sweep();
    assert.strictEqual(dirtyResult.dirtyCount, 1);
    assert.strictEqual(dirtyResult.removedCount, 0);
    assert.deepStrictEqual(removed, []);
  }).pipe(Effect.provide(makeLayer({ removed, commands, dirty: true })));
});

it.effect("skips a checkout while the Slack thread has an active terminal", () => {
  const removed: Array<unknown> = [];
  const commands: Array<OrchestrationCommand> = [];
  return Effect.gen(function* () {
    const janitor = yield* SlackChatWorktreeJanitor;
    const result = yield* janitor.sweep();
    assert.strictEqual(result.inUseCount, 1);
    assert.strictEqual(result.removedCount, 0);
  }).pipe(Effect.provide(makeLayer({ removed, commands, activeTerminalThreadIds: [threadId] })));
});

it.effect("skips a checkout when a terminal starts while the initial snapshot is delivered", () => {
  const removed: Array<unknown> = [];
  const commands: Array<OrchestrationCommand> = [];
  return Effect.gen(function* () {
    const janitor = yield* SlackChatWorktreeJanitor;
    const result = yield* janitor.sweep();
    assert.strictEqual(result.inUseCount, 1);
    assert.strictEqual(result.removedCount, 0);
  }).pipe(
    Effect.provide(makeLayer({ removed, commands, bufferedTerminalUpsertThreadIds: [threadId] })),
  );
});

it.effect("skips a checkout path referenced by more than one thread", () => {
  const removed: Array<unknown> = [];
  const commands: Array<OrchestrationCommand> = [];
  const otherThreadId = ThreadId.make("thread-slack-janitor-shared");
  return Effect.gen(function* () {
    const janitor = yield* SlackChatWorktreeJanitor;
    const result = yield* janitor.sweep();
    assert.strictEqual(result.candidateCount, 2);
    assert.strictEqual(result.inUseCount, 2);
    assert.strictEqual(result.removedCount, 0);
  }).pipe(
    Effect.provide(
      makeLayer({
        removed,
        commands,
        threads: [thread(), thread({ id: otherThreadId })],
        slackThreadIds: [threadId, otherThreadId],
      }),
    ),
  );
});

it.effect("ignores stale worktrees that are not linked to Slack chats", () => {
  const removed: Array<unknown> = [];
  const commands: Array<OrchestrationCommand> = [];
  return Effect.gen(function* () {
    const janitor = yield* SlackChatWorktreeJanitor;
    const result = yield* janitor.sweep();
    assert.strictEqual(result.candidateCount, 0);
    assert.strictEqual(result.removedCount, 0);
  }).pipe(Effect.provide(makeLayer({ removed, commands, slackThreadIds: [] })));
});

it.effect("does not inspect or remove checkouts when retention is disabled", () => {
  const removed: Array<unknown> = [];
  const commands: Array<OrchestrationCommand> = [];
  return Effect.gen(function* () {
    const janitor = yield* SlackChatWorktreeJanitor;
    assert.deepStrictEqual(yield* janitor.sweep(), {
      enabled: false,
      candidateCount: 0,
      removedCount: 0,
      dirtyCount: 0,
      inUseCount: 0,
      failedCount: 0,
    });
  }).pipe(Effect.provide(makeLayer({ removed, commands, retentionDays: null })));
});

void SlackChatWorktreeJanitorLive;
