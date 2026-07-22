import type {
  CodexMicroCapabilities,
  CodexMicroDeviceState,
  CodexMicroLedFrame,
} from "@t3tools/contracts";

/**
 * Pure state transitions + report encoders for the Codex Micro device service.
 * Kept side-effect free (mirrors `../updates/updateMachine.ts`) so the state
 * machine is trivial to reason about and unit-test.
 */

// ── Capabilities ─────────────────────────────────────────────────────

/**
 * The D1 hardware capture has not happened, so EVERY capability defaults to
 * "unverified" and every smart write is a no-op today. This is the single
 * source of capability truth — flip an entry to "supported" here (or inject an
 * override via config) once the D1 matrix is captured and the whole write path
 * comes alive with no structural change.
 */
export const UNVERIFIED_CODEX_MICRO_CAPABILITIES: CodexMicroCapabilities = {
  viaRawHid: "unverified",
  ledWrite: "unverified",
  battery: "unverified",
  brightness: "unverified",
  autoDim: "unverified",
};

export type CodexMicroWriteKind = "led" | "brightness" | "autoDim";

export function isCodexMicroWriteCapabilitySupported(
  capabilities: CodexMicroCapabilities,
  kind: CodexMicroWriteKind,
): boolean {
  switch (kind) {
    case "led":
      return capabilities.ledWrite === "supported";
    case "brightness":
      return capabilities.brightness === "supported";
    case "autoDim":
      return capabilities.autoDim === "supported";
  }
}

export function isCodexMicroBatteryPollSupported(capabilities: CodexMicroCapabilities): boolean {
  return capabilities.battery === "supported";
}

// ── State transitions ────────────────────────────────────────────────

export function createInitialCodexMicroState(
  capabilities: CodexMicroCapabilities,
): CodexMicroDeviceState {
  return {
    state: "disconnected",
    transport: null,
    batteryPercent: null,
    capabilities,
  };
}

/** Enter discovery: no transport, battery unknown, capabilities preserved. */
export function toDiscovering(state: CodexMicroDeviceState): CodexMicroDeviceState {
  return { ...state, state: "discovering", transport: null, batteryPercent: null };
}

/** A USB connection has been opened. BLE is keys-only, so smart-feature
 * connections are always USB here. */
export function toConnected(state: CodexMicroDeviceState): CodexMicroDeviceState {
  return { ...state, state: "connected", transport: "usb" };
}

/** Degraded: connection is impaired (e.g. a write just failed) but not yet
 * torn down. Transport is preserved so the UI can still show what dropped. */
export function toDegraded(state: CodexMicroDeviceState): CodexMicroDeviceState {
  return { ...state, state: "degraded" };
}

/** Fully disconnected (e.g. suspend, or giving up). */
export function toDisconnected(state: CodexMicroDeviceState): CodexMicroDeviceState {
  return { ...state, state: "disconnected", transport: null, batteryPercent: null };
}

/** Terminal state after shutdown. */
export function toClosed(state: CodexMicroDeviceState): CodexMicroDeviceState {
  return { ...state, state: "closed", transport: null, batteryPercent: null };
}

export function withBatteryPercent(
  state: CodexMicroDeviceState,
  batteryPercent: number | null,
): CodexMicroDeviceState {
  return { ...state, batteryPercent };
}

export function isConnected(state: CodexMicroDeviceState): boolean {
  return state.state === "connected";
}

// ── Report encoders (PLACEHOLDER wire format) ────────────────────────

/**
 * ⚠️ PLACEHOLDER report formats. The real Codex Micro output-report layout is
 * pending D1 capture. These encoders produce deterministic, well-formed byte
 * arrays so the serialized-write / coalescing / replay machinery is exercisable
 * end-to-end today; the leading byte is a made-up report id per kind. Do NOT
 * treat these bytes as the real protocol — they only ever reach a real device
 * once the corresponding capability is flipped to "supported" post-D1.
 */
export const CODEX_MICRO_LED_REPORT_ID = 0x01;
export const CODEX_MICRO_BRIGHTNESS_REPORT_ID = 0x02;
export const CODEX_MICRO_AUTODIM_REPORT_ID = 0x03;

const LED_EFFECT_BYTE: Record<CodexMicroLedFrame[number]["effect"], number> = {
  off: 0x00,
  solid: 0x01,
  pulse: 0x02,
};

export function encodeLedFrameReport(frame: CodexMicroLedFrame): ReadonlyArray<number> {
  const bytes: Array<number> = [CODEX_MICRO_LED_REPORT_ID];
  for (const slot of frame) {
    bytes.push(LED_EFFECT_BYTE[slot.effect], slot.color.r, slot.color.g, slot.color.b);
  }
  return bytes;
}

export function clampBrightnessPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function encodeBrightnessReport(percent: number): ReadonlyArray<number> {
  return [CODEX_MICRO_BRIGHTNESS_REPORT_ID, clampBrightnessPercent(percent)];
}

export function encodeAutoDimReport(enabled: boolean): ReadonlyArray<number> {
  return [CODEX_MICRO_AUTODIM_REPORT_ID, enabled ? 0x01 : 0x00];
}
