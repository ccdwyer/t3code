import { RegistryContext } from "@effect/atom-react";
import type {
  BoardId,
  BoardListEntry,
  EnvironmentId,
  ProjectId,
  WorkflowNeedsAttentionTicketView,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { useContext, useEffect, useMemo, useState } from "react";

import { workflowEnvironment } from "../state/workflow";
import {
  groupAttentionByBoard,
  resolveWorkflowSidebarAttentionPill,
  sortNeedsAttentionTickets,
  workflowBoardAttentionKey,
  type WorkflowSidebarAttentionPill,
  type WorkflowSidebarAttentionSummary,
} from "./workflowSidebarStatus";

export interface WorkflowSidebarEligibleProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
}

export interface WorkflowSidebarBoardRow {
  readonly kind: "board";
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly boardId: BoardId;
  readonly name: string;
  readonly filePath: string;
  /** Decode failure on a discovered board file — distinct from project query failure. */
  readonly entryError: string | null;
  readonly attention: WorkflowSidebarAttentionSummary | null;
  readonly attentionPill: WorkflowSidebarAttentionPill | null;
}

export interface WorkflowSidebarProjectErrorRow {
  readonly kind: "project-error";
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly error: string;
}

export type WorkflowSidebarListRow = WorkflowSidebarBoardRow | WorkflowSidebarProjectErrorRow;

export interface WorkflowSidebarEntriesState {
  readonly boards: ReadonlyArray<WorkflowSidebarBoardRow>;
  readonly rows: ReadonlyArray<WorkflowSidebarListRow>;
  /**
   * Every needs-attention ticket across the primary environment's boards,
   * inbox-sorted (urgency, then longest-waiting). Feeds the aggregate
   * Needs You section above the board rows.
   */
  readonly attentionTickets: ReadonlyArray<WorkflowNeedsAttentionTicketView>;
  readonly pending: boolean;
  readonly errorsByProject: ReadonlyMap<ProjectId, string>;
  /**
   * True only when every eligible project query has succeeded and total board
   * count is zero (project-error rows and pending both suppress empty).
   */
  readonly isEmpty: boolean;
  readonly refreshProject: (projectId: ProjectId) => void;
  readonly refreshAll: () => void;
}

export type ProjectBoardsQueryResult =
  | { readonly status: "pending" }
  | {
      readonly status: "error";
      readonly error: string;
      readonly revalidating: boolean;
    }
  | {
      readonly status: "success";
      readonly entries: ReadonlyArray<BoardListEntry>;
      readonly revalidating: boolean;
    };

/**
 * Pure aggregate: flatten eligible project board queries + attention join +
 * total sort. Extracted so partial-success / empty / sort tests do not need
 * the atom registry.
 */
