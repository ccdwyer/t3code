import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type SlackAgentRunSummaryView,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { WorktreeSeedService } from "../../project/WorktreeSeedService.ts";
import { SlackAgentGateway } from "../../workflow/Services/SlackAgentGateway.ts";
import { SlackAgentRunStore } from "../../workflow/Services/SlackAgentRunStore.ts";
import { SlackChatWorktreeCoordinator } from "../Services/SlackChatWorktreeCoordinator.ts";
import { SlackChatWorktreePromotion } from "../Services/SlackChatWorktreePromotion.ts";
import { SlackChatWorktreeCoordinatorLive } from "./SlackChatWorktreeCoordinator.ts";
import { SlackChatWorktreePromotionLive } from "./SlackChatWorktreePromotion.ts";

const threadId = ThreadId.make("thread-slack-promotion");
const projectId = ProjectId.make("project-slack-promotion");
const originTurnId = TurnId.make("turn-slack-promotion-origin");

const slackRun = {
  runId: "slackrun-promotion",
  instanceId: "slackinst-promotion",
  projectId,
  handle: "t3_chris",
  botUserId: "U_T3_CHRIS",
  mode: "chat",
  threadId,
  ticketId: null,
  thread: {
    workspaceId: "T_WORKSPACE",
    channelId: "C_CHANNEL",
    channelName: "engineering",
    threadTs: "123.456",
    threadKey: "C_CHANNEL:123.456",
  },
  state: "running",
  statusMessageId: null,
  prUrl: null,
  lastAppliedSequence: 0,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
} as unknown as SlackAgentRunSummaryView;

const projectShell: OrchestrationProjectShell = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/tmp/project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-09T00:00:00.000Z" as never,
  updatedAt: "2026-08-09T00:00:00.000Z" as never,
};

const threadShell = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: threadId,
  projectId,
  title: "Slack request",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claude-main"),
    model: "claude-opus-5",
  },
  runtimeMode: "approval-required",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: null,
  worktreePath: null,
  latestTurn: {
    turnId: originTurnId,
    state: "running",
    requestedAt: "2026-08-09T00:00:00.000Z" as never,
    startedAt: "2026-08-09T00:00:00.000Z" as never,
    completedAt: null,
    assistantMessageId: null,
  },
  createdAt: "2026-08-09T00:00:00.000Z" as never,
  updatedAt: "2026-08-09T00:00:00.000Z" as never,
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

const makeProjectionLayer = (
  thread: OrchestrationThreadShell,
  threadRef?: Ref.Ref<OrchestrationThreadShell>,
  lifecycleReadsRef?: Ref.Ref<number>,
  scheduleLoadStarted?: Deferred.Deferred<void>,
  releaseScheduleLoad?: Deferred.Deferred<void>,
) => {
  const currentThread = () => (threadRef ? Ref.get(threadRef) : Effect.succeed(thread));
  return Layer.succeed(ProjectionSnapshotQuery, {
    getThreadLifecycleShellById: () =>
      Effect.gen(function* () {
        const current = yield* currentThread();
        if (lifecycleReadsRef && scheduleLoadStarted && releaseScheduleLoad) {
          const readNumber = yield* Ref.modify(lifecycleReadsRef, (count) => [
            count + 1,
            count + 1,
          ]);
          if (readNumber === 2) {
            yield* Deferred.succeed(scheduleLoadStarted, undefined);
            yield* Deferred.await(releaseScheduleLoad);
          }
        }
        return Option.some({ thread: current, deletedAt: null });
      }),
    getThreadShellById: () => currentThread().pipe(Effect.map(Option.some)),
    getProjectShellById: () => Effect.succeed(Option.some(projectShell)),
  } as unknown as ProjectionSnapshotQueryShape);
};

const makeEngineLayer = (
  commandsRef: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
  continuationDispatchFailuresRef?: Ref.Ref<number>,
  continuationDispatched?: Deferred.Deferred<void>,
) =>
  Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        if (
          continuationDispatchFailuresRef !== undefined &&
          command.type === "thread.runtime-mode.set"
        ) {
          const failures = yield* Ref.get(continuationDispatchFailuresRef);
          if (failures > 0) {
            yield* Ref.set(continuationDispatchFailuresRef, failures - 1);
            return yield* Effect.fail({ _tag: "TransientDispatchFailure" } as never);
          }
        }
        yield* Ref.update(commandsRef, (commands) => [...commands, command]);
        if (continuationDispatched && command.type === "thread.turn.start") {
          yield* Deferred.succeed(continuationDispatched, undefined);
        }
        return { sequence: 1 };
      }),
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  });

