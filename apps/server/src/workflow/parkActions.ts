import type {
  BoardTicketView,
  LaneKey,
  StepRouting,
  WorkflowDefinition,
  WorkflowLaneAction,
  WorkflowParkSubstate,
  WorkflowParkTarget,
  WorkflowRouteTarget,
} from "@t3tools/contracts";
import { isParkTarget } from "@t3tools/contracts";

import type { TicketRow } from "./Services/WorkflowReadModel.ts";
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

// Assembles the public `parked` view for a ticket row, shared by every
// BoardTicketView construction site (the RPC snapshot/detail reads in
// WorkflowRpcHandlers.ts AND the live board-push in WorkflowEventCommitter.ts)
// so they can never drift. Re-resolves actions from the CURRENT board
// definition (never the event's stored actionsSnapshot — that's history-only)
// so an edited/reverted board never executes a stale snapshot. `null`
// `definition` (board unregistered/unloaded) and `null` `resolveParkActions`
// (origin unparseable / target edited away) both degrade to an absent
// `actions` — the view's "actions unavailable" idiom — never a lie about what
// the ticket can do.
export const toParkedTicketView = (
  ticket: TicketRow,
  definition: WorkflowDefinition | null,
): BoardTicketView["parked"] => {
  if (
    ticket.status !== "parked" ||
    ticket.parkedSubstate == null ||
    ticket.parkedLabel == null ||
    ticket.parkedReason == null ||
    ticket.parkedAt == null ||
    ticket.parkedEventId == null
  ) {
    return undefined;
  }
  const actions =
    definition === null || ticket.parkOrigin == null
      ? null
      : resolveParkActions(definition, ticket.currentLaneKey as LaneKey, ticket.parkOrigin);
  return {
    substate: ticket.parkedSubstate as WorkflowParkSubstate,
    label: ticket.parkedLabel,
    reason: ticket.parkedReason,
    parkedAt: ticket.parkedAt,
    parkedEventId: ticket.parkedEventId as never,
    ...(actions === null
      ? {}
      : {
          actions: actions.map((action) => ({
            label: action.label,
            to: action.to as LaneKey,
            ...(action.hint === undefined ? {} : { hint: action.hint }),
          })),
        }),
  };
};