export function buildWorkflowSidebarEntries(input: {
  readonly eligibleProjects: ReadonlyArray<WorkflowSidebarEligibleProject>;
  readonly boardResultsByProjectId: ReadonlyMap<ProjectId, ProjectBoardsQueryResult>;
  readonly attentionTickets: ReadonlyArray<WorkflowNeedsAttentionTicketView> | null;
  readonly attentionPending: boolean;
  readonly primaryEnvironmentId: EnvironmentId | string | null;
}): {
  readonly boards: ReadonlyArray<WorkflowSidebarBoardRow>;
  readonly rows: ReadonlyArray<WorkflowSidebarListRow>;
  readonly attentionTickets: ReadonlyArray<WorkflowNeedsAttentionTicketView>;
  readonly pending: boolean;
  readonly errorsByProject: ReadonlyMap<ProjectId, string>;
  readonly isEmpty: boolean;
} {
  const errorsByProject = new Map<ProjectId, string>();
  const boards: WorkflowSidebarBoardRow[] = [];
  const projectErrorRows: WorkflowSidebarProjectErrorRow[] = [];
  let anyPending = input.attentionPending;
  let allSucceeded = true;

  const attentionByBoard =
    input.primaryEnvironmentId === null || input.attentionTickets === null
      ? new Map<string, WorkflowSidebarAttentionSummary>()
      : groupAttentionByBoard({
          environmentId: input.primaryEnvironmentId,
          tickets: input.attentionTickets,
        });

  for (const project of input.eligibleProjects) {
    const result = input.boardResultsByProjectId.get(project.id) ?? {
      status: "pending" as const,
    };
    if (result.status === "pending") {
      anyPending = true;
      allSucceeded = false;
      continue;
    }
    if (result.status === "error") {
      allSucceeded = false;
      if (result.revalidating) anyPending = true;
      errorsByProject.set(project.id, result.error);
      projectErrorRows.push({
        kind: "project-error",
        environmentId: project.environmentId,
        projectId: project.id,
        projectTitle: project.title,
        error: result.error,
      });
      continue;
    }

    if (result.revalidating) anyPending = true;
    for (const entry of result.entries) {
      const attention =
        attentionByBoard.get(workflowBoardAttentionKey(project.environmentId, entry.boardId)) ??
        null;
      boards.push({
        kind: "board",
        environmentId: project.environmentId,
        projectId: project.id,
        projectTitle: project.title,
        boardId: entry.boardId,
        name: entry.name,
        filePath: entry.filePath,
        entryError: entry.error,
        attention,
        attentionPill: resolveWorkflowSidebarAttentionPill(attention),
      });
    }
  }

  const projectIndexById = new Map(
    input.eligibleProjects.map((project, index) => [project.id, index] as const),
  );

  boards.sort((left, right) => {
    const leftIndex = projectIndexById.get(left.projectId) ?? 0;
    const rightIndex = projectIndexById.get(right.projectId) ?? 0;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    const nameCmp = left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
    });
    if (nameCmp !== 0) return nameCmp;
    return left.boardId.localeCompare(right.boardId);
  });

  // Project-error rows stay after boards for the projects that failed, ordered
  // by eligible project index so partial-success remains scannable.
  projectErrorRows.sort((left, right) => {
    const leftIndex = projectIndexById.get(left.projectId) ?? 0;
    const rightIndex = projectIndexById.get(right.projectId) ?? 0;
    return leftIndex - rightIndex;
  });

  const rows: WorkflowSidebarListRow[] = [...boards, ...projectErrorRows];
  const isEmpty =
    !anyPending && allSucceeded && boards.length === 0 && projectErrorRows.length === 0;

  // The attention list is environment-wide, but the inbox must respect the
  // same scope as the rows: with the sidebar filtered to one project, another
  // project's tickets have no board row to land on and must not be counted.
  const visibleBoardIds = new Set(boards.map((board) => board.boardId as string));
  return {
    boards,
    rows,
    attentionTickets:
      input.primaryEnvironmentId === null || input.attentionTickets === null
        ? []
        : sortNeedsAttentionTickets(
            input.attentionTickets.filter((ticket) => visibleBoardIds.has(ticket.boardId)),
          ),
    pending: anyPending,
    errorsByProject,
    isEmpty,
  };
}

function formatQueryError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}

function readProjectBoardsResult(
  result: AsyncResult.AsyncResult<ReadonlyArray<BoardListEntry>, unknown>,
): ProjectBoardsQueryResult {
  // `waiting` is an overlay in AsyncResult: Success(waiting=true) is an SWR
  // revalidation in flight. Surface it on every tag so aggregate `pending`
  // reflects refreshes, not just first loads.
  if (AsyncResult.isSuccess(result)) {
    return {
      status: "success",
      entries: result.value,
      revalidating: result.waiting,
    };
  }
  if (result._tag === "Failure") {
    return {
      status: "error",
      error: formatQueryError(result.cause),
      revalidating: result.waiting,
    };
  }
  return { status: "pending" };
}

/**
 * Initial/reset snapshot: PENDING, not empty — the empty state may only appear
 * after every eligible query has succeeded with zero boards. Rendering
 * "No workflows yet" before the first aggregate value arrives was a review
 * MUST (false empty on first paint / scope change).
 */
const PENDING_STATE: Omit<WorkflowSidebarEntriesState, "refreshProject" | "refreshAll"> = {
  boards: [],
  rows: [],
  attentionTickets: [],
  pending: true,
  errorsByProject: new Map(),
  isEmpty: false,
};

