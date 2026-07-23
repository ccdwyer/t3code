import { useEffect, useMemo, useRef, useState } from "react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useShallow } from "zustand/react/shallow";

import {
  rankThreadsForAgentKeys,
  setAgentKeyRankedThreads,
  useAgentKeySlots,
} from "./agentKeySlots";
import {
  createLedFramePusher,
  isLedSyncActive,
  ledFrameForSlots,
  resolveLedHostGate,
  type CodexMicroLedStatusInput,
  type LedFramePusher,
} from "./codexMicroLedSync";
import { useClientSettings } from "./hooks/useSettings";
import { useThreadShells } from "./state/entities";
import { useUiStateStore } from "./uiStateStore";

// ── Headless LED sync host (T8) ─────────────────────────────────────────
//
// Wires live app state → the Codex Micro agent-key LEDs:
//
//   thread shells (cross-environment, `useThreadShells`)
//     → rankThreadsForAgentKeys → setAgentKeyRankedThreads   (feeds the store)
//     → useAgentKeySlots                                      (the six slots)
//     → per-slot status inputs (incl. lastVisitedAt from uiStateStore)
//     → ledFrameForSlots (pure mapping, reuses resolveThreadStatusPill)
//     → coalesced push to DesktopBridge.codexMicro.setAgentKeyColors
//
// Renders nothing. Mount ONCE, high in the authenticated app tree (see the
// mount note at the bottom of this file). Gated by the desktop bridge's
// presence, the `codexMicroLedSyncEnabled` client setting, AND the device's
// `ledWrite === "supported"` capability (B1); when it is inactive it pushes a
// single all-off frame (incl. the cold-disabled case, B2) and stops.

function codexMicroBridge() {
  if (typeof window === "undefined") return undefined;
  return window.desktopBridge?.codexMicro;
}

export function CodexMicroLedSyncHost(): null {
  const enabled = useClientSettings((settings) => settings.codexMicroLedSyncEnabled);
  const threads = useThreadShells();

  // Feed the shared slot store from the recency ranking. `setAgentKeyRankedThreads`
  // is idempotent (no-op when the mapping is unchanged) and only READS/writes the
  // agentKeySlots store, so it is safe to own this here.
  const rankedRefs = useMemo(
    () =>
      rankThreadsForAgentKeys(
        threads.map((thread) => ({
          environmentId: thread.environmentId,
          threadId: thread.id,
          updatedAt: thread.updatedAt,
          archivedAt: thread.archivedAt,
        })),
      ),
    [threads],
  );
  useEffect(() => {
    setAgentKeyRankedThreads(rankedRefs);
  }, [rankedRefs]);

  const slots = useAgentKeySlots();

  // Thread shell lookup by scoped key — the same key `scopedThreadKey(slot)`
  // produces — so a slot resolves to its status input.
  const threadByKey = useMemo(
    () =>
      new Map(
        threads.map((thread) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          thread,
        ]),
      ),
    [threads],
  );

  // Subscribe to ONLY the six slotted threads' visit timestamps (mirrors the
  // sidebar's `useShallow` selection) so an unrelated visit doesn't re-render.
  const slotKeys = useMemo(
    () => slots.map((slot) => (slot === null ? null : scopedThreadKey(slot))),
    [slots],
  );
  const slotLastVisitedAts = useUiStateStore(
    useShallow((state) =>
      slotKeys.map((key) => (key === null ? null : (state.threadLastVisitedAtById[key] ?? null))),
    ),
  );

  const statusInputByKey = useMemo(() => {
    const map = new Map<string, CodexMicroLedStatusInput>();
    slots.forEach((slot, index) => {
      if (slot === null) return;
      const key = scopedThreadKey(slot);
      const shell = threadByKey.get(key);
      if (shell === undefined) return;
      const lastVisitedAt = slotLastVisitedAts[index];
      map.set(key, {
        ...shell,
        ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
      });
    });
    return map;
  }, [slots, threadByKey, slotLastVisitedAts]);

  const frame = useMemo(() => ledFrameForSlots(slots, statusInputByKey), [slots, statusInputByKey]);

  // B1: subscribe to the device state so `active` can also require a proven
  // `ledWrite` capability. Replay-on-subscribe delivers the current state as
  // the first emission, so `deviceStateSeen` flips almost immediately.
  const [ledWriteSupported, setLedWriteSupported] = useState(false);
  const [deviceStateSeen, setDeviceStateSeen] = useState(false);
  useEffect(() => {
    const bridge = codexMicroBridge();
    if (!bridge) {
      // No device: treat the state as "known" so the cold-off path can settle,
      // but keep the capability false (nothing to stream to).
      setLedWriteSupported(false);
      return;
    }
    const unsubscribe = bridge.onStateChange((state) => {
      setLedWriteSupported(state.capabilities.ledWrite === "supported");
      setDeviceStateSeen(true);
    });
    return unsubscribe;
  }, []);

  const bridgePresent = codexMicroBridge() !== undefined;
  const active = isLedSyncActive({ enabled, bridgePresent, ledWriteSupported });

  // Persisted host latches, read/written by the pure gate (`resolveLedHostGate`).
  const wasActiveRef = useRef(false);
  const coldOffDoneRef = useRef(false);

  // B3: the pusher is created and OWNED inside this effect (no render-time side
  // effects), so a StrictMode remount recreates a fresh pusher instead of
  // reusing a permanently-nulled ref. The push sink resolves the bridge lazily
  // each time (absent bridge ⇒ silent no-op).
  const pusherRef = useRef<LedFramePusher | null>(null);
  useEffect(() => {
    const pusher = createLedFramePusher({
      push: (nextFrame) => {
        void codexMicroBridge()
          ?.setAgentKeyColors(nextFrame)
          .catch(() => {
            // Device-write rejections are IPC/decode failures; nothing the LED
            // layer can do, and never worth crashing chat over.
          });
      },
    });
    pusherRef.current = pusher;
    return () => {
      // Unmount is gate-off too (sign-out, auth drop): the hardware must not
      // keep the last lit frame. forceOff pushes one all-off frame (bypassing
      // the coalescing window), then dispose cancels any pending timer.
      if (wasActiveRef.current) {
        pusher.forceOff();
      }
      pusher.dispose();
      pusherRef.current = null;
      wasActiveRef.current = false;
      coldOffDoneRef.current = false;
    };
  }, []);

  useEffect(() => {
    const pusher = pusherRef.current;
    if (pusher === null) return;
    const gate = resolveLedHostGate({
      active,
      bridgePresent,
      deviceStateSeen,
      wasActive: wasActiveRef.current,
      coldOffDone: coldOffDoneRef.current,
    });
    wasActiveRef.current = gate.wasActive;
    coldOffDoneRef.current = gate.coldOffDone;
    if (gate.action === "submit") {
      pusher.submit(frame);
    } else if (gate.action === "forceOff") {
      pusher.forceOff();
    }
  }, [active, frame, bridgePresent, deviceStateSeen]);

  return null;
}

// Mounted once via `CodexMicroHost` in apps/web/src/routes/__root.tsx (gated on
// primaryEnvironmentAuthenticated), which also runs the keybinding seeding
// hook. This host is the single owner of the `setAgentKeyRankedThreads`
// ranking feed — keep exactly one owner to avoid redundant recomputes.
