import { MOCK_SLACK_WORKSPACE_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  MockSlackGateway,
  SlackAgentGateway,
  type SlackAgentGatewayShape,
} from "../../workflow/Services/SlackAgentGateway.ts";
import { RealSlackGateway } from "../Services/RealSlackGateway.ts";

const isMockWorkspace = (workspaceId: string) => workspaceId === MOCK_SLACK_WORKSPACE_ID;

const make = Effect.gen(function* () {
  const mock = yield* MockSlackGateway;
  const real = yield* RealSlackGateway;

  const route = (workspaceId: string): SlackAgentGatewayShape =>
    isMockWorkspace(workspaceId) ? mock : real;

  return SlackAgentGateway.of({
    snapshotThreadThroughTrigger: (input) =>
      route(input.workspaceId).snapshotThreadThroughTrigger(input),
    postOrUpdateStatus: (input) => route(input.workspaceId).postOrUpdateStatus(input),
    subscribeMockThread: (input) => route(input.workspaceId).subscribeMockThread(input),
    subscribeMockThreadChanges: (input) =>
      route(input.workspaceId).subscribeMockThreadChanges(input),
  });
});

export const SlackGatewayRouterLive = Layer.effect(SlackAgentGateway, make);
