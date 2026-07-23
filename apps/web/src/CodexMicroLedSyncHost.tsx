import { useEffect, useMemo, useRef } from "react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useShallow } from "zustand/react/shallow";

import {
  rankThreadsForAgentKeys,
  setAgentKeyRankedThreads,
  useAgentKeySlots,
} from "./agentKeySlots";
import {
  createLedFramePusher,
  ledFrameForSlots,
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
// mount note at the bottom of this file). Gated by both the desktop bridge's
// presence AND the `codexMicroLedSyncEnabled` client setting; when either is
// off it pushes a single all-off frame and stops.

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

  // One stable pusher for the component's lifetime. The push sink resolves the
  // bridge lazily each time (absent bridge ⇒ silent no-op).
  const pusherRef = useRef<LedFramePusher | null>(null);
  if (pusherRef.current === null) {
    pusherRef.current = createLedFramePusher({
      push: (nextFrame) => {
        void codexMicroBridge()
          ?.setAgentKeyColors(nextFrame)
          .catch(() => {
            // Device-write rejections are IPC/decode failures; nothing the LED
            // layer can do, and never worth crashing chat over.
          });
      },
    });
  }
  useEffect(() => {
    return () => {
      pusherRef.current?.dispose();
      pusherRef.current = null;
    };
  }, []);

  // Active only when the desktop bridge exposes the device AND the setting is on.
  const active = enabled && codexMicroBridge() !== undefined;
  const wasActiveRef = useRef(false);

  useEffect(() => {
    const pusher = pusherRef.current;
    if (pusher === null) return;
    if (active) {
      wasActiveRef.current = true;
      pusher.submit(frame);
      return;
    }
    // Gating just turned off (or was never on): push one all-off frame so the
    // LEDs never stick, then stop.
    if (wasActiveRef.current) {
      wasActiveRef.current = false;
      pusher.forceOff();
    }
  }, [active, frame]);

  return null;
}

// ── MOUNT INSTRUCTION (integration step — a later task owns this edit) ───
//
// Add ONE line beside the other authenticated headless hosts in
// apps/web/src/routes/__root.tsx (next to `<EventRouter />`, ~line 136):
//
//     {primaryEnvironmentAuthenticated ? <CodexMicroLedSyncHost /> : null}
//
// Providers/data it needs (all already in scope at that mount point):
//   - the @effect/atom registry (RegistryProvider) — for `useThreadShells()`;
//   - the global zustand stores (uiStateStore, agentKeySlots) — no provider;
//   - client settings (useClientSettings / useSettings hook) — no provider;
//   - `window.desktopBridge` — set by the desktop preload; absent on web ⇒ inert.
// No new props or wiring are required. If a future task (T7) also mounts a
// ranking feed via `setAgentKeyRankedThreads`, keep exactly ONE owner of that
// call to avoid redundant recomputes (this host is a fine owner).
