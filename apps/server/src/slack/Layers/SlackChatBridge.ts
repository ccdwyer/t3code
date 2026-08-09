import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  SlackChatBridge,
  type SlackChatBridgeDeliverInput,
  SlackChatBridgeProjectNotFoundError,
  SlackChatBridgeThreadDeletedError,
  type SlackChatBridgeError,
  type SlackChatBridgeDeliverResult,
} from "../Services/SlackChatBridge.ts";

const defaultCodexModelSelection = (): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
});

const UNPROMOTED_SLACK_RUNTIME_MODE = "approval-required" as const;

type CommandRejectionError = Extract<
  OrchestrationDispatchError,
  {
    readonly _tag:
      | "OrchestrationCommandInvariantError"
      | "OrchestrationCommandPreviouslyRejectedError";
  }
>;

const isAlreadyUnarchivedError = (
  error: OrchestrationDispatchError,
): error is CommandRejectionError =>
  (error._tag === "OrchestrationCommandInvariantError" &&
    error.commandType === "thread.unarchive" &&
    error.detail.includes("is not archived")) ||
  (error._tag === "OrchestrationCommandPreviouslyRejectedError" &&
    error.detail.includes("(thread.unarchive)") &&
    error.detail.includes("is not archived"));

const isDeletedTurnError = (error: OrchestrationDispatchError): error is CommandRejectionError =>
  (error._tag === "OrchestrationCommandInvariantError" &&
    error.commandType === "thread.turn.start" &&
    error.detail.includes("was deleted")) ||
  (error._tag === "OrchestrationCommandPreviouslyRejectedError" &&
    error.detail.includes("(thread.turn.start)") &&
    error.detail.includes("was deleted"));

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;

  const deliverUserMessage = Effect.fn("SlackChatBridge.deliverUserMessage")(function* (
    input: SlackChatBridgeDeliverInput,
  ): Effect.fn.Return<SlackChatBridgeDeliverResult, SlackChatBridgeError> {
    const lifecycle = yield* (
      projectionSnapshotQuery.getThreadLifecycleShellById?.(input.threadId) ??
        projectionSnapshotQuery
          .getThreadShellById(input.threadId)
          .pipe(Effect.map(Option.map((thread) => ({ thread, deletedAt: null }))))
    );
    if (Option.isSome(lifecycle) && lifecycle.value.deletedAt !== null) {
      return yield* new SlackChatBridgeThreadDeletedError({
        threadId: input.threadId,
        message: `Linked T3 thread "${input.threadId}" was deleted.`,
      });
    }

    const thread = Option.map(lifecycle, ({ thread }) => thread);
    const project = Option.isNone(thread)
      ? yield* projectionSnapshotQuery.getProjectShellById(input.projectId)
      : Option.none();
    if (Option.isNone(thread) && Option.isNone(project)) {
      return yield* new SlackChatBridgeProjectNotFoundError({
        projectId: input.projectId,
        message: `Project "${input.projectId}" was not found.`,
      });
    }

    const projectModelSelection = Option.isSome(project)
      ? (input.defaultModelSelection ??
        project.value.defaultModelSelection ??
        defaultCodexModelSelection())
      : defaultCodexModelSelection();
    const modelSelection = Option.isSome(thread)
      ? thread.value.modelSelection
      : projectModelSelection;
    const runtimeMode = Option.isSome(thread)
      ? thread.value.worktreePath === null
        ? UNPROMOTED_SLACK_RUNTIME_MODE
        : thread.value.runtimeMode
      : UNPROMOTED_SLACK_RUNTIME_MODE;
    const interactionMode = Option.isSome(thread)
      ? thread.value.interactionMode
      : DEFAULT_PROVIDER_INTERACTION_MODE;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const createdThread = Option.isNone(thread);
    const hasExistingTurn = Option.isSome(thread) && thread.value.latestTurn !== null;

    if (createdThread) {
      if (Option.isNone(project)) {
        return yield* new SlackChatBridgeProjectNotFoundError({
          projectId: input.projectId,
          message: `Project "${input.projectId}" was not found.`,
        });
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: input.createThreadCommandId,
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection,
        runtimeMode,
        interactionMode,
        branch: null,
        worktreePath: null,
        hidden: false,
        createdAt,
      });
    } else if (thread.value.archivedAt !== null) {
      yield* orchestrationEngine
        .dispatch({
          type: "thread.unarchive",
          commandId: input.unarchiveThreadCommandId,
          threadId: input.threadId,
        })
        .pipe(Effect.catchIf(isAlreadyUnarchivedError, () => Effect.void));
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: input.startTurnCommandId,
        threadId: input.threadId,
        message: {
          messageId: input.messageId,
          role: "user",
          text: hasExistingTurn ? (input.existingThreadText ?? input.text) : input.text,
          attachments: [],
        },
        modelSelection,
        runtimeMode,
        interactionMode,
        createdAt,
      })
      .pipe(
        Effect.catchIf(isDeletedTurnError, () =>
          Effect.fail(
            new SlackChatBridgeThreadDeletedError({
              threadId: input.threadId,
              message: `Linked T3 thread "${input.threadId}" was deleted.`,
            }),
          ),
        ),
      );

    return {
      threadId: input.threadId,
      createdThread,
    };
  });

  return SlackChatBridge.of({
    deliverUserMessage,
  });
});

export const SlackChatBridgeLive = Layer.effect(SlackChatBridge, make);
