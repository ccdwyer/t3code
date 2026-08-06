import { describe, expect, it } from "vite-plus/test";

import { evaluateJoin } from "./forkJoin.ts";

describe("evaluateJoin", () => {
  it("succeeds when require-K is met", () => {
    expect(
      evaluateJoin(["success", "unsettled", "failure"], {
        require: 1,
        onBranchFailure: "waitImpossible",
      }).result,
    ).toBe("success");
  });

  it("failFast fails on first branch failure", () => {
    expect(
      evaluateJoin(["failure", "unsettled"], {
        require: 2,
        onBranchFailure: "failFast",
      }).result,
    ).toBe("failure");
  });

  it("failFast does not trip on cancelled alone (only hard failures)", () => {
    // require 1: cancelled does not fail-fast; unsettled can still succeed.
    expect(
      evaluateJoin(["cancelled", "unsettled"], {
        require: 1,
        onBranchFailure: "failFast",
      }).result,
    ).toBe("wait");
    // require 2 with only one remaining unsettled is impossible → failure
    // via the capacity check, not via fail-fast on cancelled.
    const impossible = evaluateJoin(["cancelled", "unsettled"], {
      require: 2,
      onBranchFailure: "failFast",
    });
    expect(impossible.result).toBe("failure");
    expect(impossible.failed).toBe(0);
    expect(impossible.cancelled).toBe(1);
  });

  it("detects unsatisfiable join when cancelled shrinks remaining", () => {
    expect(
      evaluateJoin(["cancelled", "cancelled"], {
        require: 2,
        onBranchFailure: "failFast",
      }).result,
    ).toBe("failure");
    expect(
      evaluateJoin(["cancelled", "cancelled"], {
        require: 2,
        onBranchFailure: "waitImpossible",
      }).result,
    ).toBe("failure");
  });

  it("waits when still possible", () => {
    expect(
      evaluateJoin(["success", "unsettled", "unsettled"], {
        require: 2,
        onBranchFailure: "waitImpossible",
      }).result,
    ).toBe("wait");
  });

  it("does not clamp require down — short list with require>length is impossible", () => {
    // Caller must pass a fixed-length list (one entry per child). A short list
    // with require higher than length is impossible → failure, not success.
    expect(
      evaluateJoin(["success", "success"], {
        require: 3,
        onBranchFailure: "waitImpossible",
      }).result,
    ).toBe("failure");
    // Correct caller form: pad missing children as unsettled → wait.
    expect(
      evaluateJoin(["success", "success", "unsettled"], {
        require: 3,
        onBranchFailure: "waitImpossible",
      }).result,
    ).toBe("wait");
  });

  it("defaults require to all-of when undefined or non-finite", () => {
    expect(
      evaluateJoin(["success", "success"], {
        onBranchFailure: "waitImpossible",
      }).result,
    ).toBe("success");
    expect(
      evaluateJoin(["success", "unsettled"], {
        onBranchFailure: "waitImpossible",
      }).result,
    ).toBe("wait");
    // Infinity / NaN → all-of (same as undefined).
    expect(
      evaluateJoin(["success", "success"], {
        require: Number.POSITIVE_INFINITY,
        onBranchFailure: "waitImpossible",
      }).result,
    ).toBe("success");
  });

  it("floors require < 1 up to 1 (schema enforces ≥1)", () => {
    expect(
      evaluateJoin(["failure"], {
        require: 0,
        onBranchFailure: "waitImpossible",
      }).result,
    ).toBe("failure");
    expect(
      evaluateJoin(["unsettled"], {
        require: -3,
        onBranchFailure: "waitImpossible",
      }).result,
    ).toBe("wait");
  });

  it("ceils fractional require (never lowers the bar)", () => {
    // 2.1 → 3; two successes are not enough.
    expect(
      evaluateJoin(["success", "success", "unsettled"], {
        require: 2.1,
        onBranchFailure: "waitImpossible",
      }).result,
    ).toBe("wait");
    expect(
      evaluateJoin(["success", "success", "success"], {
        require: 2.1,
        onBranchFailure: "waitImpossible",
      }).result,
    ).toBe("success");
  });

  it("empty outcomes waits (not fail)", () => {
    expect(evaluateJoin([], { require: 1, onBranchFailure: "waitImpossible" }).result).toBe("wait");
  });

  it("reports cancelled separately from failed", () => {
    const r = evaluateJoin(["failure", "cancelled"], {
      require: 2,
      onBranchFailure: "failFast",
    });
    expect(r.result).toBe("failure");
    expect(r.failed).toBe(1);
    expect(r.cancelled).toBe(1);
  });
});
