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
import type { CodexMicroDeviceState } from "@t3tools/contracts";

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

// ── Seeded layout (read-only display table) ──────────────────────────

export interface CodexMicroKeyBinding {
  /** Human key label, e.g. "F13" or "Shift+F19". */
  readonly keyLabel: string;
  /** Human action label, e.g. "Open recent chat 1". */
  readonly actionLabel: string;
}

// TODO(codex-micro integration): unify with the seeding module's constant
// (apps/web/src/codexMicroSeeding.ts, owned by T7) once it exists — this local
// table mirrors the seeded defaults (f13–f18 → agentKey.open.1..6, f19 →
// approval.accept, shift+f19 → approval.decline) so the panel can build without
// a cross-task import dependency.
export const CODEX_MICRO_SEEDED_LAYOUT: readonly CodexMicroKeyBinding[] = [
  { keyLabel: "F13", actionLabel: "Open recent chat 1" },
  { keyLabel: "F14", actionLabel: "Open recent chat 2" },
  { keyLabel: "F15", actionLabel: "Open recent chat 3" },
  { keyLabel: "F16", actionLabel: "Open recent chat 4" },
  { keyLabel: "F17", actionLabel: "Open recent chat 5" },
  { keyLabel: "F18", actionLabel: "Open recent chat 6" },
  { keyLabel: "F19", actionLabel: "Approve once" },
  { keyLabel: "Shift+F19", actionLabel: "Decline" },
];

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
