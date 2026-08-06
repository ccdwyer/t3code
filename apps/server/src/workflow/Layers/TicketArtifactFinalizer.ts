import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { StepRunId, TrimmedNonEmptyString, type TicketId } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";

import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import { ARTIFACT_ALLOWED_EXTENSIONS, compareRawNames } from "../artifactRules.ts";
import {
  TicketArtifactFinalizer,
  TicketWorktreeLocator,
  type TicketArtifactFinalizerShape,
} from "../Services/TicketArtifactFinalizer.ts";
import { TicketArtifactStore, type IngestReport } from "../Services/TicketArtifactStore.ts";
import { WorkflowEventCommitter } from "../Services/WorkflowEventCommitter.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";

/** listFilesRecursive's hard bound; length == bound ⇒ treat as truncated. */
const SCAN_ENTRY_BOUND = 500;
const SKIP_NOTE_MAX_FILES = 20;

/**
 * One aggregated, deterministic skip note (spec §Skip note): author agent,
 * the finalizer run's stepRunId, first 20 names in canonical scan order.
 */
export const formatSkipNote = (report: IngestReport): string | null => {
  if (report.skips.length === 0 && !report.scanTruncated) {
    return null;
  }
  const lines: Array<string> = ["Some artifact files were not ingested:"];
  const ordered = [...report.skips].sort((a, b) => compareRawNames(a.name, b.name));
  for (const skip of ordered.slice(0, SKIP_NOTE_MAX_FILES)) {
    const reason =
      skip.reason === "unknown-extension"
        ? `unsupported extension (allowed: ${ARTIFACT_ALLOWED_EXTENSIONS})`
        : skip.detail === undefined
          ? skip.reason
          : `${skip.reason} (${skip.detail})`;
    lines.push(`- ${skip.name}: ${reason}`);
  }
  if (ordered.length > SKIP_NOTE_MAX_FILES) {
    lines.push(`…and ${String(ordered.length - SKIP_NOTE_MAX_FILES)} more`);
  }
  if (report.scanTruncated) {
    lines.push(
      `The artifacts directory listing was truncated at ${String(SCAN_ENTRY_BOUND)} entries — later files were not scanned.`,
    );
  }
  return lines.join("\n");
};

