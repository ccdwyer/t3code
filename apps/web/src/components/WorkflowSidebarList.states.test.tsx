import { RegistryContext } from "@effect/atom-react";
import { BoardId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  WorkflowSidebarBoardRow,
  WorkflowSidebarEntriesState,
  WorkflowSidebarListRow,
} from "../workflow/useWorkflowSidebarEntries";

const envPrimary = EnvironmentId.make("environment-primary");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const boardId = BoardId.make("project-a__delivery");

const entriesMock = vi.hoisted(() => ({
  /** When set, the real hook is bypassed and this snapshot is returned. */
  snapshot: null as WorkflowSidebarEntriesState | null,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useLocation: (options?: { readonly select?: (location: { search: object }) => unknown }) => {
    const location = { search: {} };
    return options?.select ? options.select(location) : location;
  },
}));

vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("environment-primary"),
}));

vi.mock("../workflow/useWorkflowApi", () => ({
  useWorkflowApi: () => ({
    deleteBoard: vi.fn(async () => undefined),
  }),
}));

vi.mock("../workflow/useWorkflowSidebarEntries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workflow/useWorkflowSidebarEntries")>();
  return {
    ...actual,
    useWorkflowSidebarEntries: (
      input: Parameters<typeof actual.useWorkflowSidebarEntries>[0],
    ): WorkflowSidebarEntriesState => {
      if (entriesMock.snapshot !== null) {
        return entriesMock.snapshot;
      }
      return actual.useWorkflowSidebarEntries(input);
    },
  };
});

import { WorkflowSidebarList } from "./WorkflowSidebarList";

const eligibleProjects = [
  { id: projectA, environmentId: envPrimary, title: "Alpha" },
  { id: projectB, environmentId: envPrimary, title: "Beta" },
] as const;

function entriesState(
  overrides: Partial<WorkflowSidebarEntriesState> = {},
): WorkflowSidebarEntriesState {
  return {
    boards: [],
    rows: [],
    pending: false,
    errorsByProject: new Map(),
    isEmpty: false,
    refreshProject: () => undefined,
    refreshAll: () => undefined,
    ...overrides,
  };
}

function boardRow(overrides: Partial<WorkflowSidebarBoardRow> = {}): WorkflowSidebarBoardRow {
  return {
    kind: "board",
    environmentId: envPrimary,
    projectId: projectA,
    projectTitle: "Alpha",
    boardId,
    name: "Delivery",
    filePath: ".t3/boards/delivery.json",
    entryError: null,
    attention: null,
    attentionPill: null,
    ...overrides,
  };
}

function renderList(onRequestAddWorkflow?: () => void): string {
  const registry = AtomRegistry.make();
  try {
    return renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <WorkflowSidebarList
          projects={[...eligibleProjects]}
          scopedProject={null}
          onRequestAddWorkflow={onRequestAddWorkflow}
        />
      </RegistryContext.Provider>,
    );
  } finally {
    registry.dispose();
  }
}

beforeEach(() => {
  entriesMock.snapshot = null;
});

afterEach(() => {
  entriesMock.snapshot = null;
});

describe("WorkflowSidebarList (real component)", () => {
  it("SSR-renders the real hook's pending sentinel (useEffect does not run)", () => {
    // snapshot left null → real useWorkflowSidebarEntries; useState initial is PENDING_STATE.
    const markup = renderList();
    expect(markup).toContain("sidebar-v2-workflows-pending");
    expect(markup).toContain("Loading workflows…");
    expect(markup).not.toContain("No workflows yet");
    expect(markup).not.toContain("No threads");
  });

  it("renders mode-specific empty copy and optional Add workflow CTA", () => {
    entriesMock.snapshot = entriesState({
      isEmpty: true,
      pending: false,
    });
    const markup = renderList(() => undefined);
    expect(markup).toContain("sidebar-v2-workflows-empty");
    expect(markup).toContain("No workflows yet — Add workflow to create one");
    expect(markup).toContain("sidebar-v2-workflows-empty-cta");
    expect(markup).toContain("Add workflow");
    expect(markup).not.toContain("No threads");
  });

  it("renders empty state without CTA when onRequestAddWorkflow is omitted", () => {
    entriesMock.snapshot = entriesState({
      isEmpty: true,
      pending: false,
    });
    const markup = renderList();
    expect(markup).toContain("sidebar-v2-workflows-empty");
    expect(markup).not.toContain("sidebar-v2-workflows-empty-cta");
  });

  it("renders project-error rows from the aggregate", () => {
    const rows: ReadonlyArray<WorkflowSidebarListRow> = [
      {
        kind: "project-error",
        environmentId: envPrimary,
        projectId: projectB,
        projectTitle: "Beta",
        error: "network down",
      },
    ];
    entriesMock.snapshot = entriesState({
      rows,
      errorsByProject: new Map([[projectB, "network down"]]),
    });
    const markup = renderList();
    expect(markup).toContain("sidebar-v2-workflows-list");
    expect(markup).toContain(`sidebar-v2-workflow-project-error-${projectB}`);
    expect(markup).toContain("Couldn&#x27;t load boards for Beta");
    expect(markup).toContain(`sidebar-v2-workflow-project-retry-${projectB}`);
  });

  it("renders board rows with attention badges and a delete control", () => {
    const row = boardRow({
      attention: { count: 2, dominantKind: "blocked" },
      attentionPill: {
        label: "2 items need your attention; includes an issue",
        className: "border-red-500",
      },
    });
    entriesMock.snapshot = entriesState({
      boards: [row],
      rows: [row],
    });
    const markup = renderList();
    expect(markup).toContain("sidebar-v2-workflows-list");
    expect(markup).toContain(`sidebar-v2-workflow-row-${boardId}`);
    expect(markup).toContain(`sidebar-v2-workflow-delete-${boardId}`);
    expect(markup).toContain("Delivery");
    expect(markup).toContain("Alpha");
    expect(markup).toContain(`sidebar-v2-workflow-attention-${boardId}`);
    expect(markup).toContain("border-dashed");
    expect(markup).toContain("border-red-500");
    expect(markup).not.toContain(">2 need you<");
  });
});
