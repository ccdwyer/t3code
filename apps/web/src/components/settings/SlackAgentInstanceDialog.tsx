import type { BoardListEntry, WorkflowDefinitionEncoded } from "@t3tools/contracts";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import type { SlackAgentWorkflowApi } from "~/workflow/useWorkflowApi";

export interface SlackAgentWizardProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot?: string;
}

export interface SlackAgentWizardBoard {
  readonly boardId: string;
  readonly name: string;
  readonly error: string | null;
}

export interface SlackAgentWizardDraft {
  readonly ownerLabel: string;
  readonly handleSuffix: string;
  readonly projectId: string;
  readonly boardId: string;
  readonly initialLane: string;
  readonly acknowledged: boolean;
}

export type SlackAgentWizardStep = "identity" | "project" | "target" | "review";

export interface SlackAgentInitialLaneTarget {
  readonly laneKey: string;
  readonly laneName: string;
  readonly path: ReadonlyArray<string>;
  readonly pathLabel: string;
}

const WIZARD_STEPS: ReadonlyArray<{
  readonly key: SlackAgentWizardStep;
  readonly label: string;
}> = [
  { key: "identity", label: "Identity" },
  { key: "project", label: "Project" },
  { key: "target", label: "Workflow target" },
  { key: "review", label: "Review" },
];

const EMPTY_BOARDS: ReadonlyArray<SlackAgentWizardBoard> = Object.freeze([]);
const EMPTY_TARGETS: ReadonlyArray<SlackAgentInitialLaneTarget> = Object.freeze([]);
const EMPTY_PROJECTS: ReadonlyArray<SlackAgentWizardProject> = Object.freeze([]);

export function normalizeSlackHandleSuffix(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@?t3_/, "")
    .replace(/[^a-z0-9_]/g, "");
}

function traceSlackAgentLaneTarget(
  definition: WorkflowDefinitionEncoded,
  initialLaneKey: string,
): SlackAgentInitialLaneTarget | null {
  const lanes = new Map(definition.lanes.map((lane) => [String(lane.key), lane]));
  const initial = lanes.get(initialLaneKey);
  if (initial === undefined || initial.entry !== "auto") return null;

  const visited = new Set<string>();
  const path: string[] = [];
  let current = initial;
  let agentStepSeen = false;

  while (current !== undefined) {
    const laneKey = String(current.key);
    if (visited.has(laneKey)) return null;
    visited.add(laneKey);
    path.push(laneKey);

    if (current.entry !== "auto" || current.terminal === true) return null;

    for (const step of current.pipeline ?? []) {
      if (step.type === "agent") {
        agentStepSeen = true;
      }
      if (step.type === "pullRequest" && step.action === "open") {
        if (!agentStepSeen) return null;
        return {
          laneKey: initialLaneKey,
          laneName: initial.name,
          path,
          pathLabel: path
            .map((key) => {
              const lane = lanes.get(key);
              return lane?.name ?? key;
            })
            .join(" / "),
        };
      }
    }

    const nextTarget = current.on?.success;
    if (nextTarget === undefined || typeof nextTarget !== "string") return null;
    const nextLane = lanes.get(nextTarget);
    if (nextLane === undefined) return null;
    current = nextLane;
  }

  return null;
}

export function getSlackAgentInitialLaneTargets(
  definition: WorkflowDefinitionEncoded | null,
): ReadonlyArray<SlackAgentInitialLaneTarget> {
  if (definition === null) return EMPTY_TARGETS;
  return definition.lanes.flatMap((lane) => {
    const target = traceSlackAgentLaneTarget(definition, String(lane.key));
    return target === null ? [] : [target];
  });
}

export function getAvailableSlackAgentBoards(
  projectId: string,
  boardsByProject: ReadonlyMap<string, ReadonlyArray<SlackAgentWizardBoard>>,
): ReadonlyArray<SlackAgentWizardBoard> {
  if (projectId.trim().length === 0) return EMPTY_BOARDS;
  return (boardsByProject.get(projectId) ?? EMPTY_BOARDS).filter((board) => board.error === null);
}

