import {
  BoardId,
  EnvironmentId,
  LaneKey,
  ProjectId,
  TicketId,
  type BoardListEntry,
  type WorkflowNeedsAttentionTicketView,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildWorkflowSidebarEntries,
  createWorkflowSidebarEntriesAggregateAtom,
  filterEligibleWorkflowProjects,
  resolveRenderSnapshot,
  type AttentionListAsyncResult,
  type BoardsListAsyncResult,
  type ProjectBoardsQueryResult,
  type WorkflowSidebarEligibleProject,
} from "./useWorkflowSidebarEntries";

const envPrimary = EnvironmentId.make("environment-primary");
const envRemote = EnvironmentId.make("environment-remote");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const projectRemote = ProjectId.make("project-remote");

const eligible: ReadonlyArray<WorkflowSidebarEligibleProject> = [
  { id: projectA, environmentId: envPrimary, title: "Alpha" },
  { id: projectB, environmentId: envPrimary, title: "Beta" },
];

const entry = (
  projectId: ProjectId,
  slug: string,
  name: string,
  error: string | null = null,
): BoardListEntry => ({
  boardId: BoardId.make(`${projectId}__${slug}`),
  name,
  filePath: `.t3/boards/${slug}.json`,
  error,
});

const attention = (
  boardId: BoardId,
  kind: WorkflowNeedsAttentionTicketView["attentionKind"],
  ticketSlug: string,
): WorkflowNeedsAttentionTicketView => ({
  ticketId: TicketId.make(`ticket-${ticketSlug}`),
  boardId,
  boardName: "Board",
  title: "Ticket",
  status: "waiting_on_user",
  currentLaneKey: LaneKey.make("run"),
  attentionKind: kind,
  attentionReason: null,
  updatedAt: "2026-07-22T00:00:00.000Z",
  parkedAt: null,
});

describe("filterEligibleWorkflowProjects", () => {
  const allProjects: ReadonlyArray<WorkflowSidebarEligibleProject> = [
    ...eligible,
    { id: projectRemote, environmentId: envRemote, title: "Remote" },
  ];

  it("keeps only primary-env projects when scope is All", () => {
    expect(
      filterEligibleWorkflowProjects({
        projects: allProjects,
        primaryEnvironmentId: envPrimary,
        scopedProject: null,
      }).map((project) => project.id),
    ).toEqual([projectA, projectB]);
  });

  it("narrows to the scoped primary-env project", () => {
    expect(
      filterEligibleWorkflowProjects({
        projects: allProjects,
        primaryEnvironmentId: envPrimary,
        scopedProject: { id: projectB, environmentId: envPrimary },
      }).map((project) => project.id),
    ).toEqual([projectB]);
  });

  it("returns empty when scope is a non-primary project", () => {
    expect(
      filterEligibleWorkflowProjects({
        projects: allProjects,
        primaryEnvironmentId: envPrimary,
        scopedProject: { id: projectRemote, environmentId: envRemote },
      }),
    ).toEqual([]);
  });

  it("returns empty without a primary environment", () => {
    expect(
      filterEligibleWorkflowProjects({
        projects: allProjects,
        primaryEnvironmentId: null,
        scopedProject: null,
      }),
    ).toEqual([]);
  });
});

