import { it as effectIt } from "@effect/vitest";
import {
  CodexMicroDeviceState,
  type CodexMicroLedFrame,
  type CodexMicroLedSlot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as CodexMicroDevice from "../../devices/CodexMicroDevice.ts";
import { UNVERIFIED_CODEX_MICRO_CAPABILITIES } from "../../devices/codexMicroMachine.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as CodexMicroIpc from "./codexMicro.ts";

const disconnectedState: CodexMicroDeviceState = {
  state: "disconnected",
  transport: null,
  batteryPercent: null,
  capabilities: UNVERIFIED_CODEX_MICRO_CAPABILITIES,
};

const connectedState: CodexMicroDeviceState = {
  state: "connected",
  transport: "usb",
  batteryPercent: null,
  capabilities: UNVERIFIED_CODEX_MICRO_CAPABILITIES,
};

const slot: CodexMicroLedSlot = { effect: "off", color: { r: 0, g: 0, b: 0 } };
const sixSlotFrame: CodexMicroLedFrame = [slot, slot, slot, slot, slot, slot];
const fiveSlotFrame = [slot, slot, slot, slot, slot];

interface RecordedCalls {
  readonly led: CodexMicroLedFrame[];
  readonly brightness: number[];
  readonly autoDim: boolean[];
}

const makeFakeDevice = (
  overrides: {
    readonly state?: CodexMicroDeviceState;
    readonly changes?: Stream.Stream<CodexMicroDeviceState>;
  } = {},
): {
  readonly service: CodexMicroDevice.CodexMicroDevice["Service"];
  readonly calls: RecordedCalls;
} => {
  const calls: RecordedCalls = { led: [], brightness: [], autoDim: [] };
  const service = CodexMicroDevice.CodexMicroDevice.of({
    getState: Effect.succeed(overrides.state ?? disconnectedState),
    changes: overrides.changes ?? Stream.empty,
    start: Effect.void,
    shutdown: Effect.void,
    setAgentKeyColors: (frame) => Effect.sync(() => void calls.led.push(frame)),
    setBrightness: (percent) => Effect.sync(() => void calls.brightness.push(percent)),
    setAutoDim: (enabled) => Effect.sync(() => void calls.autoDim.push(enabled)),
  });
  return { service, calls };
};

describe("codex micro IPC methods", () => {
  effectIt.effect("get-state returns the encoded device state", () =>
    Effect.gen(function* () {
      const { service } = makeFakeDevice({ state: connectedState });
      const encoded = yield* CodexMicroIpc.getState
        .handler(undefined)
        .pipe(Effect.provideService(CodexMicroDevice.CodexMicroDevice, service));
      const expected = yield* Schema.encodeUnknownEffect(CodexMicroDeviceState)(connectedState);
      expect(encoded).toStrictEqual(expected);
    }),
  );

  effectIt.effect("set-brightness rejects out-of-range / non-integer / NaN values", () =>
    Effect.gen(function* () {
      const { service } = makeFakeDevice();
      for (const invalid of [101, 3.5, Number.NaN]) {
        const exit = yield* CodexMicroIpc.setBrightness
          .handler(invalid)
          .pipe(Effect.provideService(CodexMicroDevice.CodexMicroDevice, service), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const error = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
        }
      }
    }),
  );

  effectIt.effect("set-brightness accepts the 0 and 100 bounds and forwards them", () =>
    Effect.gen(function* () {
      const { service, calls } = makeFakeDevice();
      for (const valid of [0, 100]) {
        yield* CodexMicroIpc.setBrightness
          .handler(valid)
          .pipe(Effect.provideService(CodexMicroDevice.CodexMicroDevice, service));
      }
      expect(calls.brightness).toStrictEqual([0, 100]);
    }),
  );

  effectIt.effect("set-agent-key-colors rejects a 5-slot frame", () =>
    Effect.gen(function* () {
      const { service } = makeFakeDevice();
      const exit = yield* CodexMicroIpc.setAgentKeyColors
        .handler(fiveSlotFrame)
        .pipe(Effect.provideService(CodexMicroDevice.CodexMicroDevice, service), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(error) && Schema.isSchemaError(error.value)).toBe(true);
      }
    }),
  );

  effectIt.effect("set-agent-key-colors accepts a 6-slot frame and forwards it", () =>
    Effect.gen(function* () {
      const { service, calls } = makeFakeDevice();
      yield* CodexMicroIpc.setAgentKeyColors
        .handler(sixSlotFrame)
        .pipe(Effect.provideService(CodexMicroDevice.CodexMicroDevice, service));
      expect(calls.led).toHaveLength(1);
      expect(calls.led[0]).toHaveLength(6);
    }),
  );

  effectIt.effect("set-auto-dim forwards the decoded boolean", () =>
    Effect.gen(function* () {
      const { service, calls } = makeFakeDevice();
      yield* CodexMicroIpc.setAutoDim
        .handler(true)
        .pipe(Effect.provideService(CodexMicroDevice.CodexMicroDevice, service));
      expect(calls.autoDim).toStrictEqual([true]);
    }),
  );

  effectIt.effect("broadcast forwards each changes-stream state, encoded, to all windows", () =>
    Effect.gen(function* () {
      const received = yield* Deferred.make<{
        readonly channel: string;
        readonly payload: unknown;
      }>();
      const { service } = makeFakeDevice({ changes: Stream.make(connectedState) });
      // Minimal ElectronWindow stub: only sendAll is exercised by the broadcast.
      const fakeWindow = {
        sendAll: (channel: string, ...args: readonly unknown[]) =>
          Deferred.succeed(received, { channel, payload: args[0] ?? null }).pipe(Effect.asVoid),
      } as unknown as ElectronWindow.ElectronWindow["Service"];

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* CodexMicroIpc.installCodexMicroStateForwarding().pipe(
            Effect.provideService(CodexMicroDevice.CodexMicroDevice, service),
            Effect.provideService(ElectronWindow.ElectronWindow, fakeWindow),
          );
          const got = yield* Deferred.await(received);
          const expected = yield* Schema.encodeUnknownEffect(CodexMicroDeviceState)(connectedState);
          expect(got.channel).toBe(IpcChannels.CODEX_MICRO_STATE_CHANNEL);
          expect(got.payload).toStrictEqual(expected);
        }),
      );
    }),
  );
});
