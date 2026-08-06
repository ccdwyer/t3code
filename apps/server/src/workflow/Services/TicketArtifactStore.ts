import type { TicketId, WorkflowTicketArtifactKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

/**
 * Durable per-ticket artifact store — spec
 * docs/superpowers/specs/2026-08-05-ticket-artifacts-design.md (v2.5).
 *
 * Bytes are immutable blobs at stateDir/ticket-artifacts/<ticketId>/<blobId>;
 * the manifest row's blob_id names the CURRENT blob. Rows are written ONLY by
 * `ingestBatch`, which is single-flight per ticket.
 */

export interface TicketArtifactRow {
  readonly artifactId: string;
  readonly blobId: string;
  readonly ticketId: string;
  readonly boardId: string;
  readonly name: string;
  readonly kind: WorkflowTicketArtifactKind;
  readonly mime: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly sourceMtimeMs: number | null;
  readonly description: string | null;
  readonly stepRunId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type IngestSkipReason =
  | "unknown-extension"
  | "invalid-name"
  | "name-collision"
  | "over-file-cap"
  | "over-ticket-count-cap"
  | "over-ticket-bytes-cap"
  | "unreadable"
  | "unstable-source"
  | "orphan-sidecar";

export interface IngestSkip {
  readonly name: string;
  readonly reason: IngestSkipReason;
  readonly detail?: string | undefined;
}

export interface IngestReport {
  /** Names ingested (created, updated, repaired, or caption-only). */
  readonly ingested: ReadonlyArray<string>;
  readonly skips: ReadonlyArray<IngestSkip>;
  /** The whole batch no-oped because the ticket no longer exists. */
  readonly ticketMissing: boolean;
  /** The caller's scan hit its entry bound (propagated for the skip note). */
  readonly scanTruncated: boolean;
}

export interface IngestBatchInput {
  readonly ticketId: TicketId;
  readonly stepRunId?: string | undefined;
  /** Realpath-resolved absolute path of the worktree's artifacts/ dir. */
  readonly artifactsRootAbsolutePath: string;
  /** Raw scan-relative entries (files only), in scan order. */
  readonly entries: ReadonlyArray<string>;
  /** The scan's listing bound was hit — some files were never seen. */
  readonly scanTruncated?: boolean | undefined;
}

export interface VerifiedBlob {
  /** Node file handle opened O_RDONLY|O_NOFOLLOW and fully verified. */
  readonly read: (maxBytes: number) => Effect.Effect<Uint8Array, WorkflowEventStoreError>;
  /** Positioned read of [start, end] (inclusive) for Range serving. */
  readonly readRange: (
    start: number,
    end: number,
  ) => Effect.Effect<Uint8Array, WorkflowEventStoreError>;
  readonly stream: () => NodeJS.ReadableStream;
  readonly close: () => Effect.Effect<void>;
  readonly size: number;
  readonly absolutePath: string;
}

export interface DiskRef {
  readonly ticketId: string;
  readonly blobId: string;
}

export interface TicketArtifactStoreShape {
  readonly ingestBatch: (
    input: IngestBatchInput,
  ) => Effect.Effect<IngestReport, WorkflowEventStoreError>;
  /** Canonical order: SQLite BINARY on the NFC name. */
  readonly list: (
    ticketId: TicketId,
  ) => Effect.Effect<ReadonlyArray<TicketArtifactRow>, WorkflowEventStoreError>;
  /** Ticket-bound row lookup; null when the pair doesn't match. */
  readonly getRow: (
    ticketId: TicketId,
    artifactId: string,
  ) => Effect.Effect<TicketArtifactRow | null, WorkflowEventStoreError>;
  /**
   * THE verified-fd primitive (spec §One blob-read primitive): O_NOFOLLOW
   * open, fstat regular-file, component-boundary realpath containment,
   * re-lstat dev/ino equality, fstat.size === row.byteSize. Null = the blob
   * is UNAVAILABLE (callers map to 404 / contentUnavailable / typed error).
   * Callers MUST close the returned handle.
   */
  readonly openVerifiedBlob: (
    row: TicketArtifactRow,
  ) => Effect.Effect<VerifiedBlob | null, WorkflowEventStoreError>;
  /**
   * Ticket-bound text read via openVerifiedBlob, U+FFFD decoded, capped at
   * `capBytes` of STORED bytes. Null = row missing or blob unavailable
   * (distinguished by `getRow`).
   */
  readonly readInlineText: (
    ticketId: TicketId,
    artifactId: string,
    capBytes: number,
  ) => Effect.Effect<string | null, WorkflowEventStoreError>;
  /** SQL-only; run INSIDE the caller's cascade transaction. */
  readonly deleteRowsForTickets: (
    ticketIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<DiskRef>, WorkflowEventStoreError>;
  readonly deleteRowsForBoard: (
    boardId: string,
  ) => Effect.Effect<ReadonlyArray<DiskRef>, WorkflowEventStoreError>;
  /** Best-effort blob/dir removal; call AFTER the transaction commits. */
  readonly removeDisk: (refs: ReadonlyArray<DiskRef>) => Effect.Effect<void>;
  /**
   * Boot-time sweep — MUST run strictly before the workflow engine starts.
   * Reclaims .tmp-* files, blobs referenced by no row, and zero-row ticket
   * dirs, all older than the grace period (file/dir mtime).
   */
  readonly reconcileOrphans: (options?: {
    readonly graceMs?: number;
    /** Test override: real fs mtimes need a real clock, not the TestClock. */
    readonly nowMs?: number;
  }) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class TicketArtifactStore extends Context.Service<
  TicketArtifactStore,
  TicketArtifactStoreShape
>()("t3/workflow/Services/TicketArtifactStore") {}

/** Paths dependency, split out so tests can point the store at a tmp dir. */
export interface TicketArtifactPathsShape {
  readonly rootDir: string;
}
export class TicketArtifactPaths extends Context.Service<
  TicketArtifactPaths,
  TicketArtifactPathsShape
>()("t3/workflow/Services/TicketArtifactStore/TicketArtifactPaths") {}