describe("buildWorkflowSidebarEntries", () => {
  it("flattens boards with (env, project, board) tags and joins attention", () => {
    const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
      [
        projectA,
        {
          status: "success",
          revalidating: false,
          entries: [entry(projectA, "delivery", "Delivery")],
        },
      ],
      [
        projectB,
        { status: "success", revalidating: false, entries: [entry(projectB, "triage", "Triage")] },
      ],
    ]);
    const deliveryId = BoardId.make(`${projectA}__delivery`);
    const built = buildWorkflowSidebarEntries({
      eligibleProjects: eligible,
      boardResultsByProjectId,
      attentionTickets: [
        attention(deliveryId, "blocked", "blocked"),
        attention(deliveryId, "parked_waiting", "waiting"),
      ],
      attentionPending: false,
      primaryEnvironmentId: envPrimary,
    });

    expect(built.boards).toHaveLength(2);
    expect(built.boards[0]).toMatchObject({
      kind: "board",
      environmentId: envPrimary,
      projectId: projectA,
      projectTitle: "Alpha",
      name: "Delivery",
      entryError: null,
    });
    expect(built.boards[0]?.attention).toEqual({ count: 2, dominantKind: "blocked" });
    expect(built.boards[0]?.attentionPill?.label).toBe(
      "2 items need your attention; includes an issue",
    );
    expect(built.isEmpty).toBe(false);
    expect(built.pending).toBe(false);
    expect(built.errorsByProject.size).toBe(0);
  });

  it("preserves partial success when one project errors", () => {
    const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
      [
        projectA,
        { status: "success", revalidating: false, entries: [entry(projectA, "ok", "Ok Board")] },
      ],
      [projectB, { status: "error", revalidating: false, error: "network down" }],
    ]);
    const built = buildWorkflowSidebarEntries({
      eligibleProjects: eligible,
      boardResultsByProjectId,
      attentionTickets: [],
      attentionPending: false,
      primaryEnvironmentId: envPrimary,
    });

    expect(built.boards.map((board) => board.name)).toEqual(["Ok Board"]);
    expect(built.errorsByProject.get(projectB)).toBe("network down");
    expect(built.rows.some((row) => row.kind === "project-error")).toBe(true);
    expect(built.isEmpty).toBe(false);
    expect(built.pending).toBe(false);
  });

  it("is pending while any eligible query is loading", () => {
    const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
      [projectA, { status: "success", revalidating: false, entries: [] }],
      [projectB, { status: "pending" }],
    ]);
    const built = buildWorkflowSidebarEntries({
      eligibleProjects: eligible,
      boardResultsByProjectId,
      attentionTickets: [],
      attentionPending: false,
      primaryEnvironmentId: envPrimary,
    });
    expect(built.pending).toBe(true);
    expect(built.isEmpty).toBe(false);
  });

  it("is empty only when all succeed with zero boards", () => {
    const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
      [projectA, { status: "success", revalidating: false, entries: [] }],
      [projectB, { status: "success", revalidating: false, entries: [] }],
    ]);
    const built = buildWorkflowSidebarEntries({
      eligibleProjects: eligible,
      boardResultsByProjectId,
      attentionTickets: [],
      attentionPending: false,
      primaryEnvironmentId: envPrimary,
    });
    expect(built.isEmpty).toBe(true);
    expect(built.boards).toEqual([]);
    expect(built.rows).toEqual([]);
  });

  it("does not treat project-error-only as empty", () => {
    const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
      [projectA, { status: "error", revalidating: false, error: "boom" }],
      [projectB, { status: "error", revalidating: false, error: "boom-2" }],
    ]);
    const built = buildWorkflowSidebarEntries({
      eligibleProjects: eligible,
      boardResultsByProjectId,
      attentionTickets: [],
      attentionPending: false,
      primaryEnvironmentId: envPrimary,
    });
    expect(built.isEmpty).toBe(false);
    expect(built.rows.every((row) => row.kind === "project-error")).toBe(true);
  });

  it("distinguishes entryError boards from project-error rows", () => {
    const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
      [
        projectA,
        {
          status: "success",
          revalidating: false,
          entries: [entry(projectA, "broken", "Broken Board", "decode failed")],
        },
      ],
      [projectB, { status: "error", revalidating: false, error: "rpc failed" }],
    ]);
    const built = buildWorkflowSidebarEntries({
      eligibleProjects: eligible,
      boardResultsByProjectId,
      attentionTickets: [],
      attentionPending: false,
      primaryEnvironmentId: envPrimary,
    });

    const boardRow = built.boards[0];
    expect(boardRow?.entryError).toBe("decode failed");
    expect(boardRow?.kind).toBe("board");
    const projectError = built.rows.find((row) => row.kind === "project-error");
    expect(projectError).toMatchObject({
      kind: "project-error",
      projectId: projectB,
      error: "rpc failed",
    });
  });

  it("sorts by eligible project index → name (locale, case-insensitive) → boardId", () => {
    const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
      [
        projectA,
        {
          status: "success",
          revalidating: false,
          entries: [
            entry(projectA, "z", "zebra"),
            entry(projectA, "a", "Apple"),
            entry(projectA, "b", "apple"),
          ],
        },
      ],
      [
        projectB,
        {
          status: "success",
          revalidating: false,
          entries: [entry(projectB, "m", "Middle")],
        },
      ],
    ]);
    const built = buildWorkflowSidebarEntries({
      eligibleProjects: eligible,
      boardResultsByProjectId,
      attentionTickets: [],
      attentionPending: false,
      primaryEnvironmentId: envPrimary,
    });

    // Project A first (eligible index 0), then names case-insensitive.
    // "Apple" and "apple" tie on name → boardId tiebreak (a before b).
    expect(
      built.boards.map((board) => `${board.projectId}:${board.name}:${board.boardId}`),
    ).toEqual([
      `${projectA}:Apple:${projectA}__a`,
      `${projectA}:apple:${projectA}__b`,
      `${projectA}:zebra:${projectA}__z`,
      `${projectB}:Middle:${projectB}__m`,
    ]);
  });

  it("keeps aggregate pending while a successful source revalidates (SWR)", () => {
    const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
      [
        projectA,
        {
          status: "success",
          revalidating: true,
          entries: [entry(projectA, "ok", "Ok")],
        },
      ],
      [projectB, { status: "success", revalidating: false, entries: [] }],
    ]);
    const built = buildWorkflowSidebarEntries({
      eligibleProjects: eligible,
      boardResultsByProjectId,
      attentionTickets: [],
      attentionPending: false,
      primaryEnvironmentId: envPrimary,
    });
    expect(built.pending).toBe(true);
    expect(built.isEmpty).toBe(false);
    expect(built.boards).toHaveLength(1);
  });

  it("keeps aggregate pending while a failed source revalidates", () => {
    const boardResultsByProjectId = new Map<ProjectId, ProjectBoardsQueryResult>([
      [projectA, { status: "error", revalidating: true, error: "stale failure" }],
      [projectB, { status: "success", revalidating: false, entries: [] }],
    ]);
    const built = buildWorkflowSidebarEntries({
      eligibleProjects: eligible,
      boardResultsByProjectId,
      attentionTickets: [],
      attentionPending: false,
      primaryEnvironmentId: envPrimary,
    });
    expect(built.pending).toBe(true);
    expect(built.errorsByProject.get(projectA)).toBe("stale failure");
    expect(built.isEmpty).toBe(false);
  });
});

