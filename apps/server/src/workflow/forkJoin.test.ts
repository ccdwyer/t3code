import { describe, expect, it } from "vite-plus/test";

import { evaluateJoin } from "./forkJoin.ts";

describe("evaluateJoin", () => {
  it("succeeds when require-K is met", () => {
    expect(
      evaluateJoin(["success", "unsettled", "failure"], {
        require: 1,
        onBranchFailure: "waitImpossible",
      }),
    ).toEqual({ result: "success", succeeded: 1, failed: 1 });
  });

  it("failFast fails on first branch failure", () => {
    expect(
      evaluateJoin(["failure", "unsettled"], {
        require: 2,
        onBranchFailure: "failFast",
      }),
    ).toEqual({ result: "failure", succeeded: 0, failed: 1 });
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
});
