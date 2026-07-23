import type {
  CodexMicroCapabilities,
  CodexMicroCapabilityStatus,
  CodexMicroDeviceState,
  KeybindingCommand,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import {
  CODEX_MICRO_LED_SYNC_UNVERIFIED_NOTE,
  CODEX_MICRO_NOT_BOUND_LABEL,
  formatCodexMicroShortcutLabel,
  resolveCodexMicroLayoutRows,
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

function resolvedRule(key: string, command: KeybindingCommand): ResolvedKeybindingRule {
  const shortcut = parseKeybindingShortcut(key);
  if (!shortcut) throw new Error(`invalid test key: ${key}`);
  return { command, shortcut };
}

describe("formatCodexMicroShortcutLabel", () => {
  it("upper-cases function keys", () => {
    expect(formatCodexMicroShortcutLabel(parseKeybindingShortcut("f13")!)).toBe("F13");
  });

  it("title-cases modifiers and keeps the function key upper-cased", () => {
    expect(formatCodexMicroShortcutLabel(parseKeybindingShortcut("shift+f19")!)).toBe("Shift+F19");
  });

  it("upper-cases a single-character key", () => {
    expect(formatCodexMicroShortcutLabel(parseKeybindingShortcut("ctrl+a")!)).toBe("Ctrl+A");
  });
});

describe("resolveCodexMicroLayoutRows", () => {
  it("shows the seeded default keys when the config still holds them", () => {
    const config: ResolvedKeybindingsConfig = [
      resolvedRule("f13", "agentKey.open.1"),
      resolvedRule("f14", "agentKey.open.2"),
      resolvedRule("f15", "agentKey.open.3"),
      resolvedRule("f16", "agentKey.open.4"),
      resolvedRule("f17", "agentKey.open.5"),
      resolvedRule("f18", "agentKey.open.6"),
      resolvedRule("f19", "approval.accept"),
      resolvedRule("shift+f19", "approval.decline"),
    ];
    const rows = resolveCodexMicroLayoutRows(config);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual({ keyLabel: "F13", actionLabel: "Open recent chat 1" });
    expect(rows[6]).toEqual({ keyLabel: "F19", actionLabel: "Approve once" });
    expect(rows[7]).toEqual({ keyLabel: "Shift+F19", actionLabel: "Decline" });
  });

  it("reflects a REMAPPED key (bound to a non-default shortcut)", () => {
    // The user rebound "open recent chat 1" to Ctrl+1.
    const config: ResolvedKeybindingsConfig = [resolvedRule("ctrl+1", "agentKey.open.1")];
    const rows = resolveCodexMicroLayoutRows(config);
    expect(rows[0]).toEqual({ keyLabel: "Ctrl+1", actionLabel: "Open recent chat 1" });
  });

  it("shows 'Not bound' for a command with no binding in the config", () => {
    const rows = resolveCodexMicroLayoutRows([]);
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.keyLabel).toBe(CODEX_MICRO_NOT_BOUND_LABEL);
    }
    // Human action labels are still present even when unbound.
    expect(rows[0]!.actionLabel).toBe("Open recent chat 1");
    expect(rows[7]!.actionLabel).toBe("Decline");
  });
});
