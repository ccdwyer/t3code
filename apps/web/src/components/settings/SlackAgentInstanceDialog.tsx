import type { ModelSelection, ServerProvider, WorkflowDefinitionEncoded } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  PlusIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

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
import { Textarea } from "~/components/ui/textarea";
import type { SlackAgentWorkflowApi } from "~/workflow/useWorkflowApi";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { TraitsPicker } from "~/components/chat/TraitsPicker";
import { getCustomModelOptionsByInstance, resolveAppModelSelectionState } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { buildSlackAppManifest } from "./slackAppManifest";

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
  readonly appConfigured: boolean;
  readonly appToken: string;
  readonly botToken: string;
  readonly projectIds: ReadonlyArray<string>;
  readonly defaultProjectId: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly acknowledged: boolean;
}

export interface SlackAgentDefaultModelPickerConfig {
  readonly settings: UnifiedSettings;
  readonly serverProviders: ReadonlyArray<ServerProvider>;
}

export interface SlackAgentProjectLink {
  readonly projectId: string;
  readonly selector: string;
}

export interface SlackAgentMultiProjectTarget {
  readonly projectId: string;
  readonly projects?: ReadonlyArray<SlackAgentProjectLink>;
}

export type SlackAgentWizardStep = "identity" | "slack-app" | "tokens" | "project" | "review";

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
  { key: "slack-app", label: "Slack App" },
  { key: "tokens", label: "Tokens" },
  { key: "project", label: "Projects" },
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

export function normalizeSlackProjectSelector(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/g, "") || "project"
  );
}

export function buildSlackProjectLinks(input: {
  readonly projectIds: ReadonlyArray<string>;
  readonly projects: ReadonlyArray<SlackAgentWizardProject>;
}): ReadonlyArray<SlackAgentProjectLink> {
  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  const nextOrdinalByBase = new Map<string, number>();
  const usedSelectors = new Set<string>();
  return input.projectIds.map((projectId) => {
    const project = projectById.get(projectId);
    const baseSelector = normalizeSlackProjectSelector(project?.title ?? projectId);
    let ordinal = nextOrdinalByBase.get(baseSelector) ?? 1;
    while (true) {
      const suffix = ordinal === 1 ? "" : `-${ordinal}`;
      const selector = `${baseSelector.slice(0, 64 - suffix.length)}${suffix}`;
      ordinal += 1;
      if (usedSelectors.has(selector)) continue;
      nextOrdinalByBase.set(baseSelector, ordinal);
      usedSelectors.add(selector);
      return { projectId, selector };
    }
  });
}

export function ensureSlackDefaultProjectId(
  selectedProjectIds: ReadonlyArray<string>,
  defaultProjectId: string,
): string {
  if (selectedProjectIds.includes(defaultProjectId)) return defaultProjectId;
  return selectedProjectIds[0] ?? "";
}

