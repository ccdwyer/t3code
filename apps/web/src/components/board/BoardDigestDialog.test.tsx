import { describe, expect, it } from "vite-plus/test";

import { digestAttentionLabel } from "./BoardDigestDialog";

describe("digestAttentionLabel", () => {
  it("labels a parked issue as 'issue' (not 'waiting')", () => {
    expect(digestAttentionLabel({ status: "parked", attentionKind: "parked_issue" })).toBe("issue");
  });

  it("labels a parked-waiting ticket as 'waiting'", () => {
    expect(
      digestAttentionLabel({
        status: "parked",
        attentionKind: "parked_waiting",
      }),
    ).toBe("waiting");
  });

  it("labels a blocked ticket as 'blocked'", () => {
    expect(digestAttentionLabel({ status: "blocked", attentionKind: "blocked" })).toBe("blocked");
  });

  it("labels a waiting-on-user ticket as 'waiting'", () => {
    expect(
      digestAttentionLabel({
        status: "waiting_on_user",
        attentionKind: "waiting_for_approval",
      }),
    ).toBe("waiting");
  });

  it("falls back to 'waiting' when attentionKind is null and status is not blocked", () => {
    expect(digestAttentionLabel({ status: "waiting_on_user", attentionKind: null })).toBe(
      "waiting",
    );
  });
});
