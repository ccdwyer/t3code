import {
  EnvironmentId,
  type BoardId,
  type EnvironmentApi,
  type ProjectId,
} from "@t3tools/contracts";
import { useNavigate, useParams, useLocation } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";

import { usePrimaryEnvironmentId } from "../state/environments";
import { deleteBoard } from "../workflow/boardRpc";
import { useWorkflowApi } from "../workflow/useWorkflowApi";
import {
  filterEligibleWorkflowProjects,
  useWorkflowSidebarEntries,
  type WorkflowSidebarEligibleProject,
} from "../workflow/useWorkflowSidebarEntries";
import { isSidebarBoardRouteActive, type SidebarBoardRouteIdentity } from "./Sidebar.logic";
import { WorkflowSidebarNeedsYou } from "./WorkflowSidebarNeedsYou";
import {
  SidebarV2WorkflowBoardRow,
  SidebarV2WorkflowProjectErrorRow,
} from "./SidebarV2WorkflowRow";
import { stackedThreadToast, toastManager } from "./ui/toast";

export interface WorkflowSidebarListProps {
  readonly projects: ReadonlyArray<WorkflowSidebarEligibleProject>;
  /**
   * Current project-scope filter: null = All projects; otherwise the selected
   * project (may be non-primary — eligibility handles that).
   */
  readonly scopedProject: { readonly id: ProjectId; readonly environmentId: EnvironmentId } | null;
  /** Called when the empty-state CTA should open create for the only/zero case. */
  readonly onRequestAddWorkflow?: (() => void) | undefined;
}

/**
 * Workflows-mode list. Mounted only when mode === "workflows" so its atom
 * subscriptions exist only in that mode. Owns the aggregate listBoards +
 * attention subscription via useWorkflowSidebarEntries.
 */
export function WorkflowSidebarList(props: WorkflowSidebarListProps) {
  const { projects, scopedProject, onRequestAddWorkflow } = props;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  // Boards are primary-env only in v1. Placeholder is unused until a board row
  // exists (which requires a real primary environment).
  const workflowApi = useWorkflowApi(primaryEnvironmentId ?? EnvironmentId.make("unconnected"));
  const fullApi = useMemo(() => ({ workflow: workflowApi }) as EnvironmentApi, [workflowApi]);

  const eligibleProjects = useMemo(
    () =>
      filterEligibleWorkflowProjects({
        projects,
        primaryEnvironmentId,
        scopedProject,
      }),
    [primaryEnvironmentId, projects, scopedProject],
  );

  const { rows, attentionTickets, pending, isEmpty, refreshProject, refreshAll } =
    useWorkflowSidebarEntries({
      eligibleProjects,
      primaryEnvironmentId,
    });

  // Mode-enter refresh: this component mounts only on workflows mode enter.
  useEffect(() => {
    refreshAll();
    // Intentionally once on mount (mode enter). refreshAll identity is stable
    // enough across eligible key changes; re-running on every refreshAll churn
    // would hammer the network.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mode-enter only
  }, []);

  const routeParams = useParams({ strict: false });
  const routeSearch = useLocation({ select: (location) => location.search });
  const activeRouteBoard = useMemo<SidebarBoardRouteIdentity | null>(() => {
    const routeEnvId = Reflect.get(routeParams, "environmentId");
    const boardId = Reflect.get(routeSearch, "boardId");
    if (typeof routeEnvId !== "string" || typeof boardId !== "string" || boardId.length === 0) {
      return null;
    }
    return { environmentId: routeEnvId, boardId };
  }, [routeParams, routeSearch]);

  const handleActivate = useCallback(
    (input: { readonly environmentId: EnvironmentId; readonly boardId: BoardId }) => {
      void navigate({
        to: "/$environmentId/board",
        params: { environmentId: input.environmentId },
        search: { boardId: input.boardId },
      });
    },
    [navigate],
  );

  const handleDelete = useCallback(
    async (input: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly boardId: BoardId;
      readonly name: string;
    }) => {
      try {
        await deleteBoard(fullApi, input.boardId);
        refreshProject(input.projectId);
        // If the deleted board is open, leave the board route so the dead
        // boardId search param cannot keep loading a removed definition.
        if (
          activeRouteBoard !== null &&
          activeRouteBoard.environmentId === input.environmentId &&
          activeRouteBoard.boardId === input.boardId
        ) {
          void navigate({
            to: "/$environmentId/board",
            params: { environmentId: input.environmentId },
            search: {},
          });
        }
        toastManager.add({
          type: "success",
          title: "Workflow deleted",
          description: `"${input.name}" was removed.`,
        });
      } catch (error: unknown) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Couldn't delete workflow",
            description: error instanceof Error ? error.message : "An unknown error occurred.",
          }),
        );
        throw error;
      }
    },
    [activeRouteBoard, fullApi, navigate, refreshProject],
  );

  const handleRetry = useCallback(
    (projectId: ProjectId) => {
      refreshProject(projectId);
    },
    [refreshProject],
  );

  if (pending && rows.length === 0) {
    return (
      <div
        data-testid="sidebar-v2-workflows-pending"
        className="px-2 py-6 text-center text-xs text-muted-foreground/60"
      >
        Loading workflows…
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div
        data-testid="sidebar-v2-workflows-empty"
        className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60"
      >
        <span>No workflows yet — Add workflow to create one</span>
        {onRequestAddWorkflow ? (
          <button
            type="button"
            data-testid="sidebar-v2-workflows-empty-cta"
            onClick={onRequestAddWorkflow}
            className="inline-flex items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-[11px] font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
          >
            Add workflow
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {primaryEnvironmentId !== null ? (
        <WorkflowSidebarNeedsYou
          tickets={attentionTickets}
          onOpenTicket={(ticket) => {
            // Route through the ticket's own board row when present so the
            // link stays correct even if boards ever span environments; the
            // primary env is only the (currently always-true) fallback.
            const boardRow = rows.find(
              (row) => row.kind === "board" && row.boardId === ticket.boardId,
            );
            void navigate({
              to: "/$environmentId/board",
              params: {
                environmentId:
                  boardRow?.kind === "board" ? boardRow.environmentId : primaryEnvironmentId,
              },
              search: { boardId: ticket.boardId, ticket: ticket.ticketId },
            });
          }}
        />
      ) : null}
      <ul role="list" data-testid="sidebar-v2-workflows-list" className="flex flex-col gap-px">
        {rows.map((row) => {
          if (row.kind === "project-error") {
            return (
              <SidebarV2WorkflowProjectErrorRow
                key={`error:${row.environmentId}:${row.projectId}`}
                row={row}
                onRetry={handleRetry}
              />
            );
          }
          return (
            <SidebarV2WorkflowBoardRow
              key={`${row.environmentId}:${row.projectId}:${row.boardId}`}
              row={row}
              isActive={isSidebarBoardRouteActive(activeRouteBoard, {
                environmentId: row.environmentId,
                projectId: row.projectId,
                boardId: row.boardId,
              })}
              onActivate={handleActivate}
              onDelete={handleDelete}
            />
          );
        })}
      </ul>
    </>
  );
}
