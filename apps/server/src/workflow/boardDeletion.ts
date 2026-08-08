import type { BoardId, ThreadId, TicketId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { BoardRegistryShape } from "./Services/BoardRegistry.ts";
import type { WorkflowAgentSessionStoreShape } from "./Services/WorkflowAgentSessionStore.ts";
import type { WorkflowBoardSaveLocksShape } from "./Services/WorkflowBoardSaveLocks.ts";
import type { WorkflowBoardVersionStoreShape } from "./Services/WorkflowBoardVersionStore.ts";
import type { WorkflowEngineShape } from "./Services/WorkflowEngine.ts";
import type { WorkflowEventStoreError } from "./Services/Errors.ts";
import type { WorkflowEventStoreShape } from "./Services/WorkflowEventStore.ts";
import type { WorkflowReadModelShape } from "./Services/WorkflowReadModel.ts";
import type { SlackAgentInstanceStoreShape } from "./Services/SlackAgentInstanceStore.ts";
import type {
  DiskRef as TicketArtifactDiskRef,
  TicketArtifactStoreShape,
} from "./Services/TicketArtifactStore.ts";
import type { WorkflowThreadJanitorShape } from "./Services/WorkflowThreadJanitor.ts";
import type { WorkflowWebhookShape } from "./Services/WorkflowWebhook.ts";
import type { WorkflowWorktreeJanitorShape } from "./Services/WorkflowWorktreeJanitor.ts";

export interface WorkflowBoardOwnedStateDeletionDeps {
  readonly boardRegistry: Pick<BoardRegistryShape, "unregister">;
  readonly engine: Pick<WorkflowEngineShape, "cancelBoardPipelines">;
  readonly eventStore: Pick<WorkflowEventStoreShape, "deleteForBoard">;
  readonly readModel: Pick<WorkflowReadModelShape, "deleteBoard" | "deleteBoardTicketState">;
  readonly versionStore: Pick<WorkflowBoardVersionStoreShape, "deleteForBoard">;
  readonly sql: Pick<SqlClient.SqlClient, "withTransaction">;
  readonly worktreeJanitor?: Pick<WorkflowWorktreeJanitorShape, "collectBoardPlan" | "run">;
  readonly threadJanitor?: Pick<
    WorkflowThreadJanitorShape,
    "collectBoardThreads" | "deleteThreads"
  >;
  readonly webhook?: Pick<WorkflowWebhookShape, "deleteForBoard">;
  // Per-agent session teardown: both queries join projection_ticket, so the
  // threads must be listed BEFORE the cascade and the rows deleted INSIDE the
  // transaction (before deleteBoardTicketState clears projection_ticket).
  // `stopSession` is a live side effect that runs after the commit, best-effort.
  readonly agentSessions?: Pick<WorkflowAgentSessionStoreShape, "listByBoard" | "deleteByBoard">;
  readonly provider?: Pick<ProviderServiceShape, "stopSession">;
  // Durable ticket artifacts (spec 2026-08-05): rows delete INSIDE the
  // cascade transaction; blob removal is best-effort post-commit (the boot
  // reconciler backstops failures).
  readonly artifactStore?: Pick<TicketArtifactStoreShape, "deleteRowsForBoard" | "removeDisk">;
  readonly slackInstances?: Pick<SlackAgentInstanceStoreShape, "disableForBoard">;
}

export interface WorkflowBoardTicketStateDeletionDeps {
  readonly saveLocks: Pick<WorkflowBoardSaveLocksShape, "withSaveLock">;
  readonly artifactStore?: Pick<TicketArtifactStoreShape, "deleteRowsForTickets" | "removeDisk">;
  readonly engine: Pick<WorkflowEngineShape, "cancelTicketPipelines">;
  readonly eventStore: Pick<WorkflowEventStoreShape, "deleteForTicket">;
  readonly readModel: Pick<WorkflowReadModelShape, "deleteTicketState">;
  readonly sql: Pick<SqlClient.SqlClient, "withTransaction">;
  readonly worktreeJanitor?: Pick<WorkflowWorktreeJanitorShape, "collectTicketPlan" | "run">;
  readonly threadJanitor?: Pick<
    WorkflowThreadJanitorShape,
    "collectTicketThreads" | "deleteThreads"
  >;
  // Per-agent session teardown for the per-ticket cascade (A8): used by the
  // terminal-retention sweep so a swept terminal ticket's stored agent sessions
  // are dropped and their live provider sessions stopped (best-effort).
  readonly agentSessions?: Pick<WorkflowAgentSessionStoreShape, "listByTicket" | "deleteByTicket">;
  readonly provider?: Pick<ProviderServiceShape, "stopSession">;
  /**
   * Optional scheduling boundary for slow, best-effort external cleanup after
   * the durable ticket cascade commits. Retention/recovery callers omit this
   * and await cleanup; the interactive delete RPC detaches it so the UI is not
   * held open by provider shutdown or Git worktree/thread removal.
   */
  readonly scheduleCleanup?: (
    cleanup: Effect.Effect<void, WorkflowEventStoreError>,
  ) => Effect.Effect<void>;
}

const noCleanup = Effect.succeed(null);
const noArtifactRefs: Effect.Effect<ReadonlyArray<TicketArtifactDiskRef>> = Effect.succeed([]);
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
    // Collected here because listByBoard joins projection_ticket, which the
    // cascade below deletes. Best-effort: a failure must not block the cascade.
    const agentSessionRows: ReadonlyArray<{ readonly threadId: string }> =
      deps.agentSessions === undefined
        ? []
        : yield* deps.agentSessions.listByBoard(boardId).pipe(Effect.orElseSucceed(() => []));
    yield* deps.engine.cancelBoardPipelines(boardId);
    let artifactRefs: ReadonlyArray<TicketArtifactDiskRef> = [];
    // The DB cascade runs in one transaction so a mid-cascade SQL/IO failure
    // (or SQLITE_BUSY) rolls back instead of leaving orphaned event-store rows
    // whose backing projection_ticket rows are gone — mirroring the per-ticket
    // path. eventStore.deleteForBoard must precede deleteBoardTicketState, which
    // clears the projection_ticket rows the IN-subquery resolves against.
    yield* deps.sql.withTransaction(
      Effect.gen(function* () {
        yield* deps.webhook?.deleteForBoard(boardId) ?? Effect.void;
        yield* deps.versionStore.deleteForBoard(boardId);
        // Inside the tx, before deleteBoardTicketState clears the
        // projection_ticket rows the IN-subquery resolves against.
        yield* deps.agentSessions?.deleteByBoard(boardId) ?? Effect.void;
        yield* deps.eventStore.deleteForBoard(boardId);
        artifactRefs = yield* deps.artifactStore?.deleteRowsForBoard(boardId) ?? noArtifactRefs;
        yield* deps.slackInstances?.disableForBoard(boardId) ?? Effect.void;
        yield* deps.readModel.deleteBoardTicketState(boardId);
        yield* deps.readModel.deleteBoard(boardId);
      }),
    );
    // In-memory registry + git/thread cleanup stay outside the transaction:
    // a Ref update and filesystem/provider work cannot be rolled back, and
    // unregistering only after the DB commit keeps the in-memory view from
    // diverging if the transaction aborts.
    yield* deps.boardRegistry.unregister(boardId);
    // Best-effort live provider teardown for the now-deleted agent sessions —
    // a provider error must never surface from board deletion.
    if (deps.provider !== undefined && agentSessionRows.length > 0) {
      const provider = deps.provider;
      yield* Effect.forEach(
        agentSessionRows,
        (row) =>
          provider
            .stopSession({ threadId: row.threadId as ThreadId })
            .pipe(Effect.catch(() => Effect.void)),
        { discard: true },
      );
    }
    yield* deps.worktreeJanitor?.run(cleanupPlan) ?? Effect.void;
    yield* deps.threadJanitor?.deleteThreads(threadIds) ?? Effect.void;
    yield* deps.artifactStore?.removeDisk(artifactRefs) ?? Effect.void;
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
        let artifactRefs: ReadonlyArray<TicketArtifactDiskRef> = [];
        const threadIds = yield* deps.threadJanitor?.collectTicketThreads(ticketId) ?? noThreads;
        // Collected before the cascade so the threads survive deleteByTicket and
        // can be stopped after the commit. Best-effort: never block the delete.
        const agentSessionRows: ReadonlyArray<{ readonly threadId: string }> =
          deps.agentSessions === undefined
            ? []
            : yield* deps.agentSessions.listByTicket(ticketId).pipe(Effect.orElseSucceed(() => []));
        const deleted = yield* deps.sql.withTransaction(
          Effect.gen(function* () {
            if (!(yield* shouldDelete)) {
              return false;
            }

            yield* deps.engine.cancelTicketPipelines(ticketId);
            yield* (
              deps.agentSessions?.deleteByTicket(ticketId).pipe(Effect.catch(() => Effect.void)) ??
                Effect.void
            );
            yield* deps.eventStore.deleteForTicket(ticketId);
            artifactRefs = yield* (
              deps.artifactStore?.deleteRowsForTickets([ticketId as string]) ?? noArtifactRefs
            );
            yield* deps.readModel.deleteTicketState(ticketId);
            return true;
          }),
        );
        if (deleted) {
          // Git/filesystem cleanup stays outside the DB transaction but under
          // the DB transaction. Interactive deletion schedules this work after
          // commit so provider/Git latency is not part of the RPC response;
          // retention/recovery callers omit scheduleCleanup and still await it.
          const cleanup = Effect.gen(function* () {
            if (deps.provider !== undefined && agentSessionRows.length > 0) {
              const provider = deps.provider;
              yield* Effect.forEach(
                agentSessionRows,
                (row) =>
                  provider
                    .stopSession({ threadId: row.threadId as ThreadId })
                    .pipe(Effect.catch(() => Effect.void)),
                { discard: true },
              );
            }
            yield* deps.worktreeJanitor?.run(cleanupPlan) ?? Effect.void;
            yield* deps.threadJanitor?.deleteThreads(threadIds) ?? Effect.void;
            yield* deps.artifactStore?.removeDisk(artifactRefs) ?? Effect.void;
          });
          yield* deps.scheduleCleanup?.(cleanup) ?? cleanup;
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
