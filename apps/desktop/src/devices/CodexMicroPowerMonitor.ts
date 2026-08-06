import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

/**
 * Small injected port over Electron's `powerMonitor` so the Codex Micro device
 * service can react to system sleep/wake without depending on Electron in
 * tests. Mirrors the wrapping style of the `../electron/*` services: each
 * listener registration is an `acquireRelease` that removes the listener when
 * its scope closes.
 */
export class CodexMicroPowerMonitor extends Context.Service<
  CodexMicroPowerMonitor,
  {
    /** Fires when the OS is about to suspend (sleep). */
    readonly onSuspend: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
    /** Fires when the OS resumes from suspend (wake). */
    readonly onResume: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/devices/CodexMicroPowerMonitor") {}

function subscribe(
  event: "suspend" | "resume",
  listener: () => void,
): Effect.Effect<void, never, Scope.Scope> {
  // Electron types powerMonitor.on with a narrow event-name union that omits
  // the plain "suspend"/"resume" strings under some typings; treat it as a
  // generic EventEmitter (same pattern as ../electron/ElectronUpdater.ts).
  const eventTarget = Electron.powerMonitor as unknown as {
    on: (event: string, listener: () => void) => void;
    removeListener: (event: string, listener: () => void) => void;
  };
  return Effect.acquireRelease(
    Effect.sync(() => {
      eventTarget.on(event, listener);
    }),
    () =>
      Effect.sync(() => {
        eventTarget.removeListener(event, listener);
      }),
  ).pipe(Effect.asVoid);
}

export const make = CodexMicroPowerMonitor.of({
  onSuspend: (listener) => subscribe("suspend", listener),
  onResume: (listener) => subscribe("resume", listener),
});

export const layer = Layer.succeed(CodexMicroPowerMonitor, make);
