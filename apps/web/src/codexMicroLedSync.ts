import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AGENT_KEY_SLOT_COUNT,
  type CodexMicroLedColor,
  type CodexMicroLedFrame,
  type CodexMicroLedSlot,
} from "@t3tools/contracts";
import { resolveThreadStatusPill } from "./components/Sidebar.logic";
import type { AgentKeySlots } from "./agentKeySlots";

// ── LED sync: chat status → agent-key colors (T8) ───────────────────────
//
// This module is the PURE core (plus a coalescing scheduler) of the Codex
// Micro LED sync. It never touches React, the desktop bridge, or any store —
// the headless `CodexMicroLedSyncHost` (CodexMicroLedSyncHost.tsx) wires the
// live data into these functions and pushes the result to the device.
//
// The mapping deliberately reuses `resolveThreadStatusPill` (Sidebar.logic)
// rather than reimplementing its status-priority logic: one thread → one pill
// → one LED. That keeps the pad's colors identical to the sidebar's status
// dots by construction.

/**
 * Per-status RGB constants — the same Tailwind-500 hues the status pills paint
 * with (amber-500 / indigo-500 / sky-500 / violet-500 / emerald-500), so the
 * pad mirrors the sidebar exactly. Exported for reuse and tests.
 */
export const LED_COLOR_AMBER: CodexMicroLedColor = { r: 0xf5, g: 0x9e, b: 0x0b };
export const LED_COLOR_INDIGO: CodexMicroLedColor = { r: 0x63, g: 0x66, b: 0xf1 };
export const LED_COLOR_SKY: CodexMicroLedColor = { r: 0x0e, g: 0xa5, b: 0xe9 };
export const LED_COLOR_VIOLET: CodexMicroLedColor = { r: 0x8b, g: 0x5c, b: 0xf6 };
export const LED_COLOR_EMERALD: CodexMicroLedColor = { r: 0x10, g: 0xb9, b: 0x81 };
/** Off is literal black — the frame keeps `color` required even for "off". */
export const LED_COLOR_BLACK: CodexMicroLedColor = { r: 0, g: 0, b: 0 };

/** A dark, effect-off slot. Used for empty slots and idle/no-status threads. */
export const LED_SLOT_OFF: CodexMicroLedSlot = Object.freeze({
  effect: "off",
  color: LED_COLOR_BLACK,
});

/** An all-off frame — pushed once when sync is gated off so LEDs never stick. */
export const LED_FRAME_ALL_OFF: CodexMicroLedFrame = Object.freeze(
  Array.from({ length: AGENT_KEY_SLOT_COUNT }, () => LED_SLOT_OFF),
);

/**
 * The status-pill input `resolveThreadStatusPill` consumes. Derived from the
 * function's own parameter type (not re-declared) so this module stays in lock-
 * step with the pill logic — it includes the visit-state `lastVisitedAt` field
 * that "Completed" (emerald) depends on.
 */
export type CodexMicroLedStatusInput = Parameters<typeof resolveThreadStatusPill>[0]["thread"];

/**
 * Map one resolved status pill to its LED slot. `null` (no status / idle) is
 * off. Working AND Connecting collapse to the SAME sky pulse — a single device
 * LED state for both, by design (the pad has no "connecting" distinction).
 */
export function ledSlotForPill(pill: { readonly label: string } | null): CodexMicroLedSlot {
  switch (pill?.label) {
    case "Pending Approval":
      return { effect: "solid", color: LED_COLOR_AMBER };
    case "Awaiting Input":
      return { effect: "solid", color: LED_COLOR_INDIGO };
    case "Working":
    case "Connecting":
      return { effect: "pulse", color: LED_COLOR_SKY };
    case "Plan Ready":
      return { effect: "solid", color: LED_COLOR_VIOLET };
    case "Completed":
      return { effect: "solid", color: LED_COLOR_EMERALD };
    default:
      return LED_SLOT_OFF;
  }
}

/**
 * PURE mapping: six agent-key slots + the status input for each slotted thread
 * (keyed by `scopedThreadKey`) → a six-slot LED frame.
 *
 *  - A `null` slot, or a slotted thread with no status input available, is off.
 *  - Otherwise the thread's pill (via `resolveThreadStatusPill`, which reads
 *    `lastVisitedAt` for the unseen-completed case) drives the color/effect.
 *
 * Always returns exactly `AGENT_KEY_SLOT_COUNT` slots regardless of the input
 * array length, so the frame satisfies the fixed-length contract schema.
 */
