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

  it("does not clamp require down to partial outcomes length", () => {
    // require 3 of 3 but only 2 slots provided as success — still wait (missing
    // child must be passed as unsettled by the caller; we do not lower the bar).
    expect(
      evaluateJoin(["success", "success"], {
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
