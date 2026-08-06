/**
 * Codex Micro — push persisted device preferences on (re)connect.
 *
 * The brightness / auto-dim client settings are the source of truth, but the
 * device only learns them when the user touches a control. That means a fresh
 * connect (app launch, hot-plug, wake) leaves the pad on its firmware defaults
 * until the user interacts. This headless hook closes that gap: on each
 * transition INTO the `connected` state it pushes the current `codexMicro`
 * brightness + auto-dim once. Every write is capability-gated in the device
 * service, so this is safe even before the D1 lighting capabilities are proven.
 *
 * Mounted once (via `CodexMicroHost` in apps/web/src/routes/__root.tsx) and
 * inert when the desktop bridge is absent.
 *
 * @module codexMicroPrefsSync
 */
import { useEffect, useRef } from "react";

import { useClientSettings } from "./hooks/useSettings";

export function useCodexMicroPrefsSync(): void {
  const brightness = useClientSettings((settings) => settings.codexMicroBrightness);
  const autoDim = useClientSettings((settings) => settings.codexMicroAutoDim);

  // Keep the latest persisted prefs in a ref so the once-only subscription
  // always pushes current values without resubscribing on every settings edit.
  const latestRef = useRef({ brightness, autoDim });
  latestRef.current = { brightness, autoDim };

  useEffect(() => {
    const bridge = window.desktopBridge?.codexMicro;
    if (!bridge) return;

    // Track the connected edge so prefs are pushed once per connect TRANSITION
    // (disconnected/degraded → connected), not on every state emission. The
    // replay-on-subscribe first emission counts, so an already-connected pad is
    // handled immediately.
    let wasConnected = false;
    const unsubscribe = bridge.onStateChange((state) => {
      const isConnected = state.state === "connected";
      if (isConnected && !wasConnected) {
        void bridge.setBrightness(latestRef.current.brightness).catch(() => {
          // IPC/decode failures only; nothing the prefs layer can do.
        });
        void bridge.setAutoDim(latestRef.current.autoDim).catch(() => {
          // IPC/decode failures only; nothing the prefs layer can do.
        });
      }
      wasConnected = isConnected;
    });
    return unsubscribe;
  }, []);
}
