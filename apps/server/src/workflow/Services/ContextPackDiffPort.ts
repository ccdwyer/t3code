import type { TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ContextPackDiffFile } from "../contextPack.ts";
import type { WorkflowEventStoreError } from "./Errors.ts";

export interface ContextPackDiffStat {
  readonly files: ReadonlyArray<ContextPackDiffFile>;
  /** True when a cap bound, so the rendered count reads "N+" rather than "N". */
  readonly partial: boolean;
}

export interface ContextPackDiffPortShape {
  /**
   * File-level stat of a ticket worktree against its base ref, for context-pack
   * compilation.
   *
   * Lookup-only and null-returning: a ticket with no attached worktree yields
   * `null`, not an error, because the pack simply omits the section. This is a
   * separate port rather than a promotion of the RPC handlers' local
   * `TicketWorktreeResolverShape` because the engine needs a failure type it can
   * handle and an absent worktree must not surface as a typed RPC error.
   *
   * Distinct from `TicketDiffQuery.getTicketDiff`, which produces a full 120k
   * patch — far more than a pack can carry.
   */
  readonly statTicketDiff: (
    ticketId: TicketId,
  ) => Effect.Effect<ContextPackDiffStat | null, WorkflowEventStoreError>;
}

export class ContextPackDiffPort extends Context.Service<
  ContextPackDiffPort,
  ContextPackDiffPortShape
>()("t3/workflow/Services/ContextPackDiffPort") {}
