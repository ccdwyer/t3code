/**
 * WorkSourceConnectionStore — Layer implementation.
 *
 * Persists connection metadata to the `work_source_connection` SQLite table
 * and stores the PAT bytes in `ServerSecretStore` under
 * `work-source-token:<connectionRef>`.
 *
 * getToken: SELECT row → secrets.get(token_secret_name) → TextDecoder.
 *   Missing row or missing secret → WorkSourceAuthError.
 *
 * create: generate connectionRef via WorkflowIds.eventId() (produces a
 *   prefixed uuid, e.g. "evt-<uuid>"), derive token_secret_name, store
 *   secret bytes, INSERT row, return view (no token).
 *
 * list: SELECT all rows, map to WorkSourceConnectionView (no token).
 *
 * remove: secrets.remove(token_secret_name) + DELETE row.
 *   v1 does NOT check for boards still referencing the connectionRef —
 *   a dangling ref will cause WorkSourceAuthError at sync time, which
 *   the syncer handles gracefully (exponential backoff per source).
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { WorkSourceConnectionView } from "@t3tools/contracts/workSource";
import type { WorkSourceProviderName } from "@t3tools/contracts/workSource";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { WorkSourceAuthError } from "../Services/WorkSourceProvider.ts";
import {
  WorkSourceConnectionStore,
  WorkSourceConnectionStoreError,
  type WorkSourceConnectionStoreShape,
} from "../Services/WorkSourceConnectionStore.ts";

interface ConnectionRow {
  readonly connection_ref: string;
  readonly provider: string;
  readonly display_name: string;
  readonly auth_mode: string;
  readonly token_secret_name: string;
  readonly created_at: string;
}

const toWorkSourceConnectionStoreError = (message: string) => (cause: unknown) =>
  new WorkSourceConnectionStoreError({ message, cause });

const toView = (row: ConnectionRow): WorkSourceConnectionView => ({
  connectionRef: row.connection_ref as never,
  provider: row.provider as WorkSourceProviderName,
  displayName: row.display_name as never,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const ids = yield* WorkflowIds;

  const getToken: WorkSourceConnectionStoreShape["getToken"] = (connectionRef, expectedProvider) =>
    Effect.gen(function* () {
      // Provider-bound: only return a token when BOTH the ref AND the provider
      // match. A row found under a different provider must not satisfy the
      // request (else a source could use the wrong provider's credential).
      const rows = yield* sql<ConnectionRow>`
        SELECT connection_ref, provider, display_name, auth_mode, token_secret_name, created_at
        FROM work_source_connection
        WHERE connection_ref = ${connectionRef} AND provider = ${expectedProvider}
      `.pipe(
        Effect.mapError(
          (cause) => new WorkSourceAuthError({ connectionRef, cause } as never),
        ),
      );

      const row = rows[0];
      if (row === undefined) {
        return yield* new WorkSourceAuthError({ connectionRef });
      }

      const bytes = yield* secretStore
        .get(row.token_secret_name)
        .pipe(Effect.mapError((cause) => new WorkSourceAuthError({ connectionRef, cause } as never)));

      if (bytes === null) {
        return yield* new WorkSourceAuthError({ connectionRef });
      }

      return new TextDecoder().decode(bytes);
    }).pipe(Effect.withSpan("WorkSourceConnectionStore.getToken"));

  const create: WorkSourceConnectionStoreShape["create"] = (input) =>
    Effect.gen(function* () {
      const connectionRef = yield* ids.eventId().pipe(
        Effect.map((id) => `conn-${id}`),
      );
      const tokenSecretName = `work-source-token:${connectionRef}`;
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);

      // INSERT the row BEFORE storing the secret. If the INSERT fails we leave
      // no orphaned, unreachable secret behind. The reverse failure mode (row
      // exists, secret missing) is graceful: getToken fails with
      // WorkSourceAuthError and remove can still clean up the row.
      yield* sql`
        INSERT INTO work_source_connection (
          connection_ref,
          provider,
          display_name,
          auth_mode,
          token_secret_name,
          created_at
        ) VALUES (
          ${connectionRef},
          ${input.provider},
          ${input.displayName},
          ${"pat"},
          ${tokenSecretName},
          ${createdAt}
        )
      `.pipe(
        Effect.mapError(
          toWorkSourceConnectionStoreError("Failed to insert work source connection"),
        ),
      );

      yield* secretStore
        .set(tokenSecretName, new TextEncoder().encode(input.token))
        .pipe(
          Effect.mapError(
            toWorkSourceConnectionStoreError("Failed to store connection token"),
          ),
        );

      return {
        connectionRef: connectionRef as never,
        provider: input.provider,
        displayName: input.displayName as never,
      } satisfies WorkSourceConnectionView;
    }).pipe(Effect.withSpan("WorkSourceConnectionStore.create"));

  const list: WorkSourceConnectionStoreShape["list"] = () =>
    sql<ConnectionRow>`
      SELECT connection_ref, provider, display_name, auth_mode, token_secret_name, created_at
      FROM work_source_connection
      ORDER BY created_at ASC
    `.pipe(
      Effect.map((rows) => rows.map(toView)),
      Effect.mapError(
        toWorkSourceConnectionStoreError("Failed to list work source connections"),
      ),
      Effect.withSpan("WorkSourceConnectionStore.list"),
    );

  const remove: WorkSourceConnectionStoreShape["remove"] = (connectionRef) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly token_secret_name: string }>`
        SELECT token_secret_name FROM work_source_connection WHERE connection_ref = ${connectionRef}
      `.pipe(
        Effect.mapError(
          toWorkSourceConnectionStoreError("Failed to look up connection for removal"),
        ),
      );

      const row = rows[0];
      if (row !== undefined) {
        yield* secretStore.remove(row.token_secret_name).pipe(
          Effect.mapError(
            toWorkSourceConnectionStoreError("Failed to remove connection token secret"),
          ),
        );
      }

      yield* sql`
        DELETE FROM work_source_connection WHERE connection_ref = ${connectionRef}
      `.pipe(
        Effect.mapError(
          toWorkSourceConnectionStoreError("Failed to delete work source connection row"),
        ),
      );
    }).pipe(Effect.withSpan("WorkSourceConnectionStore.remove"));

  return {
    getToken,
    create,
    list,
    remove,
  } satisfies WorkSourceConnectionStoreShape;
});

export const WorkSourceConnectionStoreLive = Layer.effect(WorkSourceConnectionStore, make);
