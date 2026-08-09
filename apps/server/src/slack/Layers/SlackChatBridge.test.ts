import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  OrchestrationCommandInvariantError,
  type OrchestrationDispatchError,
} from "../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  SlackChatBridge,
  SlackChatBridgeProjectNotFoundError,
  SlackChatBridgeThreadDeletedError,
  type SlackChatBridgeDeliverInput,
} from "../Services/SlackChatBridge.ts";
import { SlackChatBridgeLive } from "./SlackChatBridge.ts";

const projectId = ProjectId.make("project-slack-chat");
const threadId = ThreadId.make("thread-slack-chat");
const otherProjectId = ProjectId.make("project-other");
const input: SlackChatBridgeDeliverInput = {
  projectId,
  threadId,
  createThreadCommandId: CommandId.make("command-create-slack-chat"),
  unarchiveThreadCommandId: CommandId.make("command-unarchive-slack-chat"),
  startTurnCommandId: CommandId.make("command-start-slack-chat"),
  messageId: MessageId.make("message-slack-chat"),
  title: "Slack request",
  text: "Please inspect the failing build.",
};

const projectShell = (
  defaultModelSelection: ModelSelection | null = {
    instanceId: ProviderInstanceId.make("claude-main"),
    model: "claude-sonnet-5",
  },
): OrchestrationProjectShell => ({
  id: projectId,
  title: "Project",
  workspaceRoot: "/tmp/project",
  repositoryIdentity: null,
  defaultModelSelection,
  scripts: [],
  createdAt: "2026-08-08T00:00:00.000Z" as never,
  updatedAt: "2026-08-08T00:00:00.000Z" as never,
});

const threadShell = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: threadId,
  projectId,
  title: "Existing thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  },
  runtimeMode: DEFAULT_RUNTIME_MODE,
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-08T00:00:00.000Z" as never,
  updatedAt: "2026-08-08T00:00:00.000Z" as never,
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

const makeProjectionLayer = (options: {
  readonly project: Option.Option<OrchestrationProjectShell>;
  readonly thread: Option.Option<OrchestrationThreadShell>;
  readonly deletedAt?: string | null;
}) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    getProjectShellById: () => Effect.succeed(options.project),
    getThreadShellById: () => Effect.succeed(options.thread),
    getThreadLifecycleShellById: () =>
      Effect.succeed(
        Option.map(options.thread, (thread) => ({
          thread,
          deletedAt: options.deletedAt ?? null,
        })),
      ),
  } as unknown as ProjectionSnapshotQueryShape);

const makeEngineLayer = (
  commandsRef: Ref.Ref<ReadonlyArray<OrchestrationCommand>>,
  dispatchOverride?: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchError>,
) =>
  Layer.succeed(OrchestrationEngineService, {
    readEvents: () => Stream.empty,
    dispatch: (command: OrchestrationCommand) =>
      Ref.update(commandsRef, (commands) => [...commands, command]).pipe(
        Effect.andThen(dispatchOverride?.(command) ?? Effect.succeed({ sequence: 1 })),
      ),
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  } satisfies OrchestrationEngineService["Service"]);

