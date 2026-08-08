import type { TicketId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface TicketSourceContextMaterializerInput {
  readonly ticketId: TicketId;
  readonly worktreePath: string;
}

export interface TicketSourceContextMaterializerShape {
  /**
   * Materialize any integration-owned source context for the ticket into its
   * worktree scratch tree and return the required short provider pointer.
   * Ordinary tickets return null.
   */
  readonly materialize: (
    input: TicketSourceContextMaterializerInput,
  ) => Effect.Effect<string | null, WorkflowEventStoreError>;
}

export class TicketSourceContextMaterializer extends Context.Service<
  TicketSourceContextMaterializer,
  TicketSourceContextMaterializerShape
>()("t3/workflow/Services/TicketSourceContextMaterializer") {}
