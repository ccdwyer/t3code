import "../../../../index.css";

import { LaneKey, StepKey, type WorkflowDefinitionEncoded } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { useState } from "react";
import { render } from "vitest-browser-react";

import {
  adjustSelectionAfterTransitionRemoval,
  createWorkflowEditorModel,
  normalizeSelection,
  removeTransition,
  type WorkflowEditorModel,
  type WorkflowEditorSelection,
} from "~/workflow/editorModel";

import { CanvasView } from "./CanvasView";
import { routeDndId } from "./RoutingHandles";
import { deriveRoutingEdges, routingEdgeTestId } from "./RoutingEdges";

const queueLaneKey = LaneKey.make("queue");
const runLaneKey = LaneKey.make("run");
const doneLaneKey = LaneKey.make("done");
const reviewStepKey = StepKey.make("review");

const definition = {
  name: "Delivery",
  lanes: [
    { key: queueLaneKey, name: "Queue", entry: "manual" },
    {
      key: runLaneKey,
      name: "Run",
      entry: "auto",
      wipLimit: 2,
      pipeline: [
        {
          key: reviewStepKey,
          type: "agent",
          agent: { instance: "codex_main", model: "gpt-5.5" },
          instruction: "Review the diff.",
          on: { success: doneLaneKey },
        },
      ],
      transitions: [{ when: { var: "ticket.priority" }, to: queueLaneKey }],
      on: { success: doneLaneKey, failure: runLaneKey },
    },
    { key: doneLaneKey, name: "Done", entry: "manual", terminal: true },
  ],
} satisfies WorkflowDefinitionEncoded;

const multiTransitionDefinition = {
  ...definition,
  lanes: definition.lanes.map((lane) =>
    lane.key === runLaneKey
      ? {
          ...lane,
          transitions: [
            { when: { "==": [{ var: "ticket.status" }, "queued"] }, to: queueLaneKey },
            { when: { "==": [{ var: "ticket.status" }, "done"] }, to: doneLaneKey },
            { when: { "==": [{ var: "ticket.status" }, "retry"] }, to: queueLaneKey },
          ],
        }
      : lane,
  ),
} satisfies WorkflowDefinitionEncoded;

const duplicateTransitionDefinition = {
  ...definition,
  lanes: definition.lanes.map((lane) =>
    lane.key === runLaneKey
      ? {
          ...lane,
          transitions: [
            { when: { var: "pipeline.result" }, to: doneLaneKey },
            { when: { var: "pipeline.result" }, to: doneLaneKey },
          ],
        }
      : lane,
  ),
} satisfies WorkflowDefinitionEncoded;

const collidingRouteHandleDefinition = {
  name: "Colliding route handles",
  lanes: [
    {
      key: LaneKey.make("a:b"),
      name: "Lane A Colon",
      entry: "manual",
      pipeline: [
        {
          key: StepKey.make("c"),
          type: "approval",
        },
      ],
    },
    {
      key: LaneKey.make("a"),
      name: "Lane A Plain",
      entry: "manual",
      pipeline: [
        {
          key: StepKey.make("b:c"),
          type: "approval",
        },
      ],
    },
  ],
} satisfies WorkflowDefinitionEncoded;

const collidingEdgeIdentityDefinition = {
  name: "Colliding edge identities",
  lanes: [
    { key: LaneKey.make("target"), name: "Target", entry: "manual" },
    {
      key: LaneKey.make("a:b"),
      name: "Lane A Colon",
      entry: "manual",
      pipeline: [
        {
          key: StepKey.make("c"),
          type: "approval",
          on: { success: LaneKey.make("target") },
        },
      ],
    },
    {
      key: LaneKey.make("a"),
      name: "Lane A Plain",
      entry: "manual",
      pipeline: [
        {
          key: StepKey.make("b:c"),
          type: "approval",
          on: { success: LaneKey.make("target") },
        },
      ],
    },
  ],
} satisfies WorkflowDefinitionEncoded;

