// @effect-diagnostics nodeBuiltinImport:off
import { createHash, randomUUID } from "node:crypto";
import { constants as FsConstants, createReadStream } from "node:fs";
import * as Fs from "node:fs/promises";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { ServerConfig } from "../../config.ts";
import {
  ARTIFACT_BYTES_CAP_PER_TICKET,
  ARTIFACT_COUNT_CAP_PER_TICKET,
  ARTIFACT_FILE_CAPS,
  ARTIFACT_SIDECAR_READ_CAP_BYTES,
  collisionWinner,
  compareRawNames,
  decodeUtf8Replacing,
  detectArtifactKind,
  isCanonicalUuid,
  isSidecarName,
  isValidTicketDirKey,
  normalizeCaption,
  sidecarBaseName,
  toSourceMtimeMs,
  validateArtifactName,
} from "../artifactRules.ts";
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  TicketArtifactPaths,
  TicketArtifactStore,
  type DiskRef,
  type IngestBatchInput,
  type IngestReport,
  type IngestSkip,
  type TicketArtifactRow,
  type TicketArtifactStoreShape,
  type VerifiedBlob,
} from "../Services/TicketArtifactStore.ts";

const toStoreError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const wrapSql = <A>(message: string, effect: Effect.Effect<A, SqlError>) =>
  effect.pipe(Effect.mapError(toStoreError(message)));

const DEFAULT_RECONCILE_GRACE_MS = 60 * 60 * 1000;

interface RawRow {
  readonly artifact_id: string;
  readonly blob_id: string;
  readonly ticket_id: string;
  readonly board_id: string;
  readonly name: string;
  readonly kind: string;
  readonly mime: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly source_mtime_ms: number | null;
  readonly description: string | null;
  readonly step_run_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const toRow = (raw: RawRow): TicketArtifactRow => ({
  artifactId: raw.artifact_id,
  blobId: raw.blob_id,
  ticketId: raw.ticket_id,
  boardId: raw.board_id,
  name: raw.name,
  kind: raw.kind as TicketArtifactRow["kind"],
  mime: raw.mime,
  byteSize: raw.byte_size,
  sha256: raw.sha256,
  sourceMtimeMs: raw.source_mtime_ms,
  description: raw.description,
  stepRunId: raw.step_run_id,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
});

/**
 * The pinned safe-open sequence (spec §Ingest pipeline step 1 / §Serve-time
 * open): lstat regular → open O_NOFOLLOW → fstat regular → realpath
 * component-boundary containment → re-lstat dev/ino === fstat dev/ino.
 * Returns null on ANY violation. POSIX-only by contract.
 */
const openContained = async (
  absolutePath: string,
  containRootRealpath: string,
): Promise<{
  readonly handle: Fs.FileHandle;
  readonly size: number;
  readonly mtimeMs: number;
} | null> => {
  let handle: Fs.FileHandle | null = null;
  try {
    const pre = await Fs.lstat(absolutePath);
    if (!pre.isFile()) return null;
    handle = await Fs.open(absolutePath, FsConstants.O_RDONLY | FsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return null;
    }
    const real = await Fs.realpath(absolutePath);
    if (real !== containRootRealpath && !real.startsWith(containRootRealpath + NodePath.sep)) {
      await handle.close();
      return null;
    }
    if (real === containRootRealpath) {
      // The target must be a CHILD of the root, never the root itself.
      await handle.close();
      return null;
    }
    const post = await Fs.lstat(absolutePath);
    if (post.dev !== stat.dev || post.ino !== stat.ino) {
      await handle.close();
      return null;
    }
    return { handle, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // already closed
      }
    }
    return null;
  }
};

/**
 * Blob health for repair detection — the same no-follow/verified posture as
 * serving (O_NOFOLLOW open, fstat regular-file, size equality), not a weak
 * lstat that a symlink swap could satisfy.
 */
