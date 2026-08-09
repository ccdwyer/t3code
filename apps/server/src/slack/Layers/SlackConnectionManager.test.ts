import { assert, describe, it } from "@effect/vitest";
import type {
  SlackAgentInstanceId,
  SlackAgentInstanceKind,
  SlackAgentInstanceView,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import * as Ref from "effect/Ref";

import {
  SlackApi,
  SlackApiError,
  type SlackApiShape,
  type SlackCredentialsValidation,
  type SlackSocketEnvelope,
  type SlackSocketState,
} from "../Services/SlackApi.ts";
import {
  SlackAgentInstanceStore,
  SlackAgentInstanceStoreError,
  type SlackAgentInstanceCredentials,
  type SlackAgentInstanceStoreShape,
} from "../../workflow/Services/SlackAgentInstanceStore.ts";
import {
  SlackConnectionManager,
  SlackConnectionManagerValidationMismatchError,
  SlackConnectionManagerWrongKindError,
} from "../Services/SlackConnectionManager.ts";
import { SlackConnectionManagerLive } from "./SlackConnectionManager.ts";
import {
  SlackEventProcessor,
  type SlackEventProcessorShape,
} from "../Services/SlackEventProcessor.ts";

interface FakeSocket {
  id: string;
  closeCount: number;
  close: Effect.Effect<void, never, never>;
}

interface SocketBinding {
  readonly socket: FakeSocket;
  readonly onState: (state: SlackSocketState) => Effect.Effect<void, never>;
  readonly onEnvelope: (envelope: SlackSocketEnvelope) => Effect.Effect<void, SlackApiError>;
}

interface Harness {
  run: <A, E>(effect: Effect.Effect<A, E, SlackConnectionManager>) => Effect.Effect<A, E, never>;
  getInstance: (instanceId: SlackAgentInstanceId) => Effect.Effect<SlackAgentInstanceView | null>;
  socketsFor: (instanceId: SlackAgentInstanceId) => Effect.Effect<ReadonlyArray<FakeSocket>>;
  emitEnvelope: (
    instanceId: SlackAgentInstanceId,
    envelope: SlackSocketEnvelope,
    index?: number,
  ) => Effect.Effect<void, SlackApiError>;
  emitState: (
    instanceId: SlackAgentInstanceId,
    state: SlackSocketState,
    index?: number,
  ) => Effect.Effect<void, SlackApiError>;
  stateEmissions: (
    instanceId: SlackAgentInstanceId,
  ) => Effect.Effect<ReadonlyArray<SlackSocketState>>;
  processed: () => Effect.Effect<
    ReadonlyArray<{
      instanceId: string;
      envelope: SlackSocketEnvelope;
      workflowAuthorized: boolean;
    }>
  >;
  openCount: (instanceId: SlackAgentInstanceId) => Effect.Effect<number>;
  closeCount: (instanceId: SlackAgentInstanceId) => Effect.Effect<number>;
}

const makeInstance = (
  instanceId: string,
  kind: SlackAgentInstanceKind = "slack",
  overrides: Partial<SlackAgentInstanceView> = {},
) =>
  ({
    instanceId: instanceId as SlackAgentInstanceId,
    kind,
    workspace: { workspaceId: "T123", name: "Acme" },
    appId: "A123",
    botId: "B999",
    handle: `t3_${String(instanceId).replace(/[^a-z0-9_]/g, "_")}`,
    ownerLabel: "owner",
    botUserId: "U999",
    target: { projectId: "project-1" },
    enabled: true,
    state: "enabled",
    validation: { valid: true },
    credentialsConfigured: true,
    connection: { state: "disconnected", connectedAt: undefined, lastError: undefined },
    activeRunCount: 0,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  }) as SlackAgentInstanceView;

const makeHarness = (
  input: {
    readonly instances?: ReadonlyArray<SlackAgentInstanceView>;
    readonly credentials?: Record<string, SlackAgentInstanceCredentials | null>;
    readonly api?: Partial<SlackApiShape>;
    readonly processor?: Partial<SlackEventProcessorShape>;
  } = {},
): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const rows = new Map<string, SlackAgentInstanceView>(
      (input.instances ?? [makeInstance("slack-instance-1" as SlackAgentInstanceId)]).map((row) => [
        row.instanceId,
        row,
      ]),
    );

    const credentials = new Map<string, SlackAgentInstanceCredentials | null>(
      Object.entries(input.credentials ?? {}).map(([instanceId, value]) => [instanceId, value]),
    );

    const socketBindings = new Map<string, ReadonlyArray<SocketBinding>>();
    const stateEmissions = new Map<string, ReadonlyArray<SlackSocketState>>();
    const envelopeCalls = yield* Ref.make<
      ReadonlyArray<{
        instanceId: string;
        envelope: SlackSocketEnvelope;
        workflowAuthorized: boolean;
      }>
    >([]);
    const socketIds = (() => {
      let i = 0;
      return () => {
        i += 1;
        return `socket-${i}`;
      };
    })();

    const readInstanceByToken = (appToken: string) =>
      Array.from(rows.values()).find((row) => {
        const configured = credentials.get(row.instanceId) ?? {
          appToken: `xapp-${row.instanceId}`,
        };
        return configured.appToken === appToken;
      })?.instanceId ?? (rows.keys().next().value as SlackAgentInstanceId);

    const store: SlackAgentInstanceStoreShape = {
      create: () => Effect.die("unused"),
      createMock: () => Effect.die("unused"),
      createReal: () => Effect.die("unused"),
      list: () => Effect.succeed(Array.from(rows.values())),
      get: (instanceId) => Effect.succeed(rows.get(String(instanceId)) ?? null),
      getEnabledByBotUserId: () => Effect.succeed(null),
      readCredentials: (instanceId) =>
        Effect.succeed(
          credentials.get(String(instanceId)) ?? {
            appToken: `xapp-${instanceId}`,
            botToken: `xoxb-${instanceId}`,
          },
        ),
      replaceCredentials: () => Effect.die("unused"),
      disconnect: () => Effect.die("unused"),
      updateConnectionState: (instanceId, update) => {
        const current = rows.get(String(instanceId));
        if (current === undefined) {
          return Effect.fail(new SlackAgentInstanceStoreError({ message: "instance not found" }));
        }
        const connectedAt =
          update.connectedAt === undefined ? current.connection.connectedAt : update.connectedAt;
        const lastError =
          update.lastError === undefined ? current.connection.lastError : update.lastError;
        rows.set(String(instanceId), {
          ...current,
          connection: {
            state: update.state,
            ...(connectedAt === undefined || connectedAt === null ? {} : { connectedAt }),
            ...(lastError === undefined || lastError === null ? {} : { lastError }),
          },
        });
        return Effect.succeed(rows.get(String(instanceId))!);
      },
      update: () => Effect.die("unused"),
      disable: () => Effect.die("unused"),
      enable: () => Effect.die("unused"),
      delete: () => Effect.void,
    };

    const processor: SlackEventProcessorShape = {
      process:
        input.processor?.process ??
        ((item) => Ref.update(envelopeCalls, (items) => [...items, item])),
    };

    const defaultApi: SlackApiShape = {
      validateCredentials: () =>
        Effect.succeed({
          workspaceId: "T123",
          workspaceName: "Acme",
          botUserId: "U999",
          botId: "B999",
          appId: "A123",
          grantedScopes: ["app_mentions:read"],
        } satisfies SlackCredentialsValidation),
      openSocket: ({ appToken, onState, onEnvelope }) => {
        const instanceId = readInstanceByToken(appToken);
        const socket: FakeSocket = {
          id: socketIds(),
          closeCount: 0,
          close: Effect.die("uninitialized"),
        };
        socket.close = Effect.sync(() => {
          socket.closeCount += 1;
        });

        socketBindings.set(String(instanceId), [
          ...(socketBindings.get(String(instanceId)) ?? []),
          {
            socket,
            onState: (state) =>
              Effect.sync(() => {
                stateEmissions.set(String(instanceId), [
                  ...(stateEmissions.get(String(instanceId)) ?? []),
                  state,
                ]);
              }).pipe(Effect.flatMap(() => onState(state))),
            onEnvelope,
          },
        ]);

        return Effect.acquireRelease(
          Effect.succeed({ close: socket.close }),
          (connection) => connection.close,
        );
      },
      fetchThreadThrough: () => Effect.die("unused"),
      resolveChannelName: () => Effect.die("unused"),
      resolveUserLabel: () => Effect.die("unused"),
      postMessage: () => Effect.die("unused"),
      updateMessage: () => Effect.die("unused"),
    };

    const api: SlackApiShape = {
      ...defaultApi,
      ...input.api,
    };

    const layer = SlackConnectionManagerLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(SlackAgentInstanceStore, store),
          Layer.succeed(SlackApi, api),
          Layer.succeed(SlackEventProcessor, processor),
        ),
      ),
    );

    const emit = (
      instanceId: SlackAgentInstanceId,
      action: "envelope" | "state",
      index: number | undefined,
      arg: unknown,
    ) =>
      Effect.gen(function* () {
        const bindings = socketBindings.get(String(instanceId)) ?? [];
        const selected = bindings[index ?? Math.max(bindings.length - 1, 0)];
        if (selected === undefined) {
          return yield* Effect.die(new Error(`missing socket for ${instanceId}`));
        }
        if (action === "envelope") {
          return yield* selected.onEnvelope(arg as SlackSocketEnvelope);
        }
        return yield* selected.onState(arg as SlackSocketState);
      });

    return {
      run: <A, E>(effect: Effect.Effect<A, E, SlackConnectionManager>) =>
        effect.pipe(Effect.provide(layer), Effect.scoped),
      getInstance: (instanceId) => Effect.succeed(rows.get(String(instanceId)) ?? null),
      socketsFor: (instanceId) =>
        Effect.succeed(
          (socketBindings.get(String(instanceId)) ?? []).map((binding) => binding.socket),
        ),
      emitEnvelope: (instanceId, envelope, index) => emit(instanceId, "envelope", index, envelope),
      emitState: (instanceId, state, index) => emit(instanceId, "state", index, state),
      stateEmissions: (instanceId) =>
        Effect.sync(() => stateEmissions.get(String(instanceId)) ?? []),
      processed: () => Ref.get(envelopeCalls),
      openCount: (instanceId) =>
        Effect.succeed((socketBindings.get(String(instanceId)) ?? []).length),
      closeCount: (instanceId) => {
        const count = (socketBindings.get(String(instanceId)) ?? []).reduce(
          (sum, binding) => sum + binding.socket.closeCount,
          0,
        );
        return Effect.succeed(count);
      },
    };
  });