describe("createWorkflowSidebarEntriesAggregateAtom (registry-backed)", () => {
  const registries: AtomRegistry.AtomRegistry[] = [];

  afterEach(() => {
    for (const registry of registries.splice(0)) {
      registry.dispose();
    }
  });

  function makeRegistry() {
    const registry = AtomRegistry.make();
    registries.push(registry);
    return registry;
  }

  function makeBoardsAtom(initial: BoardsListAsyncResult = AsyncResult.initial(true)) {
    return Atom.make<BoardsListAsyncResult>(initial);
  }

  function makeAttentionAtom(initial: AttentionListAsyncResult = AsyncResult.initial(true)) {
    return Atom.make<AttentionListAsyncResult>(initial);
  }

  function mountAggregate(input: {
    readonly registry: AtomRegistry.AtomRegistry;
    readonly projects?: ReadonlyArray<WorkflowSidebarEligibleProject>;
    readonly boardsByProjectId: ReadonlyMap<ProjectId, Atom.Atom<BoardsListAsyncResult>>;
    readonly attentionAtom: Atom.Atom<AttentionListAsyncResult>;
    readonly primaryEnvironmentId?: EnvironmentId | null;
  }) {
    const projects = input.projects ?? eligible;
    const atom = createWorkflowSidebarEntriesAggregateAtom({
      eligibleProjects: projects,
      primaryEnvironmentId:
        input.primaryEnvironmentId === undefined ? envPrimary : input.primaryEnvironmentId,
      getBoardsAtom: (project) => {
        const boardsAtom = input.boardsByProjectId.get(project.id);
        if (!boardsAtom) {
          throw new Error(`missing boards atom for ${project.id}`);
        }
        return boardsAtom;
      },
      getAttentionAtom: () => input.attentionAtom,
    });
    const snapshots: ReturnType<typeof buildWorkflowSidebarEntries>[] = [];
    const unmount = input.registry.mount(atom);
    const unsubscribe = input.registry.subscribe(
      atom,
      (next) => {
        snapshots.push(next);
      },
      { immediate: true },
    );
    return {
      atom,
      snapshots,
      latest: () => {
        const value = snapshots[snapshots.length - 1];
        if (value === undefined) {
          throw new Error("aggregate produced no snapshots");
        }
        return value;
      },
      teardown: () => {
        unsubscribe();
        unmount();
      },
    };
  }

  it("starts pending (not empty) before any source resolves", () => {
    const registry = makeRegistry();
    const boardsA = makeBoardsAtom(AsyncResult.initial(true));
    const boardsB = makeBoardsAtom(AsyncResult.initial(true));
    const attentionAtom = makeAttentionAtom(AsyncResult.initial(true));
    const { latest, teardown } = mountAggregate({
      registry,
      boardsByProjectId: new Map([
        [projectA, boardsA],
        [projectB, boardsB],
      ]),
      attentionAtom,
    });

    const snapshot = latest();
    expect(snapshot.pending).toBe(true);
    expect(snapshot.isEmpty).toBe(false);
    expect(snapshot.boards).toEqual([]);
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.errorsByProject.size).toBe(0);
    teardown();
  });

  it("keeps pending true on Success(waiting=true) and clears when every source is settled", () => {
    const registry = makeRegistry();
    const boardsA = makeBoardsAtom(
      AsyncResult.success([entry(projectA, "delivery", "Delivery")], { waiting: true }),
    );
    const boardsB = makeBoardsAtom(AsyncResult.success<ReadonlyArray<BoardListEntry>>([]));
    const attentionAtom = makeAttentionAtom(
      AsyncResult.success<ReadonlyArray<WorkflowNeedsAttentionTicketView>>([]),
    );
    const { latest, teardown } = mountAggregate({
      registry,
      boardsByProjectId: new Map([
        [projectA, boardsA],
        [projectB, boardsB],
      ]),
      attentionAtom,
    });

    expect(latest().pending).toBe(true);
    expect(latest().boards).toHaveLength(1);
    expect(latest().isEmpty).toBe(false);

    registry.set(
      boardsA,
      AsyncResult.success([entry(projectA, "delivery", "Delivery")], { waiting: false }),
    );
    expect(latest().pending).toBe(false);
    expect(latest().boards.map((board) => board.name)).toEqual(["Delivery"]);
    teardown();
  });

  it("keeps pending true on Failure(waiting=true)", () => {
    const registry = makeRegistry();
    const boardsA = makeBoardsAtom(
      AsyncResult.failure(Cause.fail(new Error("network down")), { waiting: true }),
    );
    const boardsB = makeBoardsAtom(AsyncResult.success<ReadonlyArray<BoardListEntry>>([]));
    const attentionAtom = makeAttentionAtom(
      AsyncResult.success<ReadonlyArray<WorkflowNeedsAttentionTicketView>>([]),
    );
    const { latest, teardown } = mountAggregate({
      registry,
      boardsByProjectId: new Map([
        [projectA, boardsA],
        [projectB, boardsB],
      ]),
      attentionAtom,
    });

    expect(latest().pending).toBe(true);
    expect(latest().errorsByProject.get(projectA)).toBe("network down");
    expect(latest().isEmpty).toBe(false);
    teardown();
  });

  it("preserves partial success: one Failure + one Success → rows + errorsByProject", () => {
    const registry = makeRegistry();
    const boardsA = makeBoardsAtom(
      AsyncResult.success([entry(projectA, "ok", "Ok Board")], { waiting: false }),
    );
    const boardsB = makeBoardsAtom(
      AsyncResult.failure(Cause.fail(new Error("rpc failed")), { waiting: false }),
    );
    const attentionAtom = makeAttentionAtom(
      AsyncResult.success<ReadonlyArray<WorkflowNeedsAttentionTicketView>>([]),
    );
    const { latest, teardown } = mountAggregate({
      registry,
      boardsByProjectId: new Map([
        [projectA, boardsA],
        [projectB, boardsB],
      ]),
      attentionAtom,
    });

    const snapshot = latest();
    expect(snapshot.pending).toBe(false);
    expect(snapshot.boards.map((board) => board.name)).toEqual(["Ok Board"]);
    expect(snapshot.errorsByProject.get(projectB)).toBe("rpc failed");
    expect(snapshot.rows.some((row) => row.kind === "project-error")).toBe(true);
    expect(snapshot.isEmpty).toBe(false);
    teardown();
  });

  it("stops notifying after unsubscribe/unmount (subscription teardown)", () => {
    const registry = makeRegistry();
    const boardsA = makeBoardsAtom(AsyncResult.success<ReadonlyArray<BoardListEntry>>([]));
    const boardsB = makeBoardsAtom(AsyncResult.success<ReadonlyArray<BoardListEntry>>([]));
    const attentionAtom = makeAttentionAtom(
      AsyncResult.success<ReadonlyArray<WorkflowNeedsAttentionTicketView>>([]),
    );
    const { snapshots, latest, teardown } = mountAggregate({
      registry,
      boardsByProjectId: new Map([
        [projectA, boardsA],
        [projectB, boardsB],
      ]),
      attentionAtom,
    });

    expect(latest().pending).toBe(false);
    const countAfterMount = snapshots.length;

    teardown();

    registry.set(
      boardsA,
      AsyncResult.success([entry(projectA, "late", "Late Board")], { waiting: false }),
    );
    expect(snapshots).toHaveLength(countAfterMount);
  });
});