export function normalizeSlackAgentTarget(target: {
  readonly projectId: string;
  readonly projects?:
    | ReadonlyArray<{
        readonly projectId: string;
        readonly selector?: string | undefined;
      }>
    | undefined;
}): {
  readonly defaultProjectId: string;
  readonly projects: ReadonlyArray<SlackAgentProjectLink>;
} {
  const normalizedProjects =
    target.projects?.map((project) => ({
      projectId: String(project.projectId),
      selector: normalizeSlackProjectSelector(project.selector ?? String(project.projectId)),
    })) ?? [];
  const projects =
    normalizedProjects.length === 0
      ? [
          {
            projectId: String(target.projectId),
            selector: String(target.projectId),
          },
        ]
      : normalizedProjects;
  return {
    defaultProjectId: projects.some((project) => project.projectId === target.projectId)
      ? String(target.projectId)
      : (projects[0]?.projectId ?? String(target.projectId)),
    projects,
  };
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
  readonly slackAppComplete: boolean;
  readonly tokensComplete: boolean;
  readonly projectComplete: boolean;
  readonly reviewComplete: boolean;
} {
  const suffix = normalizeSlackHandleSuffix(draft.handleSuffix);
  const handle = `t3_${suffix}`;
  const identityComplete =
    draft.ownerLabel.trim().length > 0 &&
    suffix.length > 0 &&
    handle.length >= 3 &&
    handle.length <= 32;
  const slackAppComplete = identityComplete && draft.appConfigured;
  const tokensComplete =
    slackAppComplete &&
    draft.appToken.trim().startsWith("xapp-") &&
    draft.botToken.trim().startsWith("xoxb-");
  const defaultProjectId = ensureSlackDefaultProjectId(draft.projectIds, draft.defaultProjectId);
  const projectComplete = tokensComplete && draft.projectIds.length > 0 && defaultProjectId !== "";
  const reviewComplete = projectComplete && draft.acknowledged;

  return {
    activeStep: !identityComplete
      ? "identity"
      : !slackAppComplete
        ? "slack-app"
        : !tokensComplete
          ? "tokens"
          : !projectComplete
            ? "project"
            : "review",
    identityComplete,
    slackAppComplete,
    tokensComplete,
    projectComplete,
    reviewComplete,
  };
}

export function buildSlackAgentCreateInput(draft: SlackAgentWizardDraft) {
  const defaultProjectId = ensureSlackDefaultProjectId(draft.projectIds, draft.defaultProjectId);
  return {
    ownerLabel: draft.ownerLabel.trim(),
    handleSuffix: normalizeSlackHandleSuffix(draft.handleSuffix),
    appToken: draft.appToken.trim(),
    botToken: draft.botToken.trim(),
    target: {
      projectId: defaultProjectId,
      projects: buildSlackProjectLinks({
        projectIds: draft.projectIds,
        projects: [],
      }),
    },
    defaultModelSelection: draft.defaultModelSelection ?? null,
    acknowledged: true,
  };
}

export function formatSlackAgentDefaultModelSelection(input: {
  readonly selection: ModelSelection | null | undefined;
  readonly modelPickerConfig?: SlackAgentDefaultModelPickerConfig | undefined;
}): string {
  if (input.selection == null) return "Project default";
  const entries = input.modelPickerConfig
    ? sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(input.modelPickerConfig.serverProviders),
          input.modelPickerConfig.settings,
        ),
      )
    : [];
  const entry = entries.find((candidate) => candidate.instanceId === input.selection?.instanceId);
  const model = entry?.models.find((candidate) => candidate.slug === input.selection?.model);
  const instanceLabel = entry?.displayName ?? String(input.selection.instanceId);
  const modelLabel = model?.shortName ?? model?.name ?? input.selection.model;
  return `${instanceLabel} · ${modelLabel}`;
}

