/**
 * Pure join evaluation for fork-join ticket graphs.
 */
export type BranchOutcome = "success" | "failure" | "cancelled" | "unsettled";

export type JoinPolicy = {
  /**
   * Required successes. Defaults to all-of (`outcomes.length`) when undefined
   * or non-finite (incl. `Infinity` / `NaN`).
   *
   * Contract schema enforces integer ≥ 1; pure defense-in-depth:
   * - values &lt; 1 are floored up to 1 (never vacuous-success at runtime)
   * - fractional values use `Math.ceil` (never lower the bar)
   * - values above `outcomes.length` are kept — never clamped down
   *   (impossible until enough successes, or failure once unsettled cannot fill)
   */
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
 *
 * **Caller contract:**
 * - Missing / not-yet-spawned children must be represented as `"unsettled"`, never omitted.
 * - Do not call with `outcomes.length === 0` for a settled fork (fork children are
 *   non-empty by schema). Empty input returns `"wait"` so pre-spawn / recovery
 *   races do not permanently fail the join.
 *
 * `require` defaults to `outcomes.length` (all-of). Values above length are kept
 * (impossible until enough successes) — never clamped down.
 *
 * `cancelled` is excluded from fail-fast (softer than failure) but counts against
 * remaining capacity in the impossibility check (`succeeded + unsettled < require`).
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

  let require: number;
  if (policy.require === undefined || !Number.isFinite(policy.require)) {
    require = outcomes.length;
  } else if (policy.require < 1) {
    // Schema requires ≥1; floor non-positive to 1 rather than vacuous success.
    require = 1;
  } else {
    // Ceil fractions so we never silently lower the bar (e.g. 2.1 → 3).
    require = Math.ceil(policy.require);
  }

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
  // failFast: only hard failures trip early exit; cancelled is softer (see JSDoc).
  if (policy.onBranchFailure === "failFast" && failed >= 1) {
    return { result: "failure", ...base };
  }
  // Impossibility: even if every unsettled succeeds, cannot reach require.
  // cancelled is already excluded from unsettled, so it shrinks remaining capacity.
  if (succeeded + unsettled < require) {
    return { result: "failure", ...base };
  }
  return { result: "wait", ...base };
};
