/**
 * Pure join evaluation for fork-join ticket graphs.
 */
export type BranchOutcome = "success" | "failure" | "cancelled" | "unsettled";

export type JoinPolicy = {
  readonly require: number;
  readonly onBranchFailure: "failFast" | "waitImpossible";
};

export type JoinResult =
  | { readonly result: "success"; readonly succeeded: number; readonly failed: number }
  | { readonly result: "failure"; readonly succeeded: number; readonly failed: number }
  | { readonly result: "wait"; readonly succeeded: number; readonly failed: number };

export const evaluateJoin = (
  outcomes: ReadonlyArray<BranchOutcome>,
  policy: JoinPolicy,
): JoinResult => {
  const require = Math.max(1, Math.min(policy.require, outcomes.length));
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  let unsettled = 0;
  for (const o of outcomes) {
    if (o === "success") succeeded += 1;
    else if (o === "failure") failed += 1;
    else if (o === "cancelled") cancelled += 1;
    else unsettled += 1;
  }

  if (succeeded >= require) {
    return { result: "success", succeeded, failed };
  }
  if (policy.onBranchFailure === "failFast" && failed >= 1) {
    return { result: "failure", succeeded, failed };
  }
  // Impossibility for both policies: successes + unsettled cannot reach require.
  if (succeeded + unsettled < require) {
    return { result: "failure", succeeded, failed: failed + cancelled };
  }
  return { result: "wait", succeeded, failed };
};