describe("SlackConnectionManagerLive", () => {
  it.effect("isolates multiple live instances", () =>
    Effect.gen(function* () {
      const first = makeInstance("slack-instance-1");
      const second = makeInstance("slack-instance-2");
      const harness = yield* makeHarness({ instances: [first, second] });

      yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          yield* manager.startInstance(first.instanceId);
          yield* manager.startInstance(second.instanceId);
        }),
      );

      assert.equal(yield* harness.openCount(first.instanceId), 1);
      assert.equal(yield* harness.openCount(second.instanceId), 1);
      assert.equal((yield* harness.socketsFor(first.instanceId)).length, 1);
      assert.equal((yield* harness.socketsFor(second.instanceId)).length, 1);
    }),
  );

  it.effect("startAll continues after one failure and redacts secrets", () =>
    Effect.gen(function* () {
      const first = makeInstance("slack-instance-1");
      const second = makeInstance("slack-instance-2");
      const harness = yield* makeHarness({
        instances: [first, second],
        credentials: {
          [first.instanceId]: { appToken: "xapp-first", botToken: "xoxb-first" },
          [second.instanceId]: { appToken: "xapp-second", botToken: "xoxb-second" },
        },
        api: {
          openSocket: ({ appToken }) => {
            if (appToken === "xapp-first") {
              return Effect.fail(
                new SlackApiError({
                  operation: "openSocket",
                  message: "invalid token xoxb-leak for xapp-leak",
                }),
              );
            }
            return Effect.succeed({ close: Effect.void as Effect.Effect<void, never, never> });
          },
        },
      });

      yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          yield* manager.startAll(true);
        }),
      );

      const firstAfter = yield* harness.getInstance(first.instanceId);
      const secondAfter = yield* harness.getInstance(second.instanceId);

      assert.equal(firstAfter?.connection.state, "error");
      assert.equal(firstAfter?.connection.lastError?.includes("xoxb"), false);
      assert.equal(firstAfter?.connection.lastError?.includes("xapp"), false);
      assert.equal(firstAfter?.connection.lastError?.includes("[redacted]"), true);
      assert.equal(secondAfter?.connection.state, "connecting");
    }),
  );

  it.effect("startAll returns while socket workers are still pending", () =>
    Effect.gen(function* () {
      const first = makeInstance("slack-instance-1");
      const second = makeInstance("slack-instance-2");
      const harness = yield* makeHarness({
        instances: [first, second],
        api: {
          openSocket: () => Effect.never,
        },
      });

      yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          yield* manager.startAll(true).pipe(Effect.timeout(Duration.seconds(1)));
        }),
      );

      assert.equal((yield* harness.getInstance(first.instanceId))?.connection.state, "connecting");
      assert.equal((yield* harness.getInstance(second.instanceId))?.connection.state, "connecting");
    }),
  );

  it.effect("restarts keep one live socket lifecycle per instance", () =>
    Effect.gen(function* () {
      const one = makeInstance("slack-instance-1");
      const harness = yield* makeHarness({ instances: [one] });

      yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          yield* manager.startInstance(one.instanceId);
          yield* manager.restartInstance(one.instanceId);
        }),
      );

      assert.equal(yield* harness.openCount(one.instanceId), 2);
      const closeCount = yield* harness.closeCount(one.instanceId);
      assert.isTrue(closeCount >= 1);
      assert.equal((yield* harness.socketsFor(one.instanceId)).length, 2);
    }),
  );

  it.effect("stops while connect is pending without blocking", () =>
    Effect.gen(function* () {
      const one = makeInstance("slack-instance-1");
      const harness = yield* makeHarness({
        instances: [one],
        api: {
          openSocket: () => Effect.never,
        },
      });

      yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          yield* manager.startInstance(one.instanceId);
          yield* manager.stopInstance(one.instanceId);
        }),
      );

      const after = yield* harness.getInstance(one.instanceId);
      assert.equal(after?.connection.state, "disconnected");
    }),
  );

  it.effect("ignores stale callbacks from older socket generations", () =>
    Effect.gen(function* () {
      const one = makeInstance("slack-instance-1");
      const harness = yield* makeHarness({ instances: [one] });

      yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          yield* manager.startInstance(one.instanceId);
          yield* manager.restartInstance(one.instanceId);
          yield* harness.emitState(one.instanceId, { type: "disconnect", reason: "stale" }, 0);
          const afterStop = yield* harness.getInstance(one.instanceId);
          assert.equal(afterStop?.connection.state, "connecting");
          yield* harness.emitState(one.instanceId, { type: "connected" }, 1);
        }),
      );

      const after = yield* harness.getInstance(one.instanceId);
      assert.equal(after?.connection.state, "connected");
      assert.equal(after?.connection.lastError, null);
    }),
  );

  it.effect("restart skips socket open when disabled and validates credentials", () =>
    Effect.gen(function* () {
      const one = makeInstance("slack-instance-1", "slack", { enabled: false, state: "disabled" });
      let validated = false;
      const harness = yield* makeHarness({
        instances: [one],
        api: {
          validateCredentials: () =>
            Effect.sync(() => {
              validated = true;
              return {
                workspaceId: "T123",
                workspaceName: "Acme",
                botUserId: "U999",
                botId: "B999",
                appId: "A123",
                grantedScopes: ["app_mentions:read"],
              } satisfies SlackCredentialsValidation;
            }),
          openSocket: () => {
            assert.fail("openSocket should not run for disabled restart");
            return Effect.never;
          },
        },
      });

      yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          yield* manager.restartInstance(one.instanceId);
        }),
      );

      assert.equal(validated, true);
      const after = yield* harness.getInstance(one.instanceId);
      assert.equal(after?.connection.state, "disconnected");
      assert.equal(yield* harness.openCount(one.instanceId), 0);
    }),
  );

  it.effect("testInstance validates without opening socket for disabled identities", () =>
    Effect.gen(function* () {
      const one = makeInstance("slack-instance-1", "slack", { enabled: false, state: "disabled" });
      let validated = false;
      const harness = yield* makeHarness({
        instances: [one],
        api: {
          validateCredentials: () =>
            Effect.sync(() => {
              validated = true;
              return {
                workspaceId: "T123",
                workspaceName: "Acme",
                botUserId: "U999",
                botId: "B999",
                appId: "A123",
                grantedScopes: ["app_mentions:read"],
              } satisfies SlackCredentialsValidation;
            }),
          openSocket: () => {
            assert.fail("openSocket should not run for disabled test");
            return Effect.never;
          },
        },
      });

      yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          return yield* manager.testInstance(one.instanceId);
        }),
      );

      assert.equal(validated, true);
      assert.equal(yield* harness.openCount(one.instanceId), 0);
      const after = yield* harness.getInstance(one.instanceId);
      assert.equal(after?.connection.state, "disconnected");
    }),
  );

  it.effect("routes envelopes with the current workflow availability", () =>
    Effect.gen(function* () {
      const one = makeInstance("slack-instance-1");
      const envelope: SlackSocketEnvelope = {
        envelopeId: "env-1",
        type: "events_api",
        acceptsResponsePayload: false,
        payload: { team_id: "T123" },
      };
      const harness = yield* makeHarness({ instances: [one] });

      yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          yield* manager.startAll(false);
          yield* harness.emitEnvelope(one.instanceId, envelope);
        }),
      );

      const processed = yield* harness.processed();
      assert.equal(processed.length, 1);
      assert.equal(processed[0]?.instanceId, String(one.instanceId));
      assert.equal(processed[0]?.envelope.envelopeId, envelope.envelopeId);
      assert.equal(processed[0]?.workflowAuthorized, false);
    }),
  );

  it.effect("syncs socket lifecycle state transitions", () =>
    Effect.gen(function* () {
      const one = makeInstance("slack-instance-1");
      const harness = yield* makeHarness({ instances: [one] });

      yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          yield* manager.startInstance(one.instanceId);
          yield* harness.emitState(one.instanceId, { type: "connecting" });
          yield* harness.emitState(one.instanceId, { type: "connected" });
          yield* harness.emitState(one.instanceId, { type: "disconnect", reason: "manual close" });
        }),
      );

      assert.equal((yield* harness.stateEmissions(one.instanceId)).length, 3);
      const after = yield* harness.getInstance(one.instanceId);
      assert.equal(after?.connection.state, "disconnected");
      assert.equal(after?.connection.lastError, "manual close");
    }),
  );

  it.effect("testInstance validates identity and marks mismatch", () =>
    Effect.gen(function* () {
      const one = makeInstance("slack-instance-1");
      const harness = yield* makeHarness({
        instances: [one],
        api: {
          validateCredentials: () =>
            Effect.succeed({
              workspaceId: "OTHER",
              workspaceName: "Other",
              botUserId: "U999",
              appId: "OTHER",
              botId: "B999",
            } satisfies SlackCredentialsValidation),
        },
      });

      const exit = yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          return yield* manager.testInstance(one.instanceId).pipe(Effect.exit);
        }),
      );

      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        assert.instanceOf(Cause.squash(exit.cause), SlackConnectionManagerValidationMismatchError);
      }
      const after = yield* harness.getInstance(one.instanceId);
      assert.equal(after?.connection.state, "error");
    }),
  );

  it.effect("startInstance validates identity before opening a socket", () =>
    Effect.gen(function* () {
      const one = makeInstance("slack-instance-1");
      let openCalls = 0;
      const harness = yield* makeHarness({
        instances: [one],
        api: {
          validateCredentials: () =>
            Effect.succeed({
              workspaceId: "OTHER",
              workspaceName: "Other",
              botUserId: "U999",
              appId: "OTHER",
              botId: "B999",
            } satisfies SlackCredentialsValidation),
          openSocket: () => {
            openCalls += 1;
            return Effect.never;
          },
        },
      });

      const exit = yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          return yield* manager.startInstance(one.instanceId).pipe(Effect.exit);
        }),
      );

      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        assert.instanceOf(Cause.squash(exit.cause), SlackConnectionManagerValidationMismatchError);
      }
      assert.equal(openCalls, 0);
      assert.equal((yield* harness.getInstance(one.instanceId))?.connection.state, "error");
    }),
  );

  it.effect("rejects non-slack instance kind", () =>
    Effect.gen(function* () {
      const one = makeInstance("slack-instance-1", "mock");
      const harness = yield* makeHarness({ instances: [one] });

      const exit = yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          return yield* manager.startInstance(one.instanceId).pipe(Effect.exit);
        }),
      );
      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        assert.instanceOf(Cause.squash(exit.cause), SlackConnectionManagerWrongKindError);
      }
    }),
  );

  it.effect("stopInstance marks disconnected and closes sockets", () =>
    Effect.gen(function* () {
      const one = makeInstance("slack-instance-1");
      const harness = yield* makeHarness({ instances: [one] });

      yield* harness.run(
        Effect.gen(function* () {
          const manager = yield* SlackConnectionManager;
          yield* manager.startInstance(one.instanceId);
          yield* manager.stopInstance(one.instanceId);
        }),
      );

      const after = yield* harness.getInstance(one.instanceId);
      assert.equal(after?.connection.state, "disconnected");
      assert.equal(yield* harness.closeCount(one.instanceId), 1);
    }),
  );
});
