import type { BoardId, LaneKey, ThreadId, TicketId, TurnId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import {
  WorkflowSourceCommitter,
  type ReconcileLanes,
  type SourceDelta,
  type SourceItemFields,
  type SourceItemMetadata,
  type WorkflowSourceCommitterShape,
} from "../Services/WorkflowSourceCommitter.ts";

const toCommitterError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrap = <A>(message: string, effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toCommitterError(message)));

interface MappingRow {
  readonly mappingId: string;
  readonly ticketId: string;
  readonly contentHash: string;
  readonly lifecycle: string;
  readonly syncStatus: string;
}

// What a single delta application touched. Drives the POST-TX steps:
// - `publishTicketId`: a created/edited/closed/orphaned ticket whose live view
//   must be pushed to WorkflowBoardEvents after the lock/tx releases (the
//   unlocked cores append+project but never publish).
// - `republishDependents`: a terminal/closed move republishes dependents too.
// - `cancelTurns`: provider turns SNAPSHOTTED in-tx (before the close tombstoned
//   the outbox rows) to interrupt+cancel after the tx commits — no provider IO
//   runs inside the transaction.
interface DeltaEffect {
  readonly publishTicketId: TicketId | null;
  readonly republishDependents: boolean;
  readonly cancelTicketId: TicketId | null;
  readonly cancelTurns: ReadonlyArray<{ readonly threadId: ThreadId; readonly turnId: TurnId | null }>;
}

const noEffect: DeltaEffect = {
  publishTicketId: null,
  republishDependents: false,
  cancelTicketId: null,
  cancelTurns: [],
};

