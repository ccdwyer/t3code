import {
  type SlackAgentInstanceId,
  type SlackAgentInstanceKind,
  type SlackAgentInstanceView,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { SlackAgentInstanceStore } from "../../workflow/Services/SlackAgentInstanceStore.ts";
import { SlackApi, type SlackSocketEnvelope, type SlackSocketState } from "../Services/SlackApi.ts";
import {
  SlackConnectionManager,
  SlackConnectionManagerMissingCredentialsError,
  SlackConnectionManagerUnknownInstanceError,
  SlackConnectionManagerValidationMismatchError,
  SlackConnectionManagerWrongKindError,
  type SlackConnectionManagerError,
  type SlackConnectionManagerShape,
} from "../Services/SlackConnectionManager.ts";
import { SlackEventProcessor } from "../Services/SlackEventProcessor.ts";

interface ActiveConnection {
  readonly scope: Scope.Scope;
  readonly generation: number;
}

const tokenRedactionPatterns = [
  /\bxox[baprs]-[A-Za-z0-9-]+/gu,
  /\bxapp-[A-Za-z0-9-]+/gu,
  /authorization\s*:\s*bearer\s+[^\s,)}\]]+/giu,
];

const redact = (value: unknown): string => {
  const source =
    typeof value === "object" && value !== null && "message" in value
      ? String(value.message)
      : String(value);
  const redacted = tokenRedactionPatterns.reduce(
    (current, pattern) => current.replace(pattern, "[redacted]"),
    source,
  );
  return redacted.length <= 500 ? redacted : `${redacted.slice(0, 497)}...`;
};

const isSlackKind = (kind: SlackAgentInstanceKind) => kind === "slack";

