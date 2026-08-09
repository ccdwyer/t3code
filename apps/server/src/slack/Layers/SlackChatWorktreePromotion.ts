import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type ProviderInteractionMode,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { WorktreeSeedService } from "../../project/WorktreeSeedService.ts";
import { SlackAgentGateway } from "../../workflow/Services/SlackAgentGateway.ts";
import { SlackAgentRunStore } from "../../workflow/Services/SlackAgentRunStore.ts";
import { SlackChatWorktreeCoordinator } from "../Services/SlackChatWorktreeCoordinator.ts";
import {
  SlackChatWorktreePromotion,
  SlackChatWorktreePromotionOperationError,
  SlackChatWorktreePromotionUnavailableError,
  type SlackChatWorktreePromotionResult,
} from "../Services/SlackChatWorktreePromotion.ts";

type PromotionTurnEnd =
  | { readonly type: "completed" | "aborted"; readonly turnId: TurnId }
  | { readonly type: "session-exited" };

interface PreparingContinuation {
  readonly state: "preparing";
  readonly originTurnId: TurnId;
}

interface PendingContinuation {
  readonly state: "pending";
  readonly originTurnId: TurnId;
  readonly runtimeCommandId: CommandId;
  readonly turnCommandId: CommandId;
  readonly messageId: MessageId;
  readonly modelSelection: ModelSelection;
  readonly interactionMode: ProviderInteractionMode;
}

interface SettledContinuation {
  readonly state: "settled";
  readonly originTurnId: TurnId;
  readonly end: PromotionTurnEnd;
}

type ContinuationState = PreparingContinuation | PendingContinuation | SettledContinuation;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const continuationText =
  "T3 created an isolated worktree for this Slack conversation. Continue the previous request from the new worktree and carry out the requested changes.";

