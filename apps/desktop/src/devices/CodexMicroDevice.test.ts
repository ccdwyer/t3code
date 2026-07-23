import type {
  CodexMicroCapabilities,
  CodexMicroDeviceState,
  CodexMicroLedColor,
  CodexMicroLedFrame,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  CodexMicroDeviceConfig,
  make as makeCodexMicroDevice,
  type CodexMicroDeviceConfigValue,
} from "./CodexMicroDevice.ts";
import * as CodexMicroPowerMonitor from "./CodexMicroPowerMonitor.ts";
import * as CodexMicroTransport from "./CodexMicroTransport.ts";
import {
  UNVERIFIED_CODEX_MICRO_CAPABILITIES,
  encodeBrightnessReport,
  encodeLedFrameReport,
} from "./codexMicroMachine.ts";

// ── Fixtures ─────────────────────────────────────────────────────────

const REAL_IDS = { vendorId: 0x1234, productId: 0x5678 } as const;

const matchingDevice: CodexMicroTransport.CodexMicroHidDeviceInfo = {
  path: "hid:/codex-micro",
  vendorId: REAL_IDS.vendorId,
  productId: REAL_IDS.productId,
  product: "Codex Micro",
  manufacturer: "Work Louder",
  serialNumber: "CM-0001",
};

function color(r: number, g: number, b: number): CodexMicroLedColor {
  return { r, g, b };
}

function solidFrame(c: CodexMicroLedColor): CodexMicroLedFrame {
  return Array.from({ length: 6 }, () => ({ effect: "solid" as const, color: c }));
}

function makeConfig(
  overrides: Partial<CodexMicroDeviceConfigValue> = {},
): CodexMicroDeviceConfigValue {
  return {
    usbIds: REAL_IDS,
    capabilities: UNVERIFIED_CODEX_MICRO_CAPABILITIES,
    discoveryIntervalMillis: 100,
    maxBackoffMillis: 1_000,
    ...overrides,
  };
}

const allSupportedCapabilities: CodexMicroCapabilities = {
  viaRawHid: "supported",
  ledWrite: "supported",
  battery: "supported",
  brightness: "supported",
  autoDim: "supported",
};

// ── Fake transport ───────────────────────────────────────────────────

// One open handle. Each `open` mints a fresh record so tests can address a
// SPECIFIC connection's disconnect listener / write behaviour independently —
// the whole point of the connection-identity race coverage.
interface FakeConnectionRecord {
  connection: CodexMicroTransport.CodexMicroConnection;
  /** Persistent copy of the installed disconnect listener; NOT cleared on
   * unsubscribe/close so a test can re-fire it to simulate a delayed/duplicate
   * hot-unplug event arriving after the handle was already replaced. */
  installedListener: (() => void) | null;
  closed: boolean;
  /** Fail this connection's next write AFTER it passes the shared gate. */
  failAfterGate: boolean;
}

interface FakeTransportState {
  devices: ReadonlyArray<CodexMicroTransport.CodexMicroHidDeviceInfo>;
  readonly writes: Array<ReadonlyArray<number>>;
  listCount: number;
  /** Opens that have fully completed (past any open-gate). */
  openCount: number;
  /** Opens that have STARTED (before the open-gate) — for late-open tests. */
  openStarted: number;
  closeCount: number;
  readonly connections: Array<FakeConnectionRecord>;
  /** Blocks every in-flight write until resolved. */
  gate: Deferred.Deferred<void> | null;
  /** Blocks every `open` until resolved (late-open-after-suspend coverage). */
  openGate: Deferred.Deferred<void> | null;
  failNextWrite: boolean;
}

