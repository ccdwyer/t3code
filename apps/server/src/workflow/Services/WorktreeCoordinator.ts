import type { BoardId, TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";
import type { OverlapDecision } from "../worktreeOverlap.ts";

export type ParallelismHoldKind = "serialize";

export interface OverlapGateResult {
  readonly decision: OverlapDecision;
  readonly withTicketId: TicketId | null;
  readonly hold?: {
    readonly kind: ParallelismHoldKind;
    readonly blockedByTicketId: TicketId;
  };
}

export interface WorktreeCoordinatorShape {
  readonly upsertRegistry: (input: {
    readonly ticketId: TicketId;
    readonly repoRoot: string;
    readonly branch: string;
  }) => Effect.Effect<void, WorkflowEventStoreError>;

  readonly replaceChangedPaths: (input: {
    readonly ticketId: TicketId;
    readonly sourceRef: string;
    readonly paths: ReadonlyArray<string>;
  }) => Effect.Effect<void, WorkflowEventStoreError>;

  /** Early/post overlap gate for conflictPolicy warn|serialize. */
  readonly evaluateOverlapGate: (input: {
    readonly ticketId: TicketId;
    readonly boardId: BoardId;
    readonly policy: "warn" | "serialize";
    readonly ignorePaths: ReadonlyArray<string>;
    readonly laneKey: string;
    readonly laneEntryToken: string;
    readonly pipelineRunId: string;
    readonly stepRunId: string;
  }) => Effect.Effect<OverlapGateResult, WorkflowEventStoreError>;

  readonly hasActiveHold: (ticketId: TicketId) => Effect.Effect<boolean, WorkflowEventStoreError>;

  /** Mark an active hold released (operator / Phase B auto-release). */
  readonly releaseHold: (ticketId: TicketId) => Effect.Effect<void, WorkflowEventStoreError>;

  /** Auto-release every active hold blocked by this ticket (blocker terminal). */
  readonly releaseHoldsBlockedBy: (
    blockerTicketId: TicketId,
  ) => Effect.Effect<number, WorkflowEventStoreError>;
}

export class WorktreeCoordinator extends Context.Service<
  WorktreeCoordinator,
  WorktreeCoordinatorShape
>()("t3/workflow/Services/WorktreeCoordinator") {}
