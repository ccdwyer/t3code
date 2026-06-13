import "../../index.css";

import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { BoardHeaderControls } from "./BoardHeaderControls";

const lanes = [
  { key: "backlog", name: "Backlog", entry: "manual", pipelineStepCount: 0 },
  { key: "implement", name: "Implement", entry: "auto", pipelineStepCount: 2 },
] as const;

describe("BoardHeaderControls", () => {
  it("opens a create-ticket dialog and submits title plus description", async () => {
    const onCreateTicket = vi.fn();
    render(
      <BoardHeaderControls boardId="delivery" lanes={lanes} onCreateTicket={onCreateTicket} />,
    );

    await expect.element(page.getByLabelText("New ticket title")).not.toBeInTheDocument();

    await page.getByRole("button", { name: "New ticket" }).click();
    await expect.element(page.getByRole("heading", { name: "New ticket" })).toBeInTheDocument();

    await page.getByLabelText("Ticket title").fill("Ship workflow modal");
    await page
      .getByLabelText("Ticket description")
      .fill("Acceptance criteria and implementation notes.");
    await page.getByRole("button", { name: "Create ticket" }).click();

    await vi.waitFor(() => {
      expect(onCreateTicket).toHaveBeenCalledWith({
        title: "Ship workflow modal",
        description: "Acceptance criteria and implementation notes.",
        initialLane: "backlog",
      });
    });
  });

  it("toggles the workflow editor from the board header", async () => {
    const onToggleWorkflowEditor = vi.fn();
    render(
      <BoardHeaderControls
        boardId="delivery"
        lanes={lanes}
        workflowEditorOpen={false}
        onCreateTicket={() => {}}
        onToggleWorkflowEditor={onToggleWorkflowEditor}
      />,
    );

    await page.getByRole("button", { name: "Edit workflow" }).click();

    await vi.waitFor(() => {
      expect(onToggleWorkflowEditor).toHaveBeenCalledOnce();
    });
  });
});
