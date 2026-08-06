import type { WorkflowDryRunHop, WorkflowDryRunResult } from "@t3tools/contracts";

/** One simulated hop as a sentence fragment for the dry-run result list. */
export const describeDryRunHop = (
  hop: WorkflowDryRunHop,
  laneName: (key: string) => string,
): string => {
  const from = laneName(hop.fromLane);
  // Branch on `park` first: a park hop carries no `toLane` (the walk stayed
  // in `fromLane`), so it must never fall into the lane-move phrasing below.
  if (hop.park !== undefined) {
    const label = hop.park.label === undefined ? "" : ` — ${hop.park.label}`;
    return `${from} — parked (${hop.park.substate})${label}`;
  }
  if (hop.toLane === undefined) {
    // Producer invariant: exactly one of toLane/park is present, so this is
    // unreachable in practice — keeps the function total without a cast.
    return `${from} — unknown route`;
  }
  const route = `${from} → ${laneName(hop.toLane)}`;
  if (hop.source === "step_on") {
    return `${route} — step "${hop.viaStepKey ?? "?"}" ${hop.result} route`;
  }
  if (hop.source === "lane_transition") {
    return `${route} — transition #${(hop.matchedTransitionIndex ?? 0) + 1} matched`;
  }
  return `${route} — lane ${hop.result} fallback`;
};

export const describeDryRunEnd = (
  run: WorkflowDryRunResult,
  laneName: (key: string) => string,
): string => {
  const lane = laneName(run.endLane);
  switch (run.end) {
    case "terminal":
      return `Reached terminal lane "${lane}".`;
    case "manual":
      return `Waiting in "${lane}" for a human (manual lane).`;
    case "no_route":
      return `Stuck in "${lane}" — no route matched. Add a transition or fallback.`;
    case "cycle_cap":
      return `Still looping after ${run.hops.length} hops (ended in "${lane}") — likely an unbounded cycle.`;
    case "parked": {
      // The walk's final hop is the park hop that produced this end state —
      // surface its substate/label instead of a bare lane name.
      const park = run.hops[run.hops.length - 1]?.park;
      if (park === undefined) {
        return `Parked in "${lane}".`;
      }
      const label = park.label === undefined ? "" : ` — ${park.label}`;
      return `Parked in "${lane}" (${park.substate})${label}.`;
    }
  }
};
