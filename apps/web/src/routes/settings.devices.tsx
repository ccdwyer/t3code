import { createFileRoute } from "@tanstack/react-router";

import { CodexMicroSettingsPanel } from "../components/settings/CodexMicroSettingsPanel";

function SettingsDevicesRoute() {
  return <CodexMicroSettingsPanel />;
}

export const Route = createFileRoute("/settings/devices")({
  component: SettingsDevicesRoute,
});
