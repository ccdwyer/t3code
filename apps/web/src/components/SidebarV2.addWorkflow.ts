import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { WorkflowSidebarEligibleProject } from "../workflow/useWorkflowSidebarEntries";

/**
 * Pure branch logic for the Add-workflow button. Used by SidebarV2 and unit
 * tests (scoped-project direct / All: 0 disabled, 1 direct, >1 palette).
 */
export type AddWorkflowAction =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "direct";
      readonly projectId: ProjectId;
      readonly environmentId: EnvironmentId;
    }
  | { readonly kind: "palette-submenu" };

export function resolveAddWorkflowAction(input: {
  readonly eligibleProjects: ReadonlyArray<WorkflowSidebarEligibleProject>;
  readonly scopedProject: {
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
  } | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): AddWorkflowAction {
  if (
    input.scopedProject !== null &&
    input.primaryEnvironmentId !== null &&
    input.scopedProject.environmentId === input.primaryEnvironmentId
  ) {
    return {
      kind: "direct",
      projectId: input.scopedProject.id,
      environmentId: input.scopedProject.environmentId,
    };
  }

  if (input.eligibleProjects.length === 0) {
    return { kind: "disabled" };
  }
  if (input.eligibleProjects.length === 1) {
    const only = input.eligibleProjects[0];
    if (!only) return { kind: "disabled" };
    return {
      kind: "direct",
      projectId: only.id,
      environmentId: only.environmentId,
    };
  }
  return { kind: "palette-submenu" };
}
