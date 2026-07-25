/**
 * Pure join evaluation for fork-join ticket graphs.
 */
export type BranchOutcome = "success" | "failure" | "cancelled" | "unsettled";

export type JoinPolicy = {
  /** Required successes. Defaults to all-of when undefined. */
  readonly require?: number;
  readonly onBranchFailure: "failFast" | "waitImpossible";
};

export type JoinResult = {
  readonly result: "success" | "failure" | "wait";
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly unsettled: number;
};

/**
 * Evaluate join over a fixed-length child outcome list (length === children.length).
 * Missing children must be represented as `"unsettled"`, never omitted.
 * `require` defaults to outcomes.length (all-of). Values above length are kept
 * (impossible until enough successes) — never clamped down.
 */
export const evaluateJoin = (
  outcomes: ReadonlyArray<BranchOutcome>,
  policy: JoinPolicy,
): JoinResult => {
  if (outcomes.length === 0) {
    return {
      result: "wait",
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      unsettled: 0,
    };
  }
  const require =
    policy.require === undefined || !Number.isFinite(policy.require)
      ? outcomes.length
      : Math.max(1, Math.floor(policy.require));

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

  const base = { succeeded, failed, cancelled, unsettled };

  if (succeeded >= require) {
    return { result: "success", ...base };
  }
  if (policy.onBranchFailure === "failFast" && failed >= 1) {
    return { result: "failure", ...base };
  }
  // Impossibility: even if every unsettled succeeds, cannot reach require.
  if (succeeded + unsettled < require) {
    return { result: "failure", ...base };
  }
  return { result: "wait", ...base };
};
