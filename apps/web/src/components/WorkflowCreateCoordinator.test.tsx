import { RegistryContext } from "@effect/atom-react";
import { BoardId, EnvironmentId, ProjectId, type BoardListEntry } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { RequestCreateWorkflowDetail } from "../commandPaletteBus";
import type { WorkflowCreateTarget } from "./WorkflowCreateCoordinator";

const env = EnvironmentId.make("environment-primary");
const remote = EnvironmentId.make("environment-remote");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const unknownProject = ProjectId.make("project-missing");

interface CapturedDialogProps {
  readonly open: boolean;
  readonly projectId: ProjectId;
  readonly environmentId: string;
  readonly projectName: string;
  readonly existingBoardNames: ReadonlyArray<string>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (boardId: string) => void;
}

const harness = vi.hoisted(() => ({
  target: null as WorkflowCreateTarget | null,
  setTargetCalls: [] as Array<WorkflowCreateTarget | null>,
  /**
   * Mirrors the real useEnvironmentQuery contract: `data: A | null`,
   * `error: string | null`. Loading = both null; `undefined` never occurs.
   */
  boards: null as ReadonlyArray<BoardListEntry> | null,
  boardsError: null as string | null,
  navigateCalls: [] as Array<unknown>,
  refreshCalls: [] as Array<{ environmentId: EnvironmentId; projectId: ProjectId }>,
  dialogProps: null as CapturedDialogProps | null,
  projects: [] as Array<{
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly title: string;
  }>,
  primaryEnvironmentId: null as EnvironmentId | null,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // Coordinator has a single useState(null) for the create target. Seed it
    // from the harness (and record writes) so SSR can exercise the deferred /
    // dialog branches without useEffect (which does not run under
    // renderToStaticMarkup).
    useState: <T,>(initial: T | (() => T)): [T, (value: T) => void] => {
      if (initial === null) {
        return [
          harness.target as T,
          (value: T) => {
            harness.setTargetCalls.push(value as WorkflowCreateTarget | null);
          },
        ];
      }
      return actual.useState(initial);
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => (options: unknown) => {
    harness.navigateCalls.push(options);
    return Promise.resolve();
  },
}));

vi.mock("../state/entities", () => ({
  useProjects: () => harness.projects,
}));

vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => harness.primaryEnvironmentId,
}));

vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: harness.boards,
    error: harness.boardsError,
    isPending: harness.boards === null && harness.boardsError === null,
    refresh: () => undefined,
  }),
}));

vi.mock("../workflow/useWorkflowApi", () => ({
  useWorkflowApi: () => ({ marker: "workflow-api" }),
}));

vi.mock("../workflow/useWorkflowSidebarEntries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workflow/useWorkflowSidebarEntries")>();
  return {
    ...actual,
    refreshListBoards: (_registry: unknown, environmentId: EnvironmentId, projectId: ProjectId) => {
      harness.refreshCalls.push({ environmentId, projectId });
    },
  };
});

vi.mock("./board/CreateWorkflowDialog", () => ({
  CreateWorkflowDialog: (props: CapturedDialogProps): ReactNode => {
    harness.dialogProps = props;
    return (
      <div
        data-testid="create-workflow-dialog"
        data-project-name={props.projectName}
        data-existing-names={props.existingBoardNames.join("|")}
        data-project-id={props.projectId}
        data-environment-id={props.environmentId}
        data-open={props.open ? "true" : "false"}
      />
    );
  },
}));

import { onRequestCreateWorkflow, requestCreateWorkflow } from "../commandPaletteBus";
import {
  createRequestCreateWorkflowListener,
  resolveCreateWorkflowTarget,
  WorkflowCreateCoordinator,
} from "./WorkflowCreateCoordinator";

function ensureWindowEventTarget(): void {
  if (
    typeof globalThis.window === "undefined" ||
    typeof globalThis.window.addEventListener !== "function" ||
    typeof globalThis.window.dispatchEvent !== "function"
  ) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: new EventTarget(),
    });
  }
}

function renderCoordinator(): string {
  const registry = AtomRegistry.make();
  try {
    return renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <WorkflowCreateCoordinator />
      </RegistryContext.Provider>,
    );
  } finally {
    registry.dispose();
  }
}

beforeEach(() => {
  ensureWindowEventTarget();
  harness.target = null;
  harness.setTargetCalls = [];
  harness.boards = null;
  harness.boardsError = null;
  harness.navigateCalls = [];
  harness.refreshCalls = [];
  harness.dialogProps = null;
  harness.projects = [
    { id: projectA, environmentId: env, title: "Alpha" },
    { id: projectB, environmentId: env, title: "Beta" },
  ];
  harness.primaryEnvironmentId = env;
});

afterEach(() => {
  harness.target = null;
  harness.boards = null;
  harness.boardsError = null;
});