const make = Effect.gen(function* () {
  const api = yield* SlackApi;
  const processor = yield* SlackEventProcessor;
  const instances = yield* SlackAgentInstanceStore;
  const activeConnections = yield* SynchronizedRef.make<Map<string, ActiveConnection>>(new Map());
  const connectionGenerations = yield* SynchronizedRef.make<Map<string, number>>(new Map());
  const operationLocks = yield* SynchronizedRef.make<Map<string, Semaphore.Semaphore>>(new Map());
  const workflowAuthorized = yield* Ref.make(false);

  const ensureLock = (instanceId: SlackAgentInstanceId) =>
    SynchronizedRef.modifyEffect(operationLocks, (current) => {
      const existing = current.get(String(instanceId));
      if (existing !== undefined) return Effect.succeed([existing, current] as const);
      return Semaphore.make(1).pipe(
        Effect.map((lock) => {
          const next = new Map(current);
          next.set(String(instanceId), lock);
          return [lock, next] as const;
        }),
      );
    });

  const withInstanceLock = <A, E, R>(
    instanceId: SlackAgentInstanceId,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const lock = yield* ensureLock(instanceId);
      return yield* lock.withPermits(1)(effect);
    });

  const updateConnectionState = (
    instanceId: SlackAgentInstanceId,
    input: Parameters<typeof instances.updateConnectionState>[1],
  ) => instances.updateConnectionState(instanceId, input).pipe(Effect.asVoid, Effect.ignore);

  const syncSocketState = (instanceId: SlackAgentInstanceId, state: SlackSocketState) =>
    Effect.gen(function* () {
      switch (state.type) {
        case "connecting":
          yield* updateConnectionState(instanceId, {
            state: "connecting",
            lastError: null,
          });
          return;
        case "connected":
          yield* updateConnectionState(instanceId, {
            state: "connected",
            connectedAt: DateTime.formatIso(yield* DateTime.now),
            lastError: null,
          });
          return;
        case "closed":
          yield* updateConnectionState(instanceId, {
            state: "disconnected",
            connectedAt: null,
            lastError: null,
          });
          return;
        case "disconnect":
          yield* updateConnectionState(instanceId, {
            state: "disconnected",
            connectedAt: null,
            lastError: state.reason === undefined ? null : redact(state.reason),
          });
          return;
        case "error":
          yield* updateConnectionState(instanceId, {
            state: "error",
            connectedAt: null,
            lastError: redact(state.error),
          });
      }
    });

  const readInstance = (instanceId: SlackAgentInstanceId) =>
    instances.get(instanceId).pipe(
      Effect.flatMap((instance) =>
        instance === null
          ? new SlackConnectionManagerUnknownInstanceError({
              instanceId: String(instanceId),
              message: `Slack instance not found: ${instanceId}`,
            })
          : Effect.succeed(instance),
      ),
    );

  const isActiveGeneration = (instanceId: SlackAgentInstanceId, generation: number) =>
    SynchronizedRef.get(activeConnections).pipe(
      Effect.map((connections) => connections.get(String(instanceId))?.generation === generation),
    );

  const clearMatchingActiveConnection = (instanceId: SlackAgentInstanceId, generation: number) =>
    SynchronizedRef.modify(activeConnections, (current) => {
      const existing = current.get(String(instanceId));
      if (existing === undefined || existing.generation !== generation) return [undefined, current];
      const next = new Map(current);
      next.delete(String(instanceId));
      return [existing, next];
    });

  const upsertActiveConnection = (instanceId: SlackAgentInstanceId, scope: Scope.Scope) =>
    Effect.gen(function* () {
      const nextGeneration = yield* SynchronizedRef.modify(connectionGenerations, (current) => {
        const nextValue = (current.get(String(instanceId)) ?? 0) + 1;
        const next = new Map(current);
        next.set(String(instanceId), nextValue);
        return [nextValue, next] as const;
      });
      yield* SynchronizedRef.update(activeConnections, (current) => {
        const next = new Map(current);
        next.set(String(instanceId), { scope, generation: nextGeneration });
        return next;
      });
      return nextGeneration;
    });

  const clearActiveConnection = (instanceId: SlackAgentInstanceId) =>
    SynchronizedRef.modify(activeConnections, (current) => {
      const existing = current.get(String(instanceId));
      if (existing === undefined) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(String(instanceId));
      return [existing, next] as const;
    });

  const closeActiveConnection = (instanceId: SlackAgentInstanceId) =>
    Effect.gen(function* () {
      const active = yield* clearActiveConnection(instanceId);
      if (active !== undefined) {
        yield* Scope.close(active.scope, Exit.void).pipe(Effect.ignore);
      }
    });

  const validateIdentity = (
    instance: SlackAgentInstanceView,
    validation: {
      readonly workspaceId: string;
      readonly botUserId: string;
      readonly appId?: string | undefined;
    },
  ): Effect.Effect<void, SlackConnectionManagerValidationMismatchError> => {
    if (instance.workspace.workspaceId !== validation.workspaceId) {
      return new SlackConnectionManagerValidationMismatchError({
        instanceId: String(instance.instanceId),
        field: "workspace",
        expected: instance.workspace.workspaceId,
        actual: validation.workspaceId,
        message: `Slack workspace mismatch for ${instance.instanceId}`,
      });
    }
    if (String(instance.botUserId) !== validation.botUserId) {
      return new SlackConnectionManagerValidationMismatchError({
        instanceId: String(instance.instanceId),
        field: "botUser",
        expected: String(instance.botUserId),
        actual: validation.botUserId,
        message: `Slack bot user mismatch for ${instance.instanceId}`,
      });
    }
    if (
      instance.appId !== undefined &&
      validation.appId !== undefined &&
      instance.appId !== validation.appId
    ) {
      return new SlackConnectionManagerValidationMismatchError({
        instanceId: String(instance.instanceId),
        field: "app",
        expected: instance.appId,
        actual: validation.appId,
        message: `Slack app mismatch for ${instance.instanceId}`,
      });
    }
    return Effect.void;
  };

  const startInstanceInternal = (
    instance: SlackAgentInstanceView,
  ): Effect.Effect<void, SlackConnectionManagerError> =>
    Effect.gen(function* () {
      if (!isSlackKind(instance.kind)) {
        return yield* new SlackConnectionManagerWrongKindError({
          instanceId: String(instance.instanceId),
          kind: instance.kind,
          message: `Slack connection manager supports only real Slack instances: ${instance.instanceId}`,
        });
      }

      const credentials = yield* instances.readCredentials(instance.instanceId);
      if (credentials === null) {
        yield* updateConnectionState(instance.instanceId, {
          state: "error",
          connectedAt: null,
          lastError: "Missing credentials for Slack instance",
        });
        return yield* new SlackConnectionManagerMissingCredentialsError({
          instanceId: String(instance.instanceId),
          message: `Slack instance is missing credentials: ${instance.instanceId}`,
        });
      }
      yield* validateIdentity(instance, yield* api.validateCredentials(credentials));

      yield* closeActiveConnection(instance.instanceId);
      yield* updateConnectionState(instance.instanceId, {
        state: "connecting",
        connectedAt: null,
        lastError: null,
      });

      const connectionScope = yield* Scope.make("sequential");
      const generation = yield* upsertActiveConnection(instance.instanceId, connectionScope);

      const emitEnvelope = (envelope: SlackSocketEnvelope) =>
        isActiveGeneration(instance.instanceId, generation).pipe(
          Effect.flatMap((isCurrent) =>
            isCurrent
              ? Ref.get(workflowAuthorized).pipe(
                  Effect.flatMap((canUseWorkflows) =>
                    processor.process({
                      instanceId: String(instance.instanceId),
                      envelope,
                      workflowAuthorized: canUseWorkflows,
                    }),
                  ),
                  Effect.catch((error) =>
                    Effect.logWarning("slack.event.processing-failed", {
                      instanceId: String(instance.instanceId),
                      reason: error.reason,
                      message: redact(error.message),
                    }),
                  ),
                )
              : Effect.void,
          ),
        );

      const emitSocketState = (state: SlackSocketState) =>
        isActiveGeneration(instance.instanceId, generation).pipe(
          Effect.flatMap((isCurrent) =>
            isCurrent ? syncSocketState(instance.instanceId, state) : Effect.void,
          ),
        );

      const setFailureState = (cause: unknown) =>
        isActiveGeneration(instance.instanceId, generation).pipe(
          Effect.flatMap((isCurrent) =>
            isCurrent
              ? updateConnectionState(instance.instanceId, {
                  state: "error",
                  connectedAt: null,
                  lastError: redact(cause),
                }).pipe(
                  Effect.andThen(clearMatchingActiveConnection(instance.instanceId, generation)),
                )
              : Effect.void,
          ),
        );

      const openWithScope = api
        .openSocket({
          appToken: credentials.appToken,
          onEnvelope: emitEnvelope,
          onState: emitSocketState,
        })
        .pipe(
          Effect.provideService(Scope.Scope, connectionScope),
          Effect.tapError((cause) => setFailureState(cause)),
          Effect.asVoid,
        );

      yield* Effect.forkScoped(openWithScope, { startImmediately: true }).pipe(
        Effect.provideService(Scope.Scope, connectionScope),
      );
    });

  const recordConnectionFailure = (instanceId: SlackAgentInstanceId, cause: unknown) =>
    updateConnectionState(instanceId, {
      state: "error",
      connectedAt: null,
      lastError: redact(cause),
    });

  const startAll: SlackConnectionManagerShape["startAll"] = (canUseWorkflows) =>
    Effect.gen(function* () {
      yield* Ref.set(workflowAuthorized, canUseWorkflows);
      const all = yield* instances.list();
      const candidates = all.filter(
        (instance) =>
          isSlackKind(instance.kind) && instance.enabled && instance.credentialsConfigured,
      );
      yield* Effect.forEach(
        candidates,
        (instance) =>
          withInstanceLock(instance.instanceId, startInstanceInternal(instance)).pipe(
            Effect.catch((cause) => recordConnectionFailure(instance.instanceId, cause)),
          ),
        { concurrency: "unbounded", discard: true },
      );
    });

  const startInstance: SlackConnectionManagerShape["startInstance"] = (instanceId) =>
    withInstanceLock(
      instanceId,
      readInstance(instanceId).pipe(Effect.flatMap(startInstanceInternal)),
    ).pipe(Effect.tapError((cause) => recordConnectionFailure(instanceId, cause)));

  const stopInstance: SlackConnectionManagerShape["stopInstance"] = (instanceId) =>
    withInstanceLock(
      instanceId,
      Effect.gen(function* () {
        yield* closeActiveConnection(instanceId);
        yield* updateConnectionState(instanceId, {
          state: "disconnected",
          connectedAt: null,
          lastError: null,
        });
      }),
    );

  const restartInstance: SlackConnectionManagerShape["restartInstance"] = (instanceId) =>
    withInstanceLock(
      instanceId,
      Effect.gen(function* () {
        yield* closeActiveConnection(instanceId);
        const instance = yield* readInstance(instanceId);
        if (!isSlackKind(instance.kind)) {
          return yield* new SlackConnectionManagerWrongKindError({
            instanceId: String(instance.instanceId),
            kind: instance.kind,
            message: `Cannot restart non-real Slack instance: ${instance.instanceId}`,
          });
        }
        if (!instance.enabled) {
          const credentials = yield* instances.readCredentials(instance.instanceId);
          if (credentials === null) {
            yield* updateConnectionState(instanceId, {
              state: "error",
              connectedAt: null,
              lastError: "Missing credentials for Slack instance",
            });
            return yield* new SlackConnectionManagerMissingCredentialsError({
              instanceId: String(instance.instanceId),
              message: `Slack instance is missing credentials: ${instance.instanceId}`,
            });
          }
          yield* validateIdentity(instance, yield* api.validateCredentials(credentials));
          yield* updateConnectionState(instanceId, {
            state: "disconnected",
            connectedAt: null,
            lastError: null,
          });
          return;
        }
        yield* startInstanceInternal(instance);
      }),
    ).pipe(Effect.tapError((cause) => recordConnectionFailure(instanceId, cause)));

  const testInstance: SlackConnectionManagerShape["testInstance"] = (instanceId) =>
    Effect.gen(function* () {
      const instance = yield* readInstance(instanceId);
      if (!isSlackKind(instance.kind)) {
        return yield* new SlackConnectionManagerWrongKindError({
          instanceId: String(instance.instanceId),
          kind: instance.kind,
          message: `Cannot test non-real Slack instance: ${instance.instanceId}`,
        });
      }
      if (!instance.enabled) {
        const credentials = yield* instances.readCredentials(instance.instanceId);
        if (credentials === null) {
          return yield* new SlackConnectionManagerMissingCredentialsError({
            instanceId: String(instance.instanceId),
            message: `Slack instance is missing credentials: ${instance.instanceId}`,
          });
        }
        yield* validateIdentity(instance, yield* api.validateCredentials(credentials));
        yield* updateConnectionState(instanceId, {
          state: "disconnected",
          connectedAt: null,
          lastError: null,
        });
        const refreshed = yield* instances.get(instanceId);
        if (refreshed === null) {
          return yield* new SlackConnectionManagerUnknownInstanceError({
            instanceId: String(instanceId),
            message: `Slack instance disappeared while testing: ${instanceId}`,
          });
        }
        return refreshed;
      }
      yield* restartInstance(instance.instanceId);
      const refreshed = yield* instances.get(instance.instanceId);
      if (refreshed === null) {
        return yield* new SlackConnectionManagerUnknownInstanceError({
          instanceId: String(instance.instanceId),
          message: `Slack instance disappeared while testing: ${instance.instanceId}`,
        });
      }
      return refreshed;
    }).pipe(Effect.tapError((cause) => recordConnectionFailure(instanceId, cause)));

  yield* Effect.addFinalizer(() =>
    SynchronizedRef.get(activeConnections).pipe(
      Effect.flatMap((connections) =>
        Effect.forEach(
          Array.from(connections.values()),
          (active) => Scope.close(active.scope, Exit.void).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    ),
  );

  return SlackConnectionManager.of({
    startAll,
    startInstance,
    stopInstance,
    restartInstance,
    testInstance,
  });
});

export const SlackConnectionManagerLive = Layer.effect(SlackConnectionManager, make);
