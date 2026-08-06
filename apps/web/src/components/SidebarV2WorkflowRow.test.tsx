import { BoardId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { WorkflowSidebarBoardRow } from "../workflow/useWorkflowSidebarEntries";
import {
  SidebarV2WorkflowBoardRow,
  SidebarV2WorkflowProjectErrorRow,
} from "./SidebarV2WorkflowRow";

const env = EnvironmentId.make("environment-primary");
const projectId = ProjectId.make("project-a");
const boardId = BoardId.make("project-a__delivery");

function boardRow(overrides: Partial<WorkflowSidebarBoardRow> = {}): WorkflowSidebarBoardRow {
  return {
    kind: "board",
    environmentId: env,
    projectId,
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

const noopDelete = async () => undefined;

describe("SidebarV2WorkflowBoardRow", () => {
  it("renders name, project title, issue attention ring, and delete control", () => {
    const markup = renderToStaticMarkup(
      <SidebarV2WorkflowBoardRow
        row={boardRow({
          attention: { count: 2, dominantKind: "blocked" },
          attentionPill: {
            label: "2 items need your attention; includes an issue",
            className: "border-red-500",
          },
        })}
        isActive={false}
        onActivate={() => undefined}
        onDelete={noopDelete}
      />,
    );
    expect(markup).toContain("Delivery");
    expect(markup).toContain("Alpha");
    expect(markup).toContain("2 items need your attention; includes an issue");
    expect(markup).toContain("border-dashed");
    expect(markup).toContain("border-red-500");
    expect(markup).not.toContain(">2 need you<");
    expect(markup).toContain(`sidebar-v2-workflow-delete-${boardId}`);
    expect(markup).toContain("Delete workflow Delivery");
  });

  it("marks entry-error boards destructive and non-navigable but still offers delete", () => {
    const onActivate = vi.fn();
    const markup = renderToStaticMarkup(
      <SidebarV2WorkflowBoardRow
        row={boardRow({ entryError: "decode failed" })}
        isActive={false}
        onActivate={onActivate}
        onDelete={noopDelete}
      />,
    );
    expect(markup).toContain('data-entry-error="true"');
    expect(markup).toContain("text-destructive");
    expect(markup).toContain("This board&#x27;s file failed to load");
    expect(markup).toContain("aria-disabled");
    // No click handler when entryError — onActivate must not be wired via onClick.
    expect(markup).not.toContain('role="button"');
    expect(markup).toContain(`sidebar-v2-workflow-delete-${boardId}`);
  });

  it("highlights the active board by data-active", () => {
    const markup = renderToStaticMarkup(
      <SidebarV2WorkflowBoardRow
        row={boardRow()}
        isActive
        onActivate={() => undefined}
        onDelete={noopDelete}
      />,
    );
    expect(markup).toContain('data-active="true"');
    expect(markup).toContain("bg-sidebar-row-active");
  });

  it("clears active styling when not active", () => {
    const markup = renderToStaticMarkup(
      <SidebarV2WorkflowBoardRow
        row={boardRow()}
        isActive={false}
        onActivate={() => undefined}
        onDelete={noopDelete}
      />,
    );
    expect(markup).toContain('data-active="false"');
    expect(markup).not.toContain("bg-sidebar-row-active");
  });
});

describe("SidebarV2WorkflowProjectErrorRow", () => {
  it("renders a retryable project-error row", () => {
    const markup = renderToStaticMarkup(
      <SidebarV2WorkflowProjectErrorRow
        row={{
          kind: "project-error",
          environmentId: env,
          projectId,
          projectTitle: "Alpha",
          error: "network down",
        }}
        onRetry={() => undefined}
      />,
    );
    expect(markup).toContain("Couldn&#x27;t load boards for Alpha");
    expect(markup).toContain(`sidebar-v2-workflow-project-retry-${projectId}`);
    expect(markup).toContain("Retry loading boards for Alpha");
  });
});
