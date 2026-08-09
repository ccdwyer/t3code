import { describe, expect, it } from "vite-plus/test";

import {
  buildSlackAppManifest,
  SLACK_APP_MANIFEST_BOT_SCOPES,
  SLACK_APP_MANIFEST_EVENTS,
} from "./slackAppManifest";

describe("buildSlackAppManifest", () => {
  it("generates a Socket Mode Slack app manifest for a per-developer bot", () => {
    const manifest = buildSlackAppManifest({
      handle: "t3_chris",
      ownerLabel: "Chris",
    });

    expect(manifest).toContain("name: 'T3 Chris'");
    expect(manifest).toContain("display_name: 't3_chris'");
    expect(manifest).toContain("app_home:");
    expect(manifest).toContain("messages_tab_enabled: true");
    expect(manifest).toContain("socket_mode_enabled: true");
    expect(manifest).toContain("- files:read");
    for (const scope of SLACK_APP_MANIFEST_BOT_SCOPES) {
      expect(manifest).toContain(`- ${scope}`);
    }
    for (const event of SLACK_APP_MANIFEST_EVENTS) {
      expect(manifest).toContain(`- ${event}`);
    }
  });

  it("quotes apostrophes for YAML single quoted strings", () => {
    const manifest = buildSlackAppManifest({
      handle: "t3_dev",
      ownerLabel: "Chris's Laptop",
    });

    expect(manifest).toContain("name: 'T3 Chris''s Laptop'");
  });

  it("keeps the Slack app name within the manifest limit", () => {
    const manifest = buildSlackAppManifest({
      handle: "t3_chris",
      ownerLabel: "A developer label that is intentionally much too long for Slack",
    });
    const appName = manifest.match(/name: '([^']+)'/)?.[1];

    expect(appName).toHaveLength(35);
  });
});
