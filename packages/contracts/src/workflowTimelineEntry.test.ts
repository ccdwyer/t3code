import { assert, describe, it } from "@effect/vitest";

import type { WorkflowEvent } from "./workflow.ts";
import { toTimelineEntry } from "./workflowTimelineEntry.ts";

const ev = (type: string, payload: Record<string, unknown> = {}): WorkflowEvent =>
  ({
    type,
    eventId: "evt-1",
    ticketId: "t-1",
    streamVersion: 4,
    occurredAt: "2026-07-25T00:00:00.000Z",
    payload,
  }) as never;

describe("toTimelineEntry", () => {
  it("distinguishes a human move from an engine route", () => {
    // Actor is derived from semantics; the journal has no actor column.
    assert.equal(
      toTimelineEntry(ev("TicketMovedToLane", { toLane: "x", reason: "manual" })).actor,
      "user",
    );
    assert.equal(
      toTimelineEntry(ev("TicketMovedToLane", { toLane: "x", reason: "routed" })).actor,
      "system",
    );
    assert.equal(
      toTimelineEntry(ev("TicketMovedToLane", { toLane: "x", reason: "external" })).actor,
      "external",
    );
  });

  it("names the retry attempt only when there has been one", () => {
    assert.notInclude(
      toTimelineEntry(ev("StepStarted", { stepKey: "build", attempt: 1 })).summary,
      "attempt",
    );
    assert.include(
      toTimelineEntry(ev("StepStarted", { stepKey: "build", attempt: 3 })).summary,
      "attempt 3",
    );
  });

  it("carries stepRunId so an entry can deep-link to its conversation", () => {
    assert.equal(
      toTimelineEntry(ev("StepStarted", { stepKey: "b", stepRunId: "sr-1" })).stepRunId,
      "sr-1",
    );
  });

  it("surfaces a checkpoint decision in the summary", () => {
    assert.include(
      toTimelineEntry(ev("StepUserResolved", { stepRunId: "sr", decision: "changes" })).summary,
      "changes",
    );
    assert.equal(
      toTimelineEntry(ev("StepUserResolved", { stepRunId: "sr" })).summary,
      "Human responded",
    );
  });

  it("clips a long detail to one line", () => {
    const entry = toTimelineEntry(
      ev("StepFailed", {
        stepRunId: "sr",
        error: `${"x".repeat(400)}\n\nmore`,
      }),
    );
    assert.notInclude(entry.detail ?? "", "\n");
    assert.isAtMost((entry.detail ?? "").length, 161);
  });

  it("renders an unrecognized event rather than dropping it", () => {
    // A client is routinely older than the server that wrote the event, and a
    // silently missing row is invisible in a way an unfamiliar one is not.
    const entry = toTimelineEntry(ev("SomeFutureEvent", {}));
    assert.equal(entry.category, "unknown");
    assert.equal(entry.summary, "SomeFutureEvent");
  });

  it("categorizes repo mutations and shows the ref transition", () => {
    const entry = toTimelineEntry(
      ev("StepRefsCaptured", { stepRunId: "sr", preRef: "a", postRef: "b" }),
    );
    assert.equal(entry.category, "repo");
    assert.include(entry.detail ?? "", "a → b");
  });
});