export function ledFrameForSlots(
  slots: AgentKeySlots,
  statusInputByKey: ReadonlyMap<string, CodexMicroLedStatusInput>,
): CodexMicroLedFrame {
  return Array.from({ length: AGENT_KEY_SLOT_COUNT }, (_, index) => {
    const slot = slots[index] ?? null;
    if (slot === null) return LED_SLOT_OFF;
    const input = statusInputByKey.get(scopedThreadKey(slot));
    if (input === undefined) return LED_SLOT_OFF;
    return ledSlotForPill(resolveThreadStatusPill({ thread: input }));
  });
}

/** Structural equality for two LED slots (effect + r/g/b). */
export function ledSlotsEqual(left: CodexMicroLedSlot, right: CodexMicroLedSlot): boolean {
  return (
    left.effect === right.effect &&
    left.color.r === right.color.r &&
    left.color.g === right.color.g &&
    left.color.b === right.color.b
  );
}

/** Structural equality for two LED frames. */
export function ledFramesEqual(left: CodexMicroLedFrame, right: CodexMicroLedFrame): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (!ledSlotsEqual(left[index]!, right[index]!)) return false;
  }
  return true;
}

// ── Coalescing pusher ───────────────────────────────────────────────────

/** Opaque timer handle — whatever the injected `setTimer` returns. */
export type LedFrameTimerHandle = unknown;

export interface CreateLedFramePusherOptions {
  /** Sink invoked with each frame that is actually sent to the device. */
  readonly push: (frame: CodexMicroLedFrame) => void;
  /** Coalescing window in ms (default 250). */
  readonly intervalMs?: number;
  /** Injectable timer (defaults to the global `setTimeout`). */
  readonly setTimer?: (callback: () => void, ms: number) => LedFrameTimerHandle;
  /** Injectable clear (defaults to the global `clearTimeout`). */
  readonly clearTimer?: (handle: LedFrameTimerHandle) => void;
}

export interface LedFramePusher {
  /**
   * Submit the latest computed frame. Frames are coalesced on a trailing edge:
   * within a `intervalMs` window the LAST submitted frame wins, and it is only
   * sent if it differs from the last frame actually pushed.
   */
  submit: (frame: CodexMicroLedFrame) => void;
  /**
   * Cancel any pending window and push a single all-off frame immediately
   * (deduped — a no-op if the LEDs are already off). Used when sync gates off.
   */
  forceOff: () => void;
  /** Cancel any pending window without pushing (host unmount / teardown). */
  dispose: () => void;
}

/**
 * A minimal, testable coalescing scheduler. Reactive callers `submit` on every
 * recompute; the scheduler pushes to the device at most once per `intervalMs`,
 * trailing-edge, and never re-sends a frame identical to the last one pushed.
 * The clock is fully injectable so tests can drive it deterministically without
 * real timers.
 */
export function createLedFramePusher(options: CreateLedFramePusherOptions): LedFramePusher {
  const intervalMs = options.intervalMs ?? 250;
  const setTimer =
    options.setTimer ??
    ((callback, ms) => globalThis.setTimeout(callback, ms) as LedFrameTimerHandle);
  const clearTimer =
    options.clearTimer ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  let lastPushed: CodexMicroLedFrame | null = null;
  let pending: CodexMicroLedFrame | null = null;
  let timer: LedFrameTimerHandle | null = null;

  const pushNow = (frame: CodexMicroLedFrame): void => {
    if (lastPushed !== null && ledFramesEqual(lastPushed, frame)) return;
    lastPushed = frame;
    options.push(frame);
  };

  const clearPending = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    pending = null;
  };

  return {
    submit: (frame) => {
      if (timer !== null) {
        // Inside an open window: remember the trailing frame, push at close.
        pending = frame;
        return;
      }
      pending = frame;
      timer = setTimer(() => {
        timer = null;
        const trailing = pending;
        pending = null;
        if (trailing !== null) pushNow(trailing);
      }, intervalMs);
    },
    forceOff: () => {
      clearPending();
      pushNow(LED_FRAME_ALL_OFF);
    },
    dispose: () => {
      clearPending();
    },
  };
}
