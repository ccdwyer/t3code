import type { BoardId, ForkChildKey, StepRunId, TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";
import type { BranchOutcome, JoinResult } from "../forkJoin.ts";

export interface ForkChildRecord {
  readonly childKey: string;
  readonly ticketId: TicketId;
  readonly laneKey: string;
  readonly titleSnapshot: string;
  readonly settledOutcome: BranchOutcome | null;
}

export interface ForkRecord {
  readonly stepRunId: StepRunId;
  readonly parentTicketId: TicketId;
  readonly boardId: BoardId;
  readonly stepKey: string;
  readonly joinRequire: number;
  readonly onBranchFailure: "failFast" | "waitImpossible";
  readonly resolvedAt: string | null;
  readonly resolution: "success" | "failure" | "cancelled" | null;
  readonly children: ReadonlyArray<ForkChildRecord>;
}

export interface ForkJoinCoordinatorShape {
  readonly recordSpawn: (input: {
    readonly stepRunId: StepRunId;
    readonly parentTicketId: TicketId;
    /** Lineage root (propagated through nested forks); defaults to parent if omitted. */
    readonly rootTicketId?: TicketId;
    readonly boardId: BoardId;
    readonly stepKey: string;
    readonly joinRequire: number;
    readonly onBranchFailure: "failFast" | "waitImpossible";
    readonly spawnSeq: number;
    readonly children: ReadonlyArray<{
      readonly childKey: ForkChildKey | string;
      readonly ticketId: TicketId;
      readonly laneKey: string;
      readonly title: string;
    }>;
  }) => Effect.Effect<void, WorkflowEventStoreError>;

  readonly settleChild: (input: {
    readonly childTicketId: TicketId;
    readonly outcome: "success" | "failure" | "cancelled";
  }) => Effect.Effect<
    | { readonly status: "unknown_child" }
    | { readonly status: "already_settled"; readonly fork: ForkRecord }
    | {
        readonly status: "waiting";
        readonly fork: ForkRecord;
        readonly join: JoinResult;
      }
    | {
        readonly status: "resolved";
        readonly fork: ForkRecord;
        readonly join: JoinResult;
      },
    WorkflowEventStoreError
  >;

  readonly getForkByStepRunId: (
    stepRunId: StepRunId,
  ) => Effect.Effect<ForkRecord | null, WorkflowEventStoreError>;

  readonly getUnresolvedForkForParent: (
    parentTicketId: TicketId,
  ) => Effect.Effect<ForkRecord | null, WorkflowEventStoreError>;

  readonly getForkForChild: (
    childTicketId: TicketId,
  ) => Effect.Effect<ForkRecord | null, WorkflowEventStoreError>;
}

export class ForkJoinCoordinator extends Context.Service<
  ForkJoinCoordinator,
  ForkJoinCoordinatorShape
>()("t3/workflow/Services/ForkJoinCoordinator") {}
