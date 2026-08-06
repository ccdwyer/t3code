import { assert, describe, it } from "@effect/vitest";
import { isParkTarget, LaneKey, WorkflowDefinition } from "@t3tools/contracts";
import type { WorkflowParkTarget, WorkflowRouteTarget } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { resolveParkActions, toParkedTicketView } from "./parkActions.ts";
import { buildParkOrigin } from "./parkOrigin.ts";
import type { TicketRow } from "./Services/WorkflowReadModel.ts";

const decode = Schema.decodeUnknownSync(WorkflowDefinition);
const lane = (key: string) => LaneKey.make(key);

// Narrow a route target we know is a park target (built that way in the fixture).
const asPark = (target: WorkflowRouteTarget | undefined): WorkflowParkTarget => {
  if (target === undefined || !isParkTarget(target)) {
    throw new Error("expected a park target in the fixture");
  }
  return target;
};

const issuePark = (label: string, actions: ReadonlyArray<{ label: string; to: string }>) => ({
  park: "issue" as const,
  label,
  actions,
});

describe("resolveParkActions", () => {
  it("resolves a lane_on origin by fingerprint", () => {
    const def = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          on: {
            failure: issuePark("Hit a snag", [{ label: "Retry", to: "impl" }]),
          },
        },
      ],
    });
    const target = asPark(def.lanes[0]?.on?.failure);
    const origin = buildParkOrigin({ src: "lane_on", target, key: "failure" });

    const actions = resolveParkActions(def, lane("impl"), origin);
    assert.deepEqual(actions, target.actions);
  });

  it("resolves a step origin by fingerprint", () => {
    const def = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          pipeline: [
            {
              key: "code",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "do it",
              on: {
                failure: issuePark("Broke", [{ label: "Retry", to: "impl" }]),
              },
            },
          ],
        },
      ],
    });
    const step = def.lanes[0]?.pipeline?.[0];
    const target = asPark(step?.on?.failure);
    const origin = buildParkOrigin({
      src: "step",
      target,
      stepKey: "code",
      key: "failure",
    });

    const actions = resolveParkActions(def, lane("impl"), origin);
    assert.deepEqual(actions, target.actions);
  });

  it("resolves a transition origin by fingerprint", () => {
    const def = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          transitions: [
            {
              when: { "<": [{ var: "lane.runCount" }, 3] },
              to: issuePark("Loop", [{ label: "Continue", to: "impl" }]),
            },
          ],
        },
      ],
    });
    const target = asPark(def.lanes[0]?.transitions?.[0]?.to);
    const origin = buildParkOrigin({ src: "transition", target });

    const actions = resolveParkActions(def, lane("impl"), origin);
    assert.deepEqual(actions, target.actions);
  });

  it("resolves an event origin by matcher name + fingerprint", () => {
    const def = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          onEvent: [
            {
              name: "pr_closed",
              to: issuePark("Reopened", [{ label: "Re-open", to: "impl" }]),
            },
          ],
        },
      ],
    });
    const target = asPark(def.lanes[0]?.onEvent?.[0]?.to);
    const origin = buildParkOrigin({ src: "event", target, name: "pr_closed" });

    const actions = resolveParkActions(def, lane("impl"), origin);
    assert.deepEqual(actions, target.actions);
  });

  it("survives transition reordering: a transition inserted above still resolves via fingerprint", () => {
    const parkTarget = issuePark("Needs review", [{ label: "Approve", to: "land" }]);
    const original = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          transitions: [
            { when: { "==": [1, 1] }, to: "a" },
            { when: { "==": [2, 2] }, to: "b" },
            { when: { "==": [3, 3] }, to: parkTarget },
          ],
        },
      ],
    });
    const target = asPark(original.lanes[0]?.transitions?.[2]?.to);
    // Built while the park sat at index 2.
    const origin = buildParkOrigin({ src: "transition", target });

    // Now the board is edited: a new transition is inserted ABOVE, shifting the
    // park to index 3. Index-based identity would rebind to the wrong target;
    // fingerprint identity still finds it.
    const reordered = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          transitions: [
            { when: { "==": [0, 0] }, to: "z" },
            { when: { "==": [1, 1] }, to: "a" },
            { when: { "==": [2, 2] }, to: "b" },
            { when: { "==": [3, 3] }, to: parkTarget },
          ],
        },
      ],
    });

    const actions = resolveParkActions(reordered, lane("impl"), origin);
    assert.deepEqual(actions, target.actions);
  });

  it("returns the fingerprint-matched target among several park transitions, never a sibling", () => {
    const wanted = issuePark("Wanted", [{ label: "Retry", to: "impl" }]);
    const other = issuePark("Other", [{ label: "Escalate", to: "review" }]);
    const def = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          transitions: [
            { when: { "==": [1, 1] }, to: other },
            { when: { "==": [2, 2] }, to: wanted },
          ],
        },
      ],
    });
    const target = asPark(def.lanes[0]?.transitions?.[1]?.to);
    const origin = buildParkOrigin({ src: "transition", target });

    const actions = resolveParkActions(def, lane("impl"), origin);
    assert.deepEqual(actions, wanted.actions);
    assert.notDeepEqual(actions, other.actions);
  });

  it("returns null when the park target was edited (never the wrong actions)", () => {
    const original = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          on: {
            failure: issuePark("Hit a snag", [{ label: "Retry", to: "impl" }]),
          },
        },
      ],
    });
    const origin = buildParkOrigin({
      src: "lane_on",
      target: asPark(original.lanes[0]?.on?.failure),
      key: "failure",
    });

    // The board is edited: same routing site, different actions → new fingerprint.
    const edited = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          on: {
            failure: issuePark("Hit a snag", [{ label: "Retry", to: "backlog" }]),
          },
        },
      ],
    });

    assert.isNull(resolveParkActions(edited, lane("impl"), origin));
  });

  it("returns null when the lane was deleted", () => {
    const def = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          on: {
            failure: issuePark("Hit a snag", [{ label: "Retry", to: "impl" }]),
          },
        },
      ],
    });
    const origin = buildParkOrigin({
      src: "lane_on",
      target: asPark(def.lanes[0]?.on?.failure),
      key: "failure",
    });

    const withoutLane = decode({
      name: "wf",
      lanes: [{ key: "other", name: "Other", entry: "manual" }],
    });
    assert.isNull(resolveParkActions(withoutLane, lane("impl"), origin));
  });

  it("returns null when the origin JSON is malformed", () => {
    const def = decode({
      name: "wf",
      lanes: [{ key: "impl", name: "Impl", entry: "auto" }],
    });
    assert.isNull(resolveParkActions(def, lane("impl"), "not-json{"));
    assert.isNull(resolveParkActions(def, lane("impl"), JSON.stringify({ src: "lane_on" })));
  });

  it("returns null when the routing site became a bare lane key", () => {
    const original = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          on: {
            failure: issuePark("Hit a snag", [{ label: "Retry", to: "impl" }]),
          },
        },
      ],
    });
    const origin = buildParkOrigin({
      src: "lane_on",
      target: asPark(original.lanes[0]?.on?.failure),
      key: "failure",
    });

    // on.failure is now a plain lane move, not a park.
    const asLaneMove = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          on: { failure: "backlog" },
        },
        { key: "backlog", name: "Backlog", entry: "manual" },
      ],
    });
    assert.isNull(resolveParkActions(asLaneMove, lane("impl"), origin));
  });

  it("returns null for an event origin whose matcher name no longer exists", () => {
    const original = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          onEvent: [
            {
              name: "pr_closed",
              to: issuePark("X", [{ label: "Y", to: "impl" }]),
            },
          ],
        },
      ],
    });
    const origin = buildParkOrigin({
      src: "event",
      target: asPark(original.lanes[0]?.onEvent?.[0]?.to),
      name: "pr_closed",
    });

    // Same park target, but the matcher was renamed → the event origin can no
    // longer name it.
    const renamed = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          onEvent: [
            {
              name: "pr_reopened",
              to: issuePark("X", [{ label: "Y", to: "impl" }]),
            },
          ],
        },
      ],
    });
    assert.isNull(resolveParkActions(renamed, lane("impl"), origin));
  });
});

