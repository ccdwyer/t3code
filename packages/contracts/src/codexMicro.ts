import * as Schema from "effect/Schema";

// ── Connection ───────────────────────────────────────────────────────

export const CodexMicroConnectionState = Schema.Literals([
  "disconnected",
  "discovering",
  "connected",
  "degraded",
  "closed",
]);
export type CodexMicroConnectionState = typeof CodexMicroConnectionState.Type;

export const CodexMicroTransport = Schema.Literals(["usb", "ble"]);
export type CodexMicroTransport = typeof CodexMicroTransport.Type;

// ── Capabilities ─────────────────────────────────────────────────────

// D1 hardware capture has not happened yet, so every capability defaults to
// "unverified" and the smart features gated behind it no-op until a real
// device proves the capability supported.
export const CodexMicroCapabilityStatus = Schema.Literals([
  "unverified",
  "supported",
  "unsupported",
]);
export type CodexMicroCapabilityStatus = typeof CodexMicroCapabilityStatus.Type;

export const CodexMicroCapabilities = Schema.Struct({
  viaRawHid: CodexMicroCapabilityStatus,
  ledWrite: CodexMicroCapabilityStatus,
  battery: CodexMicroCapabilityStatus,
  brightness: CodexMicroCapabilityStatus,
  autoDim: CodexMicroCapabilityStatus,
});
export type CodexMicroCapabilities = typeof CodexMicroCapabilities.Type;

// ── Device state ─────────────────────────────────────────────────────

export const CodexMicroBatteryPercent = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 100 }),
);

export const CodexMicroDeviceState = Schema.Struct({
  state: CodexMicroConnectionState,
  transport: Schema.NullOr(CodexMicroTransport),
  batteryPercent: Schema.NullOr(CodexMicroBatteryPercent),
  capabilities: CodexMicroCapabilities,
});
export type CodexMicroDeviceState = typeof CodexMicroDeviceState.Type;

// ── LED frame ────────────────────────────────────────────────────────

export const CodexMicroLedEffect = Schema.Literals(["off", "solid", "pulse"]);
export type CodexMicroLedEffect = typeof CodexMicroLedEffect.Type;

const CodexMicroLedChannel = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }));

export const CodexMicroLedColor = Schema.Struct({
  r: CodexMicroLedChannel,
  g: CodexMicroLedChannel,
  b: CodexMicroLedChannel,
});
export type CodexMicroLedColor = typeof CodexMicroLedColor.Type;

// Color stays required (meaningless when `effect` is "off") so the frame is
// trivial to decode; callers pass black for off slots.
export const CodexMicroLedSlot = Schema.Struct({
  effect: CodexMicroLedEffect,
  color: CodexMicroLedColor,
});
export type CodexMicroLedSlot = typeof CodexMicroLedSlot.Type;

// The pad exposes exactly six RGB agent keys.
export const AGENT_KEY_SLOT_COUNT = 6;

// Exactly six slots. `isLengthBetween(n, n)` is the repo idiom for a fixed
// array length (see keybindings.ts `isMaxLength`); it keeps the frame a plain
// array so it round-trips over IPC without tuple ceremony.
export const CodexMicroLedFrame = Schema.Array(CodexMicroLedSlot).check(
  Schema.isLengthBetween(AGENT_KEY_SLOT_COUNT, AGENT_KEY_SLOT_COUNT),
);
export type CodexMicroLedFrame = typeof CodexMicroLedFrame.Type;
