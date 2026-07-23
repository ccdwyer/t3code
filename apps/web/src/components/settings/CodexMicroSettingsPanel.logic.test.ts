import type {
  CodexMicroCapabilities,
  CodexMicroCapabilityStatus,
  CodexMicroDeviceState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CODEX_MICRO_LED_SYNC_UNVERIFIED_NOTE,
  CODEX_MICRO_SEEDED_LAYOUT,
  resolveCodexMicroPanelView,
} from "./CodexMicroSettingsPanel.logic";

function capabilities(overrides: Partial<CodexMicroCapabilities> = {}): CodexMicroCapabilities {
  return {
    viaRawHid: "unverified",
    ledWrite: "unverified",
    battery: "unverified",
    brightness: "unverified",
    autoDim: "unverified",
    ...overrides,
  };
}

function connected(overrides: Partial<CodexMicroDeviceState> = {}): CodexMicroDeviceState {
  return {
    state: "connected",
    transport: "usb",
    batteryPercent: null,
    capabilities: capabilities(),
    ...overrides,
  };
}

const CAP_STATUSES: readonly CodexMicroCapabilityStatus[] = [
  "unverified",
  "supported",
  "unsupported",
];

describe("resolveCodexMicroPanelView — bridge absent", () => {
  it("reports the feature unavailable with no device UI", () => {
    const view = resolveCodexMicroPanelView({ bridgePresent: false, deviceState: null });
    expect(view.featureAvailable).toBe(false);
    expect(view.deviceActive).toBe(false);
    expect(view.status.showTransportBadge).toBe(false);
    expect(view.status.batteryPercent).toBeNull();
    expect(view.controls.showBrightnessSlider).toBe(false);
    expect(view.controls.showAutoDimToggle).toBe(false);
    expect(view.controls.showUnverifiedNote).toBe(false);
  });
});

describe("resolveCodexMicroPanelView — status line", () => {
  it("labels the pre-first-emission (null) state as checking", () => {
    const view = resolveCodexMicroPanelView({ bridgePresent: true, deviceState: null });
    expect(view.featureAvailable).toBe(true);
    expect(view.status.label).toBe("Checking device…");
    expect(view.deviceActive).toBe(false);
  });

  it("labels disconnected", () => {
    const view = resolveCodexMicroPanelView({
      bridgePresent: true,
      deviceState: {
        state: "disconnected",
        transport: null,
        batteryPercent: null,
        capabilities: capabilities(),
      },
    });
    expect(view.status.label).toBe("Disconnected");
    expect(view.status.showTransportBadge).toBe(false);
    expect(view.deviceActive).toBe(false);
  });

  it("labels discovering as Searching", () => {
    const view = resolveCodexMicroPanelView({
      bridgePresent: true,
      deviceState: {
        state: "discovering",
        transport: null,
        batteryPercent: null,
        capabilities: capabilities(),
      },
    });
    expect(view.status.label).toBe("Searching");
    expect(view.deviceActive).toBe(false);
  });

  it("labels closed as Disconnected (never implies a live device)", () => {
    const view = resolveCodexMicroPanelView({
      bridgePresent: true,
      deviceState: {
        state: "closed",
        transport: null,
        batteryPercent: null,
        capabilities: capabilities(),
      },
    });
    expect(view.status.label).toBe("Disconnected");
  });

  it("connected over USB shows a USB transport badge, no battery when null", () => {
    const view = resolveCodexMicroPanelView({
      bridgePresent: true,
      deviceState: connected({ transport: "usb", batteryPercent: null }),
    });
    expect(view.status.label).toBe("Connected");
    expect(view.status.transportLabel).toBe("USB");
    expect(view.status.showTransportBadge).toBe(true);
    expect(view.status.batteryPercent).toBeNull();
    expect(view.deviceActive).toBe(true);
  });

  it("connected over USB with a battery reading surfaces the percent", () => {
    const view = resolveCodexMicroPanelView({
      bridgePresent: true,
      deviceState: connected({ transport: "usb", batteryPercent: 84 }),
    });
    expect(view.status.batteryPercent).toBe(84);
  });

  it("connected over BLE labels the transport Bluetooth", () => {
    const view = resolveCodexMicroPanelView({
      bridgePresent: true,
      deviceState: connected({ transport: "ble" }),
    });
    expect(view.status.transportLabel).toBe("Bluetooth");
    expect(view.status.showTransportBadge).toBe(true);
  });

  it("degraded is active and keeps its transport badge", () => {
    const view = resolveCodexMicroPanelView({
      bridgePresent: true,
      deviceState: {
        state: "degraded",
        transport: "usb",
        batteryPercent: null,
        capabilities: capabilities(),
      },
    });
    expect(view.status.label).toBe("Degraded");
    expect(view.deviceActive).toBe(true);
    expect(view.status.showTransportBadge).toBe(true);
  });
});