const serializeMetadata = (metadata: SourceItemMetadata): string =>
  JSON.stringify({
    provider: metadata.provider,
    url: metadata.url ?? null,
    assignees: metadata.assignees ?? [],
    labels: metadata.labels ?? [],
    lifecycle: metadata.lifecycle ?? null,
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* WorkflowEngine;
  const committer = yield* WorkflowEventCommitter;
  const registry = yield* BoardRegistry;
  const saveLocks = yield* WorkflowBoardSaveLocks;
  const ids = yield* WorkflowIds;

  // Re-read the mapping row by the UNIQUE key INSIDE the transaction. The diff
  // that produced the delta ran outside the lock, so a concurrent batch may have
  // mutated the table since; this revalidation is the authority.
  const readMapping = (boardId: BoardId, item: SourceItemFields) =>
    wrap(
      "WorkflowSourceCommitter.readMapping",
      sql<MappingRow>`
        SELECT
          mapping_id AS "mappingId",
          ticket_id AS "ticketId",
          content_hash AS "contentHash",
          lifecycle AS "lifecycle",
          sync_status AS "syncStatus"
        FROM work_source_mapping
        WHERE board_id = ${String(boardId)}
          AND source_id = ${item.sourceId}
          AND provider = ${item.provider}
          AND external_id = ${item.externalId}
        LIMIT 1
      `,
    ).pipe(Effect.map((rows) => rows[0] ?? null));

  const applyNew = (
    boardId: BoardId,
    lanes: ReconcileLanes,
    item: SourceItemFields,
  ): Effect.Effect<DeltaEffect, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      // In-tx recheck: if a mapping already exists (a stale "new" diff, or a
      // racing batch won) do nothing — exactly one ticket/mapping per item.
      const existing = yield* readMapping(boardId, item);
      if (existing !== null) {
        return noEffect;
      }
      const created = yield* engine.createTicketAndEnterUnlocked({
        boardId,
        title: item.title,
        ...(item.description === undefined ? {} : { description: item.description }),
        destinationLane: lanes.destinationLane,
      });
      const mappingId = yield* ids.mappingId();
      const now = DateTime.formatIso(yield* DateTime.now);
      // INSERT in the SAME transaction as the ticket create. A UNIQUE violation
      // here means a genuine conflict the in-tx re-read above did NOT catch (the
      // mapping was committed by a racing writer between the re-read and this
      // insert). We do NOT swallow it: letting it propagate ROLLS BACK the whole
      // chunk tx (the just-created ticket rolls back with it), so we never commit
      // an orphan ticket with no mapping. The next sync cycle's in-tx re-read
      // finds the now-committed mapping and skips.
      yield* wrap(
        "WorkflowSourceCommitter.insertMapping",
        sql`
          INSERT INTO work_source_mapping (
            mapping_id, board_id, source_id, provider, external_id, ticket_id,
            provider_version, content_hash, lifecycle, sync_status,
            source_metadata_json, created_at, last_synced_at
          ) VALUES (
            ${mappingId}, ${String(boardId)}, ${item.sourceId}, ${item.provider},
            ${item.externalId}, ${String(created.ticketId)},
            ${item.providerVersion ?? null}, ${item.contentHash}, 'open', 'active',
            ${serializeMetadata(item.metadata)}, ${now}, ${now}
          )
        `,
      );
      return { ...noEffect, publishTicketId: created.ticketId };
    });

  const applyChanged = (
    boardId: BoardId,
    item: SourceItemFields,
  ): Effect.Effect<DeltaEffect, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const row = yield* readMapping(boardId, item);
      if (row === null) {
        return noEffect;
      }
      // Content-hash gate: same hash → no write (idempotent re-run).
      if (item.contentHash === row.contentHash) {
        return noEffect;
      }
      yield* engine.editTicketFieldsUnlocked(row.ticketId as TicketId, {
        title: item.title,
        ...(item.description === undefined ? {} : { description: item.description }),
      });
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* wrap(
        "WorkflowSourceCommitter.updateChanged",
        sql`
          UPDATE work_source_mapping
          SET provider_version = ${item.providerVersion ?? null},
              content_hash = ${item.contentHash},
              source_metadata_json = ${serializeMetadata(item.metadata)},
              last_synced_at = ${now}
          WHERE mapping_id = ${row.mappingId}
        `,
      );
      return { ...noEffect, publishTicketId: row.ticketId as TicketId };
    });

  // Close a ticket from the source: snapshot its cancellable provider turns
  // BEFORE the in-tx tombstone hides them, then route it to the closed lane
  // (DB-only supersession: tombstone, no provider IO). The returned DeltaEffect
  // carries the snapshot so the committer cancels the provider work POST-TX.
  const closeTicket = (
    ticketId: TicketId,
    closedLane: LaneKey,
  ): Effect.Effect<DeltaEffect, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const cancelTurns = yield* engine.cancellableProviderTurnsForTicket(ticketId);
      yield* engine.closeTicketFromSourceUnlocked(ticketId, closedLane);
      return {
        publishTicketId: ticketId,
        republishDependents: true,
        cancelTicketId: ticketId,
        cancelTurns,
      };
    });

  const applyClosed = (
    boardId: BoardId,
    lanes: ReconcileLanes,
    item: SourceItemFields,
  ): Effect.Effect<DeltaEffect, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const row = yield* readMapping(boardId, item);
      if (row === null || row.lifecycle === "closed") {
        return noEffect;
      }
      const effectResult = yield* closeTicket(row.ticketId as TicketId, lanes.closedLane);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* wrap(
        "WorkflowSourceCommitter.updateClosed",
        sql`
          UPDATE work_source_mapping
          SET lifecycle = 'closed', content_hash = ${item.contentHash}, last_synced_at = ${now}
          WHERE mapping_id = ${row.mappingId}
        `,
      );
      return effectResult;
    });

  const applyMissing = (
    boardId: BoardId,
    lanes: ReconcileLanes,
    item: SourceItemFields,
    confirmedDeleted: boolean,
  ): Effect.Effect<DeltaEffect, WorkflowEventStoreError> =>
    Effect.gen(function* () {
      const row = yield* readMapping(boardId, item);
      if (row === null) {
        return noEffect;
      }
      const now = DateTime.formatIso(yield* DateTime.now);
      // Mark-only: flag the mapping orphaned. The getItem confirmation is a
      // provider call done OUTSIDE this tx (in the syncer); when it confirms
      // deletion the syncer sets confirmedDeleted and we also terminal-route.
      if (confirmedDeleted) {
        let effectResult: DeltaEffect = { ...noEffect, publishTicketId: row.ticketId as TicketId };
        if (row.lifecycle !== "closed") {
          effectResult = yield* closeTicket(row.ticketId as TicketId, lanes.closedLane);
        }
        yield* wrap(
          "WorkflowSourceCommitter.markOrphanClosed",
          sql`
            UPDATE work_source_mapping
            SET sync_status = 'orphaned', lifecycle = 'closed', last_synced_at = ${now}
            WHERE mapping_id = ${row.mappingId}
          `,
        );
        return effectResult;
      }
      if (row.syncStatus === "orphaned") {
        return noEffect;
      }
      yield* wrap(
        "WorkflowSourceCommitter.markOrphan",
        sql`
          UPDATE work_source_mapping
          SET sync_status = 'orphaned', last_synced_at = ${now}
          WHERE mapping_id = ${row.mappingId}
        `,
      );
      return { ...noEffect, publishTicketId: row.ticketId as TicketId };
    });

  const applyDelta = (
    boardId: BoardId,
    lanes: ReconcileLanes,
    delta: SourceDelta,
  ): Effect.Effect<DeltaEffect, WorkflowEventStoreError> => {
    switch (delta._tag) {
      case "new":
        return applyNew(boardId, lanes, delta.item);
      case "changed":
        return applyChanged(boardId, delta.item);
      case "closed":
        return applyClosed(boardId, lanes, delta.item);
      case "missing":
        return applyMissing(boardId, lanes, delta.item, delta.confirmedDeleted === true);
    }
  };

  // Validate the destination/closed lanes against the CURRENT board definition
  // (the in-memory registry is the source of truth) BEFORE applying any delta.
  // A board edited between sync cycles may have removed a lane the diff named;
  // enterLaneCore would otherwise emit a move/create for a lane that no longer
  // exists and corrupt lane state. Fail the whole chunk (typed error → the
  // syncer backs the source off) without creating or moving any ticket.
  const validateLanes = (boardId: BoardId, lanes: ReconcileLanes) =>
    Effect.gen(function* () {
      const definition = yield* registry.getDefinition(boardId);
      if (definition === null) {
        return yield* new WorkflowEventStoreError({
          message: `WorkflowSourceCommitter: board ${String(boardId)} is no longer registered`,
        });
      }
      const laneKeys = new Set(definition.lanes.map((lane) => lane.key as string));
      for (const laneKey of [lanes.destinationLane, lanes.closedLane]) {
        if (!laneKeys.has(laneKey as string)) {
          return yield* new WorkflowEventStoreError({
            message: `WorkflowSourceCommitter: lane ${String(laneKey)} does not exist on board ${String(boardId)}`,
          });
        }
      }
    });

  const reconcileChunk: WorkflowSourceCommitterShape["reconcileChunk"] = (
    boardId,
    lanes,
    deltas,
  ) =>
    Effect.gen(function* () {
      if (deltas.length === 0) {
        return;
      }
      // Constraint A — lock order: admission (OUTER) -> save (INNER) ->
      // transaction (innermost). The unlocked engine cores assume the admission
      // lock is held so sync admits serialize against concurrent user moves and
      // cannot violate a WIP limit; this matches the public enterLane order.
      const effects = yield* engine.withBoardAdmissionLock(
        boardId,
        saveLocks.withSaveLock(
          boardId,
          sql
            .withTransaction(
              Effect.gen(function* () {
                // Lane validation runs INSIDE the locked tx and BEFORE any delta
                // so a missing destination/closed lane fails the chunk atomically
                // (nothing created/moved).
                yield* validateLanes(boardId, lanes);
                const collected: Array<DeltaEffect> = [];
                for (const delta of deltas) {
                  collected.push(yield* applyDelta(boardId, lanes, delta));
                }
                return collected;
              }),
            )
            .pipe(Effect.mapError(toCommitterError("WorkflowSourceCommitter.transaction"))),
        ),
      );

      // ---- POST-COMMIT phase ----------------------------------------------
      // Everything below runs ONLY because the tx committed and the locks
      // released — a rolled-back chunk never reaches here (correct: a rollback
      // skips all of it). The close's OWN durable side effects (publish +
      // provider-cancel) run FIRST and UNCONDITIONALLY; board WIP recovery runs
      // LAST and defensively, because it is an unrelated, backstopped sweep
      // whose failure must never suppress side effects tied to THIS committed
      // close.

      // 1) Publish the collected ticket views. The unlocked cores append+project
      // but never publish to WorkflowBoardEvents, so push a live view for every
      // created/edited/closed/orphaned ticket (and dependents on a terminal/
      // closed move) now that the lock/tx has released. Mirrors commitMany's
      // post-lock publish.
      const published = new Set<string>();
      for (const effectResult of effects) {
        if (effectResult.publishTicketId === null) {
          continue;
        }
        const key = `${effectResult.publishTicketId as string}:${effectResult.republishDependents}`;
        if (published.has(key)) {
          continue;
        }
        published.add(key);
        yield* committer
          .publishTicketView(effectResult.publishTicketId, {
            republishDependents: effectResult.republishDependents,
          })
          .pipe(Effect.catch(() => Effect.void));
      }

      // 2) Provider cancellation for source-closed tickets: interrupt the
      // running pipeline fiber + cancel the provider turns snapshotted in-tx.
      // Idempotent. Tied to THIS committed close, so it must always run.
      for (const effectResult of effects) {
        if (effectResult.cancelTicketId !== null) {
          yield* engine
            .supersedeProviderWorkForTicket(effectResult.cancelTicketId, effectResult.cancelTurns)
            .pipe(Effect.catch(() => Effect.void));
        }
      }

      // 3) Board WIP recovery LAST. The unlocked cores DROP auto-lane pipeline
      // starts (SQLite cannot BEGIN-within-BEGIN); recoverBoardWip sweeps the
      // board (taking its own admission lock) and starts admitted-but-not-yet-
      // started pipelines. It does DB reads + pipeline starts and CAN fail; a
      // failure here must NOT propagate to fail reconcileChunk nor suppress the
      // publish/provider-cancel above. It is backstopped — WT11's syncer calls
      // recoverBoardWip per board per cycle regardless of deltas — so a transient
      // failure self-heals. Wrap defensively: log a warning and swallow.
      yield* engine.recoverBoardWip(boardId).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("WorkflowSourceCommitter.recoverBoardWip failed post-commit", {
            boardId,
            cause,
          }),
        ),
      );
    });

  return { reconcileChunk } satisfies WorkflowSourceCommitterShape;
});

export const WorkflowSourceCommitterLive = Layer.effect(WorkflowSourceCommitter, make);