const make = Effect.gen(function* () {
  const runtimeScope = yield* Scope.Scope;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const gitWorkflow = yield* GitWorkflowService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const setupScriptRunner = yield* ProjectSetupScriptRunner;
  const worktreeSeedService = yield* WorktreeSeedService;
  const slackGateway = yield* SlackAgentGateway;
  const runStore = yield* SlackAgentRunStore;
  const worktreeCoordinator = yield* SlackChatWorktreeCoordinator;
  const continuations = yield* SynchronizedRef.make<ReadonlyMap<string, ContinuationState>>(
    new Map(),
  );
  const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);
  const branchTokenFor = (threadId: ThreadId) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(String(threadId)))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const operationError = (
    threadId: ThreadId,
    operation: SlackChatWorktreePromotionOperationError["operation"],
  ) =>
    new SlackChatWorktreePromotionOperationError({
      threadId,
      operation,
      message: `Slack worktree promotion failed during ${operation}.`,
    });

  const loadThread = Effect.fn("SlackChatWorktreePromotion.loadThread")(function* (
    threadId: ThreadId,
  ) {
    const lifecycle = yield* (
      projectionSnapshotQuery.getThreadLifecycleShellById?.(threadId) ??
      projectionSnapshotQuery
        .getThreadShellById(threadId)
        .pipe(Effect.map(Option.map((thread) => ({ thread, deletedAt: null }))))
    ).pipe(Effect.mapError(() => operationError(threadId, "load-thread")));
    if (Option.isNone(lifecycle)) {
      return yield* new SlackChatWorktreePromotionUnavailableError({
        threadId,
        reason: "thread-not-found",
        message: "The linked T3 chat thread no longer exists.",
      });
    }
    if (lifecycle.value.deletedAt !== null) {
      return yield* new SlackChatWorktreePromotionUnavailableError({
        threadId,
        reason: "thread-deleted",
        message: "The linked T3 chat thread was deleted.",
      });
    }
    return lifecycle.value.thread;
  });

  const originTurnIdFor = (thread: OrchestrationThreadShell): TurnId | null =>
    thread.session?.activeTurnId ??
    (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null);

  const endMatchesOrigin = (end: PromotionTurnEnd, originTurnId: TurnId): boolean =>
    end.type === "session-exited" || String(end.turnId) === String(originTurnId);

  const beginContinuationPreparation = (threadId: ThreadId, originTurnId: TurnId) =>
    SynchronizedRef.modify(continuations, (current) => {
      const value = current.get(threadId);
      if (value?.state === "pending" && String(value.originTurnId) === String(originTurnId)) {
        return [false, current] as const;
      }
      const next = new Map(current);
      next.set(threadId, { state: "preparing", originTurnId });
      return [true, next] as const;
    });

  const clearContinuationPreparation = (threadId: ThreadId, originTurnId: TurnId) =>
    SynchronizedRef.update(continuations, (current) => {
      const value = current.get(threadId);
      if (
        value === undefined ||
        value.state === "pending" ||
        String(value.originTurnId) !== String(originTurnId)
      ) {
        return current;
      }
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });

  const whilePreparingContinuation = <A, E, R>(
    threadId: ThreadId,
    originTurnId: TurnId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    beginContinuationPreparation(threadId, originTurnId).pipe(
      Effect.flatMap((preparationStarted) =>
        preparationStarted
          ? effect.pipe(Effect.ensuring(clearContinuationPreparation(threadId, originTurnId)))
          : effect,
      ),
    );

  const scheduleContinuation = Effect.fn("SlackChatWorktreePromotion.scheduleContinuation")(
    function* (threadId: ThreadId, originTurnId: TurnId) {
      const alreadyPending = yield* SynchronizedRef.get(continuations).pipe(
        Effect.map((current) => {
          const value = current.get(threadId);
          return value?.state === "pending" && String(value.originTurnId) === String(originTurnId);
        }),
      );
      if (alreadyPending) return true;

      const thread = yield* loadThread(threadId);
      const currentOriginTurnId = originTurnIdFor(thread);
      if (currentOriginTurnId === null || String(currentOriginTurnId) !== String(originTurnId)) {
        return false;
      }
      const ids = yield* Effect.all({
        runtimeCommandId: randomUUID.pipe(
          Effect.map((uuid) => CommandId.make(`slack-promote-runtime:${uuid}`)),
        ),
        turnCommandId: randomUUID.pipe(
          Effect.map((uuid) => CommandId.make(`slack-promote-turn:${uuid}`)),
        ),
        messageId: randomUUID.pipe(
          Effect.map((uuid) => MessageId.make(`slack-promote-message:${uuid}`)),
        ),
      });
      return yield* SynchronizedRef.modify(continuations, (current) => {
        const value = current.get(thread.id);
        if (
          value === undefined ||
          String(value.originTurnId) !== String(originTurnId) ||
          value.state === "settled"
        ) {
          const next = new Map(current);
          if (value?.state === "settled") next.delete(thread.id);
          return [false, next] as const;
        }
        const next = new Map(current);
        next.set(thread.id, {
          state: "pending",
          ...ids,
          originTurnId,
          modelSelection: thread.modelSelection,
          interactionMode: thread.interactionMode,
        });
        return [true, next] as const;
      });
    },
  );

  const runSetupScript = (thread: OrchestrationThreadShell, worktreePath: string) =>
    setupScriptRunner
      .runForThread({
        threadId: thread.id,
        projectId: thread.projectId,
        worktreePath,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Slack chat worktree setup script failed to start", {
            threadId: thread.id,
            worktreePath,
            cause,
          }),
        ),
      );

  const promote = Effect.fn("SlackChatWorktreePromotion.promote")(function* (threadId: ThreadId) {
    return yield* worktreeCoordinator.withPermit(
      threadId,
      Effect.gen(function* (): Effect.fn.Return<
        SlackChatWorktreePromotionResult,
        SlackChatWorktreePromotionOperationError | SlackChatWorktreePromotionUnavailableError
      > {
        const slackRun = yield* runStore
          .findChatByThreadId(threadId)
          .pipe(Effect.mapError(() => operationError(threadId, "load-slack-chat")));
        if (slackRun === null) {
          return yield* new SlackChatWorktreePromotionUnavailableError({
            threadId,
            reason: "not-slack-chat",
            message: "Only Slack-linked chat threads can promote themselves to a worktree.",
          });
        }

        const thread = yield* loadThread(threadId);
        const persistedCheckoutExists =
          thread.worktreePath !== null
            ? yield* fileSystem.exists(thread.worktreePath).pipe(Effect.orElseSucceed(() => false))
            : false;
        if (thread.branch !== null && thread.worktreePath !== null && persistedCheckoutExists) {
          let continuationScheduled = thread.runtimeMode !== "full-access";
          if (continuationScheduled) {
            const originTurnId = originTurnIdFor(thread);
            if (originTurnId === null) {
              return yield* operationError(threadId, "continue-turn");
            }
            continuationScheduled = yield* whilePreparingContinuation(
              thread.id,
              originTurnId,
              scheduleContinuation(thread.id, originTurnId),
            );
          }
          return {
            threadId,
            state: "existing",
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            baseBranch: null,
            continuationScheduled,
          };
        }

        const originTurnId = originTurnIdFor(thread);
        if (originTurnId === null) {
          return yield* operationError(threadId, "continue-turn");
        }

        const project = yield* projectionSnapshotQuery
          .getProjectShellById(thread.projectId)
          .pipe(Effect.mapError(() => operationError(threadId, "load-project")));
        if (Option.isNone(project)) {
          return yield* new SlackChatWorktreePromotionUnavailableError({
            threadId,
            reason: "project-not-found",
            message: "The project linked to this Slack chat no longer exists.",
          });
        }

        return yield* whilePreparingContinuation(
          thread.id,
          originTurnId,
          Effect.gen(function* () {
            let prepared: {
              readonly state: "prepared" | "rehydrated";
              readonly worktree: { readonly path: string; readonly refName: string };
              readonly baseBranch: string | null;
            };
            if (thread.branch === null) {
              const branchToken = yield* branchTokenFor(thread.id);
              const branch = buildTemporaryWorktreeBranchName(() => branchToken);
              const created = yield* gitWorkflow
                .createWorktreeFromLatestDefaultBranch({
                  cwd: project.value.workspaceRoot,
                  newRefName: branch,
                })
                .pipe(Effect.mapError(() => operationError(threadId, "prepare-worktree")));
              prepared = {
                state: "prepared",
                worktree: created.worktree,
                baseBranch: created.baseBranch,
              };
            } else {
              const created = yield* gitWorkflow
                .createWorktreeFromExistingBranch({
                  cwd: project.value.workspaceRoot,
                  refName: thread.branch,
                })
                .pipe(Effect.mapError(() => operationError(threadId, "prepare-worktree")));
              prepared = {
                state: "rehydrated",
                worktree: created.worktree,
                baseBranch: null,
              };
            }

            const updateThread = orchestrationEngine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.make(`slack-promote-meta:${yield* randomUUID}`),
              threadId,
              branch: prepared.worktree.refName,
              worktreePath: prepared.worktree.path,
            });
            yield* updateThread.pipe(
              Effect.tapError(() =>
                gitWorkflow
                  .removeWorktree({
                    cwd: project.value.workspaceRoot,
                    path: prepared.worktree.path,
                    force: true,
                  })
                  .pipe(Effect.ignoreCause),
              ),
              Effect.mapError(() => operationError(threadId, "update-thread")),
            );
            yield* worktreeSeedService.seed({
              projectCwd: project.value.workspaceRoot,
              worktreePath: prepared.worktree.path,
            });
            yield* runSetupScript(thread, prepared.worktree.path);
            const continuationScheduled = yield* scheduleContinuation(thread.id, originTurnId);

            return {
              threadId,
              state: prepared.state,
              branch: prepared.worktree.refName,
              worktreePath: prepared.worktree.path,
              baseBranch: prepared.baseBranch,
              continuationScheduled,
            };
          }),
        );
      }),
    );
  });

  const reportContinuationFailure = (threadId: ThreadId, pending: PendingContinuation) =>
    runStore.findChatByThreadId(threadId).pipe(
      Effect.flatMap((run) =>
        run === null
          ? Effect.void
          : slackGateway
              .postOrUpdateStatus({
                workspaceId: run.thread.workspaceId,
                channelId: run.thread.channelId,
                channelName: run.thread.channelName,
                threadTs: run.thread.threadTs,
                runId: run.runId,
                deliveryId: `slack-promote-continuation:${pending.turnCommandId}`,
                text: "T3 created the isolated worktree, but could not start the full-access continuation. Reply in Slack or T3 to continue from the promoted thread.",
                forceNewMessage: true,
              })
              .pipe(Effect.asVoid),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("failed to report Slack worktree continuation failure", {
          threadId,
          cause,
        }),
      ),
    );

  const settleTurn: SlackChatWorktreePromotion["Service"]["settleTurn"] = Effect.fn(
    "SlackChatWorktreePromotion.settleTurn",
  )(function* (threadId, end) {
    const pending = yield* SynchronizedRef.modify(continuations, (current) => {
      const value = current.get(threadId);
      if (value === undefined || !endMatchesOrigin(end, value.originTurnId)) {
        return [undefined, current] as const;
      }
      if (value.state === "preparing") {
        const next = new Map(current);
        next.set(threadId, {
          state: "settled",
          originTurnId: value.originTurnId,
          end,
        });
        return [undefined, next] as const;
      }
      const next = new Map(current);
      next.delete(threadId);
      return [
        value.state === "pending" && end.type === "completed" ? value : undefined,
        next,
      ] as const;
    });
    if (pending === undefined) return;

    yield* worktreeCoordinator
      .withPermit(
        threadId,
        Effect.gen(function* () {
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* Effect.gen(function* () {
            yield* orchestrationEngine.dispatch({
              type: "thread.runtime-mode.set",
              commandId: pending.runtimeCommandId,
              threadId,
              runtimeMode: "full-access",
              createdAt,
            });
            yield* orchestrationEngine.dispatch({
              type: "thread.turn.start",
              commandId: pending.turnCommandId,
              threadId,
              message: {
                messageId: pending.messageId,
                role: "user",
                text: continuationText,
                attachments: [],
              },
              modelSelection: pending.modelSelection,
              runtimeMode: "full-access",
              interactionMode: pending.interactionMode,
              createdAt,
            });
          }).pipe(
            Effect.retry(Schedule.recurs(2)),
            Effect.catch((cause) =>
              Effect.all([
                Effect.logWarning("failed to continue Slack chat after worktree promotion", {
                  threadId,
                  cause,
                }),
                reportContinuationFailure(threadId, pending).pipe(
                  Effect.timeout("5 seconds"),
                  Effect.catch((timeoutCause) =>
                    Effect.logWarning("Slack worktree continuation warning timed out", {
                      threadId,
                      timeoutCause,
                    }),
                  ),
                ),
              ]).pipe(Effect.asVoid),
            ),
          );
        }),
      )
      .pipe(Effect.forkIn(runtimeScope), Effect.asVoid);
  });

  return SlackChatWorktreePromotion.of({ promote, settleTurn });
});

export const SlackChatWorktreePromotionLive = Layer.effect(SlackChatWorktreePromotion, make);