describe("resolveCodexMicroPanelView — brightness slider gating", () => {
  for (const status of CAP_STATUSES) {
    it(`brightness=${status} → slider renders only when supported`, () => {
      const view = resolveCodexMicroPanelView({
        bridgePresent: true,
        deviceState: connected({ capabilities: capabilities({ brightness: status }) }),
      });
      expect(view.controls.showBrightnessSlider).toBe(status === "supported");
    });
  }
});

describe("resolveCodexMicroPanelView — auto-dim toggle gating", () => {
  for (const status of CAP_STATUSES) {
    it(`autoDim=${status} → toggle renders only when supported`, () => {
      const view = resolveCodexMicroPanelView({
        bridgePresent: true,
        deviceState: connected({ capabilities: capabilities({ autoDim: status }) }),
      });
      expect(view.controls.showAutoDimToggle).toBe(status === "supported");
    });
  }
});

describe("resolveCodexMicroPanelView — LED sync gating", () => {
  for (const status of CAP_STATUSES) {
    const supported = status === "supported";
    it(`ledWrite=${status} → toggle ${supported ? "enabled" : "disabled"}`, () => {
      const view = resolveCodexMicroPanelView({
        bridgePresent: true,
        deviceState: connected({ capabilities: capabilities({ ledWrite: status }) }),
      });
      expect(view.controls.ledSyncDisabled).toBe(!supported);
      expect(view.controls.ledSyncNote).toBe(
        supported ? null : CODEX_MICRO_LED_SYNC_UNVERIFIED_NOTE,
      );
    });
  }

  it("LED sync is disabled when bridge is absent", () => {
    const view = resolveCodexMicroPanelView({ bridgePresent: false, deviceState: null });
    expect(view.controls.ledSyncDisabled).toBe(true);
    expect(view.controls.ledSyncNote).toBeNull();
  });
});

describe("resolveCodexMicroPanelView — unverified note (single, active-only)", () => {
  it("shows once while any lighting/battery capability is unverified on a live device", () => {
    const view = resolveCodexMicroPanelView({
      bridgePresent: true,
      deviceState: connected({ capabilities: capabilities() }),
    });
    expect(view.controls.showUnverifiedNote).toBe(true);
  });

  it("does not nag while disconnected (no device attached)", () => {
    const view = resolveCodexMicroPanelView({
      bridgePresent: true,
      deviceState: {
        state: "disconnected",
        transport: null,
        batteryPercent: null,
        capabilities: capabilities(),
      },
    });
    expect(view.controls.showUnverifiedNote).toBe(false);
  });

  it("hides once all lighting/battery capabilities are resolved (supported)", () => {
    const view = resolveCodexMicroPanelView({
      bridgePresent: true,
      deviceState: connected({
        capabilities: capabilities({
          brightness: "supported",
          autoDim: "supported",
          battery: "supported",
        }),
      }),
    });
    expect(view.controls.showUnverifiedNote).toBe(false);
    expect(view.controls.showBrightnessSlider).toBe(true);
    expect(view.controls.showAutoDimToggle).toBe(true);
  });

  it("hides once all lighting/battery capabilities are resolved (unsupported)", () => {
    const view = resolveCodexMicroPanelView({
      bridgePresent: true,
      deviceState: connected({
        capabilities: capabilities({
          brightness: "unsupported",
          autoDim: "unsupported",
          battery: "unsupported",
        }),
      }),
    });
    expect(view.controls.showUnverifiedNote).toBe(false);
    expect(view.controls.showBrightnessSlider).toBe(false);
    expect(view.controls.showAutoDimToggle).toBe(false);
  });
});

describe("CODEX_MICRO_SEEDED_LAYOUT", () => {
  it("mirrors the seeded default layout (6 agent keys + accept/decline)", () => {
    expect(CODEX_MICRO_SEEDED_LAYOUT).toHaveLength(8);
    expect(CODEX_MICRO_SEEDED_LAYOUT[0]).toEqual({
      keyLabel: "F13",
      actionLabel: "Open recent chat 1",
    });
    expect(CODEX_MICRO_SEEDED_LAYOUT[6]).toEqual({
      keyLabel: "F19",
      actionLabel: "Approve once",
    });
    expect(CODEX_MICRO_SEEDED_LAYOUT[7]).toEqual({
      keyLabel: "Shift+F19",
      actionLabel: "Decline",
    });
  });
});
