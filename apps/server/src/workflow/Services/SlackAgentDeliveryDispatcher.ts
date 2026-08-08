import * as Context from "effect/Context";
import type { SlackAgentDeliveryView } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { SqlError } from "effect/unstable/sql/SqlError";

export interface SlackAgentDeliveryDispatcherShape {
  readonly sweep: () => Effect.Effect<void>;
  readonly recoverStaleClaims: () => Effect.Effect<void>;
  readonly retryDelivery: (
    deliveryId: string,
  ) => Effect.Effect<SlackAgentDeliveryView | null, SqlError>;
  readonly subscribeRunChanges: (
    runId: string,
  ) => Effect.Effect<Stream.Stream<SlackAgentDeliveryView>, never, Scope.Scope>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class SlackAgentDeliveryDispatcher extends Context.Service<
  SlackAgentDeliveryDispatcher,
  SlackAgentDeliveryDispatcherShape
>()("t3/workflow/Services/SlackAgentDeliveryDispatcher") {}