const overlappingEdgeLabelDefinition = {
  name: "Overlapping edge labels",
  lanes: [
    { key: queueLaneKey, name: "Queue", entry: "manual" },
    {
      key: runLaneKey,
      name: "Run",
      entry: "auto",
      transitions: [{ when: { var: "ticket.priority" }, to: queueLaneKey }],
      on: { success: queueLaneKey },
    },
  ],
} satisfies WorkflowDefinitionEncoded;

const clickElementById = async (id: string) => {
  await vi.waitFor(() => {
    expect(document.getElementById(id)).not.toBeNull();
  });
  const element = document.getElementById(id);
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};

const edgeSelector = (parts: Parameters<typeof routingEdgeTestId>[0]): string =>
  `[data-testid=${CSS.escape(routingEdgeTestId(parts))}]`;

describe("CanvasView", () => {
  it("derives opaque edge ids for lane and step keys containing separators", () => {
    const stepEdges = deriveRoutingEdges(collidingEdgeIdentityDefinition).filter(
      (edge) => edge.edgeKind === "step-on",
    );

    expect(stepEdges.map((edge) => edge.id)).toEqual([
      routeDndId(["workflow-edge", "step-on", "a:b", "c", "success", "target"]),
      routeDndId(["workflow-edge", "step-on", "a", "b:c", "success", "target"]),
    ]);
    expect(stepEdges.map((edge) => edge.testId)).toEqual([
      routeDndId(["workflow-edge-testid", "step-on", "a:b", "c", "success", "target"]),
      routeDndId(["workflow-edge-testid", "step-on", "a", "b:c", "success", "target"]),
    ]);
    expect(new Set(stepEdges.map((edge) => edge.id)).size).toBe(2);
    expect(new Set(stepEdges.map((edge) => edge.testId)).size).toBe(2);
  });

  it("renders lane cards, step blocks, precedence legend, route edges, and self-loops", async () => {
    render(
      <CanvasView
        model={createWorkflowEditorModel(definition)}
        selection={null}
        disabled={false}
        onMutate={() => {}}
        onSelect={vi.fn()}
      />,
    );

    await expect.element(page.getByRole("region", { name: "Workflow canvas" })).toBeInTheDocument();
    await expect.element(page.getByRole("group", { name: "Lane Run" })).toBeInTheDocument();
    await expect.element(page.getByText("entry auto")).toBeInTheDocument();
    await expect.element(page.getByText("WIP 2")).toBeInTheDocument();
    await expect.element(page.getByText("terminal")).toBeInTheDocument();
    await expect.element(page.getByRole("group", { name: "Step review" })).toBeInTheDocument();
    expect(document.querySelector('[data-step-type="agent"]')).not.toBeNull();
    await expect.element(page.getByText("Review the diff.")).toBeInTheDocument();

    await expect.element(page.getByText("Routing precedence")).toBeInTheDocument();
    await expect
      .element(page.getByText("Step routes > transitions > lane fallback"))
      .toBeInTheDocument();

    const stepEdge = document.querySelector(
      edgeSelector(["step-on", "run", "review", "success", "done"]),
    );
    const transitionEdge = document.querySelector(
      edgeSelector(["transition", "run", "0", "queue"]),
    );
    const laneEdge = document.querySelector(edgeSelector(["lane-on", "run", "success", "done"]));
    const selfLoop = document.querySelector(edgeSelector(["lane-on", "run", "failure", "run"]));

    expect(stepEdge?.getAttribute("data-edge-kind")).toBe("step-on");
    expect(stepEdge?.getAttribute("data-precedence")).toBe("1");
    expect(transitionEdge?.getAttribute("data-edge-kind")).toBe("lane-transition");
    expect(transitionEdge?.getAttribute("data-precedence")).toBe("2");
    expect(transitionEdge?.getAttribute("aria-label")).toBe("Transition 1 from Run to Queue");
    expect(laneEdge?.getAttribute("data-edge-kind")).toBe("lane-on");
    expect(laneEdge?.getAttribute("data-precedence")).toBe("3");
    expect(laneEdge?.getAttribute("stroke-dasharray")).toBe("6 4");
    expect(selfLoop?.getAttribute("data-self-loop")).toBe("true");
    const edgeOrder = Array.from(document.querySelectorAll("svg path")).map((element) =>
      element.getAttribute("data-testid"),
    );
    expect(
      edgeOrder.indexOf(routingEdgeTestId(["lane-on", "run", "success", "done"])),
    ).toBeLessThan(edgeOrder.indexOf(routingEdgeTestId(["transition", "run", "0", "queue"])));
    expect(edgeOrder.indexOf(routingEdgeTestId(["transition", "run", "0", "queue"]))).toBeLessThan(
      edgeOrder.indexOf(routingEdgeTestId(["step-on", "run", "review", "success", "done"])),
    );

    await expect.element(page.getByText("#1")).toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll("svg text")).some(
        (element) => element.textContent === "success",
      ),
    ).toBe(true);
  });

  it("staggers labels for edges that share the same midpoint", async () => {
    render(
      <CanvasView
        model={createWorkflowEditorModel(overlappingEdgeLabelDefinition)}
        selection={null}
        disabled={false}
        onMutate={() => {}}
        onSelect={vi.fn()}
      />,
    );

    await vi.waitFor(() => {
      expect(
        document.querySelector(edgeSelector(["transition", "run", "0", "queue"])),
      ).not.toBeNull();
      expect(
        document.querySelector(edgeSelector(["lane-on", "run", "success", "queue"])),
      ).not.toBeNull();
    });

    const labelPositions = svgTextPositions();
    expect(labelPositions.get("#1")?.y).not.toBe(labelPositions.get("success")?.y);
  });

  it("dims edges unrelated to the selected lane and raises connected ones", async () => {
    render(
      <CanvasView
        model={createWorkflowEditorModel(definition)}
        selection={{ kind: "lane", laneKey: "queue" }}
        disabled={false}
        onMutate={() => {}}
        onSelect={vi.fn()}
      />,
    );

    await vi.waitFor(() => {
      expect(
        document.querySelector(edgeSelector(["transition", "run", "0", "queue"])),
      ).not.toBeNull();
    });

    const intoQueue = document.querySelector(edgeSelector(["transition", "run", "0", "queue"]));
    const unrelated = document.querySelector(
      edgeSelector(["step-on", "run", "review", "success", "done"]),
    );
    expect(intoQueue?.closest("g")?.getAttribute("data-dimmed")).toBeNull();
    expect(unrelated?.closest("g")?.getAttribute("data-dimmed")).toBe("true");

    // Dimmed edges render first so the selected lane's wiring sits on top.
    const edgeOrder = Array.from(document.querySelectorAll("svg path")).map((element) =>
      element.getAttribute("data-testid"),
    );
    expect(
      edgeOrder.indexOf(routingEdgeTestId(["step-on", "run", "review", "success", "done"])),
    ).toBeLessThan(edgeOrder.indexOf(routingEdgeTestId(["transition", "run", "0", "queue"])));
  });

  it("selects canvas elements, renders a shared inspector, and adds lanes and steps", async () => {
    function CanvasHarness() {
      const [model, setModel] = useState<WorkflowEditorModel>(() =>
        createWorkflowEditorModel(definition),
      );
      const [selection, setSelection] = useState<WorkflowEditorSelection | null>(null);

      return (
        <CanvasView
          model={model}
          selection={selection}
          disabled={false}
          onSelect={setSelection}
          onMutate={(mutate, mutateSelection) =>
            setModel((current) => {
              const next = mutate(current);
              setSelection((currentSelection) =>
                normalizeSelection(
                  next,
                  mutateSelection ? mutateSelection(currentSelection) : currentSelection,
                ),
              );
              return next;
            })
          }
        />
      );
    }

    render(<CanvasHarness />);

    await clickElementById("lane-run");
    await expect.element(page.getByLabelText("Lane name")).toHaveValue("Run");

    await clickElementById("step-run-review");
    await expect
      .element(page.getByLabelText("Step review instruction"))
      .toHaveValue("Review the diff.");

    document
      .querySelector(edgeSelector(["transition", "run", "0", "queue"]))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect
      .element(page.getByLabelText("Transition 1 predicate JSON"))
      .toHaveValue(JSON.stringify({ var: "ticket.priority" }, null, 2));

    await page.getByTestId("workflow-canvas-surface").click({ position: { x: 8, y: 260 } });
    await expect
      .element(page.getByText("Select a lane, step, or route to edit."))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Add lane" }).click();
    await expect.element(page.getByRole("group", { name: "Lane New lane" })).toBeInTheDocument();
    await expect.element(page.getByLabelText("Lane name")).toHaveValue("New lane");

    await clickElementById("lane-run");
    await page.getByRole("button", { name: "Add agent step to Run" }).click();
    await expect.element(page.getByRole("group", { name: "Step agent" })).toBeInTheDocument();
    await expect.element(page.getByLabelText("Step agent instruction")).toBeInTheDocument();

    await clickElementById("lane-run");
    await page.getByLabelText("Lane success route").selectOptions("queue");
    await expect
      .element(page.getByText("Unsaved canvas changes", { exact: true }))
      .toBeInTheDocument();
    expect(
      document.querySelector(edgeSelector(["lane-on", "run", "success", "queue"])),
    ).not.toBeNull();
  });

  it("renders draggable lane routing handles and keeps inspector routing as the fallback", async () => {
    function CanvasHarness() {
      const [model, setModel] = useState<WorkflowEditorModel>(() =>
        createWorkflowEditorModel(definition),
      );
      const [selection, setSelection] = useState<WorkflowEditorSelection | null>(null);

      return (
        <CanvasView
          model={model}
          selection={selection}
          disabled={false}
          onSelect={setSelection}
          onMutate={(mutate, mutateSelection) =>
            setModel((current) => {
              const next = mutate(current);
              setSelection((currentSelection) =>
                normalizeSelection(
                  next,
                  mutateSelection ? mutateSelection(currentSelection) : currentSelection,
                ),
              );
              return next;
            })
          }
        />
      );
    }

    render(<CanvasHarness />);

    await expect
      .element(page.getByRole("button", { name: "Drag success route from Run" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Clear success route from Run" }))
      .toBeInTheDocument();
    await expect.element(page.getByTestId("lane-drop-run")).toBeInTheDocument();

    await clickElementById("lane-run");
    await page.getByLabelText("Lane blocked route").selectOptions("queue");
    expect(
      document.querySelector(edgeSelector(["lane-on", "run", "blocked", "queue"])),
    ).not.toBeNull();
  });

  it("falls back to lane selection after removing the selected transition", async () => {
    function CanvasHarness() {
      const [model, setModel] = useState<WorkflowEditorModel>(() =>
        createWorkflowEditorModel(multiTransitionDefinition),
      );
      const [selection, setSelection] = useState<WorkflowEditorSelection | null>(null);

      return (
        <CanvasView
          model={model}
          selection={selection}
          disabled={false}
          onSelect={setSelection}
          onMutate={(mutate, mutateSelection) =>
            setModel((current) => {
              const next = mutate(current);
              setSelection((currentSelection) =>
                normalizeSelection(
                  next,
                  mutateSelection ? mutateSelection(currentSelection) : currentSelection,
                ),
              );
              return next;
            })
          }
        />
      );
    }

    render(<CanvasHarness />);

    await vi.waitFor(() => {
      expect(
        document.querySelector(edgeSelector(["transition", "run", "1", "done"])),
      ).not.toBeNull();
    });
    document
      .querySelector(edgeSelector(["transition", "run", "1", "done"]))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect
      .element(page.getByLabelText("Transition 2 predicate JSON"))
      .toHaveValue(JSON.stringify({ "==": [{ var: "ticket.status" }, "done"] }, null, 2));

    await page.getByRole("button", { name: "Remove transition 2" }).click();

    await expect.element(page.getByLabelText("Lane name")).toHaveValue("Run");
  });

  it("keeps the transition inspector selected after editing the selected transition", async () => {
    function CanvasHarness() {
      const [model, setModel] = useState<WorkflowEditorModel>(() =>
        createWorkflowEditorModel(definition),
      );
      const [selection, setSelection] = useState<WorkflowEditorSelection | null>(null);

      return (
        <CanvasView
          model={model}
          selection={selection}
          disabled={false}
          onSelect={setSelection}
          onMutate={(mutate, mutateSelection) =>
            setModel((current) => {
              const next = mutate(current);
              setSelection((currentSelection) =>
                normalizeSelection(
                  next,
                  mutateSelection ? mutateSelection(currentSelection) : currentSelection,
                ),
              );
              return next;
            })
          }
        />
      );
    }

    render(<CanvasHarness />);

    await vi.waitFor(() => {
      expect(
        document.querySelector(edgeSelector(["transition", "run", "0", "queue"])),
      ).not.toBeNull();
    });
    document
      .querySelector(edgeSelector(["transition", "run", "0", "queue"]))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const nextPredicate = JSON.stringify({ var: "ticket.status" }, null, 2);
    await page.getByLabelText("Transition 1 predicate JSON").fill(nextPredicate);
    await expect
      .element(page.getByLabelText("Transition 1 predicate JSON"))
      .toHaveValue(nextPredicate);

    await page.getByLabelText("Transition 1 target lane").selectOptions("done");
    await expect.element(page.getByLabelText("Transition 1 target lane")).toHaveValue("done");
  });

  it("falls back to the lane after removing the selected duplicate transition", async () => {
    function CanvasHarness() {
      const [model, setModel] = useState<WorkflowEditorModel>(() =>
        createWorkflowEditorModel(duplicateTransitionDefinition),
      );
      const [selection, setSelection] = useState<WorkflowEditorSelection | null>(null);

      return (
        <CanvasView
          model={model}
          selection={selection}
          disabled={false}
          onSelect={setSelection}
          onMutate={(mutate, mutateSelection) =>
            setModel((current) => {
              const next = mutate(current);
              setSelection((currentSelection) =>
                normalizeSelection(
                  next,
                  mutateSelection ? mutateSelection(currentSelection) : currentSelection,
                ),
              );
              return next;
            })
          }
        />
      );
    }

    render(<CanvasHarness />);

    await vi.waitFor(() => {
      expect(
        document.querySelector(edgeSelector(["transition", "run", "1", "done"])),
      ).not.toBeNull();
    });
    document
      .querySelector(edgeSelector(["transition", "run", "1", "done"]))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect
      .element(page.getByLabelText("Transition 2 predicate JSON"))
      .toHaveValue(JSON.stringify({ var: "pipeline.result" }, null, 2));

    await page.getByRole("button", { name: "Remove transition 2" }).click();

    await expect.element(page.getByLabelText("Lane name")).toHaveValue("Run");
  });

  it("keeps the selected transition inspector after removing an earlier transition", async () => {
    function CanvasHarness() {
      const [model, setModel] = useState<WorkflowEditorModel>(() =>
        createWorkflowEditorModel(multiTransitionDefinition),
      );
      const [selection, setSelection] = useState<WorkflowEditorSelection | null>(null);

      const removeFirstTransition = () => {
        setModel((current) => {
          const next = removeTransition(current, "run", 0);
          setSelection((currentSelection) =>
            normalizeSelection(
              next,
              adjustSelectionAfterTransitionRemoval(currentSelection, "run", 0),
            ),
          );
          return next;
        });
      };

      return (
        <>
          <button type="button" onClick={removeFirstTransition}>
            Remove first transition
          </button>
          <CanvasView
            model={model}
            selection={selection}
            disabled={false}
            onSelect={setSelection}
            onMutate={(mutate, mutateSelection) =>
              setModel((current) => {
                const next = mutate(current);
                setSelection((currentSelection) =>
                  normalizeSelection(
                    next,
                    mutateSelection ? mutateSelection(currentSelection) : currentSelection,
                  ),
                );
                return next;
              })
            }
          />
        </>
      );
    }

    render(<CanvasHarness />);

    await vi.waitFor(() => {
      expect(
        document.querySelector(edgeSelector(["transition", "run", "1", "done"])),
      ).not.toBeNull();
    });
    document
      .querySelector(edgeSelector(["transition", "run", "1", "done"]))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect
      .element(page.getByLabelText("Transition 2 predicate JSON"))
      .toHaveValue(JSON.stringify({ "==": [{ var: "ticket.status" }, "done"] }, null, 2));

    await page.getByRole("button", { name: "Remove first transition" }).click();

    await expect
      .element(page.getByLabelText("Transition 1 predicate JSON"))
      .toHaveValue(JSON.stringify({ "==": [{ var: "ticket.status" }, "done"] }, null, 2));
  });

  it("connects a step route by dragging a step handle onto a lane", async () => {
    function CanvasHarness() {
      const [model, setModel] = useState<WorkflowEditorModel>(() =>
        createWorkflowEditorModel(definition),
      );
      const [selection, setSelection] = useState<WorkflowEditorSelection | null>(null);

      return (
        <CanvasView
          model={model}
          selection={selection}
          disabled={false}
          onSelect={setSelection}
          onMutate={(mutate, mutateSelection) =>
            setModel((current) => {
              const next = mutate(current);
              setSelection((currentSelection) =>
                normalizeSelection(
                  next,
                  mutateSelection ? mutateSelection(currentSelection) : currentSelection,
                ),
              );
              return next;
            })
          }
        />
      );
    }

    render(<CanvasHarness />);

    await expect
      .element(page.getByRole("button", { name: "Drag success route from step review in Run" }))
      .toBeInTheDocument();

    await page
      .getByRole("button", { name: "Drag success route from step review in Run" })
      .dropTo(page.getByTestId("lane-drop-run"));

    await vi.waitFor(() => {
      expect(
        document.querySelector(edgeSelector(["step-on", "run", "review", "success", "run"])),
      ).not.toBeNull();
    });
    expect(
      document.querySelector(edgeSelector(["step-on", "run", "review", "success", "done"])),
    ).toBeNull();
  });

  it("routes the exact step handle when old colon-joined dnd ids would collide", async () => {
    function CanvasHarness() {
      const [model, setModel] = useState<WorkflowEditorModel>(() =>
        createWorkflowEditorModel(collidingRouteHandleDefinition),
      );
      const [selection, setSelection] = useState<WorkflowEditorSelection | null>(null);

      return (
        <CanvasView
          model={model}
          selection={selection}
          disabled={false}
          onSelect={setSelection}
          onMutate={(mutate, mutateSelection) =>
            setModel((current) => {
              const next = mutate(current);
              setSelection((currentSelection) =>
                normalizeSelection(
                  next,
                  mutateSelection ? mutateSelection(currentSelection) : currentSelection,
                ),
              );
              return next;
            })
          }
        />
      );
    }

    render(<CanvasHarness />);

    await expect
      .element(page.getByRole("button", { name: "Drag success route from step c in Lane A Colon" }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", { name: "Drag success route from step b:c in Lane A Plain" }),
      )
      .toBeInTheDocument();

    await page
      .getByRole("button", { name: "Drag success route from step c in Lane A Colon" })
      .dropTo(page.getByTestId("lane-drop-a:b"));

    await vi.waitFor(() => {
      if (document.querySelector(edgeSelector(["step-on", "a:b", "c", "success", "a:b"]))) {
        return;
      }
      throw new Error(`Expected first colliding route edge. Found edges: ${edgeTestIds()}`);
    });
    expect(
      document.querySelector(edgeSelector(["step-on", "a", "b:c", "success", "a:b"])),
    ).toBeNull();

    await page
      .getByRole("button", { name: "Drag success route from step b:c in Lane A Plain" })
      .dropTo(page.getByTestId("lane-drop-a:b"));

    await vi.waitFor(() => {
      if (document.querySelector(edgeSelector(["step-on", "a", "b:c", "success", "a"]))) {
        return;
      }
      throw new Error(`Expected second colliding route edge. Found edges: ${edgeTestIds()}`);
    });
    expect(
      document.querySelector(edgeSelector(["step-on", "a:b", "c", "success", "a:b"])),
    ).not.toBeNull();
  });

  it("renders dotted action edges from a lane to its action targets", async () => {
    const actionDefinition = {
      ...definition,
      lanes: definition.lanes.map((lane) =>
        lane.key === queueLaneKey
          ? {
              ...lane,
              actions: [{ label: "Start work", to: runLaneKey, hint: "Kick off the pipeline." }],
            }
          : lane,
      ),
    } as WorkflowDefinitionEncoded;
    const [model] = [createWorkflowEditorModel(actionDefinition)];

    render(
      <div style={{ width: 1100, height: 900 }}>
        <CanvasView
          model={model}
          selection={null}
          disabled={false}
          onSelect={() => {}}
          onMutate={() => {}}
        />
      </div>,
    );

    const edge = await vi.waitFor(() => {
      const element = document.querySelector<SVGPathElement>(
        edgeSelector(["lane-action", "queue", "0", "run"]),
      );
      if (!element) {
        throw new Error("Expected queue action edge.");
      }
      return element;
    });
    expect(edge.getAttribute("data-edge-kind")).toBe("lane-action");
    expect(edge.getAttribute("stroke-dasharray")).toBe("2 4");
    await expect.element(page.getByText("Start work").first()).toBeVisible();
  });

  it("lays lanes out by routing depth and pins edges to measured anchors", async () => {
    const [model] = [createWorkflowEditorModel(definition)];

    render(
      <div style={{ width: 1100, height: 900 }}>
        <CanvasView
          model={model}
          selection={null}
          disabled={false}
          onSelect={() => {}}
          onMutate={() => {}}
        />
      </div>,
    );

    const edge = await vi.waitFor(() => {
      const element = document.querySelector<SVGPathElement>(
        edgeSelector(["lane-on", "run", "success", "done"]),
      );
      if (!element) {
        throw new Error("Expected run success lane edge.");
      }
      return element;
    });

    // Topological columns: queue and run are both roots (run's only inbound
    // edge is a back-transition), so they stack in column 0; done sits one
    // column to the right because run routes into it.
    await vi.waitFor(() => {
      const queueRect = document.getElementById("lane-queue")?.getBoundingClientRect();
      const runRect = document.getElementById("lane-run")?.getBoundingClientRect();
      const doneRect = document.getElementById("lane-done")?.getBoundingClientRect();
      if (!queueRect || !runRect || !doneRect) {
        throw new Error("Expected lane rects.");
      }
      expect(Math.abs(runRect.left - queueRect.left)).toBeLessThan(1);
      expect(runRect.top).toBeGreaterThan(queueRect.bottom);
      expect(doneRect.left).toBeGreaterThan(runRect.right);
    });

    // Forward edges enter the target lane through its facing (left) edge.
    await vi.waitFor(() => {
      const endpoint = pathEndpoint(edge.getAttribute("d") ?? "");
      const surface = document.querySelector('[data-testid="workflow-canvas-surface"]');
      const done = document.getElementById("lane-done");
      if (!surface || !done) {
        throw new Error("Expected canvas surface and done lane.");
      }
      const surfaceRect = surface.getBoundingClientRect();
      const doneRect = done.getBoundingClientRect();
      expect(Math.abs(endpoint.x - (doneRect.left - surfaceRect.left))).toBeLessThan(2);
      expect(endpoint.y).toBeGreaterThan(doneRect.top - surfaceRect.top);
      expect(endpoint.y).toBeLessThan(doneRect.bottom - surfaceRect.top);
    });
  });
});

function pathEndpoint(path: string): { x: number; y: number } {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return { x: numbers.at(-2) ?? Number.NaN, y: numbers.at(-1) ?? Number.NaN };
}

function anchorCenter(anchorId: string): { x: number; y: number } {
  const surface = document.querySelector('[data-testid="workflow-canvas-surface"]');
  const anchor = document.getElementById(anchorId);
  if (!surface || !anchor) {
    throw new Error(`Missing anchor test elements for ${anchorId}.`);
  }
  const surfaceRect = surface.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  return {
    x: anchorRect.left - surfaceRect.left + anchorRect.width / 2,
    y: anchorRect.top - surfaceRect.top + anchorRect.height / 2,
  };
}

function edgeTestIds(): string {
  return Array.from(document.querySelectorAll("svg path"))
    .map((element) => element.getAttribute("data-testid"))
    .join(", ");
}

function svgTextPositions(): Map<string, { x: string | null; y: string | null }> {
  return new Map(
    Array.from(document.querySelectorAll("svg text")).map((element) => [
      element.textContent ?? "",
      { x: element.getAttribute("x"), y: element.getAttribute("y") },
    ]),
  );
}
