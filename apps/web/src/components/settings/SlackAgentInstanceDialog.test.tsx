import type { WorkflowDefinitionEncoded } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSlackAgentCreateInput,
  buildSlackAgentCreateInputForProjects,
  buildSlackProjectLinks,
  getAvailableSlackAgentBoards,
  getSlackAgentInitialLaneTargets,
  getSlackAgentWizardStepState,
  normalizeSlackAgentTarget,
  ensureSlackDefaultProjectId,
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
  it("gates the wizard steps in identity, Slack app, tokens, project, and review order", () => {
    expect(
      getSlackAgentWizardStepState({
        ownerLabel: "",
        handleSuffix: "",
        appConfigured: false,
        appToken: "",
        botToken: "",
        projectIds: [],
        defaultProjectId: "",
        acknowledged: false,
      }).activeStep,
    ).toBe("identity");

    expect(
      getSlackAgentWizardStepState({
        ownerLabel: "Chris",
        handleSuffix: "@t3_chris",
        appConfigured: false,
        appToken: "",
        botToken: "",
        projectIds: [],
        defaultProjectId: "",
        acknowledged: false,
      }).activeStep,
    ).toBe("slack-app");

    expect(
      getSlackAgentWizardStepState({
        ownerLabel: "Chris",
        handleSuffix: "@t3_chris",
        appConfigured: true,
        appToken: "",
        botToken: "",
        projectIds: [],
        defaultProjectId: "",
        acknowledged: false,
      }).activeStep,
    ).toBe("tokens");

    expect(
      getSlackAgentWizardStepState({
        ownerLabel: "Chris",
        handleSuffix: "@t3_chris",
        appConfigured: true,
        appToken: "xapp-valid",
        botToken: "xoxb-valid",
        projectIds: [],
        defaultProjectId: "",
        acknowledged: false,
      }).activeStep,
    ).toBe("project");

    expect(
      getSlackAgentWizardStepState({
        ownerLabel: "Chris",
        handleSuffix: "chris",
        appConfigured: true,
        appToken: "xapp-valid",
        botToken: "xoxb-valid",
        projectIds: ["project-a"],
        defaultProjectId: "project-a",
        acknowledged: false,
      }).activeStep,
    ).toBe("review");

    expect(
      getSlackAgentWizardStepState({
        ownerLabel: "Chris",
        handleSuffix: "chris",
        appConfigured: true,
        appToken: "xapp-valid",
        botToken: "xoxb-valid",
        projectIds: ["project-a"],
        defaultProjectId: "project-a",
        acknowledged: true,
      }).reviewComplete,
    ).toBe(true);
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

  it("builds the final create payload with tokens, project, and acknowledgement", () => {
    expect(
      buildSlackAgentCreateInputForProjects(
        {
          ownerLabel: " Chris ",
          handleSuffix: "@t3_chris",
          appConfigured: true,
          appToken: " xapp-token ",
          botToken: " xoxb-token ",
          projectIds: ["project-a", "project-b"],
          defaultProjectId: "project-b",
          acknowledged: true,
        },
        [
          { id: "project-a", title: "Cellar Tracker" },
          { id: "project-b", title: "Cellar Tracker" },
        ],
      ),
    ).toEqual({
      ownerLabel: "Chris",
      handleSuffix: "chris",
      appToken: "xapp-token",
      botToken: "xoxb-token",
      target: {
        projectId: "project-b",
        projects: [
          { projectId: "project-a", selector: "cellar-tracker" },
          { projectId: "project-b", selector: "cellar-tracker-2" },
        ],
      },
      defaultModelSelection: null,
      acknowledged: true,
    });
  });

  it("keeps a selected default and falls back to the first linked project", () => {
    expect(ensureSlackDefaultProjectId(["project-a", "project-b"], "project-b")).toBe("project-b");
    expect(ensureSlackDefaultProjectId(["project-a", "project-b"], "project-z")).toBe("project-a");
  });

  it("normalizes project aliases to lowercase unique Slack selectors", () => {
    expect(
      buildSlackProjectLinks({
        projectIds: ["project-a", "project-b", "project-c"],
        projects: [
          { id: "project-a", title: "Cellar Tracker!" },
          { id: "project-b", title: "Cellar Tracker" },
          { id: "project-c", title: "A".repeat(80) },
        ],
      }),
    ).toEqual([
      { projectId: "project-a", selector: "cellar-tracker" },
      { projectId: "project-b", selector: "cellar-tracker-2" },
      { projectId: "project-c", selector: "a".repeat(64) },
    ]);
  });

  it("keeps 100 colliding project aliases unique and within Slack selector limits", () => {
    const projects = Array.from({ length: 100 }, (_value, index) => ({
      id: `project-${index + 1}`,
      title: "A".repeat(80),
    }));
    const links = buildSlackProjectLinks({
      projectIds: projects.map((project) => project.id),
      projects,
    });

    expect(links).toHaveLength(100);
    expect(new Set(links.map((link) => link.selector)).size).toBe(100);
    expect(links.every((link) => link.selector.length <= 64)).toBe(true);
    expect(links.at(98)?.selector).toBe(`${"a".repeat(61)}-99`);
    expect(links.at(99)?.selector).toBe(`${"a".repeat(60)}-100`);
  });

  it("avoids collisions between generated suffixes and other project titles", () => {
    expect(
      buildSlackProjectLinks({
        projectIds: ["project-a", "project-b", "project-c"],
        projects: [
          { id: "project-a", title: "Base" },
          { id: "project-b", title: "Base" },
          { id: "project-c", title: "Base 2" },
        ],
      }),
    ).toEqual([
      { projectId: "project-a", selector: "base" },
      { projectId: "project-b", selector: "base-2" },
      { projectId: "project-c", selector: "base-2-2" },
    ]);
  });

  it("preserves legacy single-project target display as one linked project", () => {
    expect(normalizeSlackAgentTarget({ projectId: "project-a" })).toEqual({
      defaultProjectId: "project-a",
      projects: [{ projectId: "project-a", selector: "project-a" }],
    });
  });

  it("builds a backwards-compatible payload when project metadata is unavailable", () => {
    expect(
      buildSlackAgentCreateInput({
        ownerLabel: " Chris ",
        handleSuffix: "@t3_chris",
        appConfigured: true,
        appToken: " xapp-token ",
        botToken: " xoxb-token ",
        projectIds: ["project-a"],
        defaultProjectId: "project-a",
        acknowledged: true,
      }),
    ).toEqual({
      ownerLabel: "Chris",
      handleSuffix: "chris",
      appToken: "xapp-token",
      botToken: "xoxb-token",
      target: {
        projectId: "project-a",
        projects: [{ projectId: "project-a", selector: "project-a" }],
      },
      defaultModelSelection: null,
      acknowledged: true,
    });
  });

  it("includes a configured default chat model in the create payload", () => {
    expect(
      buildSlackAgentCreateInput({
        ownerLabel: "Chris",
        handleSuffix: "chris",
        appConfigured: true,
        appToken: "xapp-token",
        botToken: "xoxb-token",
        projectIds: ["project-a"],
        defaultProjectId: "project-a",
        defaultModelSelection: {
          instanceId: "codex" as never,
          model: "gpt-5.5",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        acknowledged: true,
      }),
    ).toMatchObject({
      defaultModelSelection: {
        instanceId: "codex",
        model: "gpt-5.5",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  });
});
