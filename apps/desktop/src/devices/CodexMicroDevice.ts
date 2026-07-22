import type {
  CodexMicroCapabilities,
  CodexMicroDeviceState,
  CodexMicroLedFrame,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as CodexMicroPowerMonitor from "./CodexMicroPowerMonitor.ts";
import * as CodexMicroTransport from "./CodexMicroTransport.ts";
import {
  resolveCodexMicroUsbIds,
  codexMicroDeviceMatches,
  type CodexMicroUsbIds,
} from "./codexMicroIds.ts";
import {
  UNVERIFIED_CODEX_MICRO_CAPABILITIES,
  clampBrightnessPercent,
  createInitialCodexMicroState,
  encodeAutoDimReport,
  encodeBrightnessReport,
  encodeLedFrameReport,
  isCodexMicroWriteCapabilitySupported,
  isConnected,
  toClosed,
  toConnected,
  toDegraded,
  toDiscovering,
  toDisconnected,
  type CodexMicroWriteKind,
} from "./codexMicroMachine.ts";

// ── Config ───────────────────────────────────────────────────────────

export interface CodexMicroDeviceConfigValue {
  /** VID/PID the enumerator matches. Default = env-resolved placeholder. */
  readonly usbIds: CodexMicroUsbIds;
  /**
   * Capability matrix. The single source of capability truth: all "unverified"
   * by default (D1 gate) so every smart write no-ops. Injected here so a test —
   * or a post-D1 config — can flip a capability to "supported" with no code
   * change.
   */
  readonly capabilities: CodexMicroCapabilities;
  /** Steady-state enumeration poll interval. */
  readonly discoveryIntervalMillis: number;
  /** Backoff ceiling after repeated discovery failures. */
  readonly maxBackoffMillis: number;
}

export const defaultCodexMicroDeviceConfig = (
  env: Record<string, string | undefined> = process.env,
): CodexMicroDeviceConfigValue => ({
  usbIds: resolveCodexMicroUsbIds(env),
  capabilities: UNVERIFIED_CODEX_MICRO_CAPABILITIES,
  discoveryIntervalMillis: 4_000,
  maxBackoffMillis: 30_000,
});

export class CodexMicroDeviceConfig extends Context.Reference<CodexMicroDeviceConfigValue>(
  "@t3tools/desktop/devices/CodexMicroDeviceConfig",
  { defaultValue: () => defaultCodexMicroDeviceConfig() },
) {}

// ── Service ──────────────────────────────────────────────────────────

export class CodexMicroDevice extends Context.Service<
  CodexMicroDevice,
  {
    /** Current device state snapshot. */
    readonly getState: Effect.Effect<CodexMicroDeviceState>;
    /** State-change subscription (emits the current value, then each change). */
    readonly changes: Stream.Stream<CodexMicroDeviceState>;
    /**
     * Begin discovery/polling, wire hot-unplug + sleep/wake, and fork the
     * background loops. Scoped: everything is torn down when the scope closes.
     */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    /** Push the six agent-key LED slots (no-op unless ledWrite is supported). */
    readonly setAgentKeyColors: (frame: CodexMicroLedFrame) => Effect.Effect<void>;
    /** Set global brightness 0–100 (no-op unless brightness is supported). */
    readonly setBrightness: (percent: number) => Effect.Effect<void>;
    /** Toggle auto-dim (no-op unless autoDim is supported). */
    readonly setAutoDim: (enabled: boolean) => Effect.Effect<void>;
    /** Close the transport, stop the loops, and enter the terminal state. */
    readonly shutdown: Effect.Effect<void>;
  }
>()("@t3tools/desktop/devices/CodexMicroDevice") {}

// External-callback → fiber bridge events (offered synchronously via
// Queue.offerUnsafe from plain node-hid / powerMonitor callbacks).
type CodexMicroInternalEvent = "disconnected" | "suspend" | "resume";

interface DesiredState {
  readonly led: CodexMicroLedFrame | null;
  readonly brightness: number | null;
  readonly autoDim: boolean | null;
}

const EMPTY_DESIRED: DesiredState = { led: null, brightness: null, autoDim: null };

export const make = Effect.gen(function* () {
  const transport = yield* CodexMicroTransport.CodexMicroTransport;
  const powerMonitor = yield* CodexMicroPowerMonitor.CodexMicroPowerMonitor;
  const config = yield* CodexMicroDeviceConfig;

  const stateRef = yield* SubscriptionRef.make<CodexMicroDeviceState>(
    createInitialCodexMicroState(config.capabilities),
  );
  const connectionRef = yield* Ref.make<CodexMicroTransport.CodexMicroConnection | null>(null);
  // Synchronous unsubscribe for the current connection's listeners.
  const connectionCleanupRef = yield* Ref.make<(() => void) | null>(null);
  const suspendedRef = yield* Ref.make(false);
  const closedRef = yield* Ref.make(false);
  const backoffRef = yield* Ref.make(config.discoveryIntervalMillis);
  const desiredRef = yield* Ref.make<DesiredState>(EMPTY_DESIRED);
  // Coalescing write queue: at most one pending report PER kind; a newer
  // report for a kind replaces the older unsent one.
  const pendingRef = yield* Ref.make<Map<CodexMicroWriteKind, ReadonlyArray<number>>>(new Map());
  const writeSemaphore = yield* Semaphore.make(1);
  const wake = yield* Queue.unbounded<void>();
  const events = yield* Queue.unbounded<CodexMicroInternalEvent>();

  const setState = (
    f: (state: CodexMicroDeviceState) => CodexMicroDeviceState,
  ): Effect.Effect<void> => SubscriptionRef.update(stateRef, f);

  const enqueuePending = (kind: CodexMicroWriteKind, report: ReadonlyArray<number>) =>
    Ref.update(pendingRef, (pending) => {
      const next = new Map(pending);
      next.set(kind, report);
      return next;
    }).pipe(Effect.andThen(Queue.offer(wake, undefined)));

  const clearPending = Ref.set(pendingRef, new Map<CodexMicroWriteKind, ReadonlyArray<number>>());

  // ── Connection teardown / loss ─────────────────────────────────────

  const teardownConnection: Effect.Effect<void> = Effect.gen(function* () {
    const cleanup = yield* Ref.getAndSet(connectionCleanupRef, null);
    if (cleanup !== null) {
      cleanup();
    }
    const connection = yield* Ref.getAndSet(connectionRef, null);
    if (connection !== null) {
      yield* connection.close;
    }
    yield* clearPending;
  });

  const handleConnectionLoss: Effect.Effect<void> = Effect.gen(function* () {
    yield* teardownConnection;
    const closed = yield* Ref.get(closedRef);
    const suspended = yield* Ref.get(suspendedRef);
    if (closed) {
      return;
    }
    // Suspended → stay disconnected (quiesced); otherwise seek a device again.
    yield* setState(suspended ? toDisconnected : toDiscovering);
  });

  // ── Write pump ─────────────────────────────────────────────────────

  // Pop the oldest pending (kind, report) atomically, or null when empty.
  const popPending: Effect.Effect<{
    readonly kind: CodexMicroWriteKind;
    readonly report: ReadonlyArray<number>;
  } | null> = Ref.modify(pendingRef, (pending) => {
    const first = pending.entries().next();
    if (first.done) {
      return [null, pending];
    }
    const [kind, report] = first.value;
    const next = new Map(pending);
    next.delete(kind);
    return [{ kind, report }, next];
  });

  const performWrite = (report: ReadonlyArray<number>): Effect.Effect<void> =>
    Effect.gen(function* () {
      const connection = yield* Ref.get(connectionRef);
      if (connection === null) {
        // Not connected — drop; desired-state replay re-pushes on reconnect.
        return;
      }
      yield* connection.write(report).pipe(
        Effect.catchTag("CodexMicroTransportError", (error) =>
          // A write failure mid-session almost always means the device went
          // away. Degrade, then hand off to connection-loss handling so the
          // discovery loop reconnects. Never re-throw: keep the pump alive.
          Effect.gen(function* () {
            yield* Effect.logWarning("codex-micro write failed", error);
            yield* setState(toDegraded);
            yield* handleConnectionLoss;
          }),
        ),
      );
    });

  // Drain the coalesced queue, one report at a time, serialized so only one
  // report is ever in flight.
  const drainPending: Effect.Effect<void> = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      let next = yield* popPending;
      while (next !== null) {
        yield* performWrite(next.report);
        next = yield* popPending;
      }
    }),
  );

  const writePumpLoop: Effect.Effect<void> = Effect.gen(function* () {
    while (!(yield* Ref.get(closedRef))) {
      yield* Queue.take(wake);
      if (yield* Ref.get(closedRef)) {
        return;
      }
      yield* drainPending;
    }
  });

  // ── Desired-state tracking + replay ────────────────────────────────

  const requestWrite = (
    kind: CodexMicroWriteKind,
    report: ReadonlyArray<number>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.get(stateRef);
      if (isConnected(state) && isCodexMicroWriteCapabilitySupported(config.capabilities, kind)) {
        yield* enqueuePending(kind, report);
      }
    });

  const replayDesiredState: Effect.Effect<void> = Effect.gen(function* () {
    const desired = yield* Ref.get(desiredRef);
    if (desired.led !== null) {
      yield* requestWrite("led", encodeLedFrameReport(desired.led));
    }
    if (desired.brightness !== null) {
      yield* requestWrite("brightness", encodeBrightnessReport(desired.brightness));
    }
    if (desired.autoDim !== null) {
      yield* requestWrite("autoDim", encodeAutoDimReport(desired.autoDim));
    }
  });

  // ── Connection lifecycle ───────────────────────────────────────────

  const onConnected = (connection: CodexMicroTransport.CodexMicroConnection): Effect.Effect<void> =>
    Effect.gen(function* () {
      const unsubscribeDisconnect = connection.onDisconnect(() => {
        Queue.offerUnsafe(events, "disconnected");
      });
      const unsubscribeInput = connection.onInputReport(() => {
        // Input-report parsing (e.g. battery %) is pending the D1 capture; the
        // battery capability is "unverified" so there is nothing to decode yet.
      });
      yield* Ref.set(connectionCleanupRef, () => {
        unsubscribeDisconnect();
        unsubscribeInput();
      });
      yield* Ref.set(connectionRef, connection);
      yield* Ref.set(backoffRef, config.discoveryIntervalMillis);
      yield* setState(toConnected);
      yield* replayDesiredState;
    });

  const attemptDiscovery: Effect.Effect<boolean> = Effect.gen(function* () {
    if (yield* Ref.get(suspendedRef)) {
      return false;
    }
    if (yield* Ref.get(closedRef)) {
      return false;
    }
    yield* setState(toDiscovering);
    return yield* transport.list.pipe(
      Effect.flatMap((devices) => {
        const match = devices.find((device) => codexMicroDeviceMatches(config.usbIds, device));
        if (match === undefined) {
          return Effect.succeed(false);
        }
        return transport.open(match).pipe(
          Effect.flatMap((connection) => onConnected(connection).pipe(Effect.as(true))),
          Effect.catchTags({
            CodexMicroTransportError: (error) =>
              Effect.logWarning("codex-micro open failed", error).pipe(Effect.as(false)),
            CodexMicroTransportUnavailableError: (error) =>
              Effect.logWarning("codex-micro native transport unavailable", error).pipe(
                Effect.as(false),
              ),
          }),
        );
      }),
      Effect.catchTags({
        CodexMicroTransportError: (error) =>
          Effect.logWarning("codex-micro enumeration failed", error).pipe(Effect.as(false)),
        CodexMicroTransportUnavailableError: (error) =>
          Effect.logWarning("codex-micro native transport unavailable", error).pipe(
            Effect.as(false),
          ),
      }),
    );
  });

  // ── Discovery loop (poll + exponential backoff) ────────────────────

  const discoveryStep: Effect.Effect<void> = Effect.gen(function* () {
    const state = yield* SubscriptionRef.get(stateRef);
    const suspended = yield* Ref.get(suspendedRef);
    // Compute the pre-attempt delay from the current situation. Sleeping first
    // avoids re-attempting back-to-back with the synchronous initial attempt
    // that `start` runs.
    const delayMillis =
      isConnected(state) || suspended ? config.discoveryIntervalMillis : yield* Ref.get(backoffRef);
    yield* Effect.sleep(Duration.millis(delayMillis));

    if (yield* Ref.get(closedRef)) {
      return;
    }
    const nextState = yield* SubscriptionRef.get(stateRef);
    if (isConnected(nextState) || (yield* Ref.get(suspendedRef))) {
      return;
    }

    const connected = yield* attemptDiscovery;
    if (connected) {
      yield* Ref.set(backoffRef, config.discoveryIntervalMillis);
    } else {
      yield* Ref.update(backoffRef, (backoff) => Math.min(backoff * 2, config.maxBackoffMillis));
    }
  });

  const discoveryLoop: Effect.Effect<void> = discoveryStep.pipe(
    Effect.forever,
    Effect.catchCause((cause) => Effect.logWarning("codex-micro discovery loop stopped", cause)),
  );

  // ── Internal event loop (hot-unplug + sleep/wake) ──────────────────

  const handleEvent = (event: CodexMicroInternalEvent): Effect.Effect<void> => {
    switch (event) {
      case "disconnected":
        return handleConnectionLoss;
      case "suspend":
        return Effect.gen(function* () {
          yield* Ref.set(suspendedRef, true);
          yield* teardownConnection;
          if (!(yield* Ref.get(closedRef))) {
            yield* setState(toDisconnected);
          }
        });
      case "resume":
        return Effect.gen(function* () {
          yield* Ref.set(suspendedRef, false);
          yield* Ref.set(backoffRef, config.discoveryIntervalMillis);
          if (!(yield* Ref.get(closedRef))) {
            // Move into discovering so the loop re-attempts on its next tick.
            yield* setState(toDiscovering);
          }
        });
    }
  };

  const eventLoop: Effect.Effect<void> = Effect.gen(function* () {
    while (!(yield* Ref.get(closedRef))) {
      const event = yield* Queue.take(events);
      if (yield* Ref.get(closedRef)) {
        return;
      }
      yield* handleEvent(event);
    }
  });

  const shutdown: Effect.Effect<void> = Effect.gen(function* () {
    const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
    if (alreadyClosed) {
      return;
    }
    yield* teardownConnection;
    yield* setState(toClosed);
    // Unblock the loops so their `closedRef` checks let them exit.
    yield* Queue.offer(wake, undefined);
    yield* Queue.offer(events, "disconnected");
  });

  const start: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    // Wire OS sleep/wake into the internal event queue (synchronous offers).
    yield* powerMonitor.onSuspend(() => {
      Queue.offerUnsafe(events, "suspend");
    });
    yield* powerMonitor.onResume(() => {
      Queue.offerUnsafe(events, "resume");
    });

    // Deterministic initial discovery so state reflects the first attempt
    // without waiting on the poll loop.
    yield* attemptDiscovery.pipe(
      Effect.tap((connected) =>
        connected ? Effect.void : Ref.set(backoffRef, config.discoveryIntervalMillis),
      ),
      Effect.asVoid,
    );

    yield* Effect.forkScoped(writePumpLoop);
    yield* Effect.forkScoped(eventLoop);
    yield* Effect.forkScoped(discoveryLoop);
  });

  return CodexMicroDevice.of({
    getState: SubscriptionRef.get(stateRef),
    changes: SubscriptionRef.changes(stateRef),
    start,
    setAgentKeyColors: (frame) =>
      Effect.gen(function* () {
        yield* Ref.update(desiredRef, (desired) => ({ ...desired, led: frame }));
        yield* requestWrite("led", encodeLedFrameReport(frame));
      }),
    setBrightness: (percent) =>
      Effect.gen(function* () {
        const clamped = clampBrightnessPercent(percent);
        yield* Ref.update(desiredRef, (desired) => ({ ...desired, brightness: clamped }));
        yield* requestWrite("brightness", encodeBrightnessReport(clamped));
      }),
    setAutoDim: (enabled) =>
      Effect.gen(function* () {
        yield* Ref.update(desiredRef, (desired) => ({ ...desired, autoDim: enabled }));
        yield* requestWrite("autoDim", encodeAutoDimReport(enabled));
      }),
    shutdown,
  });
});

export const layer = Layer.effect(CodexMicroDevice, make).pipe(
  Layer.provide(CodexMicroTransport.layerNodeHid),
  Layer.provide(CodexMicroPowerMonitor.layer),
);