export function getSlackAgentWizardStepState(draft: SlackAgentWizardDraft): {
  readonly activeStep: SlackAgentWizardStep;
  readonly identityComplete: boolean;
  readonly projectComplete: boolean;
  readonly targetComplete: boolean;
  readonly reviewComplete: boolean;
} {
  const suffix = normalizeSlackHandleSuffix(draft.handleSuffix);
  const handle = `t3_${suffix}`;
  const identityComplete =
    draft.ownerLabel.trim().length > 0 &&
    suffix.length > 0 &&
    handle.length >= 3 &&
    handle.length <= 32;
  const projectComplete = identityComplete && draft.projectId.trim().length > 0;
  const targetComplete =
    projectComplete && draft.boardId.trim().length > 0 && draft.initialLane.trim().length > 0;
  const reviewComplete = targetComplete && draft.acknowledged;

  return {
    activeStep: !identityComplete
      ? "identity"
      : !projectComplete
        ? "project"
        : !targetComplete
          ? "target"
          : "review",
    identityComplete,
    projectComplete,
    targetComplete,
    reviewComplete,
  };
}

export function buildSlackAgentCreateInput(draft: SlackAgentWizardDraft) {
  return {
    ownerLabel: draft.ownerLabel.trim(),
    handleSuffix: normalizeSlackHandleSuffix(draft.handleSuffix),
    target: {
      projectId: draft.projectId.trim(),
      boardId: draft.boardId.trim(),
      initialLane: draft.initialLane.trim(),
    },
    acknowledged: true,
  };
}

function coerceBoard(entry: BoardListEntry): SlackAgentWizardBoard {
  return {
    boardId: String(entry.boardId),
    name: entry.name,
    error: entry.error,
  };
}

function stepIndex(step: SlackAgentWizardStep): number {
  return WIZARD_STEPS.findIndex((candidate) => candidate.key === step);
}

function firstProjectTitle(projects: ReadonlyArray<SlackAgentWizardProject>, projectId: string) {
  return projects.find((project) => project.id === projectId)?.title ?? projectId;
}