function makeFakeTransport(devices: ReadonlyArray<CodexMicroTransport.CodexMicroHidDeviceInfo>): {
  readonly layer: Layer.Layer<CodexMicroTransport.CodexMicroTransport>;
  readonly state: FakeTransportState;
  readonly triggerDisconnect: () => void;
  readonly triggerDisconnectFor: (index: number) => void;
} {
  const state: FakeTransportState = {
    devices,
    writes: [],
    listCount: 0,
    openCount: 0,
    openStarted: 0,
    closeCount: 0,
    connections: [],
    gate: null,
    openGate: null,
    failNextWrite: false,
  };

  const makeConnectionRecord = (): FakeConnectionRecord => {
    const record: FakeConnectionRecord = {
      connection: undefined as unknown as CodexMicroTransport.CodexMicroConnection,
      installedListener: null,
      closed: false,
      failAfterGate: false,
    };
    record.connection = {
      write: (report) =>
        Effect.gen(function* () {
          state.writes.push(report);
          if (state.failNextWrite) {
            state.failNextWrite = false;
            return yield* new CodexMicroTransport.CodexMicroTransportError({
              operation: "write",
              cause: new Error("device unplugged mid-write"),
            });
          }
          if (state.gate !== null) {
            yield* Deferred.await(state.gate);
          }
          if (record.failAfterGate) {
            record.failAfterGate = false;
            return yield* new CodexMicroTransport.CodexMicroTransportError({
              operation: "write",
              cause: new Error("stale connection write failed after gate"),
            });
          }
        }),
      close: Effect.sync(() => {
        if (!record.closed) {
          record.closed = true;
          state.closeCount += 1;
        }
      }),
      onDisconnect: (listener) => {
        record.installedListener = listener;
        return () => {
          // Unsubscribe of the LIVE wiring; the persistent copy stays so tests
          // can still simulate a late duplicate event.
        };
      },
      onInputReport: () => () => {},
    };
    return record;
  };

  const transport = CodexMicroTransport.CodexMicroTransport.of({
    list: Effect.sync(() => {
      state.listCount += 1;
      return state.devices;
    }),
    open: () =>
      Effect.gen(function* () {
        state.openStarted += 1;
        if (state.openGate !== null) {
          yield* Deferred.await(state.openGate);
        }
        const record = makeConnectionRecord();
        state.connections.push(record);
        state.openCount += 1;
        return record.connection;
      }),
  });

  return {
    layer: Layer.succeed(CodexMicroTransport.CodexMicroTransport, transport),
    state,
    triggerDisconnect: () => state.connections.at(-1)?.installedListener?.(),
    triggerDisconnectFor: (index) => state.connections[index]?.installedListener?.(),
  };
}

// ── Fake power monitor ───────────────────────────────────────────────

function makeFakePowerMonitor(): {
  readonly layer: Layer.Layer<CodexMicroPowerMonitor.CodexMicroPowerMonitor>;
  readonly triggerSuspend: () => void;
  readonly triggerResume: () => void;
} {
  let suspendListener: (() => void) | null = null;
  let resumeListener: (() => void) | null = null;

  const monitor = CodexMicroPowerMonitor.CodexMicroPowerMonitor.of({
    onSuspend: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          suspendListener = listener;
        }),
        () =>
          Effect.sync(() => {
            suspendListener = null;
          }),
      ).pipe(Effect.asVoid),
    onResume: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          resumeListener = listener;
        }),
        () =>
          Effect.sync(() => {
            resumeListener = null;
          }),
      ).pipe(Effect.asVoid),
  });

  return {
    layer: Layer.succeed(CodexMicroPowerMonitor.CodexMicroPowerMonitor, monitor),
    triggerSuspend: () => suspendListener?.(),
    triggerResume: () => resumeListener?.(),
  };
}

// ── Test harness ─────────────────────────────────────────────────────

function harnessLayer(args: {
  readonly transport: Layer.Layer<CodexMicroTransport.CodexMicroTransport>;
  readonly power: Layer.Layer<CodexMicroPowerMonitor.CodexMicroPowerMonitor>;
  readonly config: CodexMicroDeviceConfigValue;
}): Layer.Layer<
  CodexMicroTransport.CodexMicroTransport | CodexMicroPowerMonitor.CodexMicroPowerMonitor
> {
  return Layer.mergeAll(
    TestClock.layer(),
    args.transport,
    args.power,
    Layer.succeed(CodexMicroDeviceConfig, args.config),
  );
}

// Poll a synchronous predicate, yielding between checks so forked pump/event
// fibers can make progress. Dies loudly on timeout (no tautological passes).
const waitUntil = (predicate: () => boolean, label: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      if (predicate()) {
        return;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(`waitUntil timed out: ${label}`);
  });

