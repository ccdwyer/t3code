import { assert, describe, it } from "@effect/vitest";
import type { WorkflowEvent } from "@t3tools/contracts";

import { renderSlackAgentStatus } from "./slackAgentStatus.ts";

const baseEvent = {
  eventId: "event-1",
  ticketId: "ticket-1",
  streamVersion: 1,
  occurredAt: "2026-06-07T00:00:00.000Z",
} as const;

describe("renderSlackAgentStatus", () => {
  it("renders a terminal lane move as done", () => {
    const payload = renderSlackAgentStatus({
      runId: "run-1",
      ticketId: "ticket-1",
      title: "Ship the change",
      workflowSequence: 9,
      isTerminal: true,
      event: {
        eventId: "event-9",
        ticketId: "ticket-1",
        streamVersion: 9,
        occurredAt: "2026-08-07T12:00:00.000Z",
        type: "TicketMovedToLane",
        payload: { toLane: "done", laneEntryToken: "token-9", reason: "pipeline" },
      } as never,
    });

    assert.equal(payload.status, "done");
    assert.equal(payload.kind, "done");
    assert.equal(payload.body, "Completed in done");
  });

  it("renders a bounded redacted needs-attention payload", () => {
    const event = {
      ...baseEvent,
      type: "StepAwaitingUser",
      payload: {
        stepRunId: "step-run-1" as never,
        waitingReason:
          "tokens xoxb-secret and xapp-secret should not leak and neither should https://hooks.slack.com/services/T/B/C",
      } satisfies Extract<WorkflowEvent, { type: "StepAwaitingUser" }>["payload"],
    } as unknown as WorkflowEvent;

    const payload = renderSlackAgentStatus({
      runId: "run-1",
      ticketId: "ticket-1",
      title: "A".repeat(200),
      event,
      workflowSequence: 42,
    });

    assert.equal(payload.status, "waiting");
    assert.equal(payload.workflowSequence, 42);
    assert.isAtMost(payload.headline.length, 120);
    assert.include(payload.body, "[redacted]");
    assert.include(payload.body, "[redacted-slack-url]");
    assert.include(payload.text, "[redacted]");
    assert.notInclude(payload.body, "xapp-secret");
    assert.include(payload.text, "Ticket: t3://ticket/ticket-1");
  });

  it("carries a stored PR URL into later payloads", () => {
    const event = {
      ...baseEvent,
      type: "StepStarted",
      payload: {
        pipelineRunId: "pipeline-1" as never,
        stepRunId: "step-run-1" as never,
        stepKey: "verify" as never,
        stepType: "agent",
      } satisfies Extract<WorkflowEvent, { type: "StepStarted" }>["payload"],
    } as unknown as WorkflowEvent;

    const payload = renderSlackAgentStatus({
      runId: "run-1",
      ticketId: "ticket-1",
      title: "Verify work",
      event,
      workflowSequence: 43,
      prUrl: "https://github.com/acme/repo/pull/12",
    });

    assert.equal(payload.status, "running");
    assert.equal(payload.prUrl, "https://github.com/acme/repo/pull/12");
  });
});
