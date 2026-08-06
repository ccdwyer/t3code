import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import type {
  WorkflowLane,
  WorkflowLaneAction,
  WorkflowParkTarget,
  WorkflowRouteTarget,
} from "@t3tools/contracts";
import { WorkflowDefinition, isParkTarget } from "@t3tools/contracts";
import { defaultBoardDefinition } from "./defaultBoard.ts";
import { encodeWorkflowDefinitionJson, lintWorkflowDefinition } from "./workflowFile.ts";

const decodeWorkflowDefinitionJson = Schema.decodeSync(Schema.fromJsonString(WorkflowDefinition));

// Asserts `target` is a park target and returns it, failing with a helpful
// message otherwise — every park-shape assertion below routes through this.
const asParkTarget = (
  target: WorkflowRouteTarget | undefined,
  where: string,
): WorkflowParkTarget => {
  if (target === undefined || !isParkTarget(target)) {
    return assert.fail(`expected ${where} to be a park target, got ${JSON.stringify(target)}`);
  }
  return target;
};

// Asserts `target` is a plain (non-park) lane-key route and that it equals
// `expected`.
const assertLaneTarget = (
  target: WorkflowRouteTarget | undefined,
  expected: string,
  where: string,
): void => {
  if (target === undefined || isParkTarget(target)) {
    assert.fail(`expected ${where} to be a plain lane key, got ${JSON.stringify(target)}`);
    return;
  }
  assert.equal(target, expected);
};

// Strips the LaneKey brand from a park target's actions so they can be
// compared against plain object literals without a type-level brand mismatch.
const plainActions = (
  actions: ReadonlyArray<WorkflowLaneAction>,
): ReadonlyArray<{
  readonly label: string;
  readonly to: string;
  readonly hint: string | undefined;
}> =>
  actions.map((action) => ({
    label: action.label as string,
    to: action.to as string,
    hint: action.hint as string | undefined,
  }));

const findLane = (lanes: ReadonlyArray<WorkflowLane>, key: string): WorkflowLane => {
  const lane = lanes.find((candidate) => (candidate.key as string) === key);
  assert.ok(lane, `expected lane "${key}" to exist`);
  return lane;
};

