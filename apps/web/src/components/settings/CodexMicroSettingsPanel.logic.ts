/**
 * Pure render decisions for the Codex Micro device settings panel.
 *
 * The panel is deliberately thin over this module: every "does this section /
 * control / note render, and what does the status line read" decision lives
 * here so it can be tested exhaustively against the capability matrix without
 * mounting React.
 *
 * Honest-state posture (spec §5):
 * - Bridge absent (`undefined`) means the FEATURE is unavailable (plain
 *   browser / older desktop shell) — NOT that a device is unplugged.
 * - Capability-gated controls render ONLY when the D1 matrix proves the
 *   capability `"supported"`. No fake sliders/toggles pre-verification.
 */
import type {
  CodexMicroDeviceState,
  KeybindingCommand,
  KeybindingShortcut,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";

import { CODEX_MICRO_SEED_LAYOUT } from "../../codexMicroSeeding";

// ── Copy (single source so the component and tests agree) ─────────────

export const CODEX_MICRO_FEATURE_UNAVAILABLE_MESSAGE =
  "Codex Micro support is available in the T3 Code desktop app.";

/** Shown once (not per-control) while lighting/battery capabilities are unverified. */
export const CODEX_MICRO_UNVERIFIED_NOTE =
  "Lighting and battery controls unlock after hardware verification.";

/** Shown under the LED-sync toggle while the ledWrite capability is not proven. */
export const CODEX_MICRO_LED_SYNC_UNVERIFIED_NOTE =
  "LED sync unlocks once the pad's lighting is hardware-verified.";

/** Loud in-app-focus notice for the layout section (v1 has no global capture). */
export const CODEX_MICRO_FOCUS_NOTICE = "Keys work while T3 Code is focused.";

/** The Work Louder / VIA configurator — the remap escape hatch (spec §5). */
export const CODEX_MICRO_VIA_URL = "https://usevia.app/";

// ── Seeded layout (live, read-only display table) ─────────────────────

/** Shown for a seeded command that has no binding in the resolved config. */
export const CODEX_MICRO_NOT_BOUND_LABEL = "Not bound";

/**
 * Human action labels for each seeded command. The KEY/COMMAND pairs live in
 * the seeding module (`CODEX_MICRO_SEED_LAYOUT`, the single source of truth);
 * this map only adds the human-facing action copy the panel renders.
 */
const CODEX_MICRO_COMMAND_ACTION_LABELS: Partial<Record<KeybindingCommand, string>> = {
  "agentKey.open.1": "Open recent chat 1",
  "agentKey.open.2": "Open recent chat 2",
  "agentKey.open.3": "Open recent chat 3",
  "agentKey.open.4": "Open recent chat 4",
  "agentKey.open.5": "Open recent chat 5",
  "agentKey.open.6": "Open recent chat 6",
  "approval.accept": "Approve once",
  "approval.decline": "Decline",
};

export interface CodexMicroLayoutRow {
  /** Human action label, e.g. "Open recent chat 1". */
  readonly actionLabel: string;
  /**
   * The key CURRENTLY bound to the command (which may differ from the seeded
   * default if the user remapped it), or `CODEX_MICRO_NOT_BOUND_LABEL` when the
   * command has no binding.
   */
  readonly keyLabel: string;
}

/**
 * Format a resolved shortcut into a human key label, e.g. `shift+f19` →
 * `Shift+F19`, `f13` → `F13`. Function keys are upper-cased; every other token
 * is title-cased so modifiers read naturally.
 */
export function formatCodexMicroShortcutLabel(shortcut: KeybindingShortcut): string {
  const tokens: string[] = [];
  if (shortcut.modKey) tokens.push("Mod");
  if (shortcut.metaKey) tokens.push("Meta");
  if (shortcut.ctrlKey) tokens.push("Ctrl");
  if (shortcut.altKey) tokens.push("Alt");
  if (shortcut.shiftKey) tokens.push("Shift");
  const key = shortcut.key;
  const keyLabel = /^f\d{1,2}$/i.test(key)
    ? key.toUpperCase()
    : key.length === 1
      ? key.toUpperCase()
      : key.slice(0, 1).toUpperCase() + key.slice(1);
  tokens.push(keyLabel);
  return tokens.join("+");
}

/**
 * Build the read-only layout table from the seeded command list + the CURRENT
 * resolved keybindings (C2). For each seeded command we surface the key it is
 * actually bound to now — not the static seed default — or "Not bound".
 */
export function resolveCodexMicroLayoutRows(
  resolvedKeybindings: ResolvedKeybindingsConfig,
): readonly CodexMicroLayoutRow[] {
  return CODEX_MICRO_SEED_LAYOUT.map((binding) => {
    const boundRule = resolvedKeybindings.find((rule) => rule.command === binding.command);
    return {
      actionLabel: CODEX_MICRO_COMMAND_ACTION_LABELS[binding.command] ?? binding.command,
      keyLabel: boundRule
        ? formatCodexMicroShortcutLabel(boundRule.shortcut)
        : CODEX_MICRO_NOT_BOUND_LABEL,
    };
  });
}

// ── View model ───────────────────────────────────────────────────────

export interface CodexMicroStatusView {
  /** Human status word for the current connection state. */
  readonly label: string;
  /** "USB" | "Bluetooth" when a transport is present, else null. */
  readonly transportLabel: string | null;
  /** Render the transport badge (only when a live transport is known). */
  readonly showTransportBadge: boolean;
  /** Battery %, ONLY when the device reports one (never a stale/last-known value). */
  readonly batteryPercent: number | null;
}

export interface CodexMicroControlsView {
  /** Brightness slider — only when the matrix proves brightness writable. */
  readonly showBrightnessSlider: boolean;
  /** Auto-dim toggle — only when the matrix proves auto-dim writable. */
  readonly showAutoDimToggle: boolean;
  /** Single quiet "unlock after verification" note for lighting/battery. */
  readonly showUnverifiedNote: boolean;
  /** LED-sync toggle is disabled until ledWrite is proven. */
  readonly ledSyncDisabled: boolean;
  /** Explanatory note under the LED-sync toggle while disabled, else null. */
  readonly ledSyncNote: string | null;
}

export interface CodexMicroPanelView {
  /** Bridge present ⇒ the feature exists in this runtime. */
  readonly featureAvailable: boolean;
  /**
   * True once the device is actively connected (connected | degraded). Drives
   * whether the lighting section shows anything beyond the honest empty state.
   */
  readonly deviceActive: boolean;
  readonly status: CodexMicroStatusView;
  readonly controls: CodexMicroControlsView;
}

function statusLabel(state: CodexMicroDeviceState["state"] | null): string {
  switch (state) {
    case "discovering":
      return "Searching";
    case "connected":
      return "Connected";
    case "degraded":
      return "Degraded";
    // `closed` is a terminal/inactive state — presented as Disconnected so the
    // page never implies a live device. `null` = pre-first-emission.
    case null:
      return "Checking device…";
    default:
      return "Disconnected";
  }
}

function transportLabel(transport: CodexMicroDeviceState["transport"]): string | null {
  switch (transport) {
    case "usb":
      return "USB";
    case "ble":
      return "Bluetooth";
    default:
      return null;
  }
}

/**
 * Compute the full render decision for the panel.
 *
 * @param bridgePresent whether `window.desktopBridge?.codexMicro` exists.
 * @param deviceState   latest state from the bridge, or `null` before the
 *                      first (replayed) emission arrives.
 */
export function resolveCodexMicroPanelView(input: {
  readonly bridgePresent: boolean;
  readonly deviceState: CodexMicroDeviceState | null;
}): CodexMicroPanelView {
  const { bridgePresent, deviceState } = input;

  if (!bridgePresent) {
    return {
      featureAvailable: false,
      deviceActive: false,
      status: {
        label: "Disconnected",
        transportLabel: null,
        showTransportBadge: false,
        batteryPercent: null,
      },
      controls: {
        showBrightnessSlider: false,
        showAutoDimToggle: false,
        showUnverifiedNote: false,
        ledSyncDisabled: true,
        ledSyncNote: null,
      },
    };
  }

  const state = deviceState?.state ?? null;
  const deviceActive = state === "connected" || state === "degraded";
  const transport = deviceState?.transport ?? null;
  const resolvedTransportLabel = transportLabel(transport);
  const batteryPercent = deviceState?.batteryPercent ?? null;
  const capabilities = deviceState?.capabilities;

  const brightnessSupported = capabilities?.brightness === "supported";
  const autoDimSupported = capabilities?.autoDim === "supported";
  const ledWriteSupported = capabilities?.ledWrite === "supported";

  // A single quiet note while lighting/battery capabilities remain unverified —
  // only meaningful once a device is actually connected (a disconnected device
  // always reads unverified, and we don't want to nag with no device attached).
  const anyLightingCapUnverified =
    capabilities?.brightness === "unverified" ||
    capabilities?.autoDim === "unverified" ||
    capabilities?.battery === "unverified";
  const showUnverifiedNote = deviceActive && anyLightingCapUnverified;

  return {
    featureAvailable: true,
    deviceActive,
    status: {
      label: statusLabel(state),
      transportLabel: resolvedTransportLabel,
      // Transport is only ever present on connected/degraded per the contract
      // invariant, so a non-null transport is a truthful "live link" signal.
      showTransportBadge: resolvedTransportLabel !== null,
      batteryPercent,
    },
    controls: {
      showBrightnessSlider: brightnessSupported,
      showAutoDimToggle: autoDimSupported,
      showUnverifiedNote,
      ledSyncDisabled: !ledWriteSupported,
      ledSyncNote: ledWriteSupported ? null : CODEX_MICRO_LED_SYNC_UNVERIFIED_NOTE,
    },
  };
}
