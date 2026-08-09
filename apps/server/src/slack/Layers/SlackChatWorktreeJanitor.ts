import { CommandId, type OrchestrationThreadShell } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import { SlackAgentRunStore } from "../../workflow/Services/SlackAgentRunStore.ts";
import { SlackChatWorktreeCoordinator } from "../Services/SlackChatWorktreeCoordinator.ts";
import {
  SlackChatWorktreeJanitor,
  type SlackChatWorktreeSweepResult,
} from "../Services/SlackChatWorktreeJanitor.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_SWEEP_INTERVAL_MS = DAY_MS;

export interface SlackChatWorktreeJanitorLiveOptions {
  readonly nowMs?: Effect.Effect<number>;
  readonly sweepIntervalMs?: number;
}

const emptyResult = (enabled: boolean): SlackChatWorktreeSweepResult => ({
  enabled,
  candidateCount: 0,
  removedCount: 0,
  dirtyCount: 0,
  inUseCount: 0,
  failedCount: 0,
});

const threadIsInactive = (thread: OrchestrationThreadShell): boolean => {
  if (thread.latestTurn?.state === "running") return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.backgroundLiveness !== undefined && thread.backgroundLiveness !== null) return false;
  if (thread.session === null) return true;
  return (
    thread.session.activeTurnId === null &&
    (thread.session.status === "stopped" ||
      thread.session.status === "error" ||
      thread.session.status === "interrupted")
  );
};

const readActiveTerminalThreadIds = Effect.fn(
  "SlackChatWorktreeJanitor.readActiveTerminalThreadIds",
)(function* (terminalManager: TerminalManager["Service"]) {
  const activeTerminals = new Map<string, string>();
  const terminalKey = (threadId: string, terminalId: string) => `${threadId}\0${terminalId}`;
  const recordTerminal = (terminal: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly status: string;
    readonly hasRunningSubprocess: boolean;
  }) => {
    const key = terminalKey(terminal.threadId, terminal.terminalId);
    if (
      terminal.status === "starting" ||
      terminal.status === "running" ||
      terminal.hasRunningSubprocess
    ) {
      activeTerminals.set(key, terminal.threadId);
    } else {
      activeTerminals.delete(key);
    }
  };
  const unsubscribe = yield* terminalManager.subscribeMetadata((event) =>
    Effect.sync(() => {
      if (event.type === "snapshot") {
        activeTerminals.clear();
        for (const terminal of event.terminals) {
          recordTerminal(terminal);
        }
        return;
      }
      if (event.type === "upsert") {
        recordTerminal(event.terminal);
        return;
      }
      activeTerminals.delete(terminalKey(event.threadId, event.terminalId));
    }),
  );
  unsubscribe();
  return new Set(activeTerminals.values());
});

