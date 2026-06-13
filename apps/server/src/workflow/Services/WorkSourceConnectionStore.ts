import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import type { WorkSourceConnectionView } from "@t3tools/contracts/workSource";
import type { WorkSourceProviderName } from "@t3tools/contracts/workSource";
import type { WorkSourceAuthError } from "./WorkSourceProvider.ts";

export class WorkSourceConnectionStoreError extends Data.TaggedError(
  "WorkSourceConnectionStoreError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface WorkSourceConnectionStoreShape {
  /** Retrieve the PAT for an existing connection. Fails with WorkSourceAuthError
   * when no row matches the connectionRef OR when the row's provider does not
   * equal `expectedProvider` (a source must not use another provider's token). */
  readonly getToken: (
    connectionRef: string,
    expectedProvider: WorkSourceProviderName,
  ) => Effect.Effect<string, WorkSourceAuthError>;

  /** Create a new connection, storing the PAT in the secret store. */
  readonly create: (input: {
    readonly provider: WorkSourceProviderName;
    readonly displayName: string;
    readonly token: string;
  }) => Effect.Effect<WorkSourceConnectionView, WorkSourceConnectionStoreError>;

  /** List all connections (no token in the view). */
  readonly list: () => Effect.Effect<
    ReadonlyArray<WorkSourceConnectionView>,
    WorkSourceConnectionStoreError
  >;

  /** Remove a connection + delete the stored secret.
   *
   * v1 note: does NOT check for boards still referencing this connectionRef.
   * A dangling connectionRef in a board source will surface as a WorkSourceAuthError
   * at sync time (getToken fails → provider backs off). The syncer handles this
   * gracefully — that source enters backoff and no tickets are affected.
   */
  readonly remove: (connectionRef: string) => Effect.Effect<void, WorkSourceConnectionStoreError>;
}

export class WorkSourceConnectionStore extends Context.Service<
  WorkSourceConnectionStore,
  WorkSourceConnectionStoreShape
>()("t3/workflow/Services/WorkSourceConnectionStore") {}