const makeLayer = (input: {
  readonly thread?: OrchestrationThreadShell;
  readonly threadRef?: Ref.Ref<OrchestrationThreadShell>;
  readonly lifecycleReadsRef?: Ref.Ref<number>;
  readonly scheduleLoadStarted?: Deferred.Deferred<void>;
  readonly releaseScheduleLoad?: Deferred.Deferred<void>;
  readonly run?: SlackAgentRunSummaryView | null;
  readonly commandsRef: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  readonly latestCallsRef?: Ref.Ref<number>;
  readonly failLatestCall?: number;
  readonly latestCallStarted?: Deferred.Deferred<void>;
  readonly releaseLatestCall?: Deferred.Deferred<void>;
  readonly existingCallsRef?: Ref.Ref<number>;
  readonly setupCallsRef?: Ref.Ref<number>;
  readonly seedCallsRef?: Ref.Ref<number>;
  readonly seedStarted?: Deferred.Deferred<void>;
  readonly releaseSeed?: Deferred.Deferred<void>;
  readonly coordinatorCallsRef?: Ref.Ref<number>;
  readonly continuationDispatchFailuresRef?: Ref.Ref<number>;
  readonly continuationDispatched?: Deferred.Deferred<void>;
  readonly continuationFailureTextsRef?: Ref.Ref<ReadonlyArray<string>>;
  readonly continuationFailureForceNewRef?: Ref.Ref<boolean>;
  readonly continuationFailureStarted?: Deferred.Deferred<void>;
  readonly continuationFailureInterrupted?: Deferred.Deferred<void>;
  readonly continuationFailureHangs?: boolean;
}) => {
  const coordinatorLayer = input.coordinatorCallsRef
    ? Layer.mock(SlackChatWorktreeCoordinator)({
        withPermit: (_threadId, effect) =>
          Ref.update(input.coordinatorCallsRef!, (count) => count + 1).pipe(Effect.andThen(effect)),
      })
    : SlackChatWorktreeCoordinatorLive;

  return SlackChatWorktreePromotionLive.pipe(
    Layer.provideMerge(coordinatorLayer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      makeProjectionLayer(
        input.thread ?? threadShell(),
        input.threadRef,
        input.lifecycleReadsRef,
        input.scheduleLoadStarted,
        input.releaseScheduleLoad,
      ),
    ),
    Layer.provideMerge(
      makeEngineLayer(
        input.commandsRef,
        input.continuationDispatchFailuresRef,
        input.continuationDispatched,
      ),
    ),
    Layer.provideMerge(
      Layer.mock(SlackAgentRunStore)({
        findChatByThreadId: () => Effect.succeed(input.run === undefined ? slackRun : input.run),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(SlackAgentGateway)({
        postOrUpdateStatus: (status) =>
          Effect.gen(function* () {
            if (input.continuationFailureTextsRef) {
              yield* Ref.update(input.continuationFailureTextsRef, (texts) => [
                ...texts,
                status.text,
              ]);
            }
            if (input.continuationFailureForceNewRef) {
              yield* Ref.set(input.continuationFailureForceNewRef, status.forceNewMessage === true);
            }
            if (input.continuationFailureStarted) {
              yield* Deferred.succeed(input.continuationFailureStarted, undefined);
            }
            if (input.continuationFailureHangs) {
              return yield* Effect.never.pipe(
                Effect.ensuring(
                  input.continuationFailureInterrupted
                    ? Deferred.succeed(input.continuationFailureInterrupted, undefined).pipe(
                        Effect.ignore,
                      )
                    : Effect.void,
                ),
              );
            }
            return {
              threadKey: `${status.channelId}:${status.threadTs}`,
              statusMessageId: "slack-promotion-failure-status",
            };
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(GitWorkflowService)({
        createWorktreeFromLatestDefaultBranch: ({ newRefName }) =>
          Effect.gen(function* () {
            const call = input.latestCallsRef
              ? yield* Ref.modify(input.latestCallsRef, (count) => [count + 1, count + 1])
              : 1;
            if (call === input.failLatestCall) {
              if (input.latestCallStarted) {
                yield* Deferred.succeed(input.latestCallStarted, undefined);
              }
              if (input.releaseLatestCall) {
                yield* Deferred.await(input.releaseLatestCall);
              }
              return yield* Effect.fail({ _tag: "PrepareWorktreeFailure" } as never);
            }
            return {
              worktree: {
                path: "/tmp/worktrees/slack-promotion",
                refName: newRefName,
              },
              remoteName: "origin",
              baseBranch: "develop",
              baseCommit: "abc123",
              baseRefName: "origin/develop",
            };
          }),
        createWorktreeFromExistingBranch: ({ refName }) =>
          (input.existingCallsRef
            ? Ref.update(input.existingCallsRef, (count) => count + 1)
            : Effect.void
          ).pipe(
            Effect.as({
              worktree: {
                path: "/tmp/worktrees/slack-promotion",
                refName,
              },
            }),
          ),
        removeWorktree: () => Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectSetupScriptRunner)({
        runForThread: () =>
          (input.setupCallsRef
            ? Ref.update(input.setupCallsRef, (count) => count + 1)
            : Effect.void
          ).pipe(Effect.as({ status: "no-script" as const })),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(WorktreeSeedService)({
        seed: () =>
          Effect.gen(function* () {
            if (input.seedCallsRef) {
              yield* Ref.update(input.seedCallsRef, (count) => count + 1);
            }
            if (input.seedStarted) {
              yield* Deferred.succeed(input.seedStarted, undefined);
            }
            if (input.releaseSeed) {
              yield* Deferred.await(input.releaseSeed);
            }
            return {
              strategy: "not-configured" as const,
              seededPaths: [],
              skippedPaths: [],
            };
          }),
      }),
    ),
  );
};

describe("SlackChatWorktreePromotionLive", () => {
  it.effect("prepares latest-default worktree and continues after the read-only turn settles", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const latestCallsRef = yield* Ref.make(0);
      const setupCallsRef = yield* Ref.make(0);
      const seedCallsRef = yield* Ref.make(0);
      const continuationDispatched = yield* Deferred.make<void>();

      const result = yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        const promoted = yield* promotion.promote(threadId);
        yield* promotion.settleTurn(threadId, { type: "completed", turnId: originTurnId });
        yield* Deferred.await(continuationDispatched);
        return promoted;
      }).pipe(
        Effect.provide(
          makeLayer({
            commandsRef,
            latestCallsRef,
            setupCallsRef,
            seedCallsRef,
            continuationDispatched,
          }),
        ),
      );

      assert.equal(result.state, "prepared");
      assert.equal(result.baseBranch, "develop");
      assert.equal(result.continuationScheduled, true);
      assert.match(result.branch, /^t3code\/[0-9a-f]{16}$/);
      assert.equal(result.worktreePath, "/tmp/worktrees/slack-promotion");
      assert.equal(yield* Ref.get(latestCallsRef), 1);
      assert.equal(yield* Ref.get(setupCallsRef), 1);
      assert.equal(yield* Ref.get(seedCallsRef), 1);

      const commands = yield* Ref.get(commandsRef);
      assert.deepStrictEqual(
        commands.map((command) => command.type),
        ["thread.meta.update", "thread.runtime-mode.set", "thread.turn.start"],
      );
      if (commands[0]?.type !== "thread.meta.update") assert.fail("expected metadata update");
      assert.equal(commands[0].branch, result.branch);
      assert.equal(commands[0].worktreePath, result.worktreePath);
      if (commands[1]?.type !== "thread.runtime-mode.set") assert.fail("expected runtime update");
      assert.equal(commands[1].runtimeMode, "full-access");
      if (commands[2]?.type !== "thread.turn.start") assert.fail("expected continuation turn");
      assert.equal(commands[2].runtimeMode, "full-access");
      assert.deepStrictEqual(commands[2].modelSelection, threadShell().modelSelection);
      assert.equal(commands[2].interactionMode, threadShell().interactionMode);
      assert.match(commands[2].message.text, /isolated worktree/i);
    }),
  );

  it.effect(
    "uses the same per-thread branch when promotion retries before metadata is visible",
    () =>
      Effect.gen(function* () {
        const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
        const branches = yield* Effect.gen(function* () {
          const promotion = yield* SlackChatWorktreePromotion;
          const first = yield* promotion.promote(threadId);
          const second = yield* promotion.promote(threadId);
          return [first.branch, second.branch];
        }).pipe(Effect.provide(makeLayer({ commandsRef })));

        assert.equal(branches[0], branches[1]);
      }),
  );

  it.effect("keeps an armed continuation when a repeated promotion fails", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const latestCallsRef = yield* Ref.make(0);
      const latestCallStarted = yield* Deferred.make<void>();
      const releaseLatestCall = yield* Deferred.make<void>();
      const continuationDispatched = yield* Deferred.make<void>();

      yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        const first = yield* promotion.promote(threadId);
        assert.isTrue(first.continuationScheduled);

        const repeatedPromotion = yield* Effect.forkChild(promotion.promote(threadId));
        yield* Deferred.await(latestCallStarted);
        const settleFiber = yield* Effect.forkChild(
          promotion.settleTurn(threadId, { type: "completed", turnId: originTurnId }),
        );
        yield* Fiber.join(settleFiber);
        yield* promotion.settleTurn(threadId, { type: "session-exited" });
        yield* Deferred.succeed(releaseLatestCall, undefined);

        const repeatedError = yield* Fiber.join(repeatedPromotion).pipe(Effect.flip);
        assert.equal(repeatedError._tag, "SlackChatWorktreePromotionOperationError");
        yield* Deferred.await(continuationDispatched);
      }).pipe(
        Effect.provide(
          makeLayer({
            commandsRef,
            latestCallsRef,
            failLatestCall: 2,
            latestCallStarted,
            releaseLatestCall,
            continuationDispatched,
          }),
        ),
      );

      assert.equal(yield* Ref.get(latestCallsRef), 2);
      assert.deepStrictEqual(
        (yield* Ref.get(commandsRef)).map((command) => command.type),
        ["thread.meta.update", "thread.runtime-mode.set", "thread.turn.start"],
      );
    }),
  );

  it.effect("does not arm the continuation while worktree seeding is still running", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const coordinatorCallsRef = yield* Ref.make(0);
      const seedStarted = yield* Deferred.make<void>();
      const releaseSeed = yield* Deferred.make<void>();
      const continuationDispatched = yield* Deferred.make<void>();

      yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        const promoteFiber = yield* Effect.forkChild(promotion.promote(threadId));
        yield* Deferred.await(seedStarted);

        yield* promotion.settleTurn(threadId, {
          type: "completed",
          turnId: TurnId.make("turn-unrelated-during-seed"),
        });

        assert.equal(yield* Ref.get(coordinatorCallsRef), 1);
        assert.deepStrictEqual(
          (yield* Ref.get(commandsRef)).map((command) => command.type),
          ["thread.meta.update"],
        );

        yield* Deferred.succeed(releaseSeed, undefined);
        yield* Fiber.join(promoteFiber);
        yield* promotion.settleTurn(threadId, { type: "completed", turnId: originTurnId });
        yield* Deferred.await(continuationDispatched);
      }).pipe(
        Effect.provide(
          makeLayer({
            commandsRef,
            coordinatorCallsRef,
            seedStarted,
            releaseSeed,
            continuationDispatched,
          }),
        ),
      );

      assert.equal(yield* Ref.get(coordinatorCallsRef), 2);
      assert.deepStrictEqual(
        (yield* Ref.get(commandsRef)).map((command) => command.type),
        ["thread.meta.update", "thread.runtime-mode.set", "thread.turn.start"],
      );
    }),
  );

  it.effect("does not arm a continuation after the origin turn ends during seeding", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const threadRef = yield* Ref.make(threadShell());
      const seedStarted = yield* Deferred.make<void>();
      const releaseSeed = yield* Deferred.make<void>();

      const result = yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        const promoteFiber = yield* Effect.forkChild(promotion.promote(threadId));
        yield* Deferred.await(seedStarted);
        yield* Ref.set(
          threadRef,
          threadShell({
            latestTurn: {
              ...threadShell().latestTurn!,
              state: "interrupted",
              completedAt: "2026-08-09T00:01:00.000Z" as never,
            },
          }),
        );
        yield* Deferred.succeed(releaseSeed, undefined);
        return yield* Fiber.join(promoteFiber);
      }).pipe(
        Effect.provide(
          makeLayer({
            commandsRef,
            threadRef,
            seedStarted,
            releaseSeed,
          }),
        ),
      );

      assert.isFalse(result.continuationScheduled);
      assert.deepStrictEqual(
        (yield* Ref.get(commandsRef)).map((command) => command.type),
        ["thread.meta.update"],
      );
    }),
  );

  it.effect("does not miss a terminal event between schedule validation and arming", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const threadRef = yield* Ref.make(threadShell());
      const lifecycleReadsRef = yield* Ref.make(0);
      const scheduleLoadStarted = yield* Deferred.make<void>();
      const releaseScheduleLoad = yield* Deferred.make<void>();

      const result = yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        const promoteFiber = yield* Effect.forkChild(promotion.promote(threadId));
        yield* Deferred.await(scheduleLoadStarted);
        yield* Ref.set(
          threadRef,
          threadShell({
            latestTurn: {
              ...threadShell().latestTurn!,
              state: "completed",
              completedAt: "2026-08-09T00:01:00.000Z" as never,
            },
          }),
        );
        yield* promotion.settleTurn(threadId, { type: "completed", turnId: originTurnId });
        yield* Deferred.succeed(releaseScheduleLoad, undefined);
        return yield* Fiber.join(promoteFiber);
      }).pipe(
        Effect.provide(
          makeLayer({
            commandsRef,
            threadRef,
            lifecycleReadsRef,
            scheduleLoadStarted,
            releaseScheduleLoad,
          }),
        ),
      );

      assert.isFalse(result.continuationScheduled);
      assert.deepStrictEqual(
        (yield* Ref.get(commandsRef)).map((command) => command.type),
        ["thread.meta.update"],
      );
    }),
  );

  it.effect("rehydrates a cleaned checkout from its durable branch", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const existingCallsRef = yield* Ref.make(0);
      const result = yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        return yield* promotion.promote(threadId);
      }).pipe(
        Effect.provide(
          makeLayer({
            thread: threadShell({ branch: "t3code/slack-existing", worktreePath: null }),
            commandsRef,
            existingCallsRef,
          }),
        ),
      );

      assert.equal(result.state, "rehydrated");
      assert.equal(result.branch, "t3code/slack-existing");
      assert.equal(result.baseBranch, null);
      assert.equal(yield* Ref.get(existingCallsRef), 1);
    }),
  );

  it.effect("returns an existing promoted checkout without scheduling another continuation", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const result = yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        return yield* promotion.promote(threadId);
      }).pipe(
        Effect.provide(
          makeLayer({
            thread: threadShell({
              runtimeMode: "full-access",
              branch: "t3code/slack-existing",
              worktreePath: "/tmp",
            }),
            commandsRef,
          }),
        ),
      );

      assert.deepStrictEqual(result, {
        threadId,
        state: "existing",
        branch: "t3code/slack-existing",
        worktreePath: "/tmp",
        baseBranch: null,
        continuationScheduled: false,
      });
      assert.equal((yield* Ref.get(commandsRef)).length, 0);
    }),
  );

  it.effect("rehydrates when persisted checkout metadata points to a missing path", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const existingCallsRef = yield* Ref.make(0);
      const result = yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        return yield* promotion.promote(threadId);
      }).pipe(
        Effect.provide(
          makeLayer({
            thread: threadShell({
              branch: "t3code/slack-missing",
              worktreePath: "/tmp/t3code-slack-worktree-that-does-not-exist",
            }),
            commandsRef,
            existingCallsRef,
          }),
        ),
      );

      assert.equal(result.state, "rehydrated");
      assert.equal(result.branch, "t3code/slack-missing");
      assert.equal(yield* Ref.get(existingCallsRef), 1);
    }),
  );

  it.effect("retries a transient continuation dispatch without creating another worktree", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const continuationDispatchFailuresRef = yield* Ref.make(1);
      const latestCallsRef = yield* Ref.make(0);
      const continuationDispatched = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        yield* promotion.promote(threadId);
        yield* promotion.settleTurn(threadId, { type: "completed", turnId: originTurnId });
        yield* Deferred.await(continuationDispatched);
      }).pipe(
        Effect.provide(
          makeLayer({
            commandsRef,
            continuationDispatchFailuresRef,
            latestCallsRef,
            continuationDispatched,
          }),
        ),
      );

      assert.equal(yield* Ref.get(continuationDispatchFailuresRef), 0);
      assert.equal(yield* Ref.get(latestCallsRef), 1);
      assert.deepStrictEqual(
        (yield* Ref.get(commandsRef)).map((command) => command.type),
        ["thread.meta.update", "thread.runtime-mode.set", "thread.turn.start"],
      );
    }),
  );

  it.effect("does not re-arm a continuation after its terminal event exhausts retries", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const continuationDispatchFailuresRef = yield* Ref.make(3);
      const continuationFailureTextsRef = yield* Ref.make<ReadonlyArray<string>>([]);
      const continuationFailureForceNewRef = yield* Ref.make(false);
      const continuationFailureStarted = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        yield* promotion.promote(threadId);
        yield* promotion.settleTurn(threadId, { type: "completed", turnId: originTurnId });
        yield* Deferred.await(continuationFailureStarted);
        yield* Ref.set(continuationDispatchFailuresRef, 0);
        yield* promotion.settleTurn(threadId, { type: "completed", turnId: originTurnId });
      }).pipe(
        Effect.provide(
          makeLayer({
            commandsRef,
            continuationDispatchFailuresRef,
            continuationFailureTextsRef,
            continuationFailureForceNewRef,
            continuationFailureStarted,
          }),
        ),
      );

      assert.deepStrictEqual(
        (yield* Ref.get(commandsRef)).map((command) => command.type),
        ["thread.meta.update"],
      );
      assert.deepStrictEqual(yield* Ref.get(continuationFailureTextsRef), [
        "T3 created the isolated worktree, but could not start the full-access continuation. Reply in Slack or T3 to continue from the promoted thread.",
      ]);
      assert.isTrue(yield* Ref.get(continuationFailureForceNewRef));
    }),
  );

  it.effect("bounds turn settlement when the Slack warning hangs", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const continuationDispatchFailuresRef = yield* Ref.make(3);
      const continuationFailureStarted = yield* Deferred.make<void>();
      const continuationFailureInterrupted = yield* Deferred.make<void>();

      yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        yield* promotion.promote(threadId);
        yield* promotion.settleTurn(threadId, { type: "completed", turnId: originTurnId });
        yield* Deferred.await(continuationFailureStarted);
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(continuationFailureInterrupted);
      }).pipe(
        Effect.provide(
          Layer.merge(
            makeLayer({
              commandsRef,
              continuationDispatchFailuresRef,
              continuationFailureStarted,
              continuationFailureInterrupted,
              continuationFailureHangs: true,
            }),
            TestClock.layer(),
          ),
        ),
      );

      assert.deepStrictEqual(
        (yield* Ref.get(commandsRef)).map((command) => command.type),
        ["thread.meta.update"],
      );
    }),
  );

  it.effect("rejects promotion outside a Slack-linked chat", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const error = yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        return yield* promotion.promote(threadId);
      }).pipe(Effect.provide(makeLayer({ commandsRef, run: null })), Effect.flip);

      assert.equal(error._tag, "SlackChatWorktreePromotionUnavailableError");
      if (error._tag === "SlackChatWorktreePromotionUnavailableError") {
        assert.equal(error.reason, "not-slack-chat");
      }
      assert.equal((yield* Ref.get(commandsRef)).length, 0);
    }),
  );

  it.effect("drops an aborted promotion instead of continuing after a later turn", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        yield* promotion.promote(threadId);
        yield* promotion.settleTurn(threadId, { type: "aborted", turnId: originTurnId });
        yield* promotion.settleTurn(threadId, { type: "completed", turnId: originTurnId });
      }).pipe(Effect.provide(makeLayer({ commandsRef })));

      assert.deepStrictEqual(
        (yield* Ref.get(commandsRef)).map((command) => command.type),
        ["thread.meta.update"],
      );
    }),
  );

  it.effect("keeps a continuation pending when a different turn completes", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const continuationDispatched = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const promotion = yield* SlackChatWorktreePromotion;
        yield* promotion.promote(threadId);
        yield* promotion.settleTurn(threadId, {
          type: "completed",
          turnId: TurnId.make("turn-unrelated"),
        });
        yield* promotion.settleTurn(threadId, { type: "completed", turnId: originTurnId });
        yield* Deferred.await(continuationDispatched);
      }).pipe(Effect.provide(makeLayer({ commandsRef, continuationDispatched })));

      assert.deepStrictEqual(
        (yield* Ref.get(commandsRef)).map((command) => command.type),
        ["thread.meta.update", "thread.runtime-mode.set", "thread.turn.start"],
      );
    }),
  );
});