const make = Effect.gen(function* () {
  const store = yield* TicketArtifactStore;
  const locator = yield* TicketWorktreeLocator;

  const finalizeStep: TicketArtifactFinalizerShape["finalizeStep"] = (input) =>
    Effect.gen(function* () {
      const worktree = yield* locator.locate(input.ticketId);
      if (worktree === null) {
        return { ok: true };
      }
      const relativeRoot = `.t3/ticket/${input.ticketId as string}/artifacts`;

      // Caller-context capabilities (no layer-level requirement; the engine's
      // and merge/PR services' fibers always carry these). Absent = the
      // documented capability no-ops.
      const workspaceFileSystemOption = yield* Effect.serviceOption(WorkspaceFileSystem);
      const listRecursive = Option.isSome(workspaceFileSystemOption)
        ? workspaceFileSystemOption.value.listFilesRecursive
        : undefined;
      if (listRecursive === undefined) {
        // Capability absent (lightweight mocks) = LOGGED no-op (spec §Scan).
        yield* Effect.logWarning("ticket-artifact finalizer: no recursive listing capability", {
          ticketId: input.ticketId,
        });
        return { ok: true };
      }
      // Missing artifacts/ dir = SILENT no-op: listFilesRecursive yields [] for
      // an absent directory.
      const names = yield* listRecursive({
        cwd: worktree.path,
        relativePath: relativeRoot,
      }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      if (names.length === 0) {
        return { ok: true };
      }
      const entries = [...names].sort(compareRawNames);
      const scanTruncated = entries.length >= SCAN_ENTRY_BOUND;

      const report = yield* store
        .ingestBatch({
          ticketId: input.ticketId,
          stepRunId: input.stepRunId,
          artifactsRootAbsolutePath: `${worktree.path}/${relativeRoot}`,
          entries,
          scanTruncated,
        })
        .pipe(
          // Batch-level failures (DB busy, disk full): retry 3× with backoff,
          // then give up loudly — the lifecycle proceeds regardless.
          Effect.retry({ schedule: Schedule.exponential("200 millis"), times: 2 }),
        );

      if (report.ticketMissing) {
        return { ok: true };
      }
      const note = formatSkipNote(report);
      const committerOption = yield* Effect.serviceOption(WorkflowEventCommitter);
      const idsOption = yield* Effect.serviceOption(WorkflowIds);
      if (note !== null && Option.isSome(committerOption) && Option.isSome(idsOption)) {
        const committer = committerOption.value;
        const ids = idsOption.value;
        // Best-effort, posted AFTER the ingest commit; crash-duplication is an
        // accepted residual (deterministic content).
        yield* Effect.gen(function* () {
          const messageId = yield* ids.messageId();
          const now = DateTime.formatIso(yield* DateTime.now);
          const stepRunId = input.stepRunId;
          const eventId = yield* ids.eventId();
          yield* committer.commit(
            stepRunId === undefined
              ? {
                  eventId,
                  type: "TicketMessagePosted",
                  ticketId: input.ticketId,
                  occurredAt: now as never,
                  payload: {
                    messageId,
                    author: "agent",
                    body: note,
                    attachments: [],
                    createdAt: now as never,
                  },
                }
              : {
                  eventId,
                  type: "TicketMessagePosted",
                  ticketId: input.ticketId,
                  occurredAt: now as never,
                  payload: {
                    messageId,
                    stepRunId: StepRunId.make(stepRunId),
                    author: "agent",
                    body: note,
                    attachments: [],
                    createdAt: now as never,
                  },
                },
          );
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("ticket-artifact finalizer: skip note not posted", {
              cause,
              ticketId: input.ticketId,
            }),
          ),
        );
      }
      return { ok: true };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("ticket-artifact ingestion failed persistently", {
          cause,
          stepRunId: input.stepRunId,
          ticketId: input.ticketId,
        }).pipe(Effect.as({ ok: false })),
      ),
    );

  return { finalizeStep } satisfies TicketArtifactFinalizerShape;
});

export const TicketArtifactFinalizerLive = Layer.effect(TicketArtifactFinalizer, make);

/**
 * Resolve-WITHOUT-create worktree lookup (the finalizer must never create a
 * worktree the way WorktreePort.ensureWorktree would). Mirrors the resolve
 * half of WorktreePortLive; every failure degrades to null (no worktree =
 * silent no-op — evidence, not a gate).
 */
export const TicketWorktreeLocatorLive = Layer.effect(
  TicketWorktreeLocator,
  Effect.gen(function* () {
    const git = yield* GitWorkflowService;
    const sql = yield* SqlClient.SqlClient;

    const locate = (ticketId: TicketId): Effect.Effect<{ readonly path: string } | null> =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly repoRoot: string | null }>`
          SELECT projects.workspace_root AS "repoRoot"
          FROM projection_ticket AS ticket
          INNER JOIN projection_board AS board ON board.board_id = ticket.board_id
          INNER JOIN projection_projects AS projects ON projects.project_id = board.project_id
          WHERE ticket.ticket_id = ${ticketId as string}
          LIMIT 1
        `;
        const repoRoot = rows[0]?.repoRoot;
        if (repoRoot === null || repoRoot === undefined) return null;
        const refs = yield* git.listRefs({ cwd: TrimmedNonEmptyString.make(repoRoot) });
        const worktreeRef = `workflow/${ticketId as string}`;
        const existing = refs.refs.find((ref) => !ref.isRemote && ref.name === worktreeRef);
        return existing?.worktreePath ? { path: existing.worktreePath } : null;
      }).pipe(Effect.orElseSucceed(() => null));

    return { locate };
  }),
);
