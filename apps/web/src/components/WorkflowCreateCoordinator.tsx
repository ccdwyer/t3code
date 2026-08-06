import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ProjectId, type EnvironmentApi } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";

import { onRequestCreateWorkflow, type RequestCreateWorkflowDetail } from "../commandPaletteBus";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { workflowEnvironment } from "../state/workflow";
import { refreshListBoards } from "../workflow/useWorkflowSidebarEntries";
import { useWorkflowApi } from "../workflow/useWorkflowApi";
import { CreateWorkflowDialog } from "./board/CreateWorkflowDialog";

/** Placeholder ids so hooks stay unconditional while the dialog is closed. */
const IDLE_ENVIRONMENT_ID = EnvironmentId.make("workflow-create-idle");
const IDLE_PROJECT_ID = ProjectId.make("workflow-create-idle");

export interface WorkflowCreateTarget {
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly projectName: string;
}

export interface WorkflowCreateProjectCandidate {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
}

/**
 * Pure bus-intent acceptance: primary-env only, known project required.
 * Returns null for non-primary env, missing primary, or unknown project
 * (stale palette entry / removed project) so the dialog never opens for a
 * phantom target.
 */
export function resolveCreateWorkflowTarget(
  detail: RequestCreateWorkflowDetail,
  projects: ReadonlyArray<WorkflowCreateProjectCandidate>,
  primaryEnvironmentId: EnvironmentId | null,
): WorkflowCreateTarget | null {
  if (primaryEnvironmentId === null || detail.environmentId !== primaryEnvironmentId) {
    return null;
  }
  const project = projects.find(
    (candidate) =>
      candidate.id === detail.projectId && candidate.environmentId === detail.environmentId,
  );
  if (!project) {
    return null;
  }
  return {
    projectId: project.id,
    environmentId: project.environmentId,
    projectName: project.title,
  };
}

/**
 * The exact listener the coordinator's effect registers on the bus. Exported
 * so tests can drive the production path (real bus dispatch → accept/reject →
 * setTarget) without a DOM renderer for effects.
 */
export function createRequestCreateWorkflowListener(input: {
  readonly projects: ReadonlyArray<WorkflowCreateProjectCandidate>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly setTarget: (target: WorkflowCreateTarget) => void;
}): (detail: RequestCreateWorkflowDetail) => void {
  return (detail) => {
    const next = resolveCreateWorkflowTarget(detail, input.projects, input.primaryEnvironmentId);
    if (next === null) return;
    input.setTarget(next);
  };
}

/**
 * Stable owner of CreateWorkflowDialog, mounted in AppSidebarLayout outside
 * both sidebar variants. Survives mode/sidebar-variant switches. Consumes the
 * `requestCreateWorkflow` bus intent (from the palette new-workflow-in submenu
 * or the SidebarV2 Add-workflow button).
 */
export function WorkflowCreateCoordinator() {
  const registry = useContext(RegistryContext);
  const navigate = useNavigate();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [target, setTarget] = useState<WorkflowCreateTarget | null>(null);
  const open = target !== null;

  useEffect(
    () =>
      onRequestCreateWorkflow(
        createRequestCreateWorkflowListener({
          projects,
          primaryEnvironmentId,
          setTarget,
        }),
      ),
    [primaryEnvironmentId, projects],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      setTarget(null);
    }
  }, []);

  // Hooks must run unconditionally. While closed, bind to idle placeholders
  // so we never fire listBoards for a real project without an open dialog.
  const environmentId = target?.environmentId ?? primaryEnvironmentId ?? IDLE_ENVIRONMENT_ID;
  const projectId = target?.projectId ?? IDLE_PROJECT_ID;
  const workflowApi = useWorkflowApi(environmentId);
  // Same partial-facade pattern as Sidebar.tsx board create (workflow-only).
  const api = useMemo<EnvironmentApi>(
    () => ({ workflow: workflowApi }) as EnvironmentApi,
    [workflowApi],
  );

  const boardsAtom = useMemo(
    () =>
      target
        ? workflowEnvironment.listBoards({
            environmentId: target.environmentId,
            input: { projectId: target.projectId },
          })
        : null,
    [target],
  );
  const { data: boards, error: boardsError } = useEnvironmentQuery(boardsAtom);
  // Settled = success (data is a non-null array, [] included) or failure
  // (proceed without name suggestions rather than blocking the dialog).
  // useEnvironmentQuery never yields `undefined`; loading is data+error null.
  const boardsSettled = boards !== null || boardsError !== null;
  const existingBoardNames = useMemo(() => (boards ?? []).map((board) => board.name), [boards]);

  const handleCreated = useCallback(
    (boardId: string) => {
      if (!target) return;
      refreshListBoards(registry, target.environmentId, target.projectId);
      setTarget(null);
      void navigate({
        to: "/$environmentId/board",
        params: { environmentId: target.environmentId },
        search: { boardId },
      });
    },
    [navigate, registry, target],
  );

  if (!target) {
    return null;
  }

  // The dialog seeds its default name once on mount and keeps it when names
  // arrive later — mounting before the existing-names query settles could
  // suggest an already-used name.
  if (!boardsSettled) {
    return null;
  }

  return (
    <CreateWorkflowDialog
      open={open}
      onOpenChange={handleOpenChange}
      projectId={projectId}
      environmentId={environmentId}
      projectName={target.projectName}
      api={api}
      existingBoardNames={existingBoardNames}
      onCreated={handleCreated}
    />
  );
}
