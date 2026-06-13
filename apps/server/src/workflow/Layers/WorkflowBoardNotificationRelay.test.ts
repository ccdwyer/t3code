// @effect-diagnostics globalFetch:off - test harness installs a stable fetch dispatcher to defeat FetchHttpClient.Fetch memoization across cases.
// @effect-diagnostics nodeBuiltinImport:off - test seeds a deterministic Ed25519 key pair so the published proof JWT can be verified.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import type { RelayBoardTicketState } from "@t3tools/contracts/relay";
import { RELAY_BOARD_TICKET_PUBLISH_TYP } from "@t3tools/contracts/relay";
import { normalizeRelayIssuer, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../../cloud/config.ts";
import { ServerEnvironment } from "../../environment/Services/ServerEnvironment.ts";
import { WorkflowBoardNotificationRelay } from "../Services/WorkflowBoardNotificationRelay.ts";
import { WorkflowBoardNotificationRelayLive } from "./WorkflowBoardNotificationRelay.ts";

const environmentId = "env-1" as EnvironmentId;
const boardId = "board-1";
const ticketId = "ticket-1";

const state: RelayBoardTicketState = {
  environmentId,
  boardId,
  ticketId,
  attentionKind: "waiting_for_approval",
  title: "Needs approval",
  body: "The agent is waiting for your approval.",
  deepLink: "/boards/env-1/board-1/ticket-1",
  transitionId: "transition-1",
};

// Deterministic environment signing key pair. Seeding it into the secret store
// under the same name getOrCreateEnvironmentKeyPairFromSecretStore reads means the
// layer signs with this private key, so the test can verify the proof with the
// matching public key.
const ENVIRONMENT_KEY_PAIR_SECRET = "cloud-link-ed25519-key-pair";
const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const testIssuer = "https://issuer.example.test";

const descriptor = {
  environmentId,
  label: "Test Desktop",
  platform: {
    os: "darwin",
    arch: "arm64",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
} satisfies ExecutionEnvironmentDescriptor;

const encodeSecret = (value: string): Uint8Array => new TextEncoder().encode(value);

function makeMemorySecretStore() {
  const values = new Map<string, Uint8Array>();
  const store = {
    get: ((name) =>
      Effect.sync(
        () => values.get(name) ?? null,
      )) satisfies ServerSecretStore.ServerSecretStoreShape["get"],
    set: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStoreShape["set"],
    create: ((name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      })) satisfies ServerSecretStore.ServerSecretStoreShape["create"],
    getOrCreateRandom: ((name, bytes) =>
      Effect.sync(() => {
        const existing = values.get(name);
        if (existing) {
          return existing;
        }
        const generated = new Uint8Array(bytes);
        values.set(name, generated);
        return generated;
      })) satisfies ServerSecretStore.ServerSecretStoreShape["getOrCreateRandom"],
    remove: ((name) =>
      Effect.sync(() => {
        values.delete(name);
      })) satisfies ServerSecretStore.ServerSecretStoreShape["remove"],
  } satisfies ServerSecretStore.ServerSecretStoreShape;
  return {
    store,
    setString: (name: string, value: string) => store.set(name, encodeSecret(value)),
  };
}

// effect's FetchHttpClient.Fetch is a Context.Reference whose default
// (`globalThis.fetch`) is read and memoized on first use, which would otherwise
// pin every test in this process to whichever fetch stub ran first. We install a
// single stable dispatcher into `globalThis.fetch` that delegates to a mutable
// per-test handler, so each test's override stays live regardless of memoization.
type FetchFn = typeof globalThis.fetch;
const realFetch = globalThis.fetch;
let currentFetch: FetchFn = realFetch;
globalThis.fetch = ((...args: Parameters<FetchFn>) =>
  currentFetch(...args)) as unknown as FetchFn;

function useFetch(handler: FetchFn): Effect.Effect<void, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => {
      currentFetch = handler;
    }),
    () =>
      Effect.sync(() => {
        currentFetch = realFetch;
      }),
  ).pipe(Effect.asVoid);
}

