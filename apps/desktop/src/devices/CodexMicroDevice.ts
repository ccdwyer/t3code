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
  areCodexMicroUsbIdsPlaceholder,
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
  toDisconnected,
  toDiscovering,
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
//
// `connectionLost` carries the connection IDENTITY that reported the loss so a
// delayed/duplicate event from a stale handle can be discarded — tearing down
// handle A must never touch handle B. Suspend/resume are tag-only (they act on
// whatever connection is current at the time they are handled).
type CodexMicroInternalEvent =
  | {
      readonly _tag: "connectionLost";
      readonly connection: CodexMicroTransport.CodexMicroConnection;
    }
  | { readonly _tag: "suspend" }
  | { readonly _tag: "resume" };

interface DesiredState {
  readonly led: CodexMicroLedFrame | null;
  readonly brightness: number | null;
  readonly autoDim: boolean | null;
}

const EMPTY_DESIRED: DesiredState = { led: null, brightness: null, autoDim: null };

// Fixed priority in which coalesced write kinds are drained: LED first (most
// user-visible), then brightness, then auto-dim.
const DRAIN_ORDER: ReadonlyArray<CodexMicroWriteKind> = ["led", "brightness", "autoDim"];

export const make = Effect.gen(function* () {
  const transport = yield* CodexMicroTransport.CodexMicroTransport;
  const powerMonitor = yield* CodexMicroPowerMonitor.CodexMicroPowerMonitor;
  const config = yield* CodexMicroDeviceConfig;

  const idsArePlaceholder = areCodexMicroUsbIdsPlaceholder(config.usbIds);

  const stateRef = yield* SubscriptionRef.make<CodexMicroDeviceState>(
    createInitialCodexMicroState(config.capabilities),
  );
  const connectionRef = yield* Ref.make<CodexMicroTransport.CodexMicroConnection | null>(null);
  // Synchronous unsubscribe for the current connection's listeners.
  const connectionCleanupRef = yield* Ref.make<(() => void) | null>(null);
  const suspendedRef = yield* Ref.make(false);
  const closedRef = yield* Ref.make(false);
  const startedRef = yield* Ref.make(false);
  const backoffRef = yield* Ref.make(config.discoveryIntervalMillis);
  const desiredRef = yield* Ref.make<DesiredState>(EMPTY_DESIRED);
  // Coalescing write queue: a SET of pending kinds. The actual report bytes are
  // encoded from `desiredRef` at DRAIN time (not enqueue time), so a replay can
  // never stamp a stale snapshot over a newer concurrent setter.
  const pendingRef = yield* Ref.make<ReadonlySet<CodexMicroWriteKind>>(
    new Set<CodexMicroWriteKind>(),
  );
  const writeSemaphore = yield* Semaphore.make(1);
  const wake = yield* Queue.unbounded<void>();
  const events = yield* Queue.unbounded<CodexMicroInternalEvent>();

  const setState = (
    f: (state: CodexMicroDeviceState) => CodexMicroDeviceState,
  ): Effect.Effect<void> => SubscriptionRef.update(stateRef, f);

  const enqueuePending = (kind: CodexMicroWriteKind): Effect.Effect<void> =>
    Ref.update(pendingRef, (pending) => {
      const next = new Set(pending);
      next.add(kind);
      return next;
    }).pipe(Effect.andThen(Queue.offer(wake, undefined)));

  const clearPending = Ref.set(pendingRef, new Set<CodexMicroWriteKind>());

  // Encode the report for a kind FROM THE CURRENT desired state. Returns null
  // when there is no desired value for that kind (nothing to push).
  const encodeDesired = (
    kind: CodexMicroWriteKind,
    desired: DesiredState,
  ): ReadonlyArray<number> | null => {
    switch (kind) {
      case "led":
        return desired.led === null ? null : encodeLedFrameReport(desired.led);
      case "brightness":
        return desired.brightness === null ? null : encodeBrightnessReport(desired.brightness);
      case "autoDim":
        return desired.autoDim === null ? null : encodeAutoDimReport(desired.autoDim);
    }
  };

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

  // Pop the highest-priority pending kind atomically, or null when empty.
  const popPending: Effect.Effect<CodexMicroWriteKind | null> = Ref.modify(
    pendingRef,
    (pending) => {
      for (const kind of DRAIN_ORDER) {
        if (pending.has(kind)) {
          const next = new Set(pending);
          next.delete(kind);
          return [kind, next];
        }
      }
      return [null, pending];
    },
  );

  const performWrite = (report: ReadonlyArray<number>): Effect.Effect<void> =>
    Effect.gen(function* () {
      const connection = yield* Ref.get(connectionRef);
      if (connection === null) {
        // Not connected — drop; desired-state replay re-pushes on reconnect.
        return;
      }
      yield* connection.write(report).pipe(
        Effect.catchTag("CodexMicroTransportError", (error) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(connectionRef);
            if (current !== connection) {
              // The handle we wrote to was already replaced/cleared. A failure
              // on it says nothing about the CURRENT connection — swallow it
              // silently so we never emit a phantom `degraded` (or worse, tear
              // down the live handle). This also avoids the invalid
              // `degraded + transport:null` emission.
              yield* Effect.logDebug("codex-micro write failed on stale connection", error);
              return;
            }
            // Still current: degrade and hand the teardown to the single event
            // loop (do NOT tear down inline — let the loop serialize it, keyed
            // by this exact connection identity).
            yield* Effect.logWarning("codex-micro write failed", error);
            yield* setState(toDegraded);
            yield* Queue.offer(events, { _tag: "connectionLost", connection });
          }),
        ),
      );
    });

  // Drain the coalesced queue, one report at a time, serialized so only one
  // report is ever in flight. Reports are encoded from `desiredRef` HERE, at
  // drain time, so the most recent desired value always wins.
  const drainPending: Effect.Effect<void> = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      let kind = yield* popPending;
      while (kind !== null) {
        const desired = yield* Ref.get(desiredRef);
        const report = encodeDesired(kind, desired);
        if (report !== null) {
          yield* performWrite(report);
        }
        kind = yield* popPending;
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

  const requestWrite = (kind: CodexMicroWriteKind): Effect.Effect<void> =>
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.get(stateRef);
      if (isConnected(state) && isCodexMicroWriteCapabilitySupported(config.capabilities, kind)) {
        yield* enqueuePending(kind);
      }
    });

  const replayDesiredState: Effect.Effect<void> = Effect.gen(function* () {
    const desired = yield* Ref.get(desiredRef);
    if (desired.led !== null) {
      yield* requestWrite("led");
    }
    if (desired.brightness !== null) {
      yield* requestWrite("brightness");
    }
    if (desired.autoDim !== null) {
      yield* requestWrite("autoDim");
    }
  });

  // ── Connection lifecycle ───────────────────────────────────────────

  const onConnected = (connection: CodexMicroTransport.CodexMicroConnection): Effect.Effect<void> =>
    Effect.gen(function* () {
      const unsubscribeDisconnect = connection.onDisconnect(() => {
        // Tag the event with THIS connection so a stale/duplicate loss can be
        // discarded by the event loop.
        Queue.offerUnsafe(events, { _tag: "connectionLost", connection });
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
    // Placeholder ids ⇒ fully inert: never enumerate, never leave "disconnected".
    if (idsArePlaceholder) {
      return false;
    }
    if (yield* Ref.get(closedRef)) {
      return false;
    }
    if (yield* Ref.get(suspendedRef)) {
      return false;
    }
    // A connection is still owned (connected, or degraded-awaiting-teardown).
    // The event loop owns tearing it down; refuse to race a second open.
    if ((yield* Ref.get(connectionRef)) !== null) {
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
          Effect.flatMap((connection) =>
            Effect.gen(function* () {
              // `open` is async: re-check the world once it resolves. If we were
              // closed/suspended, or another connection won the race meanwhile,
              // close this just-opened handle instead of leaking it.
              const closed = yield* Ref.get(closedRef);
              const suspended = yield* Ref.get(suspendedRef);
              const existing = yield* Ref.get(connectionRef);
              if (closed || suspended || existing !== null) {
                yield* connection.close;
                return false;
              }
              yield* onConnected(connection);
              return true;
            }),
          ),
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
    const suspended = yield* Ref.get(suspendedRef);
    const connection = yield* Ref.get(connectionRef);
    // Compute the pre-attempt delay from the current situation. Sleeping first
    // avoids re-attempting back-to-back with the synchronous initial attempt
    // that `start` runs. A live/owned connection or suspend ⇒ steady interval;
    // otherwise use the (possibly backed-off) retry delay.
    const delayMillis =
      connection !== null || suspended
        ? config.discoveryIntervalMillis
        : yield* Ref.get(backoffRef);
    yield* Effect.sleep(Duration.millis(delayMillis));

    if (yield* Ref.get(closedRef)) {
      return;
    }
    // Skip enumeration entirely while inert, suspended, or a connection is
    // still owned by the event loop.
    if (idsArePlaceholder) {
      return;
    }
    if (yield* Ref.get(suspendedRef)) {
      return;
    }
    if ((yield* Ref.get(connectionRef)) !== null) {
      return;
    }

    const connected = yield* attemptDiscovery;
    if (connected) {
      yield* Ref.set(backoffRef, config.discoveryIntervalMillis);
    } else {
      yield* Ref.update(backoffRef, (backoff) => Math.min(backoff * 2, config.maxBackoffMillis));
    }
  });

  const discoveryLoop: Effect.Effect<void> = Effect.gen(function* () {
    while (!(yield* Ref.get(closedRef))) {
      // Contain any unexpected defect in a single step: log and keep looping.
      // `discoveryStep` sleeps at its head, so the next iteration still backs
      // off rather than spinning hot. One bug must never permanently kill
      // discovery.
      yield* discoveryStep.pipe(
        Effect.catchCause((cause) => Effect.logWarning("codex-micro discovery step failed", cause)),
      );
    }
  });

  // ── Internal event loop (hot-unplug + sleep/wake) ──────────────────

  const handleEvent = (event: CodexMicroInternalEvent): Effect.Effect<void> => {
    switch (event._tag) {
      case "connectionLost":
        return Effect.gen(function* () {
          const current = yield* Ref.get(connectionRef);
          if (current !== event.connection) {
            // A delayed/duplicate loss for a handle that is no longer current.
            // Ignore it — the current handle is a different, live connection.
            yield* Effect.logDebug("codex-micro ignoring stale connectionLost");
            return;
          }
          yield* handleConnectionLoss;
        });
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
          if (yield* Ref.get(closedRef)) {
            return;
          }
          // Eager: attempt discovery immediately (subject to the same guards)
          // rather than waiting up to a full poll interval for the loop tick.
          yield* attemptDiscovery.pipe(
            Effect.tap((connected) =>
              connected ? Effect.void : Ref.set(backoffRef, config.discoveryIntervalMillis),
            ),
            Effect.asVoid,
          );
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
    // Unblock the loops so their `closedRef` checks let them exit. The event
    // payload is irrelevant — the loop returns before handling it.
    yield* Queue.offer(wake, undefined);
    yield* Queue.offer(events, { _tag: "suspend" });
  });

  const start: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    // Idempotent: a second start must not wire duplicate listeners/loops/opens.
    const alreadyStarted = yield* Ref.getAndSet(startedRef, true);
    if (alreadyStarted) {
      yield* Effect.logWarning("codex-micro start called more than once; ignoring");
      return;
    }

    // Scope finalizer: always close the HID handle + listeners on scope
    // teardown even if the host forgets to call `shutdown`. `shutdown` is
    // idempotent (getAndSet closedRef), so double-invocation is harmless.
    yield* Effect.addFinalizer(() => shutdown);

    // Wire OS sleep/wake into the internal event queue (synchronous offers).
    yield* powerMonitor.onSuspend(() => {
      Queue.offerUnsafe(events, { _tag: "suspend" });
    });
    yield* powerMonitor.onResume(() => {
      Queue.offerUnsafe(events, { _tag: "resume" });
    });

    // Fork the background loops FIRST so the event loop can process a suspend
    // that arrives while the eager initial discovery below is still in flight
    // (e.g. a slow `open`).
    yield* Effect.forkScoped(writePumpLoop);
    yield* Effect.forkScoped(eventLoop);

    // Deterministic initial discovery so state reflects the first attempt
    // without waiting on the poll loop.
    yield* attemptDiscovery.pipe(
      Effect.tap((connected) =>
        connected ? Effect.void : Ref.set(backoffRef, config.discoveryIntervalMillis),
      ),
      Effect.asVoid,
    );

    yield* Effect.forkScoped(discoveryLoop);
  });

  return CodexMicroDevice.of({
    getState: SubscriptionRef.get(stateRef),
    changes: SubscriptionRef.changes(stateRef),
    start,
    setAgentKeyColors: (frame) =>
      Effect.gen(function* () {
        yield* Ref.update(desiredRef, (desired) => ({ ...desired, led: frame }));
        yield* requestWrite("led");
      }),
    setBrightness: (percent) =>
      Effect.gen(function* () {
        const clamped = clampBrightnessPercent(percent);
        yield* Ref.update(desiredRef, (desired) => ({ ...desired, brightness: clamped }));
        yield* requestWrite("brightness");
      }),
    setAutoDim: (enabled) =>
      Effect.gen(function* () {
        yield* Ref.update(desiredRef, (desired) => ({ ...desired, autoDim: enabled }));
        yield* requestWrite("autoDim");
      }),
    shutdown,
  });
});

export const layer = Layer.effect(CodexMicroDevice, make).pipe(
  Layer.provide(CodexMicroTransport.layerNodeHid),
  Layer.provide(CodexMicroPowerMonitor.layer),
);
