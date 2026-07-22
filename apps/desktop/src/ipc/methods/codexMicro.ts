import {
  CodexMicroBrightnessValue,
  CodexMicroDeviceState,
  CodexMicroLedFrame,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CodexMicroDevice from "../../devices/CodexMicroDevice.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/**
 * Wire the Codex Micro device service into the desktop app lifecycle:
 *
 *  - fork a scoped consumer of the service's `changes` stream that broadcasts
 *    every device-state change (encoded via the contract schema) to all
 *    renderer windows on `CODEX_MICRO_STATE_CHANNEL` — the push side of the
 *    renderer's replay-on-subscribe contract;
 *  - register a scope finalizer that shuts the device (transport) down cleanly
 *    on app quit, then start discovery + the background loops under that scope.
 *
 * Mirrors `installPreviewEventForwarding`; requires `Scope` (supplied by the
 * same caller that registers the invoke handlers).
 */
export const installCodexMicroStateForwarding = Effect.fn(
  "desktop.ipc.codexMicro.installStateForwarding",
)(function* () {
  const device = yield* CodexMicroDevice.CodexMicroDevice;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const encodeState = Schema.encodeUnknownEffect(CodexMicroDeviceState);

  // `changes` is SubscriptionRef-backed: it replays the current state on
  // subscribe, then emits each change. Encode each and fan it out to every
  // live window. A broadcast failure must never tear the loop down.
  yield* Effect.forkScoped(
    device.changes.pipe(
      Stream.runForEach((state) =>
        encodeState(state).pipe(
          Effect.flatMap((encoded) =>
            electronWindow.sendAll(IpcChannels.CODEX_MICRO_STATE_CHANNEL, encoded),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("codex-micro state broadcast failed", cause),
          ),
        ),
      ),
    ),
  );

  // Registered before `start` so it runs AFTER the forked loops are torn down
  // on scope close, closing the transport last.
  yield* Effect.addFinalizer(() => device.shutdown);
  yield* device.start;
});

export const getState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CODEX_MICRO_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: CodexMicroDeviceState,
  handler: Effect.fn("desktop.ipc.codexMicro.getState")(function* () {
    const device = yield* CodexMicroDevice.CodexMicroDevice;
    return yield* device.getState;
  }),
});

export const setAgentKeyColors = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CODEX_MICRO_SET_AGENT_KEY_COLORS_CHANNEL,
  payload: CodexMicroLedFrame,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.codexMicro.setAgentKeyColors")(function* (frame) {
    const device = yield* CodexMicroDevice.CodexMicroDevice;
    yield* device.setAgentKeyColors(frame);
  }),
});

export const setBrightness = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CODEX_MICRO_SET_BRIGHTNESS_CHANNEL,
  payload: CodexMicroBrightnessValue,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.codexMicro.setBrightness")(function* (percent) {
    const device = yield* CodexMicroDevice.CodexMicroDevice;
    yield* device.setBrightness(percent);
  }),
});

export const setAutoDim = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CODEX_MICRO_SET_AUTO_DIM_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.codexMicro.setAutoDim")(function* (enabled) {
    const device = yield* CodexMicroDevice.CodexMicroDevice;
    yield* device.setAutoDim(enabled);
  }),
});

export const methods = [getState, setAgentKeyColors, setBrightness, setAutoDim] as const;