describe("resolveRenderSnapshot (render-phase scope-change guard)", () => {
  const emptyBoards = new Map<ProjectId, Atom.Atom<BoardsListAsyncResult>>();
  const attention = Atom.make<AttentionListAsyncResult>(AsyncResult.initial(true));

  function makeAggregate() {
    return createWorkflowSidebarEntriesAggregateAtom({
      eligibleProjects: [],
      primaryEnvironmentId: envPrimary,
      getBoardsAtom: (project) => {
        const atom = emptyBoards.get(project.id);
        if (!atom) throw new Error("unexpected project");
        return atom;
      },
      getAttentionAtom: () => attention,
    });
  }

  it("returns the stored snapshot while the entry matches the current aggregate", () => {
    const aggregate = makeAggregate();
    const snapshot = {
      boards: [],
      rows: [],
      pending: false,
      errorsByProject: new Map(),
      isEmpty: true,
    };
    expect(resolveRenderSnapshot({ atom: aggregate, snapshot }, aggregate)).toBe(snapshot);
  });

  it("never surfaces a previous scope's snapshot against a new aggregate identity", () => {
    const previous = makeAggregate();
    const next = makeAggregate();
    const staleSnapshot = {
      boards: [],
      rows: [],
      pending: false,
      errorsByProject: new Map(),
      isEmpty: true,
    };
    const resolved = resolveRenderSnapshot({ atom: previous, snapshot: staleSnapshot }, next);
    expect(resolved).not.toBe(staleSnapshot);
    expect(resolved.pending).toBe(true);
    expect(resolved.isEmpty).toBe(false);
    expect(resolved.rows).toHaveLength(0);
    expect(resolved.boards).toHaveLength(0);
  });
});
