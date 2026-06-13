import "../../../index.css";

import {
  BoardId,
  LaneKey,
  ProjectId,
  StepKey,
  type BoardSnapshot,
  type EnvironmentApi,
  type WorkflowBoardVersionSummary,
  type WorkflowDefinitionEncoded,
  type WorkflowGetBoardVersionResult,
  type WorkflowLintError,
  type WorkflowSaveBoardDefinitionInput,
} from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { useState } from "react";
import { render } from "vitest-browser-react";

import {
  addTransition,
  createWorkflowEditorModel,
  updateTransition,
  type WorkflowEditorModel,
} from "~/workflow/editorModel";

import { RoutingEditor, TransitionFields } from "./RoutingEditor";
import { WorkflowEditor } from "./WorkflowEditor";

const boardId = BoardId.make("project-web__delivery");
const secondBoardId = BoardId.make("project-web__support");
const projectId = ProjectId.make("project-web");
const queueLaneKey = LaneKey.make("queue");
const runLaneKey = LaneKey.make("run");
const doneLaneKey = LaneKey.make("done");
const reviewStepKey = StepKey.make("review");
const triageLaneKey = LaneKey.make("triage");
const resolvedLaneKey = LaneKey.make("resolved");

const definition = {
  name: "Delivery",
  lanes: [
    { key: queueLaneKey, name: "Queue", entry: "manual" },
    {
      key: runLaneKey,
      name: "Run",
      entry: "auto",
      pipeline: [
        {
          key: reviewStepKey,
          type: "agent",
          agent: { instance: "codex_main", model: "gpt-5.5" },
          instruction: "Review the diff.",
          captureOutput: true,
          on: { success: doneLaneKey },
        },
      ],
      transitions: [{ when: { var: "pipeline.result" }, to: doneLaneKey }],
      on: { success: doneLaneKey },
    },
    { key: doneLaneKey, name: "Done", entry: "manual", terminal: true },
  ],
} satisfies WorkflowDefinitionEncoded;

const fileBackedInstructionDefinition = {
  ...definition,
  lanes: definition.lanes.map((lane) =>
    lane.key !== runLaneKey
      ? lane
      : {
          ...lane,
          pipeline: lane.pipeline?.map((step) =>
            step.key !== reviewStepKey || step.type !== "agent"
              ? step
              : { ...step, instruction: { file: "prompts/review.md" } },
          ),
        },
  ),
} satisfies WorkflowDefinitionEncoded;

const secondDefinition = {
  name: "Support",
  lanes: [
    { key: triageLaneKey, name: "Triage", entry: "manual" },
    { key: resolvedLaneKey, name: "Resolved", entry: "manual", terminal: true },
  ],
} satisfies WorkflowDefinitionEncoded;

const snapshot = {
  projectId,
  board: {
    boardId,
    name: "Delivery Edited",
    lanes: [
      { key: queueLaneKey, name: "Queue", entry: "manual", pipelineStepCount: 0 },
      { key: runLaneKey, name: "Build", entry: "auto", pipelineStepCount: 1 },
      { key: doneLaneKey, name: "Done", entry: "manual", terminal: true, pipelineStepCount: 0 },
    ],
  },
  tickets: [],
} satisfies BoardSnapshot;

