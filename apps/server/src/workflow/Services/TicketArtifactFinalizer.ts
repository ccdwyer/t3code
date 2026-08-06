import type { TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

/**
 * The artifact-ingestion finalizer — spec §Ingestion trigger (v2.5).
 *
 * Invariant: agent turn stopped → ingest drained → only then may scratch
 * cleanup, worktree removal, or the next lifecycle action proceed. The engine
 * runs it via Effect.ensuring around every step run (covering completed,
 * failed, blocked, AND interrupted/cancelled — a park/manual-move interrupt
 * awaits the finalizer because interruption awaits ensuring finalizers), and
 * the merge/PR services call it explicitly BEFORE cleanupTicketScratch.
 *
 * `finalizeStep` NEVER fails and never blocks the lifecycle: per-file
 * problems are skips inside the store's IngestReport; batch-level failures
 * retry 3× with backoff and then log loudly (artifacts are evidence, not
 * gates). The returned flag lets the merge/PR last-chance call sites surface
 * a step-level warning for the documented merge-time residual.
 */
export interface TicketArtifactFinalizeResult {
  /** False when ingestion persistently failed (last-chance callers warn). */
  readonly ok: boolean;
}

export interface TicketArtifactFinalizerShape {
  readonly finalizeStep: (input: {
    readonly ticketId: TicketId;
    readonly stepRunId?: string | undefined;
  }) => Effect.Effect<TicketArtifactFinalizeResult>;
}

export class TicketArtifactFinalizer extends Context.Service<
  TicketArtifactFinalizer,
  TicketArtifactFinalizerShape
>()("t3/workflow/Services/TicketArtifactFinalizer") {}

/**
 * Resolve-without-create worktree lookup: the finalizer must never CREATE a
 * worktree (WorktreePort.ensureWorktree would), only observe an existing one.
 * Null = the ticket has no attached worktree = silent no-op.
 */
export interface TicketWorktreeLocatorShape {
  /** Null = genuinely no worktree (silent no-op); failures MUST surface. */
  readonly locate: (
    ticketId: TicketId,
  ) => Effect.Effect<{ readonly path: string } | null, WorkflowEventStoreError>;
}

export class TicketWorktreeLocator extends Context.Service<
  TicketWorktreeLocator,
  TicketWorktreeLocatorShape
>()("t3/workflow/Services/TicketArtifactFinalizer/TicketWorktreeLocator") {}