const runWithFakes =
  (options: {
    readonly project: Option.Option<OrchestrationProjectShell>;
    readonly thread: Option.Option<OrchestrationThreadShell>;
    readonly deletedAt?: string | null;
    readonly commandsRef: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
    readonly dispatchOverride?: (
      command: OrchestrationCommand,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchError>;
  }) =>
  <A, E>(effect: Effect.Effect<A, E, SlackChatBridge>) =>
    effect.pipe(
      Effect.provide(
        SlackChatBridgeLive.pipe(
          Layer.provideMerge(makeEngineLayer(options.commandsRef, options.dispatchOverride)),
          Layer.provideMerge(makeProjectionLayer(options)),
        ),
      ),
    );

describe("SlackChatBridgeLive", () => {
  it.effect("creates a visible read-only thread without preparing a worktree", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const result = yield* Effect.gen(function* () {
        const bridge = yield* SlackChatBridge;
        return yield* bridge.deliverUserMessage(input);
      }).pipe(
        runWithFakes({
          project: Option.some(projectShell()),
          thread: Option.none(),
          commandsRef,
        }),
      );
      const commands = yield* Ref.get(commandsRef);

      assert.deepStrictEqual(result, { threadId, createdThread: true });
      assert.equal(commands.length, 2);
      assert.equal(commands[0]?.type, "thread.create");
      assert.equal(commands[1]?.type, "thread.turn.start");
      if (commands[0]?.type === "thread.create") {
        assert.equal(commands[0].commandId, input.createThreadCommandId);
        assert.equal(commands[0].threadId, input.threadId);
        assert.equal(commands[0].projectId, input.projectId);
        assert.equal(commands[0].title, input.title);
        assert.deepStrictEqual(commands[0].modelSelection, projectShell().defaultModelSelection);
        assert.equal(commands[0].runtimeMode, "approval-required");
        assert.equal(commands[0].interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
        assert.equal(commands[0].branch, null);
        assert.equal(commands[0].worktreePath, null);
        assert.equal(commands[0].hidden, false);
      }
      if (commands[1]?.type === "thread.turn.start") {
        assert.equal(commands[1].commandId, input.startTurnCommandId);
        assert.equal(commands[1].threadId, input.threadId);
        assert.deepStrictEqual(commands[1].message, {
          messageId: input.messageId,
          role: "user",
          text: input.text,
          attachments: [],
        });
        assert.deepStrictEqual(commands[1].modelSelection, projectShell().defaultModelSelection);
        assert.equal(commands[1].runtimeMode, "approval-required");
        assert.equal(commands[1].interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      }
    }),
  );

  it.effect("prefers the Slack identity default model for a new linked thread", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const identityDefaultModel = {
        instanceId: ProviderInstanceId.make("grok-main"),
        model: "grok-4.5",
      };
      yield* Effect.gen(function* () {
        const bridge = yield* SlackChatBridge;
        return yield* bridge.deliverUserMessage({
          ...input,
          defaultModelSelection: identityDefaultModel,
        });
      }).pipe(
        runWithFakes({
          project: Option.some(projectShell()),
          thread: Option.none(),
          commandsRef,
        }),
      );
      const commands = yield* Ref.get(commandsRef);

      if (commands[0]?.type !== "thread.create" || commands[1]?.type !== "thread.turn.start") {
        assert.fail("expected thread.create followed by thread.turn.start");
      }
      assert.deepStrictEqual(commands[0].modelSelection, identityDefaultModel);
      assert.deepStrictEqual(commands[1].modelSelection, identityDefaultModel);
    }),
  );

  it.effect("starts only a follow-up turn when the thread already exists", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const currentThreadModel = {
        instanceId: ProviderInstanceId.make("grok-main"),
        model: "grok-4.5",
      };
      const result = yield* Effect.gen(function* () {
        const bridge = yield* SlackChatBridge;
        return yield* bridge.deliverUserMessage({
          ...input,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("claude-main"),
            model: "claude-opus-5",
          },
          existingThreadText: "Only the new Slack reply.",
        });
      }).pipe(
        runWithFakes({
          project: Option.some(projectShell()),
          thread: Option.some(
            threadShell({
              modelSelection: currentThreadModel,
              runtimeMode: "auto-accept-edits",
              interactionMode: "plan",
              branch: "feature/slack-review",
              worktreePath: "/tmp/project-worktrees/slack-review",
              latestTurn: {
                turnId: TurnId.make("turn-slack-chat-existing"),
                state: "completed",
                requestedAt: "2026-08-08T00:00:00.000Z" as never,
                startedAt: "2026-08-08T00:00:00.000Z" as never,
                completedAt: "2026-08-08T00:00:01.000Z" as never,
                assistantMessageId: null,
              },
            }),
          ),
          commandsRef,
        }),
      );
      const commands = yield* Ref.get(commandsRef);

      assert.deepStrictEqual(result, { threadId, createdThread: false });
      assert.equal(commands.length, 1);
      assert.equal(commands[0]?.type, "thread.turn.start");
      if (commands[0]?.type === "thread.turn.start") {
        assert.deepStrictEqual(commands[0].modelSelection, currentThreadModel);
        assert.equal(commands[0].runtimeMode, "auto-accept-edits");
        assert.equal(commands[0].interactionMode, "plan");
        assert.equal(commands[0].message.text, "Only the new Slack reply.");
      }
    }),
  );

  it.effect("downgrades a cleaned Slack thread before it can edit the shared checkout", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      yield* Effect.gen(function* () {
        const bridge = yield* SlackChatBridge;
        return yield* bridge.deliverUserMessage(input);
      }).pipe(
        runWithFakes({
          project: Option.some(projectShell()),
          thread: Option.some(
            threadShell({
              runtimeMode: "full-access",
              branch: "t3code/slack-cleaned",
              worktreePath: null,
            }),
          ),
          commandsRef,
        }),
      );
      const commands = yield* Ref.get(commandsRef);

      assert.equal(commands[0]?.type, "thread.turn.start");
      if (commands[0]?.type === "thread.turn.start") {
        assert.equal(commands[0].runtimeMode, "approval-required");
      }
    }),
  );

  it.effect("replays the full transcript when the thread exists without a first turn", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const result = yield* Effect.gen(function* () {
        const bridge = yield* SlackChatBridge;
        return yield* bridge.deliverUserMessage({
          ...input,
          existingThreadText: "Only the triggering Slack reply.",
        });
      }).pipe(
        runWithFakes({
          project: Option.some(projectShell()),
          thread: Option.some(threadShell({ latestTurn: null })),
          commandsRef,
        }),
      );
      const commands = yield* Ref.get(commandsRef);

      assert.deepStrictEqual(result, { threadId, createdThread: false });
      assert.equal(commands.length, 1);
      assert.equal(commands[0]?.type, "thread.turn.start");
      if (commands[0]?.type === "thread.turn.start") {
        assert.equal(commands[0].message.text, input.text);
      }
    }),
  );

  it.effect("fails with a typed error when the project is missing", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const error = yield* Effect.gen(function* () {
        const bridge = yield* SlackChatBridge;
        return yield* bridge.deliverUserMessage(input);
      }).pipe(
        runWithFakes({
          project: Option.none(),
          thread: Option.none(),
          commandsRef,
        }),
        Effect.flip,
      );
      const commands = yield* Ref.get(commandsRef);

      assert.instanceOf(error, SlackChatBridgeProjectNotFoundError);
      assert.equal(commands.length, 0);
    }),
  );

  it.effect("uses the canonical Codex default model when the project has no default", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      yield* Effect.gen(function* () {
        const bridge = yield* SlackChatBridge;
        return yield* bridge.deliverUserMessage(input);
      }).pipe(
        runWithFakes({
          project: Option.some(projectShell(null)),
          thread: Option.none(),
          commandsRef,
        }),
      );
      const commands = yield* Ref.get(commandsRef);
      const expectedModelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
      };

      if (commands[0]?.type !== "thread.create" || commands[1]?.type !== "thread.turn.start") {
        assert.fail("expected thread.create followed by thread.turn.start");
      }
      assert.deepStrictEqual(commands[0].modelSelection, expectedModelSelection);
      assert.deepStrictEqual(commands[1].modelSelection, expectedModelSelection);
    }),
  );

  it.effect("keeps an existing link in its original project after the bot is retargeted", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const result = yield* Effect.gen(function* () {
        const bridge = yield* SlackChatBridge;
        return yield* bridge.deliverUserMessage(input);
      }).pipe(
        runWithFakes({
          project: Option.none(),
          thread: Option.some(threadShell({ projectId: otherProjectId })),
          commandsRef,
        }),
      );
      const commands = yield* Ref.get(commandsRef);

      assert.deepStrictEqual(result, { threadId, createdThread: false });
      assert.equal(commands.length, 1);
      assert.equal(commands[0]?.type, "thread.turn.start");
    }),
  );

  it.effect("unarchives a linked thread before starting the follow-up turn", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      yield* Effect.gen(function* () {
        const bridge = yield* SlackChatBridge;
        return yield* bridge.deliverUserMessage(input);
      }).pipe(
        runWithFakes({
          project: Option.none(),
          thread: Option.some(threadShell({ archivedAt: "2026-08-08T00:00:00.000Z" as never })),
          commandsRef,
        }),
      );
      const commands = yield* Ref.get(commandsRef);

      assert.equal(commands.length, 2);
      assert.equal(commands[0]?.type, "thread.unarchive");
      assert.equal(commands[0]?.commandId, input.unarchiveThreadCommandId);
      assert.equal(commands[1]?.type, "thread.turn.start");
    }),
  );

  it.effect("continues when a stale projection tries to unarchive an already-open thread", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const result = yield* Effect.gen(function* () {
        const bridge = yield* SlackChatBridge;
        return yield* bridge.deliverUserMessage(input);
      }).pipe(
        runWithFakes({
          project: Option.none(),
          thread: Option.some(threadShell({ archivedAt: "2026-08-08T00:00:00.000Z" as never })),
          commandsRef,
          dispatchOverride: (command) =>
            command.type === "thread.unarchive"
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: `Thread '${command.threadId}' is not archived for command '${command.type}'.`,
                  }),
                )
              : Effect.succeed({ sequence: 1 }),
        }),
      );
      const commands = yield* Ref.get(commandsRef);

      assert.deepStrictEqual(result, { threadId, createdThread: false });
      assert.equal(commands.length, 2);
      assert.equal(commands[0]?.type, "thread.unarchive");
      assert.equal(commands[1]?.type, "thread.turn.start");
    }),
  );

  it.effect("maps an authoritative deleted-thread rejection to the bridge lifecycle error", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const error = yield* Effect.gen(function* () {
        const bridge = yield* SlackChatBridge;
        return yield* bridge.deliverUserMessage(input);
      }).pipe(
        runWithFakes({
          project: Option.none(),
          thread: Option.some(threadShell()),
          commandsRef,
          dispatchOverride: (command) =>
            command.type === "thread.turn.start"
              ? Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: `Thread '${command.threadId}' was deleted and cannot start another turn.`,
                  }),
                )
              : Effect.succeed({ sequence: 1 }),
        }),
        Effect.flip,
      );

      assert.instanceOf(error, SlackChatBridgeThreadDeletedError);
      assert.equal((yield* Ref.get(commandsRef)).length, 1);
    }),
  );

  it.effect("fails clearly when the linked thread was deleted", () =>
    Effect.gen(function* () {
      const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const error = yield* Effect.gen(function* () {
        const bridge = yield* SlackChatBridge;
        return yield* bridge.deliverUserMessage(input);
      }).pipe(
        runWithFakes({
          project: Option.none(),
          thread: Option.some(threadShell()),
          deletedAt: "2026-08-08T00:00:00.000Z",
          commandsRef,
        }),
        Effect.flip,
      );
      const commands = yield* Ref.get(commandsRef);

      assert.instanceOf(error, SlackChatBridgeThreadDeletedError);
      assert.equal(commands.length, 0);
    }),
  );
});