const createApi = (
  saveBoardDefinition: (input: WorkflowSaveBoardDefinitionInput) => Promise<
    | {
        readonly ok: true;
        readonly definition: WorkflowDefinitionEncoded;
        readonly versionHash: string;
        readonly snapshot: BoardSnapshot;
      }
    | { readonly ok: false; readonly lintErrors: ReadonlyArray<WorkflowLintError> }
    | { readonly ok: false; readonly conflict: true; readonly currentVersionHash: string }
  >,
  initialDefinition: WorkflowDefinitionEncoded = definition,
  history?: {
    readonly listBoardVersions?:
      | (() => Promise<ReadonlyArray<WorkflowBoardVersionSummary>>)
      | undefined;
    readonly getBoardVersion?:
      | ((input: {
          readonly boardId: BoardId;
          readonly versionId: number;
        }) => Promise<WorkflowGetBoardVersionResult>)
      | undefined;
  },
) =>
  ({
    workflow: {
      getBoardDefinition: vi.fn(async () => ({
        definition: initialDefinition,
        versionHash: "hash-before",
      })),
      saveBoardDefinition: vi.fn(saveBoardDefinition),
      listBoardVersions: vi.fn(history?.listBoardVersions ?? (async () => [])),
      getBoardVersion: vi.fn(
        history?.getBoardVersion ??
          (async () => {
            throw new Error("getBoardVersion not mocked");
          }),
      ),
    },
  }) as unknown as EnvironmentApi;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const forceTextareaInput = (label: string, value: string) => {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${CSS.escape(label)}"]`,
  );
  expect(textarea).not.toBeNull();
  if (!textarea) {
    return;
  }
  textarea.disabled = false;
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
};

const forceSelectValue = (label: string, value: string) => {
  const select = document.querySelector<HTMLSelectElement>(
    `select[aria-label="${CSS.escape(label)}"]`,
  );
  expect(select).not.toBeNull();
  if (!select) {
    return;
  }
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
};

