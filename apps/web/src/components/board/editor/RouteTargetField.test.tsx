import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { RouteTargetPath, WorkflowParkTargetEncoded } from "~/workflow/editorModel";

import { ParkTargetFields, RouteTargetSelect } from "./RouteTargetField";
import type { WorkflowLaneEncoded } from "./WorkflowEditor";

const lanes = [
  { key: "queue", name: "Queue", entry: "manual" },
  { key: "run", name: "Run", entry: "auto" },
  { key: "done", name: "Done", entry: "manual", terminal: true },
] as unknown as ReadonlyArray<WorkflowLaneEncoded>;

const transitionPath: RouteTargetPath = { site: "transition", laneKey: "run", index: 0 };

const issuePark = {
  park: "issue",
  label: "Needs a fix",
  actions: [{ label: "Retry", to: "run" }],
} as unknown as WorkflowParkTargetEncoded;

describe("RouteTargetSelect", () => {
  it("offers the two distinct park options alongside lanes and No route", () => {
    const markup = renderToStaticMarkup(
      <RouteTargetSelect
        ariaLabel="Lane failure route"
        lanes={lanes}
        target={undefined}
        path={{ site: "laneOn", laneKey: "run", kind: "failure" }}
        allowNoRoute
        onMutate={() => {}}
      />,
    );
    expect(markup).toContain("No route");
    expect(markup).toContain("Park — issue");
    expect(markup).toContain("Park — waiting");
    expect(markup).toContain('value="__park_issue"');
    expect(markup).toContain('value="__park_waiting"');
  });

  it("selects the park sentinel when the current target is a park", () => {
    const markup = renderToStaticMarkup(
      <RouteTargetSelect
        ariaLabel="Transition 1 target lane"
        lanes={lanes}
        target={issuePark}
        path={transitionPath}
        onMutate={() => {}}
      />,
    );
    const issueOption = markup.match(/<option[^>]*value="__park_issue"[^>]*>/)?.[0] ?? "";
    expect(issueOption).toContain("selected");
  });
});

describe("ParkTargetFields", () => {
  it("renders the label input and one action row per park action with issue tokens", () => {
    const markup = renderToStaticMarkup(
      <ParkTargetFields
        target={issuePark}
        path={transitionPath}
        lanes={lanes}
        ariaLabelBase="Transition 1"
        heading="Park in place"
        onMutate={() => {}}
      />,
    );
    expect(markup).toContain('data-testid="park-target-fields"');
    expect(markup).toContain('data-substate="issue"');
    expect(markup).toContain("border-warning/45");
    expect(markup).toContain('aria-label="Transition 1 park label"');
    expect(markup).toContain('value="Needs a fix"');
    expect(markup).toContain('aria-label="Transition 1 action 1 label"');
    expect(markup).toContain('aria-label="Transition 1 action 1 target lane"');
    expect(markup).toContain('aria-label="Transition 1 action 1 hint"');
  });

  it("disables the remove control for the last action (min one) and enables it otherwise", () => {
    const single = renderToStaticMarkup(
      <ParkTargetFields
        target={issuePark}
        path={transitionPath}
        lanes={lanes}
        ariaLabelBase="Transition 1"
        heading="Park in place"
        onMutate={() => {}}
      />,
    );
    const singleRemove = single.match(/<button[^>]*Remove Transition 1 action 1[^>]*>/)?.[0] ?? "";
    expect(singleRemove).toContain('disabled=""');

    const twoActions = {
      park: "waiting",
      actions: [
        { label: "Approve", to: "done" },
        { label: "Send back", to: "queue" },
      ],
    } as unknown as WorkflowParkTargetEncoded;
    const many = renderToStaticMarkup(
      <ParkTargetFields
        target={twoActions}
        path={transitionPath}
        lanes={lanes}
        ariaLabelBase="Transition 1"
        heading="Park in place"
        onMutate={() => {}}
      />,
    );
    expect(many).toContain('data-substate="waiting"');
    expect(many).toContain("border-info/45");
    const firstRemove = many.match(/<button[^>]*Remove Transition 1 action 1[^>]*>/)?.[0] ?? "";
    expect(firstRemove).not.toContain('disabled=""');
  });
});
