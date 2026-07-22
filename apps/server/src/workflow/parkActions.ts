import type {
  LaneKey,
  StepRouting,
  WorkflowDefinition,
  WorkflowLaneAction,
  WorkflowParkTarget,
  WorkflowRouteTarget,
} from "@t3tools/contracts";
import { isParkTarget } from "@t3tools/contracts";

import { parkTargetFingerprint, parseParkOrigin } from "./parkOrigin.ts";

// LaneRouting and StepRouting share the same {success,failure,blocked} shape, so
// one reader serves both lane_on and step origins. A `key` that is not one of
// the three routing verdicts yields no target (fail closed).
const routeTargetForKey = (
  routing: StepRouting | undefined,
  key: string | undefined,
): WorkflowRouteTarget | undefined => {
  if (routing === undefined || key === undefined) {
    return undefined;
  }
  switch (key) {
    case "success":
      return routing.success;
    case "failure":
      return routing.failure;
    case "blocked":
      return routing.blocked;
    default:
      return undefined;
  }
};

// Re-resolves a parked ticket's actions from the CURRENT board definition. The
// stored `actionsSnapshot` on the event is display-only history; actions that
// are actually invoked come from here so an edited/reverted board never executes
// a stale snapshot.
//
// Identity is the origin fingerprint, NEVER a positional index: a transition
// inserted above a park target must not silently rebind it. We scan the
// candidate park targets of the origin's `src` in the current lane and return
// the actions of the one whose fingerprint matches the origin. Returns null when
// the origin is unparseable, the lane is gone, no candidate fingerprint-matches
// (the target was edited), or the routing site now holds a bare lane key.
export const resolveParkActions = (
  definition: WorkflowDefinition,
  laneKey: LaneKey,
  originJson: string,
): ReadonlyArray<WorkflowLaneAction> | null => {
  const origin = parseParkOrigin(originJson);
  if (origin === null) {
    return null;
  }
  const lane = definition.lanes.find((candidate) => candidate.key === laneKey);
  if (lane === undefined) {
    return null;
  }

  // Collect every park target the origin's src could name. Bare lane keys are
  // never collected, so a routing site that was edited from a park to a plain
  // lane move fails closed to null below.
  const candidates: Array<WorkflowParkTarget> = [];
  switch (origin.src) {
    case "lane_on": {
      const target = routeTargetForKey(lane.on, origin.key);
      if (target !== undefined && isParkTarget(target)) {
        candidates.push(target);
      }
      break;
    }
    case "step": {
      const step = (lane.pipeline ?? []).find((candidate) => candidate.key === origin.stepKey);
      const target = routeTargetForKey(step?.on, origin.key);
      if (target !== undefined && isParkTarget(target)) {
        candidates.push(target);
      }
      break;
    }
    case "transition": {
      // Index is never trusted — scan ALL transitions and match by fingerprint.
      for (const transition of lane.transitions ?? []) {
        if (isParkTarget(transition.to)) {
          candidates.push(transition.to);
        }
      }
      break;
    }
    case "event": {
      for (const matcher of lane.onEvent ?? []) {
        if (matcher.name === origin.name && isParkTarget(matcher.to)) {
          candidates.push(matcher.to);
        }
      }
      break;
    }
  }

  for (const candidate of candidates) {
    if (parkTargetFingerprint(candidate) === origin.fp) {
      return candidate.actions;
    }
  }
  return null;
};
