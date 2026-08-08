import type { WorkflowDefinitionEncoded } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSlackAgentCreateInput,
  getAvailableSlackAgentBoards,
  getSlackAgentInitialLaneTargets,
  getSlackAgentWizardStepState,
} from "./SlackAgentInstanceDialog";

const deliveryBoard = {
  name: "Delivery",
  lanes: [
    {
      key: "intake",
      name: "Intake",
      entry: "manual",
      on: { success: "implement" },
    },
    {
      key: "implement",
      name: "Implement",
      entry: "auto",
      pipeline: [
        {
          key: "code",
          type: "agent",
          agent: { instance: "codex", model: "gpt-5.5" },
          instruction: "Implement",
        },
      ],
      on: { success: "open-pr" },
    },
    {
      key: "open-pr",
      name: "Open PR",
      entry: "auto",
      pipeline: [{ key: "open", type: "pullRequest", action: "open" }],
    },
    {
      key: "done",
      name: "Done",
      entry: "manual",
      terminal: true,
    },
  ],
} as const satisfies WorkflowDefinitionEncoded;

describe("SlackAgentInstanceDialog wizard helpers", () => {
  it("gates the wizard steps in identity, project, target, and review order", () => {
    expect(
      getSlackAgentWizardStepState({
        ownerLabel: "",
        handleSuffix: "",
        projectId: "",
        boardId: "",
        initialLane: "",
        acknowledged: false,
      }).activeStep,
    ).toBe("identity");

    expect(
      getSlackAgentWizardStepState({
        ownerLabel: "Chris",
        handleSuffix: "@t3_chris",
        projectId: "",
        boardId: "",
        initialLane: "",
        acknowledged: false,
      }).activeStep,
    ).toBe("project");

    expect(
      getSlackAgentWizardStepState({
        ownerLabel: "Chris",
        handleSuffix: "chris",
        projectId: "project-a",
        boardId: "",
        initialLane: "",
        acknowledged: false,
      }).activeStep,
    ).toBe("target");

    expect(
      getSlackAgentWizardStepState({
        ownerLabel: "Chris",
        handleSuffix: "chris",
        projectId: "project-a",
        boardId: "board-a",
        initialLane: "implement",
        acknowledged: false,
      }).activeStep,
    ).toBe("review");
  });

  it("narrows board choices to the selected registered project", () => {
    const boardsByProject = new Map([
      ["project-a", [{ boardId: "board-a", name: "Delivery", error: null }]],
      ["project-b", [{ boardId: "board-b", name: "Support", error: null }]],
    ]);

    expect(getAvailableSlackAgentBoards("project-a", boardsByProject)).toEqual([
      { boardId: "board-a", name: "Delivery", error: null },
    ]);
  });

  it("only offers auto lanes whose success path reaches Open PR after an agent step", () => {
    expect(getSlackAgentInitialLaneTargets(deliveryBoard)).toEqual([
      {
        laneKey: "implement",
        laneName: "Implement",
        path: ["implement", "open-pr"],
        pathLabel: "Implement / Open PR",
      },
    ]);
  });

  it("builds the final create payload with the selected project, board, lane, and acknowledgement", () => {
    expect(
      buildSlackAgentCreateInput({
        ownerLabel: " Chris ",
        handleSuffix: "@t3_chris",
        projectId: "project-a",
        boardId: "board-a",
        initialLane: "implement",
        acknowledged: true,
      }),
    ).toEqual({
      ownerLabel: "Chris",
      handleSuffix: "chris",
      target: {
        projectId: "project-a",
        boardId: "board-a",
        initialLane: "implement",
      },
      acknowledged: true,
    });
  });
});
