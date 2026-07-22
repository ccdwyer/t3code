import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AGENT_KEY_SLOT_COUNT, CodexMicroDeviceState, CodexMicroLedFrame } from "./codexMicro.ts";

const decodeDeviceState = Schema.decodeUnknownSync(CodexMicroDeviceState);
const decodeLedFrame = Schema.decodeUnknownSync(CodexMicroLedFrame);

const unverifiedCapabilities = {
  viaRawHid: "unverified",
  ledWrite: "unverified",
  battery: "unverified",
  brightness: "unverified",
  autoDim: "unverified",
} as const;

describe("CodexMicroDeviceState", () => {
  it("decodes a disconnected everything-unverified state", () => {
    const decoded = decodeDeviceState({
      state: "disconnected",
      transport: null,
      batteryPercent: null,
      capabilities: unverifiedCapabilities,
    });

    expect(decoded.state).toBe("disconnected");
    expect(decoded.transport).toBeNull();
    expect(decoded.batteryPercent).toBeNull();
    expect(decoded.capabilities.ledWrite).toBe("unverified");
  });

  it("decodes a connected USB state with battery and proven capabilities", () => {
    const decoded = decodeDeviceState({
      state: "connected",
      transport: "usb",
      batteryPercent: 42,
      capabilities: {
        viaRawHid: "supported",
        ledWrite: "supported",
        battery: "supported",
        brightness: "unsupported",
        autoDim: "unverified",
      },
    });

    expect(decoded.transport).toBe("usb");
    expect(decoded.batteryPercent).toBe(42);
    expect(decoded.capabilities.brightness).toBe("unsupported");
  });

  it("rejects an unknown connection-state literal", () => {
    expect(() =>
      decodeDeviceState({
        state: "reconnecting",
        transport: null,
        batteryPercent: null,
        capabilities: unverifiedCapabilities,
      }),
    ).toThrow();
  });

  it("rejects a battery percentage outside 0..100", () => {
    expect(() =>
      decodeDeviceState({
        state: "connected",
        transport: "usb",
        batteryPercent: 101,
        capabilities: unverifiedCapabilities,
      }),
    ).toThrow();
  });
});

describe("CodexMicroLedFrame", () => {
  const slot = { effect: "solid", color: { r: 10, g: 20, b: 30 } } as const;

  it("decodes a frame with exactly six slots", () => {
    const frame = decodeLedFrame(Array.from({ length: AGENT_KEY_SLOT_COUNT }, () => slot));
    expect(frame).toHaveLength(AGENT_KEY_SLOT_COUNT);
  });

  it("rejects a frame with the wrong slot count", () => {
    expect(() => decodeLedFrame([slot, slot, slot])).toThrow();
    expect(() =>
      decodeLedFrame(Array.from({ length: AGENT_KEY_SLOT_COUNT + 1 }, () => slot)),
    ).toThrow();
  });

  it("rejects an out-of-range color channel", () => {
    const bad = { effect: "solid", color: { r: 256, g: 0, b: 0 } } as const;
    expect(() => decodeLedFrame([bad, slot, slot, slot, slot, slot])).toThrow();
  });
});
