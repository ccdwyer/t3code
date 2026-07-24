import { describe, expect, it } from "vite-plus/test";

import { attentionAgeSource, attentionLabel } from "./needsYouAttentionLabel";

describe("attentionLabel", () => {
  it("labels waiting_for_approval as Needs approval", () => {
    expect(
      attentionLabel({ attentionKind: "waiting_for_approval", status: "waiting_on_user" }),
    ).toBe("Needs approval");
  });

  it("labels waiting_for_input as Needs input", () => {
    expect(attentionLabel({ attentionKind: "waiting_for_input", status: "waiting_on_user" })).toBe(
      "Needs input",
    );
  });

  it("labels blocked as Blocked", () => {
    expect(attentionLabel({ attentionKind: "blocked", status: "blocked" })).toBe("Blocked");
  });

  it("labels parked_issue as issue", () => {
    expect(attentionLabel({ attentionKind: "parked_issue", status: "parked" })).toBe("issue");
  });

  it("labels parked_waiting as waiting on you", () => {
    expect(attentionLabel({ attentionKind: "parked_waiting", status: "parked" })).toBe(
      "waiting on you",
    );
  });

  it("falls back to parked (not the raw status) when attentionKind is null and status is parked", () => {
    expect(attentionLabel({ attentionKind: null, status: "parked" })).toBe("parked");
  });

  it("falls back to the raw status for a non-parked ticket with an unrecognized/null attentionKind", () => {
    expect(attentionLabel({ attentionKind: null, status: "running" })).toBe("running");
  });

  it("labels a notify-only SLA breach (null attentionKind + reason) as SLA breached", () => {
    expect(
      attentionLabel({
        attentionKind: null,
        status: "idle",
        slaBreachedReason: "SLA breached in review",
      }),
    ).toBe("SLA breached");
  });

  it("does not prefer SLA copy when slaBreachedReason is empty", () => {
    expect(
      attentionLabel({
        attentionKind: null,
        status: "idle",
        slaBreachedReason: "",
      }),
    ).toBe("idle");
  });
});

describe("attentionAgeSource", () => {
  it("ages a parked ticket from its parkedAt, not the edit-bumped updatedAt", () => {
    expect(
      attentionAgeSource({
        parkedAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T05:00:00.000Z",
      }),
    ).toBe("2026-07-22T00:00:00.000Z");
  });

  it("falls back to updatedAt when parkedAt is null (non-parked rows)", () => {
    expect(
      attentionAgeSource({
        parkedAt: null,
        slaBreachedAt: null,
        updatedAt: "2026-07-22T05:00:00.000Z",
      }),
    ).toBe("2026-07-22T05:00:00.000Z");
  });

  it("ages an SLA breach from slaBreachedAt when not parked", () => {
    expect(
      attentionAgeSource({
        parkedAt: null,
        slaBreachedAt: "2026-07-22T03:00:00.000Z",
        updatedAt: "2026-07-22T05:00:00.000Z",
      }),
    ).toBe("2026-07-22T03:00:00.000Z");
  });

  it("prefers parkedAt over slaBreachedAt when both are set", () => {
    expect(
      attentionAgeSource({
        parkedAt: "2026-07-22T01:00:00.000Z",
        slaBreachedAt: "2026-07-22T03:00:00.000Z",
        updatedAt: "2026-07-22T05:00:00.000Z",
      }),
    ).toBe("2026-07-22T01:00:00.000Z");
  });
});
