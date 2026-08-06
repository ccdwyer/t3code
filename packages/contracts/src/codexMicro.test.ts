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

  it("rejects a battery percentage outside 0..100 or fractional", () => {
    for (const batteryPercent of [101, -1, 42.5]) {
      expect(() =>
        decodeDeviceState({
          state: "connected",
          transport: "usb",
          batteryPercent,
          capabilities: unverifiedCapabilities,
        }),
      ).toThrow();
    }
  });

  it("accepts battery boundary values 0 and 100", () => {
    for (const batteryPercent of [0, 100]) {
      expect(
        decodeDeviceState({
          state: "connected",
          transport: "usb",
          batteryPercent,
          capabilities: unverifiedCapabilities,
        }).batteryPercent,
      ).toBe(batteryPercent);
    }
  });

  it("rejects impossible state/transport/battery combinations", () => {
    // Live states must name a transport.
    for (const state of ["connected", "degraded"] as const) {
      expect(() =>
        decodeDeviceState({
          state,
          transport: null,
          batteryPercent: null,
          capabilities: unverifiedCapabilities,
        }),
      ).toThrow();
    }
    // Inactive states cannot claim a transport or a battery reading.
    for (const state of ["disconnected", "discovering", "closed"] as const) {
      expect(() =>
        decodeDeviceState({
          state,
          transport: "usb",
          batteryPercent: null,
          capabilities: unverifiedCapabilities,
        }),
      ).toThrow();
      expect(() =>
        decodeDeviceState({
          state,
          transport: null,
          batteryPercent: 80,
          capabilities: unverifiedCapabilities,
        }),
      ).toThrow();
    }
  });

  it("defaults omitted capability fields to unverified (producer version skew)", () => {
    const decoded = decodeDeviceState({
      state: "connected",
      transport: "usb",
      batteryPercent: null,
      capabilities: { ledWrite: "supported" },
    });
    expect(decoded.capabilities.ledWrite).toBe("supported");
    expect(decoded.capabilities.battery).toBe("unverified");
    expect(decoded.capabilities.viaRawHid).toBe("unverified");
    expect(decoded.capabilities.brightness).toBe("unverified");
    expect(decoded.capabilities.autoDim).toBe("unverified");
  });

  it("rejects an unknown transport literal", () => {
    expect(() =>
      decodeDeviceState({
        state: "connected",
        transport: "bluetooth-classic",
        batteryPercent: null,
        capabilities: unverifiedCapabilities,
      }),
    ).toThrow();
  });

  it("round-trips a device state through encode and decode", () => {
    const state = decodeDeviceState({
      state: "connected",
      transport: "usb",
      batteryPercent: 55,
      capabilities: { ...unverifiedCapabilities, ledWrite: "supported" },
    });
    const encoded = Schema.encodeSync(CodexMicroDeviceState)(state);
    expect(decodeDeviceState(encoded)).toEqual(state);
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
