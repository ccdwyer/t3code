import type {
  ProviderOptionSelection,
  WorkflowDefinition,
  WorkflowLaneAction,
  WorkflowRouteTarget,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { isParkTarget } from "@t3tools/contracts";
import { defaultBoardDefinition } from "./defaultBoard.ts";
import { BOARD_TEMPLATES, listBoardTemplateSummaries } from "./boardTemplates.ts";
import { lintWorkflowDefinition } from "./workflowFile.ts";

const baseAgent = { instance: "i", model: "m" } as const;

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

const lintErrors = (def: WorkflowDefinition) =>
  lintWorkflowDefinition(def, {
    providerInstanceExists: () => true,
    instructionFileExists: () => true,
  });

describe("BOARD_TEMPLATES", () => {
  it("registers the full-sdlc and lite-agent-loop templates", () => {
    assert.deepEqual(
      BOARD_TEMPLATES.map((t) => t.id),
      ["full-sdlc", "lite-agent-loop", "design-board", "design-board-full"],
    );
    for (const template of BOARD_TEMPLATES) {
      assert.equal(template.requiresAgent, true);
    }
  });

  for (const template of BOARD_TEMPLATES) {
    describe(template.id, () => {
      const def = template.build({ name: "X", agent: baseAgent });

      it("builds a lint-clean WorkflowDefinition", () => {
        assert.equal(def.name, "X");
        assert.deepEqual(lintErrors(def), []);
      });

      it("has every transition/on/action `to` target among the lane keys (park targets' action.to too)", () => {
        const laneKeys = new Set(def.lanes.map((lane) => lane.key as string));
        const assertTarget = (target: WorkflowRouteTarget | undefined, where: string) => {
          if (target === undefined) return;
          if (isParkTarget(target)) {
            for (const action of target.actions) {
              assert.ok(laneKeys.has(action.to as string), `${where} park action ${action.to}`);
            }
            return;
          }
          assert.ok(laneKeys.has(target as string), `${where} ${target}`);
        };
        for (const lane of def.lanes) {
          for (const action of lane.actions ?? []) {
            assertTarget(action.to, "action");
          }
          for (const transition of lane.transitions ?? []) {
            assertTarget(transition.to, "transition");
          }
          if (lane.on) {
            assertTarget(lane.on.success, "on.success");
            assertTarget(lane.on.failure, "on.failure");
            assertTarget(lane.on.blocked, "on.blocked");
          }
        }
      });
    });
  }

  it("lite-agent-loop bounds its review self-loop with lane.runCount", () => {
    const def = BOARD_TEMPLATES.find((t) => t.id === "lite-agent-loop")!.build({
      name: "X",
      agent: baseAgent,
    });
    const inProgress = def.lanes.find((lane) => (lane.key as string) === "in-progress");
    assert.ok(inProgress);
    const transitions = inProgress.transitions ?? [];
    assert.ok(transitions.length >= 1);
    const loopTransition = transitions.find((t) => (t.to as string) === "in-progress");
    assert.ok(loopTransition, "expected a self-loop transition back to in-progress");
    assert.ok(JSON.stringify(loopTransition.when).includes("lane.runCount"));
  });

  it("lite-agent-loop has exactly 3 lanes and no needs-attention lane", () => {
    const def = BOARD_TEMPLATES.find((t) => t.id === "lite-agent-loop")!.build({
      name: "X",
      agent: baseAgent,
    });
    assert.deepEqual(
      def.lanes.map((lane) => lane.key as string),
      ["to-do", "in-progress", "done"],
    );
  });

  it("lite-agent-loop parks the exhausted-budget revise transition as waiting", () => {
    const def = BOARD_TEMPLATES.find((t) => t.id === "lite-agent-loop")!.build({
      name: "X",
      agent: baseAgent,
    });
    const inProgress = def.lanes.find((lane) => (lane.key as string) === "in-progress")!;
    const expectedActions = [
      { label: "Retry", to: "in-progress", hint: "Run another implement + review pass." },
      { label: "Back to to-do", to: "to-do", hint: "Park the ticket." },
    ];
    const budgetExhausted = (inProgress.transitions ?? []).find(
      (t) => t.to !== "in-progress" && isParkTarget(t.to),
    );
    if (budgetExhausted === undefined || !isParkTarget(budgetExhausted.to)) {
      assert.fail("expected a budget-exhausted transition targeting a park");
    } else {
      assert.equal(budgetExhausted.to.park, "waiting");
      assert.equal(budgetExhausted.to.label, "Needs manual review");
      assert.deepEqual(plainActions(budgetExhausted.to.actions), expectedActions);
    }
  });

  it("lite-agent-loop parks in-progress success/failure/blocked as an issue with the same actions", () => {
    const def = BOARD_TEMPLATES.find((t) => t.id === "lite-agent-loop")!.build({
      name: "X",
      agent: baseAgent,
    });
    const inProgress = def.lanes.find((lane) => (lane.key as string) === "in-progress")!;
    const expectedActions = [
      { label: "Retry", to: "in-progress", hint: "Run another implement + review pass." },
      { label: "Back to to-do", to: "to-do", hint: "Park the ticket." },
    ];
    for (const key of ["success", "failure", "blocked"] as const) {
      const target = inProgress.on?.[key];
      if (target === undefined || !isParkTarget(target)) {
        assert.fail(`expected in-progress.on.${key} to be a park target`);
      } else {
        assert.equal(target.park, "issue");
        assert.deepEqual(plainActions(target.actions), expectedActions);
      }
    }
  });

  it("lite-agent-loop keeps the approve transition targeting done unchanged", () => {
    const def = BOARD_TEMPLATES.find((t) => t.id === "lite-agent-loop")!.build({
      name: "X",
      agent: baseAgent,
    });
    const inProgress = def.lanes.find((lane) => (lane.key as string) === "in-progress")!;
    const approveTransition = (inProgress.transitions ?? []).find((t) => t.to === "done");
    assert.ok(approveTransition, "expected an approve transition targeting done");
  });

  it("full-sdlc.build deep-equals defaultBoardDefinition", () => {
    const fromTemplate = BOARD_TEMPLATES.find((t) => t.id === "full-sdlc")!.build({
      name: "X",
      agent: baseAgent,
    });
    assert.deepEqual(fromTemplate, defaultBoardDefinition({ name: "X", agent: baseAgent }));
  });

  it("threads agent.options through every agent step in BOTH templates", () => {
    const options: ReadonlyArray<ProviderOptionSelection> = [
      { id: "reasoning_effort", value: "high" },
    ];
    for (const template of BOARD_TEMPLATES) {
      const def = template.build({
        name: "X",
        agent: { instance: "i", model: "m", options },
      });
      let agentStepCount = 0;
      for (const lane of def.lanes) {
        for (const step of lane.pipeline ?? []) {
          if (step.type === "agent") {
            agentStepCount += 1;
            assert.deepEqual(step.agent.options, options, `${template.id} ${step.key}`);
          }
        }
      }
      assert.ok(agentStepCount > 0, `${template.id} should have agent steps`);
    }
  });

  it("enables output capture for every agent step in every template", () => {
    for (const template of BOARD_TEMPLATES) {
      const def = template.build({ name: "X", agent: baseAgent });
      for (const lane of def.lanes) {
        for (const step of lane.pipeline ?? []) {
          if (step.type === "agent") {
            assert.equal(step.captureOutput, true, `${template.id} ${step.key}`);
          }
        }
      }
    }
  });

  const stepKeys = (def: WorkflowDefinition) =>
    def.lanes.flatMap((l) => (l.pipeline ?? []).map((s) => s.key as string));

  it("design-board has no AI review steps", () => {
    const def = BOARD_TEMPLATES.find((t) => t.id === "design-board")!.build({
      name: "X",
      agent: baseAgent,
    });
    assert.deepEqual(
      stepKeys(def).filter((k) => k.endsWith("-review")),
      [],
    );
  });

  it("design-board-full has exactly the three review steps", () => {
    const def = BOARD_TEMPLATES.find((t) => t.id === "design-board-full")!.build({
      name: "X",
      agent: baseAgent,
    });
    assert.deepEqual(
      stepKeys(def)
        .filter((k) => k.endsWith("-review"))
        .sort(),
      ["build-review", "plan-review", "spec-review"],
    );
  });

  it("design-board-full build lane guards the loop before the unguarded revise", () => {
    const def = BOARD_TEMPLATES.find((t) => t.id === "design-board-full")!.build({
      name: "X",
      agent: baseAgent,
    });
    const build = def.lanes.find((l) => (l.key as string) === "build")!;
    // first transition must be the lane.runCount-guarded one
    assert.ok(JSON.stringify(build.transitions![0]).includes("lane.runCount"));
  });
});

describe("listBoardTemplateSummaries", () => {
  it("returns exactly the four template summaries", () => {
    assert.deepEqual(listBoardTemplateSummaries(), [
      {
        id: "full-sdlc",
        name: "Full SDLC",
        description: "Plan → spec → implement → review pipeline with a revision loop.",
        requiresAgent: true,
      },
      {
        id: "lite-agent-loop",
        name: "Lite agent loop",
        description: "To do → In progress (implement→review, loops on changes) → Done.",
        requiresAgent: true,
      },
      {
        id: "design-board",
        name: "Design board",
        description: "Idea → brainstorm → plan → build, with human approval gates.",
        requiresAgent: true,
      },
      {
        id: "design-board-full",
        name: "Design board (with AI review)",
        description: "Adds AI spec/plan/build reviews before each gate. Needs a capable agent.",
        requiresAgent: true,
      },
    ]);
  });
});
