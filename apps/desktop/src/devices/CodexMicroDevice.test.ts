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

interface FakeTransportState {
  devices: ReadonlyArray<CodexMicroTransport.CodexMicroHidDeviceInfo>;
  readonly writes: Array<ReadonlyArray<number>>;
  listCount: number;
  openCount: number;
  closeCount: number;
  disconnectListener: (() => void) | null;
  gate: Deferred.Deferred<void> | null;
  failNextWrite: boolean;
}

function makeFakeTransport(devices: ReadonlyArray<CodexMicroTransport.CodexMicroHidDeviceInfo>): {
  readonly layer: Layer.Layer<CodexMicroTransport.CodexMicroTransport>;
  readonly state: FakeTransportState;
  readonly triggerDisconnect: () => void;
} {
  const state: FakeTransportState = {
    devices,
    writes: [],
    listCount: 0,
    openCount: 0,
    closeCount: 0,
    disconnectListener: null,
    gate: null,
    failNextWrite: false,
  };

  const connection: CodexMicroTransport.CodexMicroConnection = {
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
      }),
    close: Effect.sync(() => {
      state.closeCount += 1;
      state.disconnectListener = null;
    }),
    onDisconnect: (listener) => {
      state.disconnectListener = listener;
      return () => {
        state.disconnectListener = null;
      };
    },
    onInputReport: () => () => {},
  };

  const transport = CodexMicroTransport.CodexMicroTransport.of({
    list: Effect.sync(() => {
      state.listCount += 1;
      return state.devices;
    }),
    open: () =>
      Effect.sync(() => {
        state.openCount += 1;
        return connection;
      }),
  });

  return {
    layer: Layer.succeed(CodexMicroTransport.CodexMicroTransport, transport),
    state,
    triggerDisconnect: () => state.disconnectListener?.(),
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

  it.effect("placeholder VID/PID never matches, but the service stays alive", () => {
    // A device IS present, but the config keeps the non-matching placeholder ids.
    const transport = makeFakeTransport([matchingDevice]);
    const power = makeFakePowerMonitor();
    return Effect.scoped(
      Effect.gen(function* () {
        const device = yield* makeCodexMicroDevice;
        yield* device.start;
        yield* TestClock.adjust(1_000);

        const state = yield* device.getState;
        assert.notStrictEqual(state.state, "connected");
        assert.strictEqual(transport.state.openCount, 0);
        // Enumeration ran (service alive) but nothing matched.
        assert.isTrue(transport.state.listCount >= 1);
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
});
