import { createFileRoute } from "@tanstack/react-router";

import { SlackAgentInstancesSettings } from "../components/settings/SlackAgentInstancesSettings";

export const Route = createFileRoute("/settings/slack-agents")({
  component: SlackAgentInstancesSettings,
});
