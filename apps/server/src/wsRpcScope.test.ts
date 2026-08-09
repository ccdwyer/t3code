import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthWorkflowReadScope,
  WORKFLOW_WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { RPC_REQUIRED_SCOPE } from "./ws.ts";

/**
 * Regression guard: every RPC method registered in WsRpcGroup must have a
 * declared authorization scope in RPC_REQUIRED_SCOPE. If this test fails it
 * means a new method was added to the RPC group without wiring its scope,
 * which causes ws.ts to throw "no declared authorization scope" on every real
 * call for that method.
 */
it("every WsRpcGroup method has a declared authorization scope in RPC_REQUIRED_SCOPE", () => {
  const missing: string[] = [];
  for (const [methodTag] of WsRpcGroup.requests) {
    if (!RPC_REQUIRED_SCOPE.has(methodTag)) {
      missing.push(methodTag);
    }
  }
  assert.deepStrictEqual(
    missing,
    [],
    `The following WsRpcGroup methods are missing from RPC_REQUIRED_SCOPE:\n  ${missing.join("\n  ")}`,
  );
});

/**
 * The generic guard above only proves a scope EXISTS. These read-only history
 * methods must specifically require the workflow READ scope: a mis-wire to the
 * operate scope would silently demand write permission to look at history, and
 * a mis-wire the other way would expose it to anyone.
 */
it("the timeline reads require the workflow read scope specifically", () => {
  assert.strictEqual(
    RPC_REQUIRED_SCOPE.get(WORKFLOW_WS_METHODS.getTicketTimeline),
    AuthWorkflowReadScope,
  );
  assert.strictEqual(
    RPC_REQUIRED_SCOPE.get(WORKFLOW_WS_METHODS.getBoardTimeline),
    AuthWorkflowReadScope,
  );
});

it("Slack agent chat uses orchestration scopes instead of requiring workflow access", () => {
  const reads = [
    WORKFLOW_WS_METHODS.listSlackAgentInstances,
    WORKFLOW_WS_METHODS.getSlackAgentRun,
    WORKFLOW_WS_METHODS.subscribeSlackAgentRun,
    WORKFLOW_WS_METHODS.subscribeMockSlackThread,
  ];
  const mutations = [
    WORKFLOW_WS_METHODS.createSlackAgentInstance,
    WORKFLOW_WS_METHODS.createMockSlackAgentInstance,
    WORKFLOW_WS_METHODS.connectSlackAgentInstance,
    WORKFLOW_WS_METHODS.disconnectSlackAgentInstance,
    WORKFLOW_WS_METHODS.testSlackAgentConnection,
    WORKFLOW_WS_METHODS.updateSlackAgentInstance,
    WORKFLOW_WS_METHODS.disableSlackAgentInstance,
    WORKFLOW_WS_METHODS.enableSlackAgentInstance,
    WORKFLOW_WS_METHODS.deleteSlackAgentInstance,
    WORKFLOW_WS_METHODS.simulateSlackMention,
    WORKFLOW_WS_METHODS.retrySlackAgentDelivery,
  ];

  for (const method of reads) {
    assert.strictEqual(RPC_REQUIRED_SCOPE.get(method), AuthOrchestrationReadScope, method);
  }
  for (const method of mutations) {
    assert.strictEqual(RPC_REQUIRED_SCOPE.get(method), AuthOrchestrationOperateScope, method);
  }
});
