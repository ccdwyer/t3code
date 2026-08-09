import {
  BotIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  PauseIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ModelSelection,
  SlackAgentDeliveryView,
  SlackAgentRunStreamEvent,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { primaryServerProvidersAtom } from "~/state/server";
import { useWorkflowApi } from "~/workflow/useWorkflowApi";
import type { SlackAgentInstanceView, SlackAgentWorkflowApi } from "~/workflow/useWorkflowApi";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  buildSlackProjectLinks,
  firstProjectTitle,
  formatSlackAgentDefaultModelSelection,
  normalizeSlackAgentTarget,
  SlackAgentDefaultModelControl,
  type SlackAgentDefaultModelPickerConfig,
  type SlackAgentMultiProjectTarget,
  SlackAgentInstanceDialog,
  type SlackAgentWizardProject,
} from "./SlackAgentInstanceDialog";
import { SlackMockThreadLab } from "./SlackMockThreadLab";

const ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";
const EMPTY_SLACK_AGENT_INSTANCES: ReadonlyArray<SlackAgentInstanceView> = [];
export interface SlackAgentSettingsProject extends SlackAgentWizardProject {
  readonly environmentId?: string;
}
const EMPTY_SLACK_AGENT_PROJECTS: ReadonlyArray<SlackAgentSettingsProject> = Object.freeze([]);

export function retryableFailedSlackDeliveryId(
  deliveries: ReadonlyArray<SlackAgentDeliveryView>,
): string | null {
  const failed = deliveries.filter((delivery) => delivery.state === "failed");
  const accepted = failed.find((delivery) => delivery.workflowSequence === 0);
  if (accepted !== undefined) return accepted.deliveryId;
  return (
    failed.reduce<SlackAgentDeliveryView | null>((newest, delivery) => {
      if (newest === null || delivery.workflowSequence > newest.workflowSequence) return delivery;
      return newest;
    }, null)?.deliveryId ?? null
  );
}

export function canDeleteSlackAgentInstance(instance: SlackAgentInstanceView): boolean {
  return !instance.enabled && instance.activeRunCount === 0 && instance.latestRun === undefined;
}

function setupLabel(instance: SlackAgentInstanceView): {
  readonly label: string;
  readonly className: string;
  readonly icon: typeof CircleCheckIcon;
} {
  if (!instance.enabled || instance.state === "disabled") {
    return {
      label: "Disabled",
      className: "border-muted-foreground/30 text-muted-foreground",
      icon: PauseIcon,
    };
  }
  if (instance.kind === "slack") {
    if (instance.connection.state === "connecting") {
      return {
        label: "Connecting",
        className: "border-sky-500/40 text-sky-700 dark:text-sky-300",
        icon: CircleAlertIcon,
      };
    }
    if (instance.connection.state === "error") {
      return {
        label: "Error",
        className: "border-destructive/50 text-destructive",
        icon: CircleAlertIcon,
      };
    }
    if (instance.connection.state === "disconnected") {
      return {
        label: "Disconnected",
        className: "border-amber-500/40 text-amber-700 dark:text-amber-300",
        icon: CircleAlertIcon,
      };
    }
    if (!instance.credentialsConfigured) {
      return {
        label: "Needs credentials",
        className: "border-amber-500/40 text-amber-700 dark:text-amber-300",
        icon: CircleAlertIcon,
      };
    }
  }
  if (
    instance.state === "enabled" &&
    instance.validation.valid &&
    (instance.kind !== "slack" ||
      (instance.credentialsConfigured && instance.connection.state === "connected"))
  ) {
    return {
      label: "Ready",
      className: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
      icon: CircleCheckIcon,
    };
  }
  return {
    label: "Needs setup",
    className: "border-amber-500/40 text-amber-700 dark:text-amber-300",
    icon: CircleAlertIcon,
  };
}

function diagnosticPath(instance: SlackAgentInstanceView): string {
  return instance.validation.path?.join(" / ") ?? instance.target.projectId;
}