describe("toParkedTicketView", () => {
  const baseTicket = {
    ticketId: "ticket-1",
    boardId: "board-1",
    title: "A ticket",
    description: null,
    currentLaneKey: "impl",
    currentLaneEntryToken: null,
    queuedAt: null,
    totalTokens: null,
    totalDurationMs: null,
  } satisfies Partial<TicketRow>;

  it("assembles the full parked object, with actions re-resolved from the definition", () => {
    const definition = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          on: {
            failure: issuePark("Hit a snag", [{ label: "Retry", to: "impl" }]),
          },
        },
      ],
    });
    const target = asPark(definition.lanes[0]?.on?.failure);
    const parkOrigin = buildParkOrigin({
      src: "lane_on",
      target,
      key: "failure",
    });

    const ticket: TicketRow = {
      ...baseTicket,
      status: "parked",
      parkedSubstate: "issue",
      parkedLabel: "Hit a snag",
      parkedReason: "step failed: boom",
      parkedAt: "2026-07-22T00:00:02.000Z",
      parkedEventId: "evt-parked-1",
      parkOrigin,
    } as never;

    assert.deepEqual(toParkedTicketView(ticket, definition), {
      substate: "issue",
      label: "Hit a snag",
      reason: "step failed: boom",
      parkedAt: "2026-07-22T00:00:02.000Z",
      parkedEventId: "evt-parked-1",
      actions: [{ label: "Retry", to: "impl" }],
    } as never);
  });

  it("omits actions (undefined), but keeps substate/label/reason, once the definition drops the park", () => {
    const original = decode({
      name: "wf",
      lanes: [
        {
          key: "impl",
          name: "Impl",
          entry: "auto",
          on: {
            failure: issuePark("Hit a snag", [{ label: "Retry", to: "impl" }]),
          },
        },
      ],
    });
    const parkOrigin = buildParkOrigin({
      src: "lane_on",
      target: asPark(original.lanes[0]?.on?.failure),
      key: "failure",
    });

    // Board edited after the ticket parked: on.failure is now a plain lane move.
    const edited = decode({
      name: "wf",
      lanes: [{ key: "impl", name: "Impl", entry: "auto", on: { failure: "impl" } }],
    });

    const ticket: TicketRow = {
      ...baseTicket,
      status: "parked",
      parkedSubstate: "issue",
      parkedLabel: "Hit a snag",
      parkedReason: "step failed: boom",
      parkedAt: "2026-07-22T00:00:02.000Z",
      parkedEventId: "evt-parked-2",
      parkOrigin,
    } as never;

    const parked = toParkedTicketView(ticket, edited);
    assert.isDefined(parked, "parked detail must still render substate/label/reason");
    assert.equal(parked?.substate, "issue");
    assert.equal(parked?.label, "Hit a snag");
    assert.equal(parked?.reason, "step failed: boom");
    assert.isUndefined(parked?.actions);
  });

  it("returns undefined for a non-parked ticket row", () => {
    const ticket: TicketRow = {
      ...baseTicket,
      status: "running",
    } as never;

    assert.isUndefined(toParkedTicketView(ticket, null));
  });
});
