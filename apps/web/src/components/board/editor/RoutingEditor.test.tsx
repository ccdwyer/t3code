import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { RoutingEditor } from "./RoutingEditor";
import { StepFields } from "./StepFields";
import type { WorkflowLaneEncoded } from "./WorkflowEditor";

const lanes = [
  { key: "run", name: "Run", entry: "auto" },
  { key: "done", name: "Done", entry: "manual", terminal: true },
] as unknown as ReadonlyArray<WorkflowLaneEncoded>;

describe("RoutingEditor park targets", () => {
  it("offers park options and renders the park sub-editor for a park transition", () => {
    const lane = {
      key: "run",
      name: "Run",
      entry: "auto",
      transitions: [
        {
          when: { var: "pipeline.result" },
          to: {
            park: "issue",
            label: "Build broke",
            actions: [{ label: "Retry", to: "run" }],
          },
        },
      ],
    } as unknown as WorkflowLaneEncoded;

    const markup = renderToStaticMarkup(
      <RoutingEditor lane={lane} lanes={lanes} lintErrors={[]} onMutate={() => {}} />,
    );

    expect(markup).toContain("Park — issue");
    expect(markup).toContain("Park — waiting");
    expect(markup).toContain('data-testid="park-target-fields"');
    expect(markup).toContain('data-substate="issue"');
    expect(markup).toContain('value="Build broke"');
  });
});

describe("StepFields park targets", () => {
  it("renders the park sub-editor for a park step route", () => {
    const step = {
      key: "check",
      type: "script",
      run: "true",
      on: {
        failure: {
          park: "waiting",
          actions: [{ label: "Approve", to: "done" }],
        },
      },
    } as unknown as Parameters<typeof StepFields>[0]["step"];

    const markup = renderToStaticMarkup(
      <StepFields laneKey="run" lanes={lanes} step={step} onMutate={() => {}} />,
    );

    expect(markup).toContain("Park — waiting");
    expect(markup).toContain('data-testid="park-target-fields"');
    expect(markup).toContain('data-substate="waiting"');
    expect(markup).toContain('aria-label="Step check failure route action 1 target lane"');
  });
});
