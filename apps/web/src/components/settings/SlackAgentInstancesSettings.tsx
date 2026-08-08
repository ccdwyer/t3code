import {
  BotIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  PauseIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";
import type {
  EnvironmentId,
  SlackAgentDeliveryView,
  SlackAgentRunStreamEvent,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useWorkflowApi } from "~/workflow/useWorkflowApi";
import type { SlackAgentInstanceView, SlackAgentWorkflowApi } from "~/workflow/useWorkflowApi";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  normalizeSlackHandleSuffix,
  SlackAgentInstanceDialog,
  type SlackAgentWizardProject,
} from "./SlackAgentInstanceDialog";
import { SlackMockThreadLab } from "./SlackMockThreadLab";

const ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";
const EMPTY_SLACK_AGENT_INSTANCES: ReadonlyArray<SlackAgentInstanceView> = [];
interface SlackAgentSettingsProject extends SlackAgentWizardProject {
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
  if (instance.state === "enabled" && instance.validation.valid) {
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
  return (
    instance.validation.path?.join(" / ") ??
    `${instance.target.boardId} / ${instance.target.initialLane}`
  );
}

function setupReason(instance: SlackAgentInstanceView): string | null {
  if (instance.state !== "needs_setup" && instance.validation.valid) return null;
  return (
    instance.validation.reason ??
    "The selected board no longer has a valid automatic path to Open PR."
  );
}

function InstanceRow({
  instance,
  api,
  onChanged,
}: {
  readonly instance: SlackAgentInstanceView;
  readonly api: SlackAgentWorkflowApi;
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
  const rename = () => {
    const next = window.prompt("New handle suffix", instance.handle.replace(/^t3_/, ""));
    if (next === null) return;
    const handleSuffix = normalizeSlackHandleSuffix(next);
    if (handleSuffix.length === 0) return;
    void runAction("rename", () =>
      api.updateSlackAgentInstance({
        instanceId: instance.instanceId,
        handleSuffix,
      } as Parameters<typeof api.updateSlackAgentInstance>[0]),
    );
  };

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
            <span className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              Mock
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {instance.ownerLabel} · bot user {instance.botUserId}
          </p>
          <p className="text-xs text-muted-foreground">
            {instance.target.projectId} / {instance.target.boardId} / {instance.target.initialLane}
          </p>
          <p className="text-xs text-muted-foreground">
            Diagnostic path before save: {diagnosticPath(instance)}
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
          {instance.enabled ? (
            <>
              <Button size="xs" variant="outline" disabled={busyAction !== null} onClick={rename}>
                Rename
              </Button>
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
            </>
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
              Re-enable
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
      {actionError !== null ? <p className="mt-3 text-xs text-destructive">{actionError}</p> : null}
    </div>
  );
}

export function SlackAgentInstancesPanel({
  api,
  initialInstances = EMPTY_SLACK_AGENT_INSTANCES,
  environmentId,
  projects = EMPTY_SLACK_AGENT_PROJECTS,
}: {
  readonly api: SlackAgentWorkflowApi;
  readonly initialInstances?: ReadonlyArray<SlackAgentInstanceView>;
  readonly environmentId?: string;
  readonly projects?: ReadonlyArray<SlackAgentSettingsProject>;
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
  }, [load]);

  const loadedInstances = instances ?? [];

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="slack-agents"
        title="Slack Agents"
        icon={<BotIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <SlackAgentInstanceDialog
            api={api}
            projects={
              environmentId === undefined
                ? projects
                : projects.filter((project) => project.environmentId === environmentId)
            }
            onCreated={load}
          />
        }
      >
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3 sm:px-5">
            <p className="text-sm font-medium text-foreground">Personal Slack agents · Mock</p>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              Local deterministic Slack-shaped testing only. This page does not connect to
              slack.com, OAuth, Socket Mode, or the Slack Web API.
            </p>
          </div>
          {instances === null ? (
            <div className={ROW_CLASSNAME}>
              <Spinner className="size-4" />
            </div>
          ) : loadedInstances.length === 0 ? (
            <div className={ROW_CLASSNAME}>
              <p className="text-sm font-medium text-foreground">No mock Slack agents yet</p>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Create a personal mock bot such as @t3_chris after choosing a workflow board with an
                automatic agent path that reaches Open PR.
              </p>
            </div>
          ) : (
            loadedInstances.map((instance) => (
              <InstanceRow
                key={instance.instanceId}
                instance={instance}
                api={api}
                onChanged={load}
              />
            ))
          )}
        </div>
        {loadError !== null ? <p className="px-4 text-sm text-destructive">{loadError}</p> : null}
      </SettingsSection>
      <SlackMockThreadLab
        api={api}
        instances={loadedInstances}
        onRunCreated={load}
        {...(environmentId === undefined ? {} : { environmentId })}
      />
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
          Connect to an environment before managing mock Slack agents.
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
  const api = useWorkflowApi(environmentId);
  return <SlackAgentInstancesPanel api={api} environmentId={environmentId} projects={projects} />;
}
