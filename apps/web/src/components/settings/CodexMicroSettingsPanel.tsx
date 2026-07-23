import { ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";

import type { CodexMicroDeviceState, DesktopCodexMicroBridge } from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";

import { ensureLocalApi } from "../../localApi";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  CODEX_MICRO_FEATURE_UNAVAILABLE_MESSAGE,
  CODEX_MICRO_FOCUS_NOTICE,
  CODEX_MICRO_SEEDED_LAYOUT,
  CODEX_MICRO_UNVERIFIED_NOTE,
  CODEX_MICRO_VIA_URL,
  resolveCodexMicroPanelView,
} from "./CodexMicroSettingsPanel.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const CODEX_MICRO_LOG_SCOPE = "[CODEX_MICRO]";

function getCodexMicroBridge(): DesktopCodexMicroBridge | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.desktopBridge?.codexMicro;
}

function logBridgeError(operation: string, error: unknown): void {
  console.error(`${CODEX_MICRO_LOG_SCOPE} ${operation} failed`, {
    operation,
    ...safeErrorLogAttributes(error),
  });
}

/** Subscribe to bridge device-state. Replay-on-subscribe delivers the current state first. */
function useCodexMicroDeviceState(
  bridge: DesktopCodexMicroBridge | undefined,
): CodexMicroDeviceState | null {
  const [deviceState, setDeviceState] = useState<CodexMicroDeviceState | null>(null);
  useEffect(() => {
    if (!bridge) {
      setDeviceState(null);
      return;
    }
    // The bridge always emits the current state as the first (ordered)
    // emission, so a subscription alone is a lossless snapshot source.
    const unsubscribe = bridge.onStateChange(setDeviceState);
    return unsubscribe;
  }, [bridge]);
  return deviceState;
}

