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

  it("defaults require to all-of when undefined", () => {
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
  });

  it("empty outcomes waits (not fail)", () => {
    expect(evaluateJoin([], { require: 1, onBranchFailure: "waitImpossible" }).result).toBe("wait");
  });
});