describe("defaultBoardDefinition", () => {
  const def = defaultBoardDefinition({
    name: "My board",
    agent: { instance: "codex", model: "gpt-5.4" },
  });

  it("round-trips through the board file encoder with exactly the 7 collapsed lanes", () => {
    const decoded = decodeWorkflowDefinitionJson(encodeWorkflowDefinitionJson(def));
    assert.equal(decoded.name, "My board");
    assert.deepEqual(
      decoded.lanes.map((lane) => lane.key as string),
      ["backlog", "planning", "specifying", "implementation", "owner_review", "land", "done"],
    );
  });

  it("removes every legacy parking-lane key", () => {
    const laneKeys = def.lanes.map((lane) => lane.key as string);
    for (const removed of ["planning_issues", "implementation_issues", "manual_review"]) {
      assert.ok(!laneKeys.includes(removed), `expected "${removed}" lane to be removed`);
    }
  });

  it("parks planning failures/blocks as an issue with retry-planning/back-to-backlog actions", () => {
    const planning = findLane(def.lanes, "planning");
    for (const key of ["failure", "blocked"] as const) {
      const target = asParkTarget(planning.on?.[key], `planning.on.${key}`);
      assert.equal(target.park, "issue");
      assert.deepEqual(plainActions(target.actions), [
        {
          label: "Retry planning",
          to: "planning",
          hint: "Run planning and specification again.",
        },
        {
          label: "Back to backlog",
          to: "backlog",
          hint: "Park the ticket; nothing runs until you start it again.",
        },
      ]);
    }
    assertLaneTarget(planning.on?.success, "specifying", "planning.on.success");
  });

  it("parks specifying failures/blocks the same way as planning", () => {
    const specifying = findLane(def.lanes, "specifying");
    const planning = findLane(def.lanes, "planning");
    for (const key of ["failure", "blocked"] as const) {
      const target = asParkTarget(specifying.on?.[key], `specifying.on.${key}`);
      const expected = asParkTarget(planning.on?.[key], `planning.on.${key}`);
      assert.equal(target.park, expected.park);
      assert.equal(target.label, expected.label);
      assert.deepEqual(plainActions(target.actions), plainActions(expected.actions));
    }
    assertLaneTarget(specifying.on?.success, "implementation", "specifying.on.success");
  });

  it("parks implementation success/failure/blocked as an issue with retry/re-plan/back-to-backlog actions", () => {
    const implementation = findLane(def.lanes, "implementation");
    const expectedActions = [
      {
        label: "Retry implementation",
        to: "implementation",
        hint: "Run the implement + review pipeline again.",
      },
      {
        label: "Re-plan",
        to: "planning",
        hint: "Start over from planning with what you learned.",
      },
      {
        label: "Back to backlog",
        to: "backlog",
        hint: "Park the ticket; nothing runs until you start it again.",
      },
    ];
    for (const key of ["success", "failure", "blocked"] as const) {
      const target = asParkTarget(implementation.on?.[key], `implementation.on.${key}`);
      assert.equal(target.park, "issue");
      assert.deepEqual(plainActions(target.actions), expectedActions);
    }
  });

  it("parks the exhausted-budget revise transition as waiting with Needs-manual-review actions", () => {
    const implementation = findLane(def.lanes, "implementation");
    const transitions = implementation.transitions ?? [];
    const budgetExhausted = transitions.find(
      (t) => (JSON.stringify(t.when) ?? "").includes(`"revise"`) && isParkTarget(t.to),
    );
    const target = asParkTarget(
      budgetExhausted?.to,
      "implementation budget-exhausted transition.to",
    );
    assert.equal(target.park, "waiting");
    assert.equal(target.label, "Needs manual review");
    assert.deepEqual(plainActions(target.actions), [
      {
        label: "Approve & land",
        to: "land",
        hint: "Merge the ticket's work into the branch checked out in your repo.",
      },
      {
        label: "Send back",
        to: "implementation",
        hint: "Run another implement + review pass with a fresh loop budget.",
      },
    ]);
  });

  it("parks land failures/blocks the same as implementation's issue park", () => {
    const land = findLane(def.lanes, "land");
    const implementation = findLane(def.lanes, "implementation");
    for (const key of ["failure", "blocked"] as const) {
      const target = asParkTarget(land.on?.[key], `land.on.${key}`);
      const expected = asParkTarget(implementation.on?.success, "implementation.on.success");
      assert.equal(target.park, expected.park);
      assert.equal(target.label, expected.label);
      assert.deepEqual(plainActions(target.actions), plainActions(expected.actions));
    }
    assertLaneTarget(land.on?.success, "done", "land.on.success");
  });

  it("keeps Owner Review as an unchanged manual lane", () => {
    const ownerReview = findLane(def.lanes, "owner_review");
    assert.equal(ownerReview.entry, "manual");
    assert.deepEqual(plainActions(ownerReview.actions ?? []), [
      {
        label: "Approve & land",
        to: "land",
        hint: "Merge the ticket's work into the branch checked out in your repo.",
      },
      {
        label: "Send back",
        to: "implementation",
        hint: "Run another implement + review pass.",
      },
    ]);
  });

  it("passes the linter for a known agent instance", () => {
    const errors = lintWorkflowDefinition(def, {
      providerInstanceExists: (id) => id === "codex",
      instructionFileExists: () => true,
    });
    assert.deepEqual(errors, []);
  });

  it("bakes the agent into every agent step", () => {
    for (const lane of def.lanes) {
      for (const step of lane.pipeline ?? []) {
        if (step.type === "agent") {
          assert.equal(step.agent.instance, "codex");
          assert.equal(step.agent.model, "gpt-5.4");
        }
      }
    }
  });

  it("bounds the implementation review loop and escalates to a waiting park on budget exhaustion", () => {
    const implementation = def.lanes.find((lane) => (lane.key as string) === "implementation");
    assert.ok(implementation);
    const transitions = implementation.transitions ?? [];
    assert.equal(transitions.length, 3);
    const plainTargets: Array<{
      readonly index: number;
      readonly expected: string;
    }> = [
      { index: 0, expected: "implementation" },
      { index: 2, expected: "owner_review" },
    ];
    for (const { index, expected } of plainTargets) {
      const to = transitions[index]?.to;
      if (to === undefined || isParkTarget(to)) {
        assert.fail(`expected transition ${index} to target a plain lane key`);
      } else {
        assert.equal(to, expected);
      }
    }
    const budgetExhausted = transitions[1]?.to;
    if (budgetExhausted === undefined || !isParkTarget(budgetExhausted)) {
      assert.fail("expected transition 1 to be a park target");
    } else {
      assert.equal(budgetExhausted.park, "waiting");
      assert.equal(budgetExhausted.label, "Needs manual review");
    }
    const loopRule = JSON.stringify(transitions[0]?.when);
    assert.ok(loopRule.includes("lane.runCount"));
    const review = implementation.pipeline?.find((step) => (step.key as string) === "review");
    assert.ok(review?.type === "agent" && review.captureOutput === true);
  });

  it("uses retry policies on the agent work steps and retention on done", () => {
    for (const stepKey of ["plan", "spec", "implement"]) {
      const step = def.lanes
        .flatMap((lane) => lane.pipeline ?? [])
        .find((candidate) => (candidate.key as string) === stepKey);
      assert.ok(
        step?.type === "agent" && step.retry?.maxAttempts === 2,
        `step ${stepKey} should retry`,
      );
    }
    const done = def.lanes.find((lane) => (lane.key as string) === "done");
    assert.ok(done?.terminal === true && done.retention !== undefined);
    const land = def.lanes.find((lane) => (lane.key as string) === "land");
    assert.equal(land?.pipeline?.[0]?.type, "merge");
  });
});
