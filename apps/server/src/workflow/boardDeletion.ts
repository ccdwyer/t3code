import type { BoardId, TicketId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { BoardRegistryShape } from "./Services/BoardRegistry.ts";
import type { WorkflowBoardSaveLocksShape } from "./Services/WorkflowBoardSaveLocks.ts";
import type { WorkflowBoardVersionStoreShape } from "./Services/WorkflowBoardVersionStore.ts";
import type { WorkflowEngineShape } from "./Services/WorkflowEngine.ts";
import type { WorkflowEventStoreShape } from "./Services/WorkflowEventStore.ts";
import type { WorkflowReadModelShape } from "./Services/WorkflowReadModel.ts";
import type { WorkflowThreadJanitorShape } from "./Services/WorkflowThreadJanitor.ts";
import type { WorkflowWebhookShape } from "./Services/WorkflowWebhook.ts";
import type { WorkflowWorktreeJanitorShape } from "./Services/WorkflowWorktreeJanitor.ts";

export interface WorkflowBoardOwnedStateDeletionDeps {
  readonly boardRegistry: Pick<BoardRegistryShape, "unregister">;
  readonly engine: Pick<WorkflowEngineShape, "cancelBoardPipelines">;
  readonly eventStore: Pick<WorkflowEventStoreShape, "deleteForBoard">;
  readonly readModel: Pick<WorkflowReadModelShape, "deleteBoard" | "deleteBoardTicketState">;
  readonly versionStore: Pick<WorkflowBoardVersionStoreShape, "deleteForBoard">;
  readonly worktreeJanitor?: Pick<WorkflowWorktreeJanitorShape, "collectBoardPlan" | "run">;
  readonly threadJanitor?: Pick<
    WorkflowThreadJanitorShape,
    "collectBoardThreads" | "deleteThreads"
  >;
  readonly webhook?: Pick<WorkflowWebhookShape, "deleteForBoard">;
}

export interface WorkflowBoardTicketStateDeletionDeps {
  readonly saveLocks: Pick<WorkflowBoardSaveLocksShape, "withSaveLock">;
  readonly engine: Pick<WorkflowEngineShape, "cancelTicketPipelines">;
  readonly eventStore: Pick<WorkflowEventStoreShape, "deleteForTicket">;
  readonly readModel: Pick<WorkflowReadModelShape, "deleteTicketState">;
  readonly sql: Pick<SqlClient.SqlClient, "withTransaction">;
  readonly worktreeJanitor?: Pick<WorkflowWorktreeJanitorShape, "collectTicketPlan" | "run">;
  readonly threadJanitor?: Pick<
    WorkflowThreadJanitorShape,
    "collectTicketThreads" | "deleteThreads"
  >;
}

const noCleanup = Effect.succeed(null);
const noThreads = Effect.succeed([] as ReadonlyArray<string>);

export const deleteWorkflowBoardOwnedState = (
  deps: WorkflowBoardOwnedStateDeletionDeps,
  boardId: BoardId,
) =>
  Effect.gen(function* () {
    // Collected before the cascade — the repo root and ticket list are only
    // resolvable while the projections still exist.
    const cleanupPlan = yield* deps.worktreeJanitor?.collectBoardPlan(boardId) ?? noCleanup;
    const threadIds = yield* deps.threadJanitor?.collectBoardThreads(boardId) ?? noThreads;
    yield* deps.engine.cancelBoardPipelines(boardId);
    yield* deps.webhook?.deleteForBoard(boardId) ?? Effect.void;
    yield* deps.versionStore.deleteForBoard(boardId);
    yield* deps.eventStore.deleteForBoard(boardId);
    yield* deps.readModel.deleteBoardTicketState(boardId);
    yield* deps.boardRegistry.unregister(boardId);
    yield* deps.readModel.deleteBoard(boardId);
    yield* deps.worktreeJanitor?.run(cleanupPlan) ?? Effect.void;
    yield* deps.threadJanitor?.deleteThreads(threadIds) ?? Effect.void;
  });

export const deleteWorkflowBoardTicketOwnedStateWhen = <E, R>(
  deps: WorkflowBoardTicketStateDeletionDeps,
  boardId: BoardId,
  ticketId: TicketId,
  shouldDelete: Effect.Effect<boolean, E, R>,
) =>
  Effect.gen(function* () {
    const deleted = yield* deps.saveLocks.withSaveLock(
      boardId,
      Effect.gen(function* () {
        const cleanupPlan = yield* deps.worktreeJanitor?.collectTicketPlan(ticketId) ?? noCleanup;
        const threadIds = yield* deps.threadJanitor?.collectTicketThreads(ticketId) ?? noThreads;
        const deleted = yield* deps.sql.withTransaction(
          Effect.gen(function* () {
            if (!(yield* shouldDelete)) {
              return false;
            }

            yield* deps.engine.cancelTicketPipelines(ticketId);
            yield* deps.eventStore.deleteForTicket(ticketId);
            yield* deps.readModel.deleteTicketState(ticketId);
            return true;
          }),
        );
        if (deleted) {
          // Git/filesystem cleanup stays outside the DB transaction but under
          // the board save lock so a concurrent re-create of the same ticket
          // worktree cannot interleave with its removal.
          yield* deps.worktreeJanitor?.run(cleanupPlan) ?? Effect.void;
          yield* deps.threadJanitor?.deleteThreads(threadIds) ?? Effect.void;
        }
        return deleted;
      }),
    );
    return deleted;
  });

export const deleteWorkflowBoardTicketOwnedState = (
  deps: WorkflowBoardTicketStateDeletionDeps,
  boardId: BoardId,
  ticketId: TicketId,
) =>
  deleteWorkflowBoardTicketOwnedStateWhen(deps, boardId, ticketId, Effect.succeed(true)).pipe(
    Effect.asVoid,
  );