function setupReason(instance: SlackAgentInstanceView): string | null {
  if (instance.state !== "needs_setup" && instance.validation.valid) return null;
  if (instance.kind === "slack" && !instance.credentialsConfigured) {
    return "Reconnect this Slack identity's app-level and bot tokens.";
  }
  return (
    instance.validation.reason ?? "The selected project is not available for this Slack identity."
  );
}

function workspaceLabel(instance: SlackAgentInstanceView): string {
  return instance.workspace.name ?? instance.workspace.workspaceId;
}

function connectionStateLabel(instance: SlackAgentInstanceView): string {
  if (!instance.enabled || instance.state === "disabled") return "Disabled";
  if (instance.kind !== "slack") return "Developer test connection";
  switch (instance.connection.state) {
    case "connected":
      return instance.connection.connectedAt === undefined
        ? "Socket connected"
        : `Socket connected since ${new Date(instance.connection.connectedAt).toLocaleString()}`;
    case "connecting":
      return "Connecting to Socket Mode";
    case "error":
      return instance.connection.lastError === undefined
        ? "Connection error"
        : `Connection error: ${instance.connection.lastError}`;
    case "disconnected":
      return "Disconnected";
  }
}

function tokenStatusLabel(instance: SlackAgentInstanceView): string {
  return instance.credentialsConfigured ? "Credentials configured" : "Credentials required";
}

export function buildSlackAgentEditTarget(input: {
  readonly projectIds: ReadonlyArray<string>;
  readonly defaultProjectId: string;
  readonly projects: ReadonlyArray<SlackAgentSettingsProject>;
}): SlackAgentMultiProjectTarget | null {
  const projectId = input.projectIds.includes(input.defaultProjectId)
    ? input.defaultProjectId
    : (input.projectIds[0] ?? "");
  if (projectId === "") return null;
  return {
    projectId,
    projects: buildSlackProjectLinks({
      projectIds: input.projectIds,
      projects: input.projects,
    }),
  };
}

export function selectSlackAgentDefaultProject(input: {
  readonly projectIds: ReadonlyArray<string>;
  readonly defaultProjectId: string;
}): { readonly projectIds: ReadonlyArray<string>; readonly defaultProjectId: string } {
  return {
    projectIds: input.projectIds.includes(input.defaultProjectId)
      ? input.projectIds
      : [...input.projectIds, input.defaultProjectId],
    defaultProjectId: input.defaultProjectId,
  };
}