function makeLayer(secrets: ReturnType<typeof makeMemorySecretStore>) {
  return WorkflowBoardNotificationRelayLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store),
        Layer.succeed(ServerEnvironment, {
          getEnvironmentId: Effect.succeed(environmentId),
          getDescriptor: Effect.succeed(descriptor),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe.sequential("WorkflowBoardNotificationRelay", () => {
  it.effect("signs a board-ticket proof and publishes it to the relay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const runFork = Effect.runForkWith(context);
        const requestSeen = yield* Deferred.make<{
          readonly url: URL;
          readonly body: unknown;
        }>();
        const secrets = makeMemorySecretStore();

        yield* useFetch(((
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          const readBody = async (): Promise<unknown> => {
            if (input instanceof Request) {
              const text = await input.clone().text();
              return text ? JSON.parse(text) : null;
            }
            const rawBody = init?.body;
            if (typeof rawBody === "string") {
              return JSON.parse(rawBody);
            }
            if (rawBody instanceof Uint8Array || rawBody instanceof ArrayBuffer) {
              const text = new TextDecoder().decode(rawBody);
              return text ? JSON.parse(text) : null;
            }
            return null;
          };
          runFork(
            Effect.promise(readBody).pipe(
              Effect.flatMap((body) => Deferred.succeed(requestSeen, { url, body })),
            ),
          );
          return Promise.resolve(Response.json({ ok: true, deliveries: [] }));
        }) as unknown as typeof fetch);

        yield* secrets.setString(
          ENVIRONMENT_KEY_PAIR_SECRET,
          // @effect-diagnostics-next-line preferSchemaOverJson:off - mirrors the on-disk JSON envelope getOrCreateEnvironmentKeyPairFromSecretStore decodes.
          JSON.stringify({ privateKey: keyPair.privateKey, publicKey: keyPair.publicKey }),
        );

        yield* Effect.gen(function* () {
          yield* secrets.setString(RELAY_URL_SECRET, "https://transport.example.test");
          yield* secrets.setString(RELAY_ISSUER_SECRET, testIssuer);
          yield* secrets.setString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "relay-credential");

          const relay = yield* WorkflowBoardNotificationRelay;
          yield* relay.publishTicket({ environmentId, boardId, ticketId, state });

          const seen = yield* Deferred.await(requestSeen).pipe(Effect.timeout("2 seconds"));
          expect(seen.url.origin).toBe("https://transport.example.test");
          expect(seen.url.pathname).toBe(
            `/v1/environments/${environmentId}/tickets/${ticketId}/board-activity`,
          );
          const body = seen.body as { readonly state: unknown; readonly proof: unknown };
          expect(body.state).toMatchObject({ ticketId, boardId, attentionKind: "waiting_for_approval" });
          expect(typeof body.proof).toBe("string");
          expect((body.proof as string).length).toBeGreaterThan(0);

          // Decode and verify the proof JWT the way the relay side (Task 10) will,
          // asserting every signed claim — not just that a non-empty proof exists.
          // it.effect runs under a TestClock anchored at epoch 0, so the proof's
          // iat/exp are 0/300. Verify at a point inside that window.
          const verified = yield* verifyRelayJwt({
            publicKey: keyPair.publicKey,
            token: body.proof as string,
            typ: RELAY_BOARD_TICKET_PUBLISH_TYP,
            issuer: `t3-env:${environmentId}`,
            audience: normalizeRelayIssuer(testIssuer),
            nowEpochSeconds: 150,
          });
          expect(verified.iss).toBe(`t3-env:${environmentId}`);
          expect(verified.sub).toBe(environmentId);
          expect(verified.aud).toBe(normalizeRelayIssuer(testIssuer));
          expect((verified as { environmentId?: unknown }).environmentId).toBe(environmentId);
          expect((verified as { boardId?: unknown }).boardId).toBe(boardId);
          expect((verified as { ticketId?: unknown }).ticketId).toBe(ticketId);
          expect((verified as { state?: unknown }).state).toEqual(state);
          expect(typeof verified.iat).toBe("number");
          expect(typeof verified.exp).toBe("number");
          expect((verified.exp as number) > (verified.iat as number)).toBe(true);
        }).pipe(Effect.provide(makeLayer(secrets)));
      }),
    ),
  );

  it.effect("is a no-op success when relay config is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secrets = makeMemorySecretStore();
        let fetchCalls = 0;

        yield* useFetch((() => {
          fetchCalls += 1;
          return Promise.resolve(Response.json({ ok: true, deliveries: [] }));
        }) as unknown as typeof fetch);

        yield* Effect.gen(function* () {
          const relay = yield* WorkflowBoardNotificationRelay;
          yield* relay.publishTicket({ environmentId, boardId, ticketId, state });
        }).pipe(Effect.provide(makeLayer(secrets)));

        expect(fetchCalls).toBe(0);
      }),
    ),
  );

  it.effect("fails (not standby success) when reading relay config secrets errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Seed the env key pair so the layer build succeeds, but make get() for
        // the relay config secrets FAIL — a real secret-store read error must
        // propagate as a failure, not be swallowed into a standby no-op success
        // (which would let the dispatcher mark the row sent and drop the buzz).
        const backing = makeMemorySecretStore();
        yield* backing.setString(
          ENVIRONMENT_KEY_PAIR_SECRET,
          // @effect-diagnostics-next-line preferSchemaOverJson:off - mirrors the on-disk JSON envelope getOrCreateEnvironmentKeyPairFromSecretStore decodes.
          JSON.stringify({ privateKey: keyPair.privateKey, publicKey: keyPair.publicKey }),
        );
        const RELAY_CONFIG_SECRETS = new Set([
          RELAY_URL_SECRET,
          RELAY_ISSUER_SECRET,
          RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
        ]);
        let fetchCalls = 0;
        yield* useFetch((() => {
          fetchCalls += 1;
          return Promise.resolve(Response.json({ ok: true, deliveries: [] }));
        }) as unknown as typeof fetch);

        const failingStore: ServerSecretStore.ServerSecretStoreShape = {
          ...backing.store,
          get: ((name) =>
            RELAY_CONFIG_SECRETS.has(name)
              ? Effect.fail(
                  new ServerSecretStore.SecretStoreError({
                    message: `boom reading ${name}`,
                  }),
                )
              : backing.store.get(
                  name,
                )) satisfies ServerSecretStore.ServerSecretStoreShape["get"],
        };
        const failingLayer = WorkflowBoardNotificationRelayLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ServerSecretStore.ServerSecretStore, failingStore),
              Layer.succeed(ServerEnvironment, {
                getEnvironmentId: Effect.succeed(environmentId),
                getDescriptor: Effect.succeed(descriptor),
              }),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        );

        const exit = yield* Effect.gen(function* () {
          const relay = yield* WorkflowBoardNotificationRelay;
          return yield* relay
            .publishTicket({ environmentId, boardId, ticketId, state })
            .pipe(Effect.exit);
        }).pipe(Effect.provide(failingLayer));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect((error as { _tag?: string })._tag).toBe("WorkflowEventStoreError");
        }
        expect(fetchCalls).toBe(0);
      }),
    ),
  );

  it.effect("fails with WorkflowEventStoreError when the relay HTTP call fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secrets = makeMemorySecretStore();

        yield* useFetch((() =>
          Promise.reject(new Error("upstream boom"))) as unknown as typeof fetch);

        const exit = yield* Effect.gen(function* () {
          yield* secrets.setString(RELAY_URL_SECRET, "https://transport.example.test");
          yield* secrets.setString(RELAY_ISSUER_SECRET, "https://issuer.example.test");
          yield* secrets.setString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "relay-credential");

          const relay = yield* WorkflowBoardNotificationRelay;
          return yield* relay.publishTicket({ environmentId, boardId, ticketId, state }).pipe(
            Effect.exit,
          );
        }).pipe(Effect.provide(makeLayer(secrets)));

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          expect((error as { _tag?: string })._tag).toBe("WorkflowEventStoreError");
        }
      }),
    ),
  );
});