function StepHeader({
  currentStep,
  state,
  onStep,
}: {
  readonly currentStep: SlackAgentWizardStep;
  readonly state: ReturnType<typeof getSlackAgentWizardStepState>;
  readonly onStep: (step: SlackAgentWizardStep) => void;
}) {
  const maxReachable = stepIndex(state.activeStep);
  return (
    <ol className="grid gap-2 sm:grid-cols-4">
      {WIZARD_STEPS.map((step, index) => {
        const complete =
          (step.key === "identity" && state.identityComplete) ||
          (step.key === "project" && state.projectComplete) ||
          (step.key === "target" && state.targetComplete) ||
          (step.key === "review" && state.reviewComplete);
        const reachable = index <= maxReachable;
        return (
          <li key={step.key}>
            <button
              className={`flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left text-xs ${
                currentStep === step.key
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-border text-muted-foreground"
              }`}
              type="button"
              disabled={!reachable}
              onClick={() => onStep(step.key)}
            >
              <span className="grid size-5 place-items-center rounded-full border border-current text-[11px]">
                {complete ? <CheckIcon className="size-3" /> : index + 1}
              </span>
              <span className="min-w-0 truncate">{step.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function SlackAgentInstanceDialog({
  api,
  projects = EMPTY_PROJECTS,
  onCreated,
}: {
  readonly api: Pick<
    SlackAgentWorkflowApi,
    "createSlackAgentInstance" | "listBoards" | "getBoardDefinition"
  >;
  readonly projects?: ReadonlyArray<SlackAgentWizardProject>;
  readonly onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<SlackAgentWizardStep>("identity");
  const [ownerLabel, setOwnerLabel] = useState("");
  const [handleSuffix, setHandleSuffix] = useState("");
  const [projectId, setProjectId] = useState("");
  const [boardId, setBoardId] = useState("");
  const [initialLane, setInitialLane] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [boardsByProject, setBoardsByProject] = useState<
    ReadonlyMap<string, ReadonlyArray<SlackAgentWizardBoard>>
  >(new Map());
  const [boardDefinitions, setBoardDefinitions] = useState<
    ReadonlyMap<string, WorkflowDefinitionEncoded>
  >(new Map());
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [definitionLoading, setDefinitionLoading] = useState(false);
  const [targetLoadError, setTargetLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const draft = useMemo<SlackAgentWizardDraft>(
    () => ({
      ownerLabel,
      handleSuffix,
      projectId,
      boardId,
      initialLane,
      acknowledged,
    }),
    [acknowledged, boardId, handleSuffix, initialLane, ownerLabel, projectId],
  );
  const stepState = useMemo(() => getSlackAgentWizardStepState(draft), [draft]);
  const normalizedSuffix = useMemo(() => normalizeSlackHandleSuffix(handleSuffix), [handleSuffix]);
  const handle = `t3_${normalizedSuffix}`;
  const availableBoards = useMemo(
    () => getAvailableSlackAgentBoards(projectId, boardsByProject),
    [boardsByProject, projectId],
  );
  const selectedBoardDefinition = boardId.trim().length > 0 ? boardDefinitions.get(boardId) : null;
  const laneTargets = useMemo(
    () => getSlackAgentInitialLaneTargets(selectedBoardDefinition ?? null),
    [selectedBoardDefinition],
  );
  const selectedLaneTarget = laneTargets.find((target) => target.laneKey === initialLane) ?? null;
  const selectedBoardName =
    availableBoards.find((board) => board.boardId === boardId)?.name ?? boardId;

  useEffect(() => {
    if (!open || projectId.trim().length === 0 || boardsByProject.has(projectId)) return;
    let active = true;
    setBoardsLoading(true);
    setTargetLoadError(null);
    void api
      .listBoards({ projectId } as Parameters<typeof api.listBoards>[0])
      .then((entries) => {
        if (!active) return;
        setBoardsByProject((current) => {
          const next = new Map(current);
          next.set(projectId, entries.map(coerceBoard));
          return next;
        });
      })
      .catch((caught: unknown) => {
        if (active) {
          setTargetLoadError(caught instanceof Error ? caught.message : "Could not load boards.");
        }
      })
      .finally(() => {
        if (active) setBoardsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, boardsByProject, open, projectId]);

  useEffect(() => {
    if (!open || boardId.trim().length === 0 || boardDefinitions.has(boardId)) return;
    let active = true;
    setDefinitionLoading(true);
    setTargetLoadError(null);
    void api
      .getBoardDefinition({ boardId } as Parameters<typeof api.getBoardDefinition>[0])
      .then((result) => {
        if (!active) return;
        setBoardDefinitions((current) => {
          const next = new Map(current);
          next.set(boardId, result.definition);
          return next;
        });
      })
      .catch((caught: unknown) => {
        if (active) {
          setTargetLoadError(
            caught instanceof Error ? caught.message : "Could not load board definition.",
          );
        }
      })
      .finally(() => {
        if (active) setDefinitionLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, boardDefinitions, boardId, open]);

  useEffect(() => {
    if (boardId.trim().length === 0) return;
    if (laneTargets.length === 0) {
      if (initialLane.length > 0) setInitialLane("");
      return;
    }
    if (!laneTargets.some((target) => target.laneKey === initialLane)) {
      setInitialLane(laneTargets[0]?.laneKey ?? "");
    }
  }, [boardId, initialLane, laneTargets]);

  const reset = () => {
    setCurrentStep("identity");
    setOwnerLabel("");
    setHandleSuffix("");
    setProjectId("");
    setBoardId("");
    setInitialLane("");
    setAcknowledged(false);
    setBoardsByProject(new Map());
    setBoardDefinitions(new Map());
    setTargetLoadError(null);
    setSubmitError(null);
  };

  const chooseProject = (nextProjectId: string) => {
    setProjectId(nextProjectId);
    setBoardId("");
    setInitialLane("");
    setTargetLoadError(null);
  };

  const chooseBoard = (nextBoardId: string) => {
    setBoardId(nextBoardId);
    setInitialLane("");
    setTargetLoadError(null);
  };

  const goNext = () => {
    const index = stepIndex(currentStep);
    const next = WIZARD_STEPS[index + 1]?.key;
    if (next !== undefined) setCurrentStep(next);
  };

  const goBack = () => {
    const index = stepIndex(currentStep);
    const previous = WIZARD_STEPS[index - 1]?.key;
    if (previous !== undefined) setCurrentStep(previous);
  };

  const canGoNext =
    (currentStep === "identity" && stepState.identityComplete) ||
    (currentStep === "project" && stepState.projectComplete) ||
    (currentStep === "target" && stepState.targetComplete);

  const submit = async () => {
    if (!stepState.reviewComplete) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.createSlackAgentInstance(
        buildSlackAgentCreateInput(draft) as Parameters<typeof api.createSlackAgentInstance>[0],
      );
      reset();
      setOpen(false);
      onCreated();
    } catch (caught: unknown) {
      setSubmitError(caught instanceof Error ? caught.message : "Could not create Slack agent.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button size="xs">
            <PlusIcon className="size-3.5" />
            Add mock bot
          </Button>
        }
      />
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Slack agent mock</DialogTitle>
          <DialogDescription>
            Create a local mock bot identity. This does not connect to slack.com or store Slack
            credentials.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <StepHeader currentStep={currentStep} state={stepState} onStep={setCurrentStep} />

          {currentStep === "identity" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  Owner label
                </span>
                <Input
                  value={ownerLabel}
                  placeholder="Chris"
                  onChange={(event) => setOwnerLabel(event.currentTarget.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  @t3_ handle
                </span>
                <Input
                  value={handleSuffix}
                  placeholder="chris"
                  onChange={(event) => setHandleSuffix(event.currentTarget.value)}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">Preview: @{handle}</p>
              </label>
            </div>
          ) : null}

          {currentStep === "project" ? (
            <div className="space-y-3">
              {projects.length === 0 ? (
                <p className="rounded-md border border-border px-3 py-3 text-sm text-muted-foreground">
                  No registered projects were found in the connected environment.
                </p>
              ) : (
                <div className="grid gap-2">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      className={`rounded-md border px-3 py-2 text-left ${
                        projectId === project.id
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-muted/50"
                      }`}
                      type="button"
                      onClick={() => chooseProject(project.id)}
                    >
                      <span className="block text-sm font-medium text-foreground">
                        {project.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {project.workspaceRoot ?? project.id}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {currentStep === "target" ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-foreground">
                    Workflow board
                  </span>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                    value={boardId}
                    disabled={boardsLoading || availableBoards.length === 0}
                    onChange={(event) => chooseBoard(event.currentTarget.value)}
                  >
                    <option value="">Choose board</option>
                    {availableBoards.map((board) => (
                      <option key={board.boardId} value={board.boardId}>
                        {board.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-foreground">
                    Initial lane/path
                  </span>
                  <select
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                    value={initialLane}
                    disabled={definitionLoading || laneTargets.length === 0}
                    onChange={(event) => setInitialLane(event.currentTarget.value)}
                  >
                    <option value="">Choose lane</option>
                    {laneTargets.map((target) => (
                      <option key={target.laneKey} value={target.laneKey}>
                        {target.pathLabel}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {boardsLoading || definitionLoading ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="size-3.5" />
                  Loading workflow target options...
                </p>
              ) : null}
              {targetLoadError !== null ? (
                <p className="text-sm text-destructive">{targetLoadError}</p>
              ) : null}
              {projectId !== "" && !boardsLoading && availableBoards.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No readable workflow boards were found for{" "}
                  {firstProjectTitle(projects, projectId)}.
                </p>
              ) : null}
              {boardId !== "" && !definitionLoading && laneTargets.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This board has no automatic lane whose success path runs an agent before opening a
                  pull request.
                </p>
              ) : null}
            </div>
          ) : null}

          {currentStep === "review" ? (
            <div className="space-y-4">
              <dl className="grid gap-3 rounded-md border border-border px-3 py-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">Owner</dt>
                  <dd className="font-medium text-foreground">{ownerLabel.trim()}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Handle</dt>
                  <dd className="font-medium text-foreground">@{handle}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Project</dt>
                  <dd className="font-medium text-foreground">
                    {firstProjectTitle(projects, projectId)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Board</dt>
                  <dd className="font-medium text-foreground">{selectedBoardName}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Automatic path</dt>
                  <dd className="font-medium text-foreground">
                    {selectedLaneTarget?.pathLabel ?? initialLane}
                  </dd>
                </div>
              </dl>
              <label className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-foreground">
                <input
                  className="mt-0.5"
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.currentTarget.checked)}
                />
                <span>
                  People represented in the mock workspace can start an agent that changes code and
                  opens a pull request in this project. This is a mock-only Slack setup.
                </span>
              </label>
            </div>
          ) : null}

          {submitError !== null ? <p className="text-sm text-destructive">{submitError}</p> : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose render={<Button variant="outline" disabled={submitting} />}>
            Cancel
          </DialogClose>
          {currentStep !== "identity" ? (
            <Button variant="outline" disabled={submitting} onClick={goBack}>
              <ChevronLeftIcon className="size-3.5" />
              Back
            </Button>
          ) : null}
          {currentStep !== "review" ? (
            <Button disabled={!canGoNext || submitting} onClick={goNext}>
              Next
              <ChevronRightIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              disabled={!stepState.reviewComplete || submitting}
              onClick={() => void submit()}
            >
              {submitting ? "Creating..." : "Create mock bot"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