export const makeSlackChatWorktreeJanitorLive = (options?: SlackChatWorktreeJanitorLiveOptions) =>
  Layer.effect(
    SlackChatWorktreeJanitor,
    Effect.gen(function* () {
      const gitWorkflow = yield* GitWorkflowService;
      const orchestrationEngine = yield* OrchestrationEngineService;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      const runStore = yield* SlackAgentRunStore;
      const serverSettings = yield* ServerSettingsService;
      const terminalManager = yield* TerminalManager;
      const worktreeCoordinator = yield* SlackChatWorktreeCoordinator;
      const nowMs = options?.nowMs ?? Clock.currentTimeMillis;
      const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

      const sweep = Effect.fn("SlackChatWorktreeJanitor.sweep")(function* () {
        const settings = yield* serverSettings.getSettings;
        const retentionDays = settings.slackWorktreeRetentionDays;
        if (retentionDays === null) return emptyResult(false);

        const now = yield* nowMs;
        const cutoff = now - retentionDays * DAY_MS;
        const [activeSnapshot, archivedSnapshot, activeTerminalThreadIds] = yield* Effect.all([
          projectionSnapshotQuery.getShellSnapshot(),
          projectionSnapshotQuery.getArchivedShellSnapshot(),
          readActiveTerminalThreadIds(terminalManager),
        ]);

        const projects = new Map(
          [...activeSnapshot.projects, ...archivedSnapshot.projects].map((project) => [
            project.id,
            project,
          ]),
        );
        const threads = new Map(
          [...activeSnapshot.threads, ...archivedSnapshot.threads].map((thread) => [
            thread.id,
            thread,
          ]),
        );
        const worktreeOwners = new Map<string, number>();
        for (const thread of threads.values()) {
          if (thread.worktreePath === null) continue;
          worktreeOwners.set(
            thread.worktreePath,
            (worktreeOwners.get(thread.worktreePath) ?? 0) + 1,
          );
        }

        let candidateCount = 0;
        let removedCount = 0;
        let dirtyCount = 0;
        let inUseCount = 0;
        let failedCount = 0;

        for (const thread of threads.values()) {
          if (thread.branch === null || thread.worktreePath === null) continue;
          const branch = thread.branch;
          const worktreePath = thread.worktreePath;
          if (Date.parse(thread.updatedAt) >= cutoff) continue;

          const slackRun = yield* runStore.findChatByThreadId(thread.id).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Slack worktree cleanup could not identify linked chat", {
                threadId: thread.id,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
          if (slackRun === null) continue;
          candidateCount += 1;

          const outcome = yield* worktreeCoordinator.withPermit(
            thread.id,
            Effect.gen(function* () {
              const lifecycle = yield* (
                projectionSnapshotQuery.getThreadLifecycleShellById?.(thread.id) ??
                  Effect.succeed(Option.some({ thread, deletedAt: null }))
              );
              if (Option.isNone(lifecycle) || lifecycle.value.deletedAt !== null) {
                return "in-use" as const;
              }
              const current = lifecycle.value.thread;
              const currentActiveTerminals = yield* readActiveTerminalThreadIds(terminalManager);
              if (
                current.branch !== branch ||
                current.worktreePath !== worktreePath ||
                !threadIsInactive(current) ||
                currentActiveTerminals.has(thread.id) ||
                activeTerminalThreadIds.has(thread.id) ||
                (worktreeOwners.get(worktreePath) ?? 0) > 1
              ) {
                return "in-use" as const;
              }

              const project = projects.get(current.projectId);
              if (project === undefined) return "failed" as const;

              const status = yield* gitWorkflow.localStatus({ cwd: worktreePath }).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Slack worktree cleanup could not inspect checkout", {
                    threadId: thread.id,
                    worktreePath,
                    cause,
                  }).pipe(Effect.as(null)),
                ),
              );
              if (status === null || !status.isRepo) return "failed" as const;
              if (status.hasWorkingTreeChanges) return "dirty" as const;

              const createdAt = DateTime.formatIso(DateTime.makeUnsafe(now));
              return yield* Effect.gen(function* () {
                yield* orchestrationEngine.dispatch({
                  type: "thread.runtime-mode.set",
                  commandId: CommandId.make(`slack-worktree-cleanup-runtime:${thread.id}:${now}`),
                  threadId: thread.id,
                  runtimeMode: "approval-required",
                  createdAt,
                });
                yield* gitWorkflow.removeWorktree({
                  cwd: project.workspaceRoot,
                  path: worktreePath,
                  force: false,
                });
                yield* orchestrationEngine.dispatch({
                  type: "thread.meta.update",
                  commandId: CommandId.make(`slack-worktree-cleanup-meta:${thread.id}:${now}`),
                  threadId: thread.id,
                  worktreePath: null,
                });
                return "removed" as const;
              }).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Slack worktree cleanup failed", {
                    threadId: thread.id,
                    worktreePath,
                    branch,
                    cause,
                  }).pipe(Effect.as("failed" as const)),
                ),
              );
            }),
          );
          if (outcome === "removed") removedCount += 1;
          else if (outcome === "dirty") dirtyCount += 1;
          else if (outcome === "in-use") inUseCount += 1;
          else failedCount += 1;
        }

        return {
          enabled: true,
          candidateCount,
          removedCount,
          dirtyCount,
          inUseCount,
          failedCount,
        } satisfies SlackChatWorktreeSweepResult;
      });

      const safeSweep = sweep().pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Slack worktree retention sweep failed", { cause }).pipe(
            Effect.as({ ...emptyResult(true), failedCount: 1 }),
          ),
        ),
      );

      const start = () =>
        safeSweep.pipe(
          Effect.tap((result) =>
            result.candidateCount === 0 && result.failedCount === 0
              ? Effect.void
              : Effect.logInfo("Slack worktree retention sweep completed", result),
          ),
          Effect.repeat(Schedule.spaced(sweepIntervalMs)),
          Effect.forkScoped,
          Effect.asVoid,
        );

      return SlackChatWorktreeJanitor.of({ sweep: () => safeSweep, start });
    }),
  );

export const SlackChatWorktreeJanitorLive = makeSlackChatWorktreeJanitorLive();
