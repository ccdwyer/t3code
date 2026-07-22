import { DndContext } from "@dnd-kit/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LaneCard } from "./LaneCard";
import type { CanvasLaneLayout } from "./canvasLayout";
import type { WorkflowLaneEncoded } from "../WorkflowEditor";

const layout: CanvasLaneLayout = {
  laneKey: "run",
  x: 0,
  y: 0,
  width: 240,
  estimatedHeight: 160,
};

const renderLane = (lane: unknown) =>
  renderToStaticMarkup(
    <DndContext>
      <LaneCard
        lane={lane as WorkflowLaneEncoded}
        layout={layout}
        onSelect={() => {}}
        onSelectStep={() => {}}
        onSelectRoute={() => {}}
        onAddStep={() => {}}
        onClearRoute={() => {}}
      />
    </DndContext>,
  );

describe("LaneCard park badges", () => {
  it("renders a warning-tinted badge for an issue park with its label", () => {
    const markup = renderLane({
      key: "run",
      name: "Run",
      entry: "auto",
      on: {
        failure: {
          park: "issue",
          label: "Build broke",
          actions: [{ label: "Retry", to: "run" }],
        },
      },
    });
    expect(markup).toContain('data-testid="park-badge-run-0"');
    expect(markup).toContain('data-substate="issue"');
    expect(markup).toContain("border-warning/50");
    expect(markup).toContain("Build broke");
  });

  it("renders an info-tinted badge for a waiting park, falling back to the substate word", () => {
    const markup = renderLane({
      key: "run",
      name: "Run",
      entry: "auto",
      transitions: [
        {
          when: { var: "pipeline.result" },
          to: { park: "waiting", actions: [{ label: "Approve", to: "run" }] },
        },
      ],
    });
    expect(markup).toContain('data-substate="waiting"');
    expect(markup).toContain("border-info/50");
    expect(markup).toContain("waiting");
  });

  it("renders no park badges when the lane has only bare lane routes", () => {
    const markup = renderLane({
      key: "run",
      name: "Run",
      entry: "auto",
      on: { success: "done" },
    });
    expect(markup).not.toContain("park-badge-run");
  });
});