const blobHealthy = async (
  dir: string,
  row: { readonly blobId: string; readonly byteSize: number },
): Promise<boolean> => {
  let handle: Fs.FileHandle | null = null;
  try {
    handle = await Fs.open(
      NodePath.join(dir, row.blobId),
      FsConstants.O_RDONLY | FsConstants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    return stat.isFile() && stat.size === row.byteSize;
  } catch {
    return false;
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
};

/**
 * Bounded streaming copy with the pinned stability check (spec §Ingest step
 * 3): record size S and mtime M, stream at most min(cap, S) + 1 bytes, then
 * require size == S, mtime == M, bytes == S. Returns staged file metadata or
 * a refusal tag.
 */
const stageBounded = async (
  source: { readonly handle: Fs.FileHandle; readonly size: number; readonly mtimeMs: number },
  cap: number,
  tmpPath: string,
): Promise<
  | { readonly ok: true; readonly sha256: string; readonly size: number; readonly mtimeMs: number }
  | { readonly ok: false; readonly reason: "over-file-cap" | "unstable-source" | "unreadable" }
> => {
  const { handle, size, mtimeMs } = source;
  if (size > cap) return { ok: false, reason: "over-file-cap" };
  const hash = createHash("sha256");
  let copied = 0;
  let out: Fs.FileHandle | null = null;
  try {
    out = await Fs.open(tmpPath, "wx");
    const limit = Math.min(cap, size) + 1;
    const chunk = Buffer.alloc(64 * 1024);
    let position = 0;
    while (copied < limit) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, limit - copied),
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      copied += bytesRead;
      if (copied > cap) {
        await out.close();
        await Fs.rm(tmpPath, { force: true });
        return { ok: false, reason: "over-file-cap" };
      }
      hash.update(chunk.subarray(0, bytesRead));
      await out.write(chunk, 0, bytesRead);
    }
    const after = await handle.stat();
    if (after.size !== size || after.mtimeMs !== mtimeMs || copied !== size) {
      await out.close();
      await Fs.rm(tmpPath, { force: true });
      return { ok: false, reason: "unstable-source" };
    }
    await out.sync();
    await out.close();
    return { ok: true, sha256: hash.digest("hex"), size, mtimeMs };
  } catch {
    try {
      if (out !== null) await out.close();
    } catch {
      // already closed
    }
    await Fs.rm(tmpPath, { force: true }).catch(() => undefined);
    return { ok: false, reason: "unreadable" };
  }
};

interface Candidate {
  readonly rawName: string;
  readonly normalized: string;
  readonly kind: TicketArtifactRow["kind"];
  readonly mime: string;
}

