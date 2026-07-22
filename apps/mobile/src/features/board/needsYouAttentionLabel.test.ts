import { describe, expect, it } from "vite-plus/test";

import { attentionLabel } from "./needsYouAttentionLabel";

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
});