/**
 * Guards the one render where `entry` still belongs to a previous aggregate
 * identity (before the render-phase reset re-renders): never surface a
 * snapshot produced by a different aggregate atom.
 */
export function resolveRenderSnapshot(
  entry: {
    readonly atom: Atom.Atom<WorkflowSidebarEntriesAggregateSnapshot>;
    readonly snapshot: Omit<WorkflowSidebarEntriesState, "refreshProject" | "refreshAll">;
  },
  aggregateAtom: Atom.Atom<WorkflowSidebarEntriesAggregateSnapshot>,
): Omit<WorkflowSidebarEntriesState, "refreshProject" | "refreshAll"> {
  return entry.atom === aggregateAtom ? entry.snapshot : PENDING_STATE;
}

export type BoardsListAsyncResult = AsyncResult.AsyncResult<ReadonlyArray<BoardListEntry>, unknown>;
export type AttentionListAsyncResult = AsyncResult.AsyncResult<
  ReadonlyArray<WorkflowNeedsAttentionTicketView>,
  unknown
>;

export type WorkflowSidebarEntriesAggregateSnapshot = ReturnType<
  typeof buildWorkflowSidebarEntries
>;

/**
 * Pure aggregate-atom factory. Production supplies real `listBoards` /
 * `listNeedsAttentionTickets` atoms; tests inject writable stubs against a
 * real `AtomRegistry.make()` so pending / SWR / teardown can be asserted
 * without React.
 */
export function createWorkflowSidebarEntriesAggregateAtom(input: {
  readonly eligibleProjects: ReadonlyArray<WorkflowSidebarEligibleProject>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly getBoardsAtom: (
    project: WorkflowSidebarEligibleProject,
  ) => Atom.Atom<BoardsListAsyncResult>;
  readonly getAttentionAtom: (environmentId: EnvironmentId) => Atom.Atom<AttentionListAsyncResult>;
}): Atom.Atom<WorkflowSidebarEntriesAggregateSnapshot> {
  const projects = input.eligibleProjects;
  const primaryEnvironmentId = input.primaryEnvironmentId;

  return Atom.make((get): WorkflowSidebarEntriesAggregateSnapshot => {
    const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>();
    for (const project of projects) {
      boardResultsByProjectId.set(
        project.id,
        readProjectBoardsResult(get(input.getBoardsAtom(project))),
      );
    }

    let attentionTickets: ReadonlyArray<WorkflowNeedsAttentionTicketView> | null = null;
    let attentionPending = false;
    if (primaryEnvironmentId !== null) {
      const attentionResult = get(input.getAttentionAtom(primaryEnvironmentId));
      if (AsyncResult.isSuccess(attentionResult)) {
        attentionTickets = attentionResult.value;
        attentionPending = attentionResult.waiting;
      } else if (attentionResult._tag === "Failure") {
        // Attention failure does not blank the board list; treat as empty join.
        attentionTickets = [];
      } else {
        attentionPending = attentionResult.waiting;
        attentionTickets = Option.getOrNull(AsyncResult.value(attentionResult));
      }
    }

    return buildWorkflowSidebarEntries({
      eligibleProjects: projects,
      boardResultsByProjectId,
      attentionTickets,
      attentionPending,
      primaryEnvironmentId,
    });
  }).pipe(Atom.withLabel("workflow-sidebar-entries-aggregate"));
}

/**
 * Aggregate hook for the Workflows sidebar list.
 *
 * Eligible projects must already be filtered (primary-env ∩ project-scope)
 * before this hook is called. One memoized aggregate atom reads each project's
 * listBoards atom + the primary env listNeedsAttentionTickets atom; the
 * registry mounts + subscribes that aggregate once (not useEnvironmentQuery
 * inside a .map()).
 */
