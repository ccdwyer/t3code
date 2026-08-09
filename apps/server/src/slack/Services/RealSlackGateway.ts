import * as Context from "effect/Context";

import type { SlackAgentGatewayShape } from "../../workflow/Services/SlackAgentGateway.ts";

export interface RealSlackGatewayShape extends SlackAgentGatewayShape {}

export class RealSlackGateway extends Context.Service<RealSlackGateway, RealSlackGatewayShape>()(
  "t3/slack/Services/RealSlackGateway",
) {}