function EditDefaultsDialog({
  instance,
  projects,
  modelPickerConfig,
  disabled,
  onSave,
}: {
  readonly instance: SlackAgentInstanceView;
  readonly projects: ReadonlyArray<SlackAgentSettingsProject>;
  readonly modelPickerConfig?: SlackAgentDefaultModelPickerConfig | undefined;
  readonly disabled: boolean;
  readonly onSave: (input: {
    readonly target: SlackAgentMultiProjectTarget;
    readonly defaultModelSelection: ModelSelection | null;
  }) => Promise<void>;
}) {
  const normalizedTarget = normalizeSlackAgentTarget(instance.target);
  const initialDefaultModelSelection = instance.defaultModelSelection;
  const [open, setOpen] = useState(false);
  const [projectIds, setProjectIds] = useState<ReadonlyArray<string>>(
    normalizedTarget.projects.map((project) => project.projectId),
  );
  const [defaultProjectId, setDefaultProjectId] = useState<string>(
    normalizedTarget.defaultProjectId,
  );
  const [defaultModelSelection, setDefaultModelSelection] = useState<ModelSelection | null>(
    initialDefaultModelSelection,
  );
  const [submitting, setSubmitting] = useState(false);
  const target = buildSlackAgentEditTarget({ projectIds, defaultProjectId, projects });
  const linkedProjects = target?.projects ?? [];
  const resolvedDefaultProjectId = target?.projectId ?? "";
  const canSave = target !== null;

  const reset = () => {
    setProjectIds(normalizedTarget.projects.map((project) => project.projectId));
    setDefaultProjectId(normalizedTarget.defaultProjectId);
    setDefaultModelSelection(initialDefaultModelSelection);
  };

  const toggleProject = (projectId: string) => {
    setProjectIds((current) => {
      const next = current.includes(projectId)
        ? current.filter((candidate) => candidate !== projectId)
        : [...current, projectId];
      setDefaultProjectId((currentDefault) =>
        next.includes(currentDefault) ? currentDefault : (next[0] ?? ""),
      );
      return next;
    });
  };

  const selectDefaultProject = (projectId: string) => {
    setProjectIds(
      (current) =>
        selectSlackAgentDefaultProject({ projectIds: current, defaultProjectId: projectId })
          .projectIds,
    );
    setDefaultProjectId(projectId);
  };

  const submit = async () => {
    if (target === null) return;
    setSubmitting(true);
    try {
      await onSave({ target, defaultModelSelection });
      setOpen(false);
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
      <DialogTrigger render={<Button size="xs" variant="outline" disabled={disabled} />}>
        Edit defaults
      </DialogTrigger>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Slack agent defaults</DialogTitle>
          <DialogDescription>
            Change where new Slack chats start and which model they use. Existing linked chats keep
            their current project and model.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-2 rounded-md border border-border px-3 py-3">
            <div>
              <p className="text-sm font-medium text-foreground">Default project</p>
              <p className="text-xs text-muted-foreground">
                New Slack chats start here unless the message includes a project selector.
              </p>
            </div>
            <Select
              value={resolvedDefaultProjectId}
              onValueChange={(value) => {
                if (typeof value === "string") selectDefaultProject(value);
              }}
            >
              <SelectTrigger aria-label="Default Slack agent project" disabled={submitting}>
                <SelectValue>{firstProjectTitle(projects, resolvedDefaultProjectId)}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{project.title}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {project.workspaceRoot ?? project.id}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <div className="space-y-2">
            <div>
              <p className="text-sm font-medium text-foreground">Default chat model</p>
              <p className="text-xs text-muted-foreground">
                Applies to new Slack-linked chats. Existing chats stay on their current model.
              </p>
            </div>
            <SlackAgentDefaultModelControl
              value={defaultModelSelection}
              modelPickerConfig={modelPickerConfig}
              disabled={submitting}
              onChange={setDefaultModelSelection}
            />
          </div>
          <div className="space-y-2 border-t border-border pt-4">
            <div>
              <p className="text-sm font-medium text-foreground">Linked projects</p>
              <p className="text-xs text-muted-foreground">
                Optional projects people can target with a project selector in Slack.
              </p>
            </div>
            {projects.map((project) => (
              <label
                key={project.id}
                className={`block rounded-md border px-3 py-2 ${
                  projectIds.includes(project.id) ? "border-primary bg-primary/5" : "border-border"
                }`}
              >
                <span className="flex items-start gap-2">
                  <input
                    className="mt-1"
                    type="checkbox"
                    checked={projectIds.includes(project.id)}
                    disabled={submitting}
                    onChange={() => toggleProject(project.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {project.title}
                      {resolvedDefaultProjectId === project.id ? (
                        <span className="ml-2 text-xs font-normal text-primary">Default</span>
                      ) : null}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {project.workspaceRoot ?? project.id}
                    </span>
                  </span>
                </span>
              </label>
            ))}
            {linkedProjects.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Aliases:{" "}
                {linkedProjects
                  .map(
                    (project) =>
                      `${firstProjectTitle(projects, project.projectId)} project:${project.selector}`,
                  )
                  .join(", ")}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose render={<Button variant="outline" disabled={submitting} />}>
            Cancel
          </DialogClose>
          <Button disabled={!canSave || submitting} onClick={() => void submit()}>
            {submitting ? "Saving..." : "Save defaults"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RotateTokensDialog({
  disabled,
  onSave,
}: {
  readonly disabled: boolean;
  readonly onSave: (tokens: {
    readonly appToken: string;
    readonly botToken: string;
  }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const valid = appToken.trim().startsWith("xapp-") && botToken.trim().startsWith("xoxb-");
  const reset = () => {
    setAppToken("");
    setBotToken("");
  };
  const submit = async () => {
    if (!valid) return;
    const tokens = { appToken: appToken.trim(), botToken: botToken.trim() };
    reset();
    setSubmitting(true);
    try {
      await onSave(tokens);
      setOpen(false);
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
      <DialogTrigger render={<Button size="xs" variant="outline" disabled={disabled} />}>
        Rotate/reconnect tokens
      </DialogTrigger>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rotate or reconnect Slack tokens</DialogTitle>
          <DialogDescription>
            Paste a fresh app-level xapp token and Bot User OAuth xoxb token. Values are cleared
            from this form immediately after submit.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              App-level token
            </span>
            <Input
              type="password"
              autoComplete="off"
              value={appToken}
              placeholder="xapp-..."
              disabled={submitting}
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
              disabled={submitting}
              onChange={(event) => setBotToken(event.currentTarget.value)}
            />
          </label>
        </DialogPanel>
        <DialogFooter variant="bare">
          <DialogClose render={<Button variant="outline" disabled={submitting} />}>
            Cancel
          </DialogClose>
          <Button disabled={!valid || submitting} onClick={() => void submit()}>
            {submitting ? "Saving..." : "Save tokens"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function InstanceRow({
  instance,
  api,
  projects,
  modelPickerConfig,
  onChanged,
}: {
  readonly instance: SlackAgentInstanceView;
  readonly api: SlackAgentWorkflowApi;
  readonly projects: ReadonlyArray<SlackAgentSettingsProject>;
  readonly modelPickerConfig?: SlackAgentDefaultModelPickerConfig | undefined;
  readonly onChanged: () => void;
}) {
  const setup = setupLabel(instance);
  const SetupIcon = setup.icon;
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [failedDeliveryId, setFailedDeliveryId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let streamObserved = false;
    const deliveriesById = new Map<string, SlackAgentDeliveryView>();
    const showRetryableFailure = () => {
      setFailedDeliveryId(retryableFailedSlackDeliveryId([...deliveriesById.values()]));
    };
    const replaceDeliveries = (deliveries: ReadonlyArray<SlackAgentDeliveryView>) => {
      deliveriesById.clear();
      for (const delivery of deliveries) deliveriesById.set(delivery.deliveryId, delivery);
      showRetryableFailure();
    };
    const runId = instance.latestRun?.runId;
    if (runId === undefined) {
      setFailedDeliveryId(null);
      return () => {
        active = false;
      };
    }
    setFailedDeliveryId(null);
    const unsubscribe = api.subscribeSlackAgentRun({ runId }, (event: SlackAgentRunStreamEvent) => {
      if (!active) return;
      streamObserved = true;
      if (event.type === "snapshot") {
        replaceDeliveries(event.run.deliveries);
        return;
      }
      if (event.delivery === undefined) return;
      deliveriesById.set(event.delivery.deliveryId, event.delivery);
      showRetryableFailure();
    });
    void api
      .getSlackAgentRun({ runId })
      .then((detail) => {
        if (!active || streamObserved) return;
        replaceDeliveries(detail.deliveries);
      })
      .catch(() => {
        if (active) setFailedDeliveryId(null);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api, instance.latestRun?.runId]);

  const runAction = async (name: string, action: () => Promise<unknown>) => {
    setBusyAction(name);
    setActionError(null);
    try {
      await action();
      onChanged();
    } catch (caught: unknown) {
      setActionError(caught instanceof Error ? caught.message : `Could not ${name} Slack agent.`);
    } finally {
      setBusyAction(null);
    }
  };
  const normalizedTarget = normalizeSlackAgentTarget(instance.target);
  const defaultProjectTitle = firstProjectTitle(projects, normalizedTarget.defaultProjectId);
  const otherLinkedProjects = normalizedTarget.projects.filter(
    (project) => project.projectId !== normalizedTarget.defaultProjectId,
  );
  const aliasText = normalizedTarget.projects
    .map((project) => {
      const title = firstProjectTitle(projects, project.projectId);
      const prefix = project.projectId === normalizedTarget.defaultProjectId ? "default " : "";
      return `${prefix}${title}: project:${project.selector}`;
    })
    .join(", ");
  const defaultModelSelection = instance.defaultModelSelection;
  const defaultModelLabel = formatSlackAgentDefaultModelSelection({
    selection: defaultModelSelection,
    modelPickerConfig,
  });

  return (
    <div className={ROW_CLASSNAME}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">@{instance.handle}</p>
            <span
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${setup.className}`}
            >
              <SetupIcon className="size-3" />
              {setup.label}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {instance.ownerLabel} · {workspaceLabel(instance)} · bot user {instance.botUserId}
          </p>
          <p className="text-xs text-muted-foreground">
            {normalizedTarget.projects.length} linked{" "}
            {normalizedTarget.projects.length === 1 ? "project" : "projects"} ·{" "}
            {connectionStateLabel(instance)}
          </p>
          <div className="rounded-md border border-border/70 bg-background px-3 py-2">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-xs font-medium text-foreground">Defaults for new Slack chats</p>
                <p className="mt-1 text-xs text-muted-foreground">Project: {defaultProjectTitle}</p>
                <p className="text-xs text-muted-foreground">Model: {defaultModelLabel}</p>
              </div>
              <EditDefaultsDialog
                instance={instance}
                projects={projects}
                modelPickerConfig={modelPickerConfig}
                disabled={busyAction !== null || projects.length === 0}
                onSave={({ target, defaultModelSelection }) =>
                  runAction("edit defaults", () =>
                    api.updateSlackAgentInstance({
                      instanceId: instance.instanceId,
                      target,
                      defaultModelSelection,
                    } as Parameters<typeof api.updateSlackAgentInstance>[0]),
                  )
                }
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{tokenStatusLabel(instance)}</p>
          <p className="text-xs text-muted-foreground">
            Diagnostic path: {diagnosticPath(instance)}
          </p>
          {setupReason(instance) !== null ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">{setupReason(instance)}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Active runs: {instance.activeRunCount} · Most recent:{" "}
            {instance.latestRun?.state ?? "none"}
          </p>
          {instance.latestRun?.ticketId ? (
            <span className="text-xs text-muted-foreground">
              Ticket {instance.latestRun.ticketId}
            </span>
          ) : null}
          {instance.latestRun?.prUrl ? (
            <a
              className="ml-3 text-xs text-primary underline-offset-2 hover:underline"
              href={instance.latestRun.prUrl}
            >
              PR
            </a>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {instance.kind === "slack" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busyAction !== null || !instance.credentialsConfigured}
              onClick={() =>
                void runAction("test", () =>
                  api.testSlackAgentConnection({ instanceId: instance.instanceId }),
                )
              }
            >
              Test
            </Button>
          ) : null}
          {instance.kind === "slack" ? (
            <RotateTokensDialog
              disabled={busyAction !== null}
              onSave={(tokens) =>
                runAction("reconnect", () =>
                  api.connectSlackAgentInstance({
                    instanceId: instance.instanceId,
                    appToken: tokens.appToken,
                    botToken: tokens.botToken,
                  }),
                )
              }
            />
          ) : null}
          {instance.enabled ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busyAction !== null}
              onClick={() =>
                void runAction("disable", () =>
                  api.disableSlackAgentInstance({ instanceId: instance.instanceId }),
                )
              }
            >
              <PauseIcon className="size-3.5" />
              Disable
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={busyAction !== null}
              onClick={() =>
                void runAction("enable", () =>
                  api.enableSlackAgentInstance({ instanceId: instance.instanceId }),
                )
              }
            >
              <PlayIcon className="size-3.5" />
              Enable
            </Button>
          )}
          {failedDeliveryId !== null ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busyAction !== null}
              onClick={() =>
                void runAction("retry", () =>
                  api.retrySlackAgentDelivery({ deliveryId: failedDeliveryId as never }),
                )
              }
            >
              Retry status
            </Button>
          ) : null}
          {instance.kind === "slack" && instance.credentialsConfigured ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busyAction !== null}
              onClick={() =>
                void runAction("disconnect", () =>
                  api.disconnectSlackAgentInstance({ instanceId: instance.instanceId }),
                )
              }
            >
              Disconnect
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={busyAction !== null || !canDeleteSlackAgentInstance(instance)}
            onClick={() =>
              void runAction("delete", () =>
                api.deleteSlackAgentInstance({ instanceId: instance.instanceId }),
              )
            }
          >
            <Trash2Icon className="size-3.5" />
            Delete
          </Button>
        </div>
      </div>
      <div className="mt-3 rounded-md border border-border/70 bg-background px-3 py-2 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Channel instructions</p>
        <p className="mt-1">
          Invite @{instance.handle} to a Slack channel, mention it in a thread to create a T3 Chat
          thread in {defaultProjectTitle}, then reply in that Slack thread to send follow-up turns.
          {defaultModelSelection === null
            ? " New chat threads use the target project's default model."
            : ` New chat threads use ${defaultModelLabel}.`}{" "}
          Omit a selector to use the default project
          {otherLinkedProjects.length > 0
            ? `, or include project:<alias> for another linked project. Linked aliases: ${aliasText}.`
            : "."}{" "}
          For private channels, invite the app before mentioning it.
        </p>
        <a
          className="mt-2 inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
          href="https://api.slack.com/apps"
          target="_blank"
          rel="noreferrer"
        >
          Open Slack apps
          <ExternalLinkIcon className="size-3" />
        </a>
      </div>
      {actionError !== null ? <p className="mt-3 text-xs text-destructive">{actionError}</p> : null}
    </div>
  );
}

export function SlackAgentInstancesPanel({
  api,
  initialInstances = EMPTY_SLACK_AGENT_INSTANCES,
  environmentId,
  projects = EMPTY_SLACK_AGENT_PROJECTS,
  modelPickerConfig,
  worktreeRetentionConfig,
}: {
  readonly api: SlackAgentWorkflowApi;
  readonly initialInstances?: ReadonlyArray<SlackAgentInstanceView>;
  readonly environmentId?: string;
  readonly projects?: ReadonlyArray<SlackAgentSettingsProject>;
  readonly modelPickerConfig?: SlackAgentDefaultModelPickerConfig | undefined;
  readonly worktreeRetentionConfig?:
    | {
        readonly days: number | null;
        readonly onChange: (days: number | null) => void;
      }
    | undefined;
}) {
  const [instances, setInstances] = useState<ReadonlyArray<SlackAgentInstanceView> | null>(
    initialInstances,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    void api
      .listSlackAgentInstances({})
      .then((result) => setInstances(result.instances))
      .catch((caught: unknown) => {
        setLoadError(caught instanceof Error ? caught.message : "Could not load Slack agents.");
        setInstances([]);
      });
  }, [api]);

  useEffect(() => {
    load();
    const poll = window.setInterval(load, 5_000);
    return () => window.clearInterval(poll);
  }, [load]);

  const loadedInstances = instances ?? [];
  const environmentProjects =
    environmentId === undefined
      ? projects
      : projects.filter((project) => project.environmentId === environmentId);

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="slack-agents"
        title="Slack Agents"
        icon={<BotIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <SlackAgentInstanceDialog
            api={api}
            projects={environmentProjects}
            modelPickerConfig={modelPickerConfig}
            onCreated={load}
          />
        }
      >
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3 sm:px-5">
            <p className="text-sm font-medium text-foreground">Personal Slack app identities</p>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              Configure per-developer Slack apps that connect to T3 through Socket Mode and map each
              app identity to a project.
            </p>
          </div>
          {instances === null ? (
            <div className={ROW_CLASSNAME}>
              <Spinner className="size-4" />
            </div>
          ) : loadedInstances.length === 0 ? (
            <div className={ROW_CLASSNAME}>
              <p className="text-sm font-medium text-foreground">No Slack identities yet</p>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Create a per-developer Slack app such as @t3_chris, paste its local Socket Mode
                tokens, and choose the project where Slack mentions create T3 Chat threads.
              </p>
            </div>
          ) : (
            loadedInstances.map((instance) => (
              <InstanceRow
                key={instance.instanceId}
                instance={instance}
                api={api}
                projects={environmentProjects}
                modelPickerConfig={modelPickerConfig}
                onChanged={load}
              />
            ))
          )}
        </div>
        {loadError !== null ? <p className="px-4 text-sm text-destructive">{loadError}</p> : null}
      </SettingsSection>
      {worktreeRetentionConfig !== undefined ? (
        <SettingsSection title="Worktree cleanup">
          <div className="rounded-lg border border-border bg-card px-4 py-4 sm:px-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="max-w-2xl">
                <p className="text-sm font-medium text-foreground">
                  Clean inactive Slack checkouts
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  T3 removes only clean, inactive worktree checkouts. The chat branch is kept and
                  recreated automatically when work resumes; dirty or in-use checkouts are never
                  removed.
                </p>
              </div>
              <Select
                value={
                  worktreeRetentionConfig.days === null
                    ? "never"
                    : String(worktreeRetentionConfig.days)
                }
                onValueChange={(value) => {
                  if (value === "never") worktreeRetentionConfig.onChange(null);
                  else if (typeof value === "string") {
                    worktreeRetentionConfig.onChange(Number(value));
                  }
                }}
              >
                <SelectTrigger className="w-40" aria-label="Slack worktree retention">
                  <SelectValue>
                    {worktreeRetentionConfig.days === null
                      ? "Never"
                      : `${worktreeRetentionConfig.days} days`}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {[7, 14, 30, 90].map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {days} days
                    </SelectItem>
                  ))}
                  <SelectItem value="never">Never</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          </div>
        </SettingsSection>
      ) : null}
      {import.meta.env.DEV ? (
        <SettingsSection title="Developer testing">
          <details className="space-y-3 px-3 sm:px-4">
            <summary className="cursor-pointer text-sm font-medium text-foreground">
              Mock Thread Lab
            </summary>
            <SlackMockThreadLab
              api={api}
              instances={loadedInstances}
              projects={environmentProjects}
              onRunCreated={load}
              {...(environmentId === undefined ? {} : { environmentId })}
            />
          </details>
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

export function SlackAgentInstancesSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <p className="px-4 py-6 text-sm text-muted-foreground">
          Connect to an environment before managing Slack app identities.
        </p>
      </SettingsPageContainer>
    );
  }

  return <SlackAgentInstancesConnected environmentId={environmentId} projects={projects} />;
}

function SlackAgentInstancesConnected({
  environmentId,
  projects,
}: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<SlackAgentSettingsProject>;
}) {
  const api = useWorkflowApi(environmentId) as unknown as SlackAgentWorkflowApi;
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  return (
    <SlackAgentInstancesPanel
      api={api}
      environmentId={environmentId}
      projects={projects}
      modelPickerConfig={{ settings, serverProviders }}
      worktreeRetentionConfig={{
        days: settings.slackWorktreeRetentionDays,
        onChange: (days) => updateSettings({ slackWorktreeRetentionDays: days }),
      }}
    />
  );
}