export function useWorkflowSidebarEntries(input: {
  readonly eligibleProjects: ReadonlyArray<WorkflowSidebarEligibleProject>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): WorkflowSidebarEntriesState {
  const registry = useContext(RegistryContext);
  const eligibleKey = input.eligibleProjects
    // Title participates in the key: a project rename must rebuild the
    // aggregate or rows would keep the stale captured title.
    .map((project) => `${project.environmentId}:${project.id}:${project.title}`)
    .join("|");

  const aggregateAtom = useMemo(() => {
    return createWorkflowSidebarEntriesAggregateAtom({
      eligibleProjects: input.eligibleProjects,
      primaryEnvironmentId: input.primaryEnvironmentId,
      getBoardsAtom: (project) =>
        workflowEnvironment.listBoards({
          environmentId: project.environmentId,
          input: { projectId: project.id },
        }),
      getAttentionAtom: (environmentId) =>
        workflowEnvironment.listNeedsAttentionTickets({
          environmentId,
          input: {},
        }),
    });
    // eligibleKey captures project identity; primaryEnvironmentId is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable key for eligible list
  }, [eligibleKey, input.primaryEnvironmentId]);

  // Snapshot is keyed to the aggregate atom that produced it. An effect-only
  // reset would let one render commit the PREVIOUS scope's rows against a new
  // aggregate identity; keying + the render-phase reset below closes that gap.
  const [entry, setEntry] = useState<{
    readonly atom: Atom.Atom<WorkflowSidebarEntriesAggregateSnapshot>;
    readonly snapshot: Omit<WorkflowSidebarEntriesState, "refreshProject" | "refreshAll">;
  }>({ atom: aggregateAtom, snapshot: PENDING_STATE });
  if (entry.atom !== aggregateAtom) {
    // Render-phase state adjustment (the sanctioned React pattern): re-render
    // with the pending sentinel before anything stale can commit.
    setEntry({ atom: aggregateAtom, snapshot: PENDING_STATE });
  }
  const snapshot = resolveRenderSnapshot(entry, aggregateAtom);

  useEffect(() => {
    const unmount = registry.mount(aggregateAtom);
    const unsubscribe = registry.subscribe(
      aggregateAtom,
      (next) => {
        setEntry({ atom: aggregateAtom, snapshot: next });
      },
      // Immediate so first paint has data without waiting for a change.
      { immediate: true },
    );
    return () => {
      unsubscribe();
      unmount();
    };
  }, [aggregateAtom, registry]);

  const refreshProject = useMemo(() => {
    return (projectId: ProjectId) => {
      const project = input.eligibleProjects.find((candidate) => candidate.id === projectId);
      if (!project) return;
      refreshListBoards(registry, project.environmentId, project.id);
    };
  }, [input.eligibleProjects, registry]);

  const refreshAll = useMemo(() => {
    return () => {
      for (const project of input.eligibleProjects) {
        refreshListBoards(registry, project.environmentId, project.id);
      }
      if (input.primaryEnvironmentId !== null) {
        registry.refresh(
          workflowEnvironment.listNeedsAttentionTickets({
            environmentId: input.primaryEnvironmentId,
            input: {},
          }),
        );
      }
    };
  }, [input.eligibleProjects, input.primaryEnvironmentId, registry]);

  return {
    ...snapshot,
    refreshProject,
    refreshAll,
  };
}

export function refreshListBoards(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): void {
  registry.refresh(
    workflowEnvironment.listBoards({
      environmentId,
      input: { projectId },
    }),
  );
}

/** Filter projects to primary-env ∩ optional scope (scope null = all). */
export function filterEligibleWorkflowProjects(input: {
  readonly projects: ReadonlyArray<WorkflowSidebarEligibleProject>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly scopedProject: {
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
  } | null;
}): ReadonlyArray<WorkflowSidebarEligibleProject> {
  if (input.primaryEnvironmentId === null) {
    return [];
  }
  const primaryOnly = input.projects.filter(
    (project) => project.environmentId === input.primaryEnvironmentId,
  );
  if (input.scopedProject === null) {
    return primaryOnly;
  }
  // Scope must itself be primary-env to be eligible.
  if (input.scopedProject.environmentId !== input.primaryEnvironmentId) {
    return [];
  }
  return primaryOnly.filter((project) => project.id === input.scopedProject?.id);
}