const openFormView = async () => {
  await page.getByRole("button", { name: "Form", exact: true }).click();
  await expect
    .element(page.getByRole("button", { name: "Form", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
};

describe("WorkflowEditor", () => {
  it("defaults to canvas, toggles with shared dirty selection, and saves from canvas", async () => {
    const api = createApi(async (input) => ({
      ok: true,
      definition: input.definition,
      versionHash: "hash-after",
      snapshot,
    }));

    render(<WorkflowEditor api={api} boardId={boardId} />);

    await expect.element(page.getByRole("region", { name: "Workflow canvas" })).toBeInTheDocument();
    await expect.element(page.getByRole("group", { name: "Lane Run" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Canvas", exact: true }))
      .toHaveAttribute("aria-pressed", "true");

    await openFormView();
    await expect
      .element(page.getByRole("button", { name: "Run", exact: true }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByLabelText("Lane name").fill("Build");
    await expect.element(page.getByText("Unsaved changes")).toBeInTheDocument();

    await page.getByRole("button", { name: "Canvas", exact: true }).click();
    await expect.element(page.getByRole("group", { name: "Lane Build" })).toBeInTheDocument();
    await expect.element(page.getByLabelText("Lane name")).toHaveValue("Build");
    await page.getByLabelText("Lane name").fill("Canvas Build");

    await openFormView();
    await expect.element(page.getByLabelText("Lane name")).toHaveValue("Canvas Build");

    await page.getByRole("button", { name: "Canvas", exact: true }).click();
    await page.getByRole("button", { name: "Save workflow" }).click();

    await vi.waitFor(() => {
      expect(api.workflow.saveBoardDefinition).toHaveBeenCalledOnce();
    });
    const saveInput = vi.mocked(api.workflow.saveBoardDefinition).mock.calls[0]?.[0];
    expect(saveInput?.definition.lanes[1]?.name).toBe("Canvas Build");
    await expect.element(page.getByText("Version hash-after")).toBeInTheDocument();
  });

  it("renders TransitionFields standalone and edits one transition through model mutations", async () => {
    function TransitionHarness() {
      const [model, setModel] = useState<WorkflowEditorModel>(() =>
        updateTransition(addTransition(createWorkflowEditorModel(definition), "run"), "run", 0, {
          when: { "==": [{ var: "pipeline.result" }, "pass"] },
          to: "done",
        }),
      );
      const lane = model.definition.lanes.find((candidate) => candidate.key === runLaneKey);
      const transition = lane?.transitions?.[0];
      if (!lane || !transition) {
        return null;
      }

      return (
        <TransitionFields
          laneKey="run"
          lanes={model.definition.lanes}
          lintErrors={[]}
          transition={transition}
          transitionIndex={0}
          onMutate={(mutate) => setModel((current) => mutate(current))}
        />
      );
    }

    render(<TransitionHarness />);

    await expect
      .element(page.getByLabelText("Transition 1 predicate JSON"))
      .toHaveValue(JSON.stringify({ "==": [{ var: "pipeline.result" }, "pass"] }, null, 2));

    await page.getByLabelText("Transition 1 target lane").selectOptions("queue");
    await expect.element(page.getByLabelText("Transition 1 target lane")).toHaveValue("queue");

    const nextPredicate = JSON.stringify({ var: "ticket.priority" }, null, 2);
    await page.getByLabelText("Transition 1 predicate JSON").fill(nextPredicate);
    await expect
      .element(page.getByLabelText("Transition 1 predicate JSON"))
      .toHaveValue(nextPredicate);
  });

  it("renders duplicate transitions as independent editable rows without key collisions", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      function RoutingHarness() {
        const [model, setModel] = useState<WorkflowEditorModel>(() =>
          createWorkflowEditorModel({
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
          }),
        );
        const lane = model.definition.lanes.find((candidate) => candidate.key === runLaneKey);
        if (!lane) {
          return null;
        }

        return (
          <RoutingEditor
            lane={lane}
            lanes={model.definition.lanes}
            lintErrors={[]}
            onMutate={(mutate) => setModel((current) => mutate(current))}
          />
        );
      }

      render(<RoutingHarness />);

      const duplicateKeyWarnings = () =>
        consoleError.mock.calls.filter((call) =>
          call.some((part) => String(part).includes("Encountered two children with the same key")),
        );

      await expect
        .element(page.getByLabelText("Transition 1 predicate JSON"))
        .toHaveValue(JSON.stringify({ var: "pipeline.result" }, null, 2));
      await expect
        .element(page.getByLabelText("Transition 2 predicate JSON"))
        .toHaveValue(JSON.stringify({ var: "pipeline.result" }, null, 2));

      const nextPredicate = JSON.stringify({ var: "ticket.priority" }, null, 2);
      await page.getByLabelText("Transition 2 predicate JSON").fill(nextPredicate);

      await expect
        .element(page.getByLabelText("Transition 1 predicate JSON"))
        .toHaveValue(JSON.stringify({ var: "pipeline.result" }, null, 2));
      await expect
        .element(page.getByLabelText("Transition 2 predicate JSON"))
        .toHaveValue(nextPredicate);
      expect(duplicateKeyWarnings()).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps dirty edits when a parent rerenders with a fresh API wrapper", async () => {
    const getBoardDefinition = vi.fn(async () => ({ definition, versionHash: "hash-before" }));
    const saveBoardDefinition = vi.fn(async (input) => ({
      ok: true,
      definition: input.definition,
      versionHash: "hash-after",
      snapshot,
    }));
    const createFreshApiWrapper = () =>
      ({
        workflow: {
          getBoardDefinition,
          saveBoardDefinition,
        },
      }) as unknown as EnvironmentApi;

    const screen = await render(<WorkflowEditor api={createFreshApiWrapper()} boardId={boardId} />);

    await expect.element(page.getByRole("heading", { name: "Delivery" })).toBeInTheDocument();
    await openFormView();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByLabelText("Step review instruction").fill("Dirty review prompt.");
    await screen.rerender(<WorkflowEditor api={createFreshApiWrapper()} boardId={boardId} />);
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect
      .element(page.getByLabelText("Step review instruction"))
      .toHaveValue("Dirty review prompt.");
    await expect.element(page.getByText("Unsaved changes")).toBeInTheDocument();
    expect(getBoardDefinition).toHaveBeenCalledOnce();
  });

  it("renders, edits, saves, and clears dirty state after a successful save", async () => {
    const api = createApi(async (input) => ({
      ok: true,
      definition: input.definition,
      versionHash: "hash-after",
      snapshot,
    }));
    const onSaved = vi.fn();

    render(<WorkflowEditor api={api} boardId={boardId} onSaved={onSaved} />);

    await expect.element(page.getByRole("heading", { name: "Delivery" })).toBeInTheDocument();
    await openFormView();
    await expect
      .element(page.getByRole("button", { name: "Run", exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("review", { exact: true })).toBeInTheDocument();

    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByLabelText("Lane name").fill("Build");
    await expect.element(page.getByText("Unsaved changes")).toBeInTheDocument();
    await page.getByLabelText("Step review instruction").fill("Updated review prompt.");
    await expect.element(page.getByLabelText("Step review success route")).toHaveValue("done");
    await page.getByRole("button", { name: "Save workflow" }).click();

    await vi.waitFor(() => {
      expect(api.workflow.saveBoardDefinition).toHaveBeenCalledOnce();
    });
    const saveInput = vi.mocked(api.workflow.saveBoardDefinition).mock.calls[0]?.[0];
    expect(saveInput?.boardId).toBe(boardId);
    expect(saveInput?.expectedVersionHash).toBe("hash-before");
    expect(saveInput?.definition.lanes[1]?.name).toBe("Build");
    const savedStep = saveInput?.definition.lanes[1]?.pipeline?.[0];
    expect(savedStep?.type).toBe("agent");
    if (savedStep?.type === "agent") {
      expect(savedStep.instruction).toBe("Updated review prompt.");
      expect(savedStep.on?.success).toBe("done");
    }
    await expect.element(page.getByText("Unsaved changes")).not.toBeInTheDocument();
    await vi.waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(snapshot);
    });
  });

  it("lists history, diffs a selected version, and saves a revert through the editor", async () => {
    const oldDefinition = {
      name: "Delivery v1",
      lanes: [
        { key: queueLaneKey, name: "Queue", entry: "manual" },
        { key: doneLaneKey, name: "Done", entry: "manual", terminal: true },
      ],
    } satisfies WorkflowDefinitionEncoded;
    const versions = [
      {
        versionId: 3,
        versionHash: "hash-current",
        source: "save",
        createdAt: "2026-06-08T12:10:00.000Z",
        isCurrent: true,
      },
      {
        versionId: 2,
        versionHash: "hash-old",
        source: "save",
        createdAt: "2026-06-08T12:05:00.000Z",
        isCurrent: false,
      },
    ] satisfies WorkflowBoardVersionSummary[];
    const api = createApi(
      async (input) => ({
        ok: true,
        definition: input.definition,
        versionHash: "hash-revert",
        snapshot,
      }),
      definition,
      {
        listBoardVersions: async () => versions,
        getBoardVersion: async (input) => ({
          versionId: input.versionId,
          definition: oldDefinition,
          versionHash: "hash-old",
          source: "save",
          createdAt: "2026-06-08T12:05:00.000Z",
        }),
      },
    );

    render(<WorkflowEditor api={api} boardId={boardId} />);

    await expect.element(page.getByRole("heading", { name: "Delivery" })).toBeInTheDocument();
    await page.getByRole("button", { name: "History" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Version history" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Version 3 current save" }))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Revert version 3" })).toBeDisabled();

    await page.getByRole("button", { name: "Version 2 save" }).click();
    await expect.element(page.getByText('-   "name": "Delivery v1"')).toBeInTheDocument();
    await expect.element(page.getByText('+   "name": "Delivery"')).toBeInTheDocument();
    await page.getByRole("button", { name: "Revert version 2" }).click();

    await expect.element(page.getByRole("heading", { name: "Delivery v1" })).toBeInTheDocument();
    await expect.element(page.getByText("Reverting to v2")).toBeInTheDocument();
    await expect.element(page.getByText("Unsaved changes")).toBeInTheDocument();

    await page.getByRole("button", { name: "Save workflow" }).click();
    await vi.waitFor(() => {
      expect(api.workflow.saveBoardDefinition).toHaveBeenCalledOnce();
    });
    const saveInput = vi.mocked(api.workflow.saveBoardDefinition).mock.calls[0]?.[0];
    expect(saveInput?.expectedVersionHash).toBe("hash-before");
    expect(saveInput?.source).toBe("revert");
    expect(saveInput?.definition.name).toBe("Delivery v1");
  });

  it("disables reverting versions while unsaved edits are present", async () => {
    const oldDefinition = {
      name: "Delivery v1",
      lanes: [
        { key: queueLaneKey, name: "Queue", entry: "manual" },
        { key: doneLaneKey, name: "Done", entry: "manual", terminal: true },
      ],
    } satisfies WorkflowDefinitionEncoded;
    const versions = [
      {
        versionId: 3,
        versionHash: "hash-current",
        source: "save",
        createdAt: "2026-06-08T12:10:00.000Z",
        isCurrent: true,
      },
      {
        versionId: 2,
        versionHash: "hash-old",
        source: "save",
        createdAt: "2026-06-08T12:05:00.000Z",
        isCurrent: false,
      },
    ] satisfies WorkflowBoardVersionSummary[];
    const api = createApi(
      async (input) => ({
        ok: true,
        definition: input.definition,
        versionHash: "hash-revert",
        snapshot,
      }),
      definition,
      {
        listBoardVersions: async () => versions,
        getBoardVersion: async (input) => ({
          versionId: input.versionId,
          definition: oldDefinition,
          versionHash: "hash-old",
          source: "save",
          createdAt: "2026-06-08T12:05:00.000Z",
        }),
      },
    );

    render(<WorkflowEditor api={api} boardId={boardId} />);

    await expect.element(page.getByRole("heading", { name: "Delivery" })).toBeInTheDocument();
    await openFormView();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByLabelText("Lane name").fill("Dirty Run");
    await expect.element(page.getByText("Unsaved changes")).toBeInTheDocument();

    await page.getByRole("button", { name: "History" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Version history" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Save or discard changes before reverting."))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Revert version 2" })).toBeDisabled();
  });

  it("does not apply an in-flight revert after newer edits make the editor dirty", async () => {
    const oldDefinition = {
      name: "Delivery v1",
      lanes: [
        { key: queueLaneKey, name: "Queue", entry: "manual" },
        { key: doneLaneKey, name: "Done", entry: "manual", terminal: true },
      ],
    } satisfies WorkflowDefinitionEncoded;
    const versions = [
      {
        versionId: 3,
        versionHash: "hash-current",
        source: "save",
        createdAt: "2026-06-08T12:10:00.000Z",
        isCurrent: true,
      },
      {
        versionId: 2,
        versionHash: "hash-old",
        source: "save",
        createdAt: "2026-06-08T12:05:00.000Z",
        isCurrent: false,
      },
    ] satisfies WorkflowBoardVersionSummary[];
    const versionResult = deferred<WorkflowGetBoardVersionResult>();
    const api = createApi(
      async (input) => ({
        ok: true,
        definition: input.definition,
        versionHash: "hash-revert",
        snapshot,
      }),
      definition,
      {
        listBoardVersions: async () => versions,
        getBoardVersion: () => versionResult.promise,
      },
    );

    render(<WorkflowEditor api={api} boardId={boardId} />);

    await expect.element(page.getByRole("heading", { name: "Delivery" })).toBeInTheDocument();
    await page.getByRole("button", { name: "History" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Version history" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Revert version 2" }).click();
    await vi.waitFor(() => {
      expect(api.workflow.getBoardVersion).toHaveBeenCalledOnce();
    });

    await openFormView();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByLabelText("Lane name").fill("Dirty Run");
    await expect.element(page.getByText("Unsaved changes")).toBeInTheDocument();

    versionResult.resolve({
      versionId: 2,
      definition: oldDefinition,
      versionHash: "hash-old",
      source: "save",
      createdAt: "2026-06-08T12:05:00.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect.element(page.getByLabelText("Lane name")).toHaveValue("Dirty Run");
    await expect
      .element(page.getByRole("heading", { name: "Version history" }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Reverting to v2")).not.toBeInTheDocument();
    expect(api.workflow.saveBoardDefinition).not.toHaveBeenCalled();
  });

  it("does not apply an in-flight revert after the editor changes boards", async () => {
    const oldDefinition = {
      name: "Delivery v1",
      lanes: [
        { key: queueLaneKey, name: "Queue", entry: "manual" },
        { key: doneLaneKey, name: "Done", entry: "manual", terminal: true },
      ],
    } satisfies WorkflowDefinitionEncoded;
    const versions = [
      {
        versionId: 3,
        versionHash: "hash-current",
        source: "save",
        createdAt: "2026-06-08T12:10:00.000Z",
        isCurrent: true,
      },
      {
        versionId: 2,
        versionHash: "hash-old",
        source: "save",
        createdAt: "2026-06-08T12:05:00.000Z",
        isCurrent: false,
      },
    ] satisfies WorkflowBoardVersionSummary[];
    const versionResult = deferred<WorkflowGetBoardVersionResult>();
    const api = {
      workflow: {
        getBoardDefinition: vi.fn(async (input: { readonly boardId: BoardId }) =>
          input.boardId === secondBoardId
            ? { definition: secondDefinition, versionHash: "hash-support" }
            : { definition, versionHash: "hash-before" },
        ),
        saveBoardDefinition: vi.fn(async (input: WorkflowSaveBoardDefinitionInput) => ({
          ok: true,
          definition: input.definition,
          versionHash: "hash-after",
          snapshot,
        })),
        listBoardVersions: vi.fn(async () => versions),
        getBoardVersion: vi.fn(() => versionResult.promise),
      },
    } as unknown as EnvironmentApi;

    const screen = await render(<WorkflowEditor api={api} boardId={boardId} />);

    await expect.element(page.getByRole("heading", { name: "Delivery" })).toBeInTheDocument();
    await page.getByRole("button", { name: "History" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Version history" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Revert version 2" }).click();
    await vi.waitFor(() => {
      expect(api.workflow.getBoardVersion).toHaveBeenCalledOnce();
    });

    await screen.rerender(<WorkflowEditor api={api} boardId={secondBoardId} />);
    await expect.element(page.getByRole("heading", { name: "Support" })).toBeInTheDocument();

    versionResult.resolve({
      versionId: 2,
      definition: oldDefinition,
      versionHash: "hash-old",
      source: "save",
      createdAt: "2026-06-08T12:05:00.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect.element(page.getByRole("heading", { name: "Support" })).toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Delivery v1" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("Reverting to v2")).not.toBeInTheDocument();
    expect(api.workflow.saveBoardDefinition).not.toHaveBeenCalled();
  });

  it("keeps newer dirty edits when an older in-flight save response returns", async () => {
    const saveResult = deferred<
      | {
          readonly ok: true;
          readonly definition: WorkflowDefinitionEncoded;
          readonly versionHash: string;
          readonly snapshot: BoardSnapshot;
        }
      | { readonly ok: false; readonly lintErrors: ReadonlyArray<WorkflowLintError> }
      | { readonly ok: false; readonly conflict: true; readonly currentVersionHash: string }
    >();
    let submittedDefinition: WorkflowDefinitionEncoded | null = null;
    const api = createApi((input) => {
      submittedDefinition = input.definition;
      return saveResult.promise;
    });

    render(<WorkflowEditor api={api} boardId={boardId} />);

    await openFormView();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByLabelText("Step review instruction").fill("Submitted review prompt.");
    await page.getByRole("button", { name: "Save workflow" }).click();

    await vi.waitFor(() => {
      expect(api.workflow.saveBoardDefinition).toHaveBeenCalledOnce();
      expect(submittedDefinition).not.toBeNull();
    });
    await expect.element(page.getByLabelText("Step review instruction")).toBeDisabled();
    await expect.element(page.getByLabelText("Lane name")).toBeDisabled();

    forceTextareaInput("Step review instruction", "Newer review prompt.");
    await expect
      .element(page.getByLabelText("Step review instruction"))
      .toHaveValue("Newer review prompt.");
    saveResult.resolve({
      ok: true,
      definition: submittedDefinition!,
      versionHash: "hash-after",
      snapshot,
    });

    await expect.element(page.getByText("Version hash-after")).toBeInTheDocument();
    await expect
      .element(page.getByLabelText("Step review instruction"))
      .toHaveValue("Newer review prompt.");
    await expect.element(page.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("does not apply an in-flight save after the editor changes boards", async () => {
    const saveResult = deferred<
      | {
          readonly ok: true;
          readonly definition: WorkflowDefinitionEncoded;
          readonly versionHash: string;
          readonly snapshot: BoardSnapshot;
        }
      | { readonly ok: false; readonly lintErrors: ReadonlyArray<WorkflowLintError> }
      | { readonly ok: false; readonly conflict: true; readonly currentVersionHash: string }
    >();
    let submittedDefinition: WorkflowDefinitionEncoded | null = null;
    const onSaved = vi.fn();
    const api = {
      workflow: {
        getBoardDefinition: vi.fn(async (input: { readonly boardId: BoardId }) =>
          input.boardId === secondBoardId
            ? { definition: secondDefinition, versionHash: "hash-support" }
            : { definition, versionHash: "hash-before" },
        ),
        saveBoardDefinition: vi.fn((input: WorkflowSaveBoardDefinitionInput) => {
          submittedDefinition = input.definition;
          return saveResult.promise;
        }),
        listBoardVersions: vi.fn(async () => []),
        getBoardVersion: vi.fn(async () => {
          throw new Error("getBoardVersion not mocked");
        }),
      },
    } as unknown as EnvironmentApi;

    const screen = await render(<WorkflowEditor api={api} boardId={boardId} onSaved={onSaved} />);

    await openFormView();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByLabelText("Step review instruction").fill("Submitted review prompt.");
    await page.getByRole("button", { name: "Save workflow" }).click();

    await vi.waitFor(() => {
      expect(api.workflow.saveBoardDefinition).toHaveBeenCalledOnce();
      expect(submittedDefinition).not.toBeNull();
    });

    await screen.rerender(<WorkflowEditor api={api} boardId={secondBoardId} onSaved={onSaved} />);
    await expect.element(page.getByRole("heading", { name: "Support" })).toBeInTheDocument();
    await expect.element(page.getByText("Version hash-support")).toBeInTheDocument();

    saveResult.resolve({
      ok: true,
      definition: submittedDefinition!,
      versionHash: "hash-after",
      snapshot,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect.element(page.getByRole("heading", { name: "Support" })).toBeInTheDocument();
    await expect.element(page.getByText("Version hash-support")).toBeInTheDocument();
    await expect.element(page.getByText("Version hash-after")).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("keeps dirty edits and offers reload when save detects a newer board version", async () => {
    const api = createApi(async () => ({
      ok: false,
      conflict: true,
      currentVersionHash: "hash-current",
    }));

    render(<WorkflowEditor api={api} boardId={boardId} />);

    await openFormView();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByLabelText("Step review instruction").fill("Conflict review prompt.");
    await page.getByRole("button", { name: "Save workflow" }).click();

    await vi.waitFor(() => {
      expect(api.workflow.saveBoardDefinition).toHaveBeenCalledOnce();
    });
    await expect
      .element(page.getByText("This board changed elsewhere. Reload to review the latest version."))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Reload workflow" })).toBeInTheDocument();
    await expect
      .element(page.getByLabelText("Step review instruction"))
      .toHaveValue("Conflict review prompt.");
    await expect.element(page.getByText("Unsaved changes")).toBeInTheDocument();
    await page.getByRole("button", { name: "Reload workflow" }).click();
    await vi.waitFor(() => {
      expect(api.workflow.getBoardDefinition).toHaveBeenCalledTimes(2);
    });
  });

  it("preserves file-backed instruction shape and switches instruction modes", async () => {
    const api = createApi(
      async (input) => ({
        ok: true,
        definition: input.definition,
        versionHash: "hash-after",
        snapshot,
      }),
      fileBackedInstructionDefinition,
    );

    render(<WorkflowEditor api={api} boardId={boardId} />);

    await openFormView();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect
      .element(page.getByLabelText("Instruction source for step review"))
      .toHaveValue("file");
    await page.getByLabelText("Instruction file for step review").fill("prompts/updated-review.md");
    await page.getByRole("button", { name: "Save workflow" }).click();

    await vi.waitFor(() => {
      expect(api.workflow.saveBoardDefinition).toHaveBeenCalledOnce();
    });
    const fileSaveInput = vi.mocked(api.workflow.saveBoardDefinition).mock.calls[0]?.[0];
    const fileSavedStep = fileSaveInput?.definition.lanes[1]?.pipeline?.[0];
    expect(fileSavedStep?.type).toBe("agent");
    if (fileSavedStep?.type === "agent") {
      expect(fileSavedStep.instruction).toEqual({ file: "prompts/updated-review.md" });
    }

    forceSelectValue("Instruction source for step review", "inline");
    await page.getByLabelText("Step review instruction").fill("Inline review prompt.");
    await page.getByRole("button", { name: "Save workflow" }).click();

    await vi.waitFor(() => {
      expect(api.workflow.saveBoardDefinition).toHaveBeenCalledTimes(2);
    });
    const inlineSaveInput = vi.mocked(api.workflow.saveBoardDefinition).mock.calls[1]?.[0];
    const inlineSavedStep = inlineSaveInput?.definition.lanes[1]?.pipeline?.[0];
    expect(inlineSavedStep?.type).toBe("agent");
    if (inlineSavedStep?.type === "agent") {
      expect(inlineSavedStep.instruction).toBe("Inline review prompt.");
    }
  });

  it("blocks save with field validation errors before calling the RPC", async () => {
    const api = createApi(async (input) => ({
      ok: true,
      definition: input.definition,
      versionHash: "hash-after",
      snapshot,
    }));

    render(<WorkflowEditor api={api} boardId={boardId} />);

    await openFormView();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByLabelText("Lane name").fill("");
    await page.getByRole("button", { name: "Save workflow" }).click();
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect.element(page.getByText('Lane "run" name is required.')).toBeInTheDocument();
    await expect.element(page.getByText("Unsaved changes")).toBeInTheDocument();
    expect(api.workflow.saveBoardDefinition).not.toHaveBeenCalled();
  });

  it("keeps dirty state and renders lint errors by lane, step, and transition", async () => {
    const lintErrors = [
      { code: "invalid_wip_limit", message: "Run WIP must be at least 1", laneKey: runLaneKey },
      {
        code: "unknown_provider_instance",
        message: "Provider is missing",
        laneKey: runLaneKey,
        stepKey: reviewStepKey,
      },
      {
        code: "invalid_json_logic",
        message: "Transition predicate is invalid",
        laneKey: runLaneKey,
        transitionIndex: 0,
      },
    ] satisfies WorkflowLintError[];
    const api = createApi(async () => ({ ok: false, lintErrors }));

    render(<WorkflowEditor api={api} boardId={boardId} />);

    await openFormView();
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByLabelText("Lane name").fill("Build");
    await page.getByRole("button", { name: "Save workflow" }).click();

    await expect.element(page.getByText("Run WIP must be at least 1")).toBeInTheDocument();
    await expect.element(page.getByText("Provider is missing")).toBeInTheDocument();
    await expect.element(page.getByText("Transition predicate is invalid")).toBeInTheDocument();
    await expect.element(page.getByText("Unsaved changes")).toBeInTheDocument();
  });
});