export function CodexMicroSettingsPanel() {
  // Bridge identity is stable for the lifetime of the window; memoize so the
  // subscription effect doesn't churn.
  const bridge = useMemo(() => getCodexMicroBridge(), []);
  const deviceState = useCodexMicroDeviceState(bridge);

  const ledSyncEnabled = useClientSettings((settings) => settings.codexMicroLedSyncEnabled);
  const brightness = useClientSettings((settings) => settings.codexMicroBrightness);
  const autoDim = useClientSettings((settings) => settings.codexMicroAutoDim);
  const agentKeysSource = useClientSettings((settings) => settings.codexMicroAgentKeysSource);
  const updateSettings = useUpdateClientSettings();

  const view = useMemo(
    () => resolveCodexMicroPanelView({ bridgePresent: bridge !== undefined, deviceState }),
    [bridge, deviceState],
  );

  const openViaConfigurator = useCallback(() => {
    void ensureLocalApi()
      .shell.openExternal(CODEX_MICRO_VIA_URL)
      .catch((error: unknown) => logBridgeError("openExternal", error));
  }, []);

  const handleAutoDimChange = useCallback(
    (checked: boolean) => {
      updateSettings({ codexMicroAutoDim: checked });
      void bridge
        ?.setAutoDim(checked)
        .catch((error: unknown) => logBridgeError("setAutoDim", error));
    },
    [bridge, updateSettings],
  );

  const handleBrightnessChange = useCallback(
    (next: number) => {
      updateSettings({ codexMicroBrightness: next });
    },
    [updateSettings],
  );

  const commitBrightness = useCallback(
    (next: number) => {
      void bridge
        ?.setBrightness(next)
        .catch((error: unknown) => logBridgeError("setBrightness", error));
    },
    [bridge],
  );

  // ── Feature unavailable (plain browser / older desktop shell) ──────
  if (!view.featureAvailable) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Codex Micro">
          <SettingsRow title="Codex Micro" description={CODEX_MICRO_FEATURE_UNAVAILABLE_MESSAGE} />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const agentKeysSourceLabel =
    agentKeysSource === "recentChats" ? "Most recent chats" : agentKeysSource;

  return (
    <SettingsPageContainer>
      {/* ── Connection ─────────────────────────────────────────────── */}
      <SettingsSection title="Codex Micro">
        <SettingsRow
          title="Connection"
          description="Status of the Codex Micro macro-pad."
          control={
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-foreground">{view.status.label}</span>
              {view.status.showTransportBadge && view.status.transportLabel ? (
                <Badge variant="outline" size="sm">
                  {view.status.transportLabel}
                </Badge>
              ) : null}
              {view.status.batteryPercent !== null ? (
                <Badge variant="outline" size="sm">
                  {view.status.batteryPercent}%
                </Badge>
              ) : null}
            </div>
          }
        />

        {view.controls.showUnverifiedNote ? (
          <SettingsRow title="Lighting & battery" description={CODEX_MICRO_UNVERIFIED_NOTE} />
        ) : null}

        {view.controls.showBrightnessSlider ? (
          <SettingsRow
            title="Brightness"
            description="Key LED brightness."
            control={
              <div className="flex w-full items-center gap-2 sm:w-56">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={brightness}
                  aria-label="Codex Micro key brightness"
                  className="w-full accent-primary"
                  onChange={(event) => handleBrightnessChange(Number(event.target.value))}
                  onPointerUp={(event) =>
                    commitBrightness(Number((event.target as HTMLInputElement).value))
                  }
                  onKeyUp={(event) =>
                    commitBrightness(Number((event.target as HTMLInputElement).value))
                  }
                  onBlur={(event) => commitBrightness(Number(event.target.value))}
                />
                <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {brightness}%
                </span>
              </div>
            }
          />
        ) : null}

        {view.controls.showAutoDimToggle ? (
          <SettingsRow
            title="Auto-dim"
            description="Dim the keys automatically when idle."
            control={
              <Switch
                checked={autoDim}
                onCheckedChange={(checked) => handleAutoDimChange(Boolean(checked))}
                aria-label="Auto-dim Codex Micro keys when idle"
              />
            }
          />
        ) : null}

        <SettingsRow
          title="LED sync"
          description="Mirror chat states onto the six agent keys."
          status={view.controls.ledSyncNote}
          control={
            <Switch
              checked={ledSyncEnabled}
              disabled={view.controls.ledSyncDisabled}
              onCheckedChange={(checked) =>
                updateSettings({ codexMicroLedSyncEnabled: Boolean(checked) })
              }
              aria-label="Enable Codex Micro LED sync"
            />
          }
        />
      </SettingsSection>

      {/* ── Agent keys ─────────────────────────────────────────────── */}
      <SettingsSection title="Agent keys">
        <SettingsRow
          title="Source"
          description="The six agent keys open your most recently active chats — the topmost slot is the most recent."
          control={
            <span className="text-[13px] font-medium text-foreground">{agentKeysSourceLabel}</span>
          }
        />
      </SettingsSection>

      {/* ── Layout (read-only) ─────────────────────────────────────── */}
      <SettingsSection title="Layout">
        <SettingsRow
          title="Seeded keys"
          description="The default key map the device ships with. Remap the commands in-app from Settings → Keybindings."
        >
          <div className="pt-1 pb-3.5">
            <ul className="space-y-1.5">
              {CODEX_MICRO_SEEDED_LAYOUT.map((binding) => (
                <li
                  key={binding.keyLabel}
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                  <kbd className="min-w-14 rounded-sm border bg-surface-raised px-1.5 py-0.5 text-center font-mono text-[11px] text-foreground">
                    {binding.keyLabel}
                  </kbd>
                  <span>{binding.actionLabel}</span>
                </li>
              ))}
            </ul>
          </div>
        </SettingsRow>

        <SettingsRow title="Focus" description={CODEX_MICRO_FOCUS_NOTICE} />

        <SettingsRow
          title="Remap on the device"
          description="Change the hardware key mapping with the Work Louder / VIA configurator."
          control={
            <Button variant="outline" size="xs" onClick={openViaConfigurator}>
              <ExternalLinkIcon className="size-3.5" />
              Open VIA
            </Button>
          }
        />

        <SettingsRow
          title="Keybindings"
          description="Remap the commands these keys invoke inside T3 Code."
          control={
            <Button render={<Link to="/settings/keybindings" />} size="xs" variant="outline">
              Open Keybindings
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