export function SlackAgentDefaultModelControl({
  value,
  modelPickerConfig,
  disabled = false,
  onChange,
}: {
  readonly value: ModelSelection | null;
  readonly modelPickerConfig?: SlackAgentDefaultModelPickerConfig | undefined;
  readonly disabled?: boolean;
  readonly onChange: (selection: ModelSelection | null) => void;
}) {
  if (modelPickerConfig === undefined) {
    return (
      <p className="text-xs text-muted-foreground">
        Default chat model: {formatSlackAgentDefaultModelSelection({ selection: value })}
      </p>
    );
  }

  const fallbackSelection = resolveAppModelSelectionState(
    modelPickerConfig.settings,
    modelPickerConfig.serverProviders,
  );
  const activeSelection = value ?? fallbackSelection;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(modelPickerConfig.serverProviders),
      modelPickerConfig.settings,
    ),
  );
  const activeEntry = instanceEntries.find(
    (entry) => entry.instanceId === activeSelection.instanceId,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    modelPickerConfig.settings,
    modelPickerConfig.serverProviders,
    activeSelection.instanceId,
    activeSelection.model,
  );
  const useSpecificModel = value !== null;

  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2">
      <label className="flex items-start gap-2 text-sm text-foreground">
        <input
          className="mt-1"
          type="checkbox"
          checked={useSpecificModel}
          disabled={disabled}
          onChange={(event) => {
            onChange(
              event.currentTarget.checked
                ? createModelSelection(
                    fallbackSelection.instanceId,
                    fallbackSelection.model,
                    fallbackSelection.options,
                  )
                : null,
            );
          }}
        />
        <span>
          <span className="block font-medium">
            Use a specific chat model for this Slack identity
          </span>
          <span className="block text-xs text-muted-foreground">
            Off uses each selected project&apos;s default model.
          </span>
        </span>
      </label>
      {useSpecificModel ? (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <ProviderModelPicker
            activeInstanceId={activeSelection.instanceId}
            model={activeSelection.model}
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            disabled={disabled}
            compact
            triggerVariant="outline"
            triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
            triggerAriaLabel="Slack identity default chat model"
            onInstanceModelChange={(instanceId, model) => {
              onChange(createModelSelection(instanceId, model));
            }}
          />
          {activeEntry !== undefined ? (
            <TraitsPicker
              provider={activeEntry.driverKind}
              instanceId={activeEntry.instanceId}
              models={activeEntry.models}
              model={activeSelection.model}
              prompt=""
              onPromptChange={() => undefined}
              modelOptions={activeSelection.options}
              allowPromptInjectedEffort={false}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              disabled={disabled}
              onModelOptionsChange={(options) => {
                onChange(
                  createModelSelection(activeSelection.instanceId, activeSelection.model, options),
                );
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function buildSlackAgentCreateInputForProjects(
  draft: SlackAgentWizardDraft,
  projects: ReadonlyArray<SlackAgentWizardProject>,
) {
  const defaultProjectId = ensureSlackDefaultProjectId(draft.projectIds, draft.defaultProjectId);
  return {
    ...buildSlackAgentCreateInput(draft),
    target: {
      projectId: defaultProjectId,
      projects: buildSlackProjectLinks({
        projectIds: draft.projectIds,
        projects,
      }),
    },
  };
}

function stepIndex(step: SlackAgentWizardStep): number {
  return WIZARD_STEPS.findIndex((candidate) => candidate.key === step);
}

export function firstProjectTitle(
  projects: ReadonlyArray<SlackAgentWizardProject>,
  projectId: string,
) {
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
    <ol className="grid gap-2 sm:grid-cols-5">
      {WIZARD_STEPS.map((step, index) => {
        const complete =
          (step.key === "identity" && state.identityComplete) ||
          (step.key === "slack-app" && state.slackAppComplete) ||
          (step.key === "tokens" && state.tokensComplete) ||
          (step.key === "project" && state.projectComplete) ||
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
  modelPickerConfig,
  onCreated,
}: {
  readonly api: Pick<SlackAgentWorkflowApi, "createSlackAgentInstance">;
  readonly projects?: ReadonlyArray<SlackAgentWizardProject>;
  readonly modelPickerConfig?: SlackAgentDefaultModelPickerConfig | undefined;
  readonly onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [currentStep, setCurrentStep] = useState<SlackAgentWizardStep>("identity");
  const [ownerLabel, setOwnerLabel] = useState("");
  const [handleSuffix, setHandleSuffix] = useState("");
  const [appConfigured, setAppConfigured] = useState(false);
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [projectIds, setProjectIds] = useState<ReadonlyArray<string>>([]);
  const [defaultProjectId, setDefaultProjectId] = useState("");
  const [defaultModelSelection, setDefaultModelSelection] = useState<ModelSelection | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [manifestCopied, setManifestCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const draft = useMemo<SlackAgentWizardDraft>(
    () => ({
      ownerLabel,
      handleSuffix,
      appConfigured,
      appToken,
      botToken,
      projectIds,
      defaultProjectId,
      defaultModelSelection,
      acknowledged,
    }),
    [
      acknowledged,
      appConfigured,
      appToken,
      botToken,
      defaultModelSelection,
      defaultProjectId,
      handleSuffix,
      ownerLabel,
      projectIds,
    ],
  );
  const stepState = useMemo(() => getSlackAgentWizardStepState(draft), [draft]);
  const normalizedSuffix = useMemo(() => normalizeSlackHandleSuffix(handleSuffix), [handleSuffix]);
  const handle = `t3_${normalizedSuffix}`;
  const manifest = useMemo(
    () => buildSlackAppManifest({ handle, ownerLabel }),
    [handle, ownerLabel],
  );
  const defaultLinkedProjectId = ensureSlackDefaultProjectId(projectIds, defaultProjectId);
  const linkedProjectAliases = useMemo(
    () => buildSlackProjectLinks({ projectIds, projects }),
    [projectIds, projects],
  );

  const reset = () => {
    setCurrentStep("identity");
    setOwnerLabel("");
    setHandleSuffix("");
    setAppConfigured(false);
    setAppToken("");
    setBotToken("");
    setProjectIds([]);
    setDefaultProjectId("");
    setDefaultModelSelection(null);
    setAcknowledged(false);
    setManifestCopied(false);
    setSubmitError(null);
  };

  const toggleProject = (nextProjectId: string) => {
    setProjectIds((current) => {
      const next = current.includes(nextProjectId)
        ? current.filter((projectId) => projectId !== nextProjectId)
        : [...current, nextProjectId];
      setDefaultProjectId((currentDefault) => ensureSlackDefaultProjectId(next, currentDefault));
      return next;
    });
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
    (currentStep === "slack-app" && stepState.slackAppComplete) ||
    (currentStep === "tokens" && stepState.tokensComplete) ||
    (currentStep === "project" && stepState.projectComplete);

  const copyManifest = () => {
    void navigator.clipboard?.writeText(manifest).then(() => {
      setManifestCopied(true);
    });
  };

  const submit = async () => {
    if (!stepState.reviewComplete) return;
    const input = buildSlackAgentCreateInputForProjects(draft, projects) as Parameters<
      typeof api.createSlackAgentInstance
    >[0];
    setAppToken("");
    setBotToken("");
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.createSlackAgentInstance(input);
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
            Add identity
          </Button>
        }
      />
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Slack app identity</DialogTitle>
          <DialogDescription>
            Configure a per-developer Slack app identity such as @t3_chris, validate its local
            Socket Mode tokens, and link it to one or more T3 projects.
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

          {currentStep === "slack-app" ? (
            <div className="space-y-4">
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  Create a Slack app from this manifest, then install it to the workspace where the
                  bot should receive mentions and thread replies.
                </p>
                <a
                  className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                  href="https://api.slack.com/apps?new_app=1"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Slack app creation
                  <ExternalLinkIcon className="size-3.5" />
                </a>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-foreground">Slack app manifest</span>
                  <Button type="button" size="xs" variant="outline" onClick={copyManifest}>
                    <CopyIcon className="size-3.5" />
                    {manifestCopied ? "Copied" : "Copy manifest"}
                  </Button>
                </div>
                <Textarea
                  readOnly
                  rows={14}
                  value={manifest}
                  className="font-mono text-xs leading-relaxed"
                  onFocus={(event) => event.currentTarget.select()}
                />
              </div>
              <label className="flex gap-2 rounded-md border border-border px-3 py-2 text-xs text-foreground">
                <input
                  className="mt-0.5"
                  type="checkbox"
                  checked={appConfigured}
                  onChange={(event) => setAppConfigured(event.currentTarget.checked)}
                />
                <span>
                  I created the Slack app from this manifest and installed it to the target
                  workspace.
                </span>
              </label>
            </div>
          ) : null}

          {currentStep === "tokens" ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                In Slack, create an app-level token under Basic Information with the{" "}
                <code className="rounded bg-muted px-1 py-0.5">connections:write</code> scope, then
                copy its <code className="rounded bg-muted px-1 py-0.5">xapp-</code> value here.
                Copy the <code className="rounded bg-muted px-1 py-0.5">xoxb-</code> Bot User OAuth
                Token from OAuth &amp; Permissions after installing the app.
              </p>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  App-level token
                </span>
                <Input
                  type="password"
                  autoComplete="off"
                  value={appToken}
                  placeholder="xapp-..."
                  onChange={(event) => setAppToken(event.currentTarget.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-foreground">
                  Bot User OAuth Token
                </span>
                <Input
                  type="password"
                  autoComplete="off"
                  value={botToken}
                  placeholder="xoxb-..."
                  onChange={(event) => setBotToken(event.currentTarget.value)}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Tokens are submitted to the connected T3 environment for local validation and are
                cleared from this form immediately after submit.
              </p>
            </div>
          ) : null}

          {currentStep === "project" ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Map @{handle} to any registered T3 project. The first Slack mention creates a normal
                visible T3 Chat thread in the default project; later messages in the linked Slack
                thread are forwarded as new turns. Use project selectors in Slack to target another
                linked project.
              </p>
              {projects.length === 0 ? (
                <p className="rounded-md border border-border px-3 py-3 text-sm text-muted-foreground">
                  No registered projects were found in the connected environment.
                </p>
              ) : (
                <div className="grid gap-2">
                  {projects.map((project) => (
                    <label
                      key={project.id}
                      className={`rounded-md border px-3 py-2 text-left ${
                        projectIds.includes(project.id)
                          ? "border-primary bg-primary/5"
                          : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <span className="flex items-start gap-2">
                        <input
                          className="mt-1"
                          type="checkbox"
                          checked={projectIds.includes(project.id)}
                          onChange={() => toggleProject(project.id)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-foreground">
                            {project.title}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {project.workspaceRoot ?? project.id}
                          </span>
                        </span>
                        <input
                          className="mt-1"
                          type="radio"
                          name="slack-default-project"
                          aria-label={`Use ${project.title} as default`}
                          checked={defaultLinkedProjectId === project.id}
                          disabled={!projectIds.includes(project.id)}
                          onChange={() => setDefaultProjectId(project.id)}
                        />
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {linkedProjectAliases.length > 0 ? (
                <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">Linked project selectors</p>
                  <ul className="mt-1 space-y-1">
                    {linkedProjectAliases.map((project) => (
                      <li key={project.projectId}>
                        {project.projectId === defaultLinkedProjectId ? "Default: " : null}
                        {firstProjectTitle(projects, project.projectId)} · project:
                        {project.selector}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <SlackAgentDefaultModelControl
                value={defaultModelSelection}
                modelPickerConfig={modelPickerConfig}
                onChange={setDefaultModelSelection}
              />
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
                  <dt className="text-xs text-muted-foreground">Slack identity</dt>
                  <dd className="font-medium text-foreground">@{handle}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Tokens</dt>
                  <dd className="font-medium text-foreground">App-level and bot tokens ready</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Project</dt>
                  <dd className="font-medium text-foreground">
                    {firstProjectTitle(projects, defaultLinkedProjectId)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Linked projects</dt>
                  <dd className="font-medium text-foreground">{linkedProjectAliases.length}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Default chat model</dt>
                  <dd className="font-medium text-foreground">
                    {formatSlackAgentDefaultModelSelection({
                      selection: defaultModelSelection,
                      modelPickerConfig,
                    })}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Selectors</dt>
                  <dd className="font-medium text-foreground">
                    {linkedProjectAliases
                      .map((project) => `project:${project.selector}`)
                      .join(", ")}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs text-muted-foreground">Thread behavior</dt>
                  <dd className="font-medium text-foreground">
                    First mention creates a T3 Chat thread in the default project unless a selector
                    names another linked project; later Slack replies continue it.
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
                  Anyone in this Slack workspace who can mention or message the app can start model
                  turns in linked projects. When a request needs workspace changes, the agent can
                  promote it to an isolated worktree and run a full-access continuation on this
                  computer. Replies in the linked Slack thread continue the same T3 Chat thread.
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
              {submitting ? "Creating..." : "Create Slack identity"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