/** Classify a scan listing into candidates, sidecar map, and skips. */
export const classifyEntries = (
  entries: ReadonlyArray<string>,
): {
  readonly candidates: ReadonlyArray<Candidate>;
  /** Winning sidecar raw name per raw BASE name. */
  readonly sidecarByBase: ReadonlyMap<string, string>;
  readonly skips: ReadonlyArray<IngestSkip>;
} => {
  const ordered = [...entries].sort(compareRawNames);
  const skips: Array<IngestSkip> = [];

  const sidecarsByBase = new Map<string, Array<string>>();
  const fileNames: Array<string> = [];
  for (const entry of ordered) {
    if (isSidecarName(entry)) {
      const base = sidecarBaseName(entry);
      if (base !== null) {
        const list = sidecarsByBase.get(base) ?? [];
        list.push(entry);
        sidecarsByBase.set(base, list);
      }
      continue;
    }
    fileNames.push(entry);
  }

  const fileSet = new Set(fileNames);
  const sidecarByBase = new Map<string, string>();
  for (const [base, names] of sidecarsByBase) {
    // Multi-casing duplicates: smallest raw name under the canonical
    // comparator wins; the rest are ignored with a report note.
    const winner = collisionWinner(names);
    sidecarByBase.set(base, winner);
    for (const loser of names) {
      if (loser !== winner) {
        skips.push({ name: loser, reason: "name-collision", detail: "duplicate sidecar casing" });
      }
    }
    if (!fileSet.has(base)) {
      skips.push({ name: winner, reason: "orphan-sidecar" });
      sidecarByBase.delete(base);
    }
  }

  // NFC-collision groups over candidate files: smallest raw name wins.
  const byNormalized = new Map<string, Array<{ raw: string; normalized: string }>>();
  const preliminary: Array<{ raw: string; normalized: string }> = [];
  for (const raw of fileNames) {
    const validated = validateArtifactName(raw);
    if (!validated.ok) {
      skips.push({ name: raw, reason: "invalid-name", detail: validated.reason });
      continue;
    }
    preliminary.push({ raw, normalized: validated.normalized });
    const group = byNormalized.get(validated.normalized) ?? [];
    group.push({ raw, normalized: validated.normalized });
    byNormalized.set(validated.normalized, group);
  }

  const candidates: Array<Candidate> = [];
  for (const { raw, normalized } of preliminary) {
    const group = byNormalized.get(normalized) ?? [];
    if (group.length > 1 && collisionWinner(group.map((g) => g.raw)) !== raw) {
      skips.push({ name: raw, reason: "name-collision", detail: "normalizes to a duplicate name" });
      continue;
    }
    const detected = detectArtifactKind(raw);
    if (detected === null) {
      skips.push({ name: raw, reason: "unknown-extension" });
      continue;
    }
    candidates.push({ rawName: raw, normalized, kind: detected.kind, mime: detected.mime });
  }

  return { candidates, sidecarByBase, skips };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const paths = yield* TicketArtifactPaths;
  const rootDir = NodePath.resolve(paths.rootDir);

  // Per-ticket single-flight (spec §Single-flight): rows are written only by
  // ingestBatch, and one ingest runs per ticket at a time.
  const ticketLocks = yield* SynchronizedRef.make<Map<string, Semaphore.Semaphore>>(new Map());
  const lockFor = (ticketId: string) =>
    SynchronizedRef.modifyEffect(ticketLocks, (current) => {
      const existing = current.get(ticketId);
      if (existing) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(ticketId, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const ticketDir = (ticketId: string): string | null =>
    isValidTicketDirKey(ticketId) ? NodePath.join(rootDir, ticketId) : null;

  const rootRealpath = () =>
    Fs.mkdir(rootDir, { recursive: true }).then(() => Fs.realpath(rootDir));

  const openVerifiedBlob: TicketArtifactStoreShape["openVerifiedBlob"] = (row) =>
    Effect.tryPromise({
      try: async (): Promise<VerifiedBlob | null> => {
        if (!isValidTicketDirKey(row.ticketId) || !isCanonicalUuid(row.blobId)) return null;
        const dir = ticketDir(row.ticketId);
        if (dir === null) return null;
        const absolutePath = NodePath.join(dir, row.blobId);
        const contained = await openContained(absolutePath, await rootRealpath());
        if (contained === null) return null;
        if (contained.size !== row.byteSize) {
          await contained.handle.close();
          return null;
        }
        const handle = contained.handle;
        return {
          size: contained.size,
          absolutePath,
          read: (maxBytes) =>
            Effect.tryPromise({
              try: async () => {
                const buffer = Buffer.alloc(Math.min(maxBytes, contained.size));
                let readTotal = 0;
                while (readTotal < buffer.length) {
                  const { bytesRead } = await handle.read(
                    buffer,
                    readTotal,
                    buffer.length - readTotal,
                    readTotal,
                  );
                  if (bytesRead === 0) break;
                  readTotal += bytesRead;
                }
                return new Uint8Array(buffer.subarray(0, readTotal));
              },
              catch: toStoreError("TicketArtifactStore.readVerifiedBlob"),
            }),
          readRange: (start, end) =>
            Effect.tryPromise({
              try: async () => {
                const length = Math.max(0, end - start + 1);
                const buffer = Buffer.alloc(length);
                let readTotal = 0;
                while (readTotal < length) {
                  const { bytesRead } = await handle.read(
                    buffer,
                    readTotal,
                    length - readTotal,
                    start + readTotal,
                  );
                  if (bytesRead === 0) break;
                  readTotal += bytesRead;
                }
                return new Uint8Array(buffer.subarray(0, readTotal));
              },
              catch: toStoreError("TicketArtifactStore.readRangeVerifiedBlob"),
            }),
          stream: () => createReadStream(absolutePath, { fd: handle.fd, autoClose: false }),
          close: () => Effect.promise(() => handle.close().catch(() => undefined)),
        };
      },
      catch: toStoreError("TicketArtifactStore.openVerifiedBlob"),
    });

  const getRow: TicketArtifactStoreShape["getRow"] = (ticketId, artifactId) =>
    wrapSql(
      "TicketArtifactStore.getRow",
      sql<RawRow>`
        SELECT * FROM workflow_ticket_artifact
        WHERE ticket_id = ${String(ticketId)} AND artifact_id = ${artifactId}
      `,
    ).pipe(Effect.map((rows) => (rows[0] === undefined ? null : toRow(rows[0]))));

  const list: TicketArtifactStoreShape["list"] = (ticketId) =>
    wrapSql(
      "TicketArtifactStore.list",
      sql<RawRow>`
        SELECT * FROM workflow_ticket_artifact
        WHERE ticket_id = ${String(ticketId)}
        ORDER BY name ASC
      `,
    ).pipe(Effect.map((rows) => rows.map(toRow)));

  const readInlineText: TicketArtifactStoreShape["readInlineText"] = (
    ticketId,
    artifactId,
    capBytes,
  ) =>
    Effect.gen(function* () {
      const row = yield* getRow(ticketId, artifactId);
      if (row === null) return null;
      const blob = yield* openVerifiedBlob(row);
      if (blob === null) return null;
      const bytes = yield* blob.read(capBytes).pipe(Effect.ensuring(blob.close()));
      return decodeUtf8Replacing(bytes);
    });

  const ingestBatch: TicketArtifactStoreShape["ingestBatch"] = (input) =>
    Effect.gen(function* () {
      const lock = yield* lockFor(String(input.ticketId));
      return yield* lock.withPermits(1)(ingestBatchUnlocked(input));
    });

  const ingestBatchUnlocked = (input: IngestBatchInput) => {
    // Hoisted so the OUTER interrupt finalizer sees them: an interrupt during
    // Phase-A staging (before the tx-scoped handlers exist) must still remove
    // promoted blobs; after commit the adopted set protects referenced blobs.
    const promotedBlobPaths: Array<string> = [];
    const adoptedBlobIds = new Set<string>();
    return Effect.gen(function* () {
      const ticketId = String(input.ticketId);
      const scanTruncated = input.scanTruncated === true;
      const dir = ticketDir(ticketId);
      if (dir === null) {
        return {
          ingested: [],
          skips: [
            { name: ticketId, reason: "invalid-name", detail: "unsafe ticket id" } as IngestSkip,
          ],
          ticketMissing: false,
          scanTruncated,
        } satisfies IngestReport;
      }

      const { candidates, sidecarByBase, skips } = classifyEntries(input.entries);
      const allSkips: Array<IngestSkip> = [...skips];
      const ingested: Array<string> = [];

      // Optimistic row snapshot (outside the tx) for the Phase-A short-circuit.
      const existingRows = yield* wrapSql(
        "TicketArtifactStore.ingest:snapshot",
        sql<RawRow>`SELECT * FROM workflow_ticket_artifact WHERE ticket_id = ${ticketId}`,
      ).pipe(Effect.map((rows) => new Map(rows.map((raw) => [raw.name, toRow(raw)]))));

      interface Staged {
        readonly candidate: Candidate;
        readonly description: string | undefined;
        readonly sidecarPresent: boolean;
        readonly mode: "staged" | "unchanged";
        readonly blobId?: string;
        readonly sha256?: string;
        readonly size?: number;
        readonly mtimeMs: number;
        readonly repairRequired: boolean;
      }

      const rootReal = yield* Effect.tryPromise({
        try: async () => {
          const real = await Fs.realpath(input.artifactsRootAbsolutePath);
          await Fs.mkdir(dir, { recursive: true });
          return real;
        },
        catch: toStoreError("TicketArtifactStore.ingest:roots"),
      });

      const staged: Array<Staged> = [];
      for (const candidate of candidates) {
        // Sidecar first (owned here per plan A4): containment-safe bounded read.
        const sidecarRaw = sidecarByBase.get(candidate.rawName);
        let description: string | undefined;
        let sidecarPresent = false;
        if (sidecarRaw !== undefined) {
          const sidecarAbs = NodePath.join(input.artifactsRootAbsolutePath, sidecarRaw);
          const opened = yield* Effect.promise(() => openContained(sidecarAbs, rootReal));
          if (opened !== null) {
            // A sidecar that opens but fails to READ is treated as ABSENT
            // (existing description preserved) — a transient read error must
            // not clear a caption. The handle always closes.
            const bytes = yield* Effect.promise(async (): Promise<Buffer | null> => {
              try {
                const buffer = Buffer.alloc(Math.min(ARTIFACT_SIDECAR_READ_CAP_BYTES, opened.size));
                const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, 0);
                return buffer.subarray(0, bytesRead);
              } catch {
                return null;
              } finally {
                await opened.handle.close().catch(() => undefined);
              }
            });
            if (bytes !== null) {
              sidecarPresent = true;
              description = normalizeCaption(decodeUtf8Replacing(bytes));
            }
          }
        }

        const sourceAbs = NodePath.join(input.artifactsRootAbsolutePath, candidate.rawName);
        const existing = existingRows.get(candidate.normalized);

        // Phase-A short-circuit: size+mtime match AND healthy current blob →
        // skip blob staging; still enters Phase B as an UnchangedCandidate.
        const preOpen = yield* Effect.promise(() => openContained(sourceAbs, rootReal));
        if (preOpen === null) {
          allSkips.push({ name: candidate.rawName, reason: "unreadable" });
          continue;
        }
        const observedMtime = toSourceMtimeMs(preOpen.mtimeMs);
        let repairRequired = false;
        if (
          existing !== undefined &&
          existing.byteSize === preOpen.size &&
          existing.sourceMtimeMs === observedMtime
        ) {
          const healthy = yield* Effect.promise(() => blobHealthy(dir, existing));
          if (healthy) {
            yield* Effect.promise(() => preOpen.handle.close().catch(() => undefined));
            staged.push({
              candidate,
              description,
              sidecarPresent,
              mode: "unchanged",
              mtimeMs: observedMtime,
              repairRequired: false,
            });
            continue;
          }
          repairRequired = true;
        }

        // Repair detection must not depend on the short-circuit firing: a
        // missing/unhealthy current blob with a drifted mtime still needs the
        // staged bytes ADOPTED even when the sha matches (spec Phase-B pin).
        if (existing !== undefined && !repairRequired) {
          const healthy = yield* Effect.promise(() => blobHealthy(dir, existing));
          repairRequired = !healthy;
        }
        const cap = ARTIFACT_FILE_CAPS[candidate.kind];
        const blobId = randomUUID();
        const tmpPath = NodePath.join(dir, `.tmp-${randomUUID()}`);
        const result = yield* Effect.promise(() => stageBounded(preOpen, cap, tmpPath));
        yield* Effect.promise(() => preOpen.handle.close().catch(() => undefined));
        if (!result.ok) {
          allSkips.push({ name: candidate.rawName, reason: result.reason });
          continue;
        }
        yield* Effect.tryPromise({
          try: () => Fs.rename(tmpPath, NodePath.join(dir, blobId)),
          catch: toStoreError("TicketArtifactStore.ingest:promote"),
        });
        promotedBlobPaths.push(NodePath.join(dir, blobId));
        staged.push({
          candidate,
          description,
          sidecarPresent,
          mode: "staged",
          blobId,
          sha256: result.sha256,
          size: result.size,
          mtimeMs: toSourceMtimeMs(result.mtimeMs),
          repairRequired,
        });
      }

      // Phase B — one short write transaction with liveness + caps + the four
      // exhaustive branches. EVERY-EXIT staged cleanup (spec pin): if the
      // transaction fails or the fiber is interrupted before adoption, all
      // promoted-but-unadopted staged blobs are removed here — the reconciler
      // is a backstop, not the primary exit path.
      const removeStagedExcept = (keep: ReadonlySet<string>) =>
        Effect.promise(async () => {
          for (const item of staged) {
            if (item.mode === "staged" && item.blobId !== undefined && !keep.has(item.blobId)) {
              await Fs.rm(NodePath.join(dir, item.blobId), { force: true }).catch(() => undefined);
            }
          }
        });
      const supersededBlobs: Array<string> = [];
      const unadoptedBlobs: Array<string> = [];
      const txResult = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const live = yield* sql<{ readonly board_id: string }>`
              SELECT board_id FROM projection_ticket WHERE ticket_id = ${ticketId}
            `;
            const boardId = live[0]?.board_id;
            if (boardId === undefined) {
              return { ticketMissing: true as const };
            }

            const totals = yield* sql<{ readonly count: number; readonly bytes: number }>`
              SELECT COUNT(*) AS count, COALESCE(SUM(byte_size), 0) AS bytes
              FROM workflow_ticket_artifact WHERE ticket_id = ${ticketId}
            `;
            let count = totals[0]?.count ?? 0;
            let bytes = totals[0]?.bytes ?? 0;

            const now = DateTime.formatIso(yield* DateTime.now);

            for (const item of staged) {
              const current = yield* sql<RawRow>`
                SELECT * FROM workflow_ticket_artifact
                WHERE ticket_id = ${ticketId} AND name = ${item.candidate.normalized}
              `;
              const row = current[0] === undefined ? null : toRow(current[0]);

              if (item.mode === "unchanged") {
                if (row === null) {
                  // Optimistic snapshot was stale (row deleted between reads).
                  // Single-flight makes this unreachable in practice; the next
                  // finalization re-stages. Report as unstable for visibility.
                  allSkips.push({ name: item.candidate.rawName, reason: "unstable-source" });
                  continue;
                }
                const nextDescription = item.sidecarPresent
                  ? (item.description ?? null)
                  : row.description; // absence preserves (last-wins)
                if (nextDescription !== row.description) {
                  yield* sql`
                    UPDATE workflow_ticket_artifact
                    SET description = ${nextDescription}, updated_at = ${now}
                    WHERE artifact_id = ${row.artifactId}
                  `;
                  ingested.push(item.candidate.normalized);
                }
                // identical → write NOTHING (no updated_at churn)
                continue;
              }

              const blobId = item.blobId ?? "";
              const size = item.size ?? 0;
              const sha = item.sha256 ?? "";

              if (row === null) {
                // New name: count cap gates NEW names only.
                if (count >= ARTIFACT_COUNT_CAP_PER_TICKET) {
                  allSkips.push({ name: item.candidate.rawName, reason: "over-ticket-count-cap" });
                  unadoptedBlobs.push(blobId);
                  continue;
                }
                if (bytes + size > ARTIFACT_BYTES_CAP_PER_TICKET) {
                  allSkips.push({ name: item.candidate.rawName, reason: "over-ticket-bytes-cap" });
                  unadoptedBlobs.push(blobId);
                  continue;
                }
                yield* sql`
                  INSERT INTO workflow_ticket_artifact
                    (artifact_id, blob_id, ticket_id, board_id, name, kind, mime,
                     byte_size, sha256, source_mtime_ms, description, step_run_id,
                     created_at, updated_at)
                  VALUES
                    (${randomUUID()}, ${blobId}, ${ticketId}, ${boardId},
                     ${item.candidate.normalized}, ${item.candidate.kind},
                     ${item.candidate.mime}, ${size}, ${sha}, ${item.mtimeMs},
                     ${item.description ?? null}, ${input.stepRunId ?? null},
                     ${now}, ${now})
                `;
                count += 1;
                bytes += size;
                adoptedBlobIds.add(blobId);
                ingested.push(item.candidate.normalized);
                continue;
              }

              if (sha === row.sha256 && !item.repairRequired) {
                // Same bytes rewritten (mtime drifted): drop the staged blob,
                // absorb mtime + description, keep provenance.
                unadoptedBlobs.push(blobId);
                const nextDescription = item.sidecarPresent
                  ? (item.description ?? null)
                  : row.description;
                yield* sql`
                  UPDATE workflow_ticket_artifact
                  SET source_mtime_ms = ${item.mtimeMs}, updated_at = ${now},
                      description = ${nextDescription}
                  WHERE artifact_id = ${row.artifactId}
                `;
                ingested.push(item.candidate.normalized);
                continue;
              }

              // Bytes changed OR repair adoption (same sha + unhealthy blob).
              const delta = size - row.byteSize;
              if (bytes + delta > ARTIFACT_BYTES_CAP_PER_TICKET) {
                allSkips.push({ name: item.candidate.rawName, reason: "over-ticket-bytes-cap" });
                unadoptedBlobs.push(blobId);
                continue;
              }
              const nextDescription = item.sidecarPresent
                ? (item.description ?? null)
                : row.description;
              yield* sql`
                UPDATE workflow_ticket_artifact
                SET blob_id = ${blobId}, byte_size = ${size}, sha256 = ${sha},
                    source_mtime_ms = ${item.mtimeMs}, updated_at = ${now},
                    step_run_id = ${sha === row.sha256 ? row.stepRunId : (input.stepRunId ?? null)},
                    description = ${nextDescription}
                WHERE artifact_id = ${row.artifactId}
              `;
              bytes += delta;
              adoptedBlobIds.add(blobId);
              supersededBlobs.push(row.blobId);
              ingested.push(item.candidate.normalized);
            }
            return { ticketMissing: false as const };
          }),
        )
        .pipe(
          Effect.mapError(toStoreError("TicketArtifactStore.ingest:commit")),
          // Adoption-aware: a failure/interrupt after commit must not delete
          // blobs a committed row now references; before commit the set is
          // empty and every staged blob goes.
          Effect.onError(() => removeStagedExcept(adoptedBlobIds)),
          Effect.onInterrupt(() => removeStagedExcept(adoptedBlobIds)),
        );

      if (txResult.ticketMissing) {
        // Whole batch no-ops: remove everything we staged.
        for (const item of staged) {
          if (item.mode === "staged" && item.blobId !== undefined) {
            yield* Effect.promise(() =>
              Fs.rm(NodePath.join(dir, item.blobId ?? ""), { force: true }).catch(() => undefined),
            );
          }
        }
        return { ingested: [], skips: allSkips, ticketMissing: true, scanTruncated };
      }

      // Post-commit best-effort cleanup: superseded + unadopted blobs.
      for (const blobId of [...supersededBlobs, ...unadoptedBlobs]) {
        if (blobId.length > 0) {
          yield* Effect.promise(() =>
            Fs.rm(NodePath.join(dir, blobId), { force: true }).catch(() => undefined),
          );
        }
      }

      return {
        ingested,
        skips: allSkips,
        ticketMissing: false,
        scanTruncated,
      } satisfies IngestReport;
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.promise(async () => {
          for (const path of promotedBlobPaths) {
            if (!adoptedBlobIds.has(NodePath.basename(path))) {
              await Fs.rm(path, { force: true }).catch(() => undefined);
            }
          }
        }),
      ),
    );
  };

  const deleteRowsForTickets: TicketArtifactStoreShape["deleteRowsForTickets"] = (ticketIds) =>
    Effect.gen(function* () {
      const refs: Array<DiskRef> = [];
      for (const ticketId of ticketIds) {
        const rows = yield* wrapSql(
          "TicketArtifactStore.deleteRows:collect",
          sql<{ readonly ticket_id: string; readonly blob_id: string }>`
            SELECT ticket_id, blob_id FROM workflow_ticket_artifact
            WHERE ticket_id = ${ticketId}
          `,
        );
        for (const row of rows) refs.push({ ticketId: row.ticket_id, blobId: row.blob_id });
        yield* wrapSql(
          "TicketArtifactStore.deleteRows:delete",
          sql`DELETE FROM workflow_ticket_artifact WHERE ticket_id = ${ticketId}`,
        );
      }
      return refs;
    });

  const deleteRowsForBoard: TicketArtifactStoreShape["deleteRowsForBoard"] = (boardId) =>
    Effect.gen(function* () {
      const rows = yield* wrapSql(
        "TicketArtifactStore.deleteRowsForBoard:collect",
        sql<{ readonly ticket_id: string; readonly blob_id: string }>`
          SELECT ticket_id, blob_id FROM workflow_ticket_artifact
          WHERE board_id = ${boardId}
        `,
      );
      yield* wrapSql(
        "TicketArtifactStore.deleteRowsForBoard:delete",
        sql`DELETE FROM workflow_ticket_artifact WHERE board_id = ${boardId}`,
      );
      return rows.map((row) => ({ ticketId: row.ticket_id, blobId: row.blob_id }));
    });

  const removeDisk: TicketArtifactStoreShape["removeDisk"] = (refs) =>
    Effect.promise(async () => {
      const dirs = new Set<string>();
      for (const ref of refs) {
        const dir = ticketDir(ref.ticketId);
        if (dir === null || !isCanonicalUuid(ref.blobId)) continue;
        dirs.add(dir);
        await Fs.rm(NodePath.join(dir, ref.blobId), { force: true }).catch(() => undefined);
      }
      for (const dir of dirs) {
        // Remove the dir when empty (best-effort; reconciler backstops).
        await Fs.rmdir(dir).catch(() => undefined);
      }
    });

  const reconcileOrphans: TicketArtifactStoreShape["reconcileOrphans"] = (options) =>
    Effect.gen(function* () {
      const graceMs = options?.graceMs ?? DEFAULT_RECONCILE_GRACE_MS;
      const nowMs = options?.nowMs ?? (yield* Clock.currentTimeMillis);
      const exists = yield* Effect.promise(() =>
        Fs.stat(rootDir).then(
          (stat) => stat.isDirectory(),
          () => false,
        ),
      );
      if (!exists) return;

      const dirEntries = yield* Effect.promise(() => Fs.readdir(rootDir).catch(() => []));
      for (const ticketKey of dirEntries) {
        if (!isValidTicketDirKey(ticketKey)) continue;
        const dir = NodePath.join(rootDir, ticketKey);
        const dirStat = yield* Effect.promise(() => Fs.lstat(dir).catch(() => null));
        if (dirStat === null || !dirStat.isDirectory()) continue;

        const referenced = yield* wrapSql(
          "TicketArtifactStore.reconcile:rows",
          sql<{ readonly blob_id: string }>`
            SELECT blob_id FROM workflow_ticket_artifact WHERE ticket_id = ${ticketKey}
          `,
        ).pipe(Effect.map((rows) => new Set(rows.map((row) => row.blob_id))));

        const files = yield* Effect.promise(() => Fs.readdir(dir).catch(() => []));
        if (referenced.size === 0) {
          // Zero-row ticket dir: reclaim wholesale once past the grace (dir mtime).
          if (nowMs - dirStat.mtimeMs >= graceMs) {
            yield* Effect.promise(() =>
              Fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
            );
          }
          continue;
        }
        for (const file of files) {
          const filePath = NodePath.join(dir, file);
          const fileStat = yield* Effect.promise(() => Fs.lstat(filePath).catch(() => null));
          if (fileStat === null || !fileStat.isFile()) continue;
          if (nowMs - fileStat.mtimeMs < graceMs) continue;
          if (file.startsWith(".tmp-")) {
            yield* Effect.promise(() => Fs.rm(filePath, { force: true }).catch(() => undefined));
            continue;
          }
          if (isCanonicalUuid(file) && !referenced.has(file)) {
            yield* Effect.promise(() => Fs.rm(filePath, { force: true }).catch(() => undefined));
          }
        }
      }
    });

  return {
    ingestBatch,
    list,
    getRow,
    openVerifiedBlob,
    readInlineText,
    deleteRowsForTickets,
    deleteRowsForBoard,
    removeDisk,
    reconcileOrphans,
  } satisfies TicketArtifactStoreShape;
});

export const TicketArtifactStoreLive = Layer.effect(TicketArtifactStore, make);

/** Production paths: stateDir/ticket-artifacts (sibling of attachments/). */
export const TicketArtifactPathsLive = Layer.effect(
  TicketArtifactPaths,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return { rootDir: `${config.stateDir}/ticket-artifacts` };
  }),
);