// Fork a collector of state transitions into a plain array read synchronously
// by predicates. Subscribe before `start` so the whole sequence is captured.
const trackStates = (
  changes: Stream.Stream<CodexMicroDeviceState>,
): Effect.Effect<ReadonlyArray<CodexMicroDeviceState>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const seen: Array<CodexMicroDeviceState> = [];
    yield* Effect.forkScoped(
      Stream.runForEach(changes, (state) =>
        Effect.sync(() => {
          seen.push(state);
        }),
      ),
    );
    return seen;
  });

const lastStateName = (seen: ReadonlyArray<CodexMicroDeviceState>): string | undefined =>
  seen.at(-1)?.state;

describe("CodexMicroDevice", () => {
  it.effect("connects to a matching device on start", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        yield* device.start;

        const state = yield* device.getState;
        assert.strictEqual(state.state, "connected");
        assert.strictEqual(state.transport, "usb");
        assert.strictEqual(state.batteryPercent, null); // battery unverified
        assert.strictEqual(transport.state.openCount, 1);
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({ transport: transport.layer, power: power.layer, config: makeConfig() }),
      ),
    );
  });

  it.effect("hot-unplug returns to discovering, then reconnects", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        const seen = yield* trackStates(device.changes);
        yield* device.start;
        yield* waitUntil(() => transport.state.openCount === 1, "initial connect");

        transport.triggerDisconnect();
        yield* waitUntil(
          () => seen.some((state) => state.state === "discovering"),
          "returns to discovering after unplug",
        );
        assert.strictEqual(transport.state.closeCount, 1);

        // The device is still enumerable; let the poll loop find it again.
        yield* TestClock.adjust(500);
        yield* waitUntil(() => transport.state.openCount === 2, "reconnect");

        const state = yield* device.getState;
        assert.strictEqual(state.state, "connected");
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({ transport: transport.layer, power: power.layer, config: makeConfig() }),
      ),
    );
  });

  it.effect("serialized writes coalesce to first + last while one is in flight", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    const first = solidFrame(color(10, 0, 0));
    const second = solidFrame(color(0, 20, 0));
    const third = solidFrame(color(0, 0, 30));
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        yield* device.start;
        yield* waitUntil(() => transport.state.openCount === 1, "connect");

        // Block the first write in flight.
        const gate = yield* Deferred.make<void>();
        transport.state.gate = gate;

        yield* device.setAgentKeyColors(first);
        yield* waitUntil(() => transport.state.writes.length === 1, "first write in flight");

        // These two coalesce while the pump is blocked: only the last survives.
        yield* device.setAgentKeyColors(second);
        yield* device.setAgentKeyColors(third);

        yield* Deferred.succeed(gate, undefined);
        yield* waitUntil(() => transport.state.writes.length === 2, "coalesced last write");
        // Let the pump settle; no extra writes should appear.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        assert.strictEqual(transport.state.writes.length, 2);
        assert.deepEqual(transport.state.writes[0], encodeLedFrameReport(first));
        assert.deepEqual(transport.state.writes[1], encodeLedFrameReport(third));
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({
          transport: transport.layer,
          power: power.layer,
          config: makeConfig({ capabilities: allSupportedCapabilities }),
        }),
      ),
    );
  });

  it.effect("write failure mid-session degrades then recovers", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        const seen = yield* trackStates(device.changes);
        yield* device.start;
        yield* waitUntil(() => transport.state.openCount === 1, "connect");

        transport.state.failNextWrite = true;
        yield* device.setBrightness(80);

        yield* waitUntil(
          () => seen.some((state) => state.state === "degraded"),
          "degrades on write failure",
        );

        // Recovers on the next poll tick — no unhandled rejection.
        yield* TestClock.adjust(500);
        yield* waitUntil(() => transport.state.openCount === 2, "recovers");
        const state = yield* device.getState;
        assert.strictEqual(state.state, "connected");
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({
          transport: transport.layer,
          power: power.layer,
          config: makeConfig({ capabilities: allSupportedCapabilities }),
        }),
      ),
    );
  });

  it.effect("replays desired LED frame and brightness on reconnect", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    const frame = solidFrame(color(5, 6, 7));
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        yield* device.start;
        yield* waitUntil(() => transport.state.openCount === 1, "connect");

        yield* device.setAgentKeyColors(frame);
        yield* device.setBrightness(42);
        yield* waitUntil(() => transport.state.writes.length === 2, "initial writes");

        // Drop the connection and clear the observed writes.
        transport.triggerDisconnect();
        yield* waitUntil(() => transport.state.closeCount === 1, "disconnected");
        transport.state.writes.length = 0;

        yield* TestClock.adjust(500);
        yield* waitUntil(() => transport.state.openCount === 2, "reconnect");
        yield* waitUntil(() => transport.state.writes.length === 2, "desired-state replay");

        const reports = [...transport.state.writes];
        assert.deepEqual(
          reports.find((report) => report[0] === encodeLedFrameReport(frame)[0]),
          encodeLedFrameReport(frame),
        );
        assert.deepEqual(
          reports.find((report) => report[0] === encodeBrightnessReport(42)[0]),
          encodeBrightnessReport(42),
        );
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({
          transport: transport.layer,
          power: power.layer,
          config: makeConfig({ capabilities: allSupportedCapabilities }),
        }),
      ),
    );
  });

  it.effect("suspend stops polling; resume triggers re-discovery", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        const seen = yield* trackStates(device.changes);
        yield* device.start;
        yield* waitUntil(() => transport.state.openCount === 1, "connect");

        power.triggerSuspend();
        yield* waitUntil(() => lastStateName(seen) === "disconnected", "quiesced on suspend");

        // While suspended, the poll loop must not enumerate or open.
        const listCountAfterSuspend = transport.state.listCount;
        yield* TestClock.adjust(1_000);
        assert.strictEqual(transport.state.listCount, listCountAfterSuspend);
        assert.strictEqual(transport.state.openCount, 1);

        power.triggerResume();
        yield* TestClock.adjust(500);
        yield* waitUntil(() => transport.state.openCount === 2, "re-discovery on resume");
        const state = yield* device.getState;
        assert.strictEqual(state.state, "connected");
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({ transport: transport.layer, power: power.layer, config: makeConfig() }),
      ),
    );
  });

  it.effect("capability-gated writes no-op when capabilities are unverified", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        yield* device.start;
        yield* waitUntil(() => transport.state.openCount === 1, "connect");

        // Default capabilities are all "unverified" → smart writes are no-ops.
        yield* device.setBrightness(55);
        yield* device.setAgentKeyColors(solidFrame(color(1, 2, 3)));
        yield* device.setAutoDim(true);

        // Give any (erroneously enqueued) pump work a chance to run.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        assert.strictEqual(transport.state.writes.length, 0);
        const state = yield* device.getState;
        assert.strictEqual(state.state, "connected");
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({ transport: transport.layer, power: power.layer, config: makeConfig() }),
      ),
    );
  });

  it.effect("placeholder VID/PID: fully inert — never enumerates, stays disconnected", () => {
    // A device IS present, but the config keeps the non-matching placeholder ids.
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        yield* device.start;
        yield* TestClock.adjust(10_000);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const state = yield* device.getState;
        // Placeholder ids must keep the service HONESTLY disconnected: no
        // enumeration at all (a settings page would otherwise show "searching…"
        // forever), never a flip to "discovering", never an open.
        assert.strictEqual(state.state, "disconnected");
        assert.strictEqual(transport.state.openCount, 0);
        assert.strictEqual(transport.state.listCount, 0);
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({
          transport: transport.layer,
          power: power.layer,
          config: makeConfig({ usbIds: { vendorId: 0x0000, productId: 0x0000 } }),
        }),
      ),
    );
  });

  it.effect("shutdown closes the transport and enters the closed state", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        yield* device.start;
        yield* waitUntil(() => transport.state.openCount === 1, "connect");

        yield* device.shutdown;
        const state = yield* device.getState;
        assert.strictEqual(state.state, "closed");
        assert.strictEqual(transport.state.closeCount, 1);
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({ transport: transport.layer, power: power.layer, config: makeConfig() }),
      ),
    );
  });

  // A: the discovery loop must actually END on shutdown (no immortal
  // sleep/wake fiber that keeps enumerating forever).
  it.effect("after shutdown the discovery loop stops enumerating and writing", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        yield* device.start;
        yield* waitUntil(() => transport.state.openCount === 1, "connect");

        yield* device.shutdown;
        const listAfterShutdown = transport.state.listCount;
        const writesAfterShutdown = transport.state.writes.length;

        // Advance the clock far beyond any poll interval / backoff ceiling.
        yield* TestClock.adjust(60_000);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        assert.strictEqual(transport.state.listCount, listAfterShutdown);
        assert.strictEqual(transport.state.writes.length, writesAfterShutdown);
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({
          transport: transport.layer,
          power: power.layer,
          config: makeConfig({ capabilities: allSupportedCapabilities }),
        }),
      ),
    );
  });

  // C1: a delayed/duplicate hot-unplug event for a handle that has since been
  // replaced must NOT tear down the current, live handle.
  it.effect("stale connectionLost for a replaced handle is ignored", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        yield* device.start;
        yield* waitUntil(() => transport.state.openCount === 1, "connect A");
        // Connection A is index 0.

        // Unplug A, then let the poll loop find & open connection B (index 1).
        transport.triggerDisconnect();
        yield* waitUntil(() => transport.state.closeCount === 1, "A closed");
        yield* TestClock.adjust(500);
        yield* waitUntil(() => transport.state.openCount === 2, "reconnect B");
        const connectedState = yield* device.getState;
        assert.strictEqual(connectedState.state, "connected");

        const closeCountBeforeStale = transport.state.closeCount;

        // Fire A's ORIGINAL disconnect listener again — a delayed duplicate.
        transport.triggerDisconnectFor(0);
        // Give the event loop several turns to (wrongly) act on it.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const finalState = yield* device.getState;
        assert.strictEqual(finalState.state, "connected");
        // B must not have been closed by A's stale event.
        assert.strictEqual(transport.state.closeCount, closeCountBeforeStale);
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({ transport: transport.layer, power: power.layer, config: makeConfig() }),
      ),
    );
  });

  // C2: a write that fails on a connection which is no longer current must be
  // swallowed silently — no phantom `degraded`, and the live handle survives.
  it.effect("stale write failure does not degrade the live connection", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        const seen = yield* trackStates(device.changes);
        yield* device.start;
        yield* waitUntil(() => transport.state.openCount === 1, "connect A");

        // Gate the write so it stays in flight on connection A.
        const gate = yield* Deferred.make<void>();
        transport.state.gate = gate;
        yield* device.setBrightness(50);
        yield* waitUntil(() => transport.state.writes.length === 1, "A write in flight");

        // Unplug A while its write is still pending, then reconnect B.
        transport.triggerDisconnect();
        yield* waitUntil(() => transport.state.closeCount === 1, "A closed");
        yield* TestClock.adjust(500);
        yield* waitUntil(() => transport.state.openCount === 2, "reconnect B");
        yield* waitUntil(() => lastStateName(seen) === "connected", "B connected");
        const connectedIndex = seen.length;

        // Now make A's gated write FAIL, then release it.
        transport.state.connections[0]!.failAfterGate = true;
        yield* Deferred.succeed(gate, undefined);
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const finalState = yield* device.getState;
        assert.strictEqual(finalState.state, "connected");
        // No `degraded` may appear AFTER B connected — the failure was stale.
        const afterB = seen.slice(connectedIndex);
        assert.isFalse(afterB.some((state) => state.state === "degraded"));
        // B (index 1) was never closed.
        assert.strictEqual(transport.state.closeCount, 1);
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({
          transport: transport.layer,
          power: power.layer,
          config: makeConfig({ capabilities: allSupportedCapabilities }),
        }),
      ),
    );
  });

  // C3: an `open` that resolves AFTER a suspend must not leak — the late handle
  // is closed and the device does not end up connected.
  it.effect("late open after suspend is closed and does not connect", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        // Gate every open BEFORE start so the eager initial open is in flight.
        const openGate = yield* Deferred.make<void>();
        transport.state.openGate = openGate;

        const device = yield* makeCodexMicroDevice;
        const seen = yield* trackStates(device.changes);
        // Fork start: its eager attempt will block on the gated open, but the
        // forked loops (incl. the event loop) still run.
        yield* Effect.forkScoped(device.start);
        yield* waitUntil(() => transport.state.openStarted === 1, "open in flight");
        // The eager attempt flips to "discovering" before it blocks on open.
        yield* waitUntil(
          () => seen.some((state) => state.state === "discovering"),
          "discovering while open in flight",
        );

        // Suspend arrives while open is still in flight; wait for it to quiesce.
        power.triggerSuspend();
        yield* waitUntil(() => lastStateName(seen) === "disconnected", "suspend processed");

        // Release the open — the connection resolves post-suspend.
        yield* Deferred.succeed(openGate, undefined);
        yield* waitUntil(() => transport.state.openCount === 1, "open resolved");
        yield* waitUntil(() => transport.state.closeCount === 1, "late handle closed");
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        const finalState = yield* device.getState;
        assert.notStrictEqual(finalState.state, "connected");
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({ transport: transport.layer, power: power.layer, config: makeConfig() }),
      ),
    );
  });

  // D: encode-at-drain — a newer setter wins over the replayed value even when
  // the replayed write is already in flight.
  it.effect("replay vs concurrent setter: last brightness on the wire is the new value", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        yield* device.start;
        yield* waitUntil(() => transport.state.openCount === 1, "connect");

        // Establish desired brightness = 10 and let it write ungated.
        yield* device.setBrightness(10);
        yield* waitUntil(() => transport.state.writes.length === 1, "initial brightness write");
        const writesBefore = transport.state.writes.length;

        // Now gate writes, drop the connection, and let it reconnect → replay.
        const gate = yield* Deferred.make<void>();
        transport.state.gate = gate;
        transport.triggerDisconnect();
        yield* waitUntil(() => transport.state.closeCount === 1, "disconnected");
        yield* TestClock.adjust(500);
        yield* waitUntil(() => transport.state.openCount === 2, "reconnect");
        // The replayed brightness(10) write is now in flight, blocked on gate.
        yield* waitUntil(
          () => transport.state.writes.length === writesBefore + 1,
          "replayed write in flight",
        );

        // While the replay is gated, a newer setter changes brightness to 20.
        yield* device.setBrightness(20);
        yield* Deferred.succeed(gate, undefined);
        yield* waitUntil(
          () => transport.state.writes.length === writesBefore + 2,
          "second brightness write drained",
        );
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        // Exactly two writes after the initial: replayed 10, then coalesced 20.
        assert.strictEqual(transport.state.writes.length, writesBefore + 2);
        assert.deepEqual(transport.state.writes[writesBefore], encodeBrightnessReport(10));
        assert.deepEqual(transport.state.writes[writesBefore + 1], encodeBrightnessReport(20));
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({
          transport: transport.layer,
          power: power.layer,
          config: makeConfig({ capabilities: allSupportedCapabilities }),
        }),
      ),
    );
  });

  // F: resume re-discovers eagerly, without waiting a full poll interval.
  it.effect("resume re-discovers eagerly without advancing the clock", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        yield* device.start;
        yield* waitUntil(() => transport.state.openCount === 1, "connect");

        power.triggerSuspend();
        yield* waitUntil(() => transport.state.closeCount === 1, "quiesced on suspend");

        // Resume, then WITHOUT any TestClock.adjust, discovery must reconnect.
        power.triggerResume();
        yield* waitUntil(() => transport.state.openCount === 2, "eager re-discovery on resume");
        const state = yield* device.getState;
        assert.strictEqual(state.state, "connected");
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({ transport: transport.layer, power: power.layer, config: makeConfig() }),
      ),
    );
  });

  // H: a second `start` is a warned no-op — no duplicate opens or state churn.
  it.effect("start is idempotent — a second call opens nothing new", () => {
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        const seen = yield* trackStates(device.changes);
        yield* device.start;
        yield* waitUntil(() => transport.state.openCount === 1, "connect");
        // Wait for the connected emission to reach the collector before
        // capturing the baseline — the open precedes the state broadcast.
        yield* waitUntil(
          () => seen.some((state) => state.state === "connected"),
          "connected state observed",
        );
        const connectedTransitions = seen.filter((state) => state.state === "connected").length;

        // Second start must no-op.
        yield* device.start;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        assert.strictEqual(transport.state.openCount, 1);
        assert.strictEqual(transport.state.listCount, 1);
        assert.strictEqual(
          seen.filter((state) => state.state === "connected").length,
          connectedTransitions,
        );
      }),
    ).pipe(
      Effect.provide(
        harnessLayer({ transport: transport.layer, power: power.layer, config: makeConfig() }),
      ),
    );
  });
});