describe("resolveCreateWorkflowTarget", () => {
  const projects = [
    { id: projectA, environmentId: env, title: "Alpha" },
    { id: projectB, environmentId: env, title: "Beta" },
  ];

  it("opens for a known primary-env project", () => {
    expect(
      resolveCreateWorkflowTarget({ projectId: projectA, environmentId: env }, projects, env),
    ).toEqual({
      projectId: projectA,
      environmentId: env,
      projectName: "Alpha",
    });
  });

  it("rejects non-primary environment intents", () => {
    expect(
      resolveCreateWorkflowTarget({ projectId: projectA, environmentId: remote }, projects, env),
    ).toBeNull();
  });

  it("rejects when there is no primary environment", () => {
    expect(
      resolveCreateWorkflowTarget({ projectId: projectA, environmentId: env }, projects, null),
    ).toBeNull();
  });

  it("rejects unknown projects (stale palette / removed project)", () => {
    expect(
      resolveCreateWorkflowTarget({ projectId: unknownProject, environmentId: env }, projects, env),
    ).toBeNull();
  });
});

describe("bus → coordinator listener (production composition)", () => {
  it("real dispatch through the real bus sets the target for an accepted intent", () => {
    const targets: WorkflowCreateTarget[] = [];
    const listener = createRequestCreateWorkflowListener({
      projects: harness.projects,
      primaryEnvironmentId: env,
      setTarget: (target) => targets.push(target),
    });
    const unsubscribe = onRequestCreateWorkflow(listener);

    requestCreateWorkflow({ projectId: projectA, environmentId: env });
    expect(targets).toEqual([{ projectId: projectA, environmentId: env, projectName: "Alpha" }]);

    // Rejected intents never set a target.
    requestCreateWorkflow({ projectId: unknownProject, environmentId: env });
    requestCreateWorkflow({ projectId: projectA, environmentId: remote });
    expect(targets).toHaveLength(1);

    unsubscribe();
    requestCreateWorkflow({ projectId: projectB, environmentId: env });
    expect(targets).toHaveLength(1);
  });

  it("delivers detail to subscribers and stops after unsubscribe", () => {
    const received: RequestCreateWorkflowDetail[] = [];
    const unsubscribe = onRequestCreateWorkflow((detail) => {
      received.push(detail);
    });

    requestCreateWorkflow({ projectId: projectA, environmentId: env });
    expect(received).toEqual([{ projectId: projectA, environmentId: env }]);

    unsubscribe();
    requestCreateWorkflow({ projectId: projectB, environmentId: env });
    expect(received).toEqual([{ projectId: projectA, environmentId: env }]);
  });
});

describe("WorkflowCreateCoordinator (real component SSR)", () => {
  it("renders null when there is no create target", () => {
    harness.target = null;
    harness.boards = [{ boardId: BoardId.make("x"), name: "X", filePath: "x.json", error: null }];
    expect(renderCoordinator()).toBe("");
  });

  it("defers the dialog while the boards query is loading (data and error both null)", () => {
    harness.target = {
      projectId: projectA,
      environmentId: env,
      projectName: "Alpha",
    };
    harness.boards = null;
    harness.boardsError = null;
    const markup = renderCoordinator();
    expect(markup).toBe("");
    expect(markup).not.toContain("create-workflow-dialog");
  });

  it("renders the dialog with empty names when the boards query fails (settled)", () => {
    harness.target = {
      projectId: projectA,
      environmentId: env,
      projectName: "Alpha",
    };
    harness.boards = null;
    harness.boardsError = "listBoards failed";
    const markup = renderCoordinator();
    expect(markup).toContain("create-workflow-dialog");
    expect(markup).toContain('data-existing-names=""');
  });

  it("renders CreateWorkflowDialog with projectName and existingBoardNames when settled", () => {
    harness.target = {
      projectId: projectA,
      environmentId: env,
      projectName: "Alpha",
    };
    harness.boards = [
      {
        boardId: BoardId.make("project-a__existing"),
        name: "Existing Flow",
        filePath: ".t3/boards/existing.json",
        error: null,
      },
    ];
    const markup = renderCoordinator();
    expect(markup).toContain("create-workflow-dialog");
    expect(markup).toContain('data-project-name="Alpha"');
    expect(markup).toContain('data-existing-names="Existing Flow"');
    expect(markup).toContain(`data-project-id="${projectA}"`);
    expect(markup).toContain(`data-environment-id="${env}"`);
    expect(markup).toContain('data-open="true"');
  });

  it("onOpenChange(false) clears the target (dialog close)", () => {
    harness.target = {
      projectId: projectA,
      environmentId: env,
      projectName: "Alpha",
    };
    harness.boards = [];
    renderCoordinator();
    expect(harness.dialogProps).not.toBeNull();
    harness.dialogProps?.onOpenChange(false);
    expect(harness.setTargetCalls).toEqual([null]);
  });

  it("onCreated refreshes the project's boards, closes, and navigates to the board", () => {
    harness.target = {
      projectId: projectA,
      environmentId: env,
      projectName: "Alpha",
    };
    harness.boards = [];
    renderCoordinator();
    expect(harness.dialogProps).not.toBeNull();
    harness.dialogProps?.onCreated("project-a__created");
    expect(harness.refreshCalls).toEqual([{ environmentId: env, projectId: projectA }]);
    expect(harness.setTargetCalls).toEqual([null]);
    expect(harness.navigateCalls).toEqual([
      {
        to: "/$environmentId/board",
        params: { environmentId: env },
        search: { boardId: "project-a__created" },
      },
    ]);
  });
});
