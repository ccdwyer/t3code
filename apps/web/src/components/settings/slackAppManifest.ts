export const SLACK_APP_MANIFEST_BOT_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "users:read",
  "files:read",
] as const;

export const SLACK_APP_MANIFEST_EVENTS = [
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
] as const;

function yamlSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildSlackAppManifest(input: {
  readonly handle: string;
  readonly ownerLabel: string;
}): string {
  const handle = input.handle.trim();
  const ownerLabel = input.ownerLabel.trim();
  const appName = (ownerLabel.length === 0 ? handle : `T3 ${ownerLabel}`).slice(0, 35);

  return [
    "_metadata:",
    "  major_version: 1",
    "  minor_version: 1",
    "display_information:",
    `  name: ${yamlSingleQuote(appName)}`,
    "features:",
    "  app_home:",
    "    messages_tab_enabled: true",
    "    messages_tab_read_only_enabled: false",
    "  bot_user:",
    `    display_name: ${yamlSingleQuote(handle)}`,
    "    always_online: true",
    "oauth_config:",
    "  scopes:",
    "    bot:",
    ...SLACK_APP_MANIFEST_BOT_SCOPES.map((scope) => `      - ${scope}`),
    "settings:",
    "  event_subscriptions:",
    "    bot_events:",
    ...SLACK_APP_MANIFEST_EVENTS.map((event) => `      - ${event}`),
    "  org_deploy_enabled: false",
    "  socket_mode_enabled: true",
    "  token_rotation_enabled: false",
  ].join("\n");
}
