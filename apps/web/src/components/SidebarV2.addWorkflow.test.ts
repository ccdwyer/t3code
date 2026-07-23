import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkflowSidebarEligibleProject } from "../workflow/useWorkflowSidebarEntries";
import { resolveAddWorkflowAction } from "./SidebarV2.addWorkflow";

const env = EnvironmentId.make("environment-primary");
const remote = EnvironmentId.make("environment-remote");
const a = ProjectId.make("project-a");
const b = ProjectId.make("project-b");

const two: ReadonlyArray<WorkflowSidebarEligibleProject> = [
  { id: a, environmentId: env, title: "A" },
  { id: b, environmentId: env, title: "B" },
];

describe("resolveAddWorkflowAction", () => {
  it("targets a scoped primary-env project directly", () => {
    expect(
      resolveAddWorkflowAction({
        eligibleProjects: two,
        scopedProject: { id: b, environmentId: env },
        primaryEnvironmentId: env,
      }),
    ).toEqual({ kind: "direct", projectId: b, environmentId: env });
  });

  it("disables when All-scope has zero eligible projects", () => {
    expect(
      resolveAddWorkflowAction({
        eligibleProjects: [],
        scopedProject: null,
        primaryEnvironmentId: env,
      }),
    ).toEqual({ kind: "disabled" });
  });

  it("opens dialog directly when All-scope has exactly one eligible project", () => {
    expect(
      resolveAddWorkflowAction({
        eligibleProjects: [two[0]!],
        scopedProject: null,
        primaryEnvironmentId: env,
      }),
    ).toEqual({ kind: "direct", projectId: a, environmentId: env });
  });

  it("opens palette submenu when All-scope has multiple eligible projects", () => {
    expect(
      resolveAddWorkflowAction({
        eligibleProjects: two,
        scopedProject: null,
        primaryEnvironmentId: env,
      }),
    ).toEqual({ kind: "palette-submenu" });
  });

  it("does not treat a non-primary scoped project as a direct target", () => {
    expect(
      resolveAddWorkflowAction({
        eligibleProjects: [],
        scopedProject: { id: a, environmentId: remote },
        primaryEnvironmentId: env,
      }),
    ).toEqual({ kind: "disabled" });
  });
});
