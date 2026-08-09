import {
  type BoardListEntry,
  BoardId,
  MOCK_SLACK_WORKSPACE_ID,
  type MockSlackThreadStreamEvent,
  type SlackAgentRunStreamEvent,
  ProjectId,
  type WorkflowDefinitionEncoded,
} from "@t3tools/contracts";
import { PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import type {
  SlackAgentInstanceView,
  SlackAgentMockMessageDraft,
  SlackAgentWorkflowApi,
} from "~/workflow/useWorkflowApi";
import {
  getAvailableSlackAgentBoards,
  getSlackAgentInitialLaneTargets,
  normalizeSlackHandleSuffix,
  type SlackAgentInitialLaneTarget,
  type SlackAgentWizardBoard,
  type SlackAgentWizardProject,
} from "./SlackAgentInstanceDialog";

const MAX_MOCK_MESSAGES = 500;
const MAX_CANONICAL_SNAPSHOT_BYTES = 1024 * 1024;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function encodeMockThreadKey(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function makeMessageDraft(index: number): SlackAgentMockMessageDraft {
  return {
    messageId: `msg-${index + 1}`,
    authorLabel: index === 0 ? "Chris" : "Teammate",
    text: index === 0 ? "Can @t3_chris help with this thread?" : "",
    attachments: [],
  };
}

type MockInvocationMode = "chat" | "workflow";

export interface MockSlackAgentIdentityDraft {
  readonly ownerLabel: string;
  readonly handleSuffix: string;
  readonly projectId: string;
  readonly acknowledged: boolean;
}

export interface SlackMockWorkflowInvocationDraft {
  readonly mode: "workflow";
  readonly target: {
    readonly boardId: string;
    readonly initialLane: string;
  };
}

function coerceBoard(entry: BoardListEntry): SlackAgentWizardBoard {
  return {
    boardId: String(entry.boardId),
    name: entry.name,
    error: entry.error,
  };
}

export function buildMockMentionInput(input: {
  readonly instanceId: string;
  readonly messages: ReadonlyArray<SlackAgentMockMessageDraft>;
  readonly triggerMessageIndex: number;
  readonly threadKey?: string;
  readonly threadTs?: string;
  readonly externalEventId?: string;
  readonly invocation?: { readonly mode: "chat" } | SlackMockWorkflowInvocationDraft;
}): {
  readonly input: Parameters<SlackAgentWorkflowApi["simulateSlackMention"]>[0] | null;
  readonly error: string | null;
} {
  const messages = input.messages.map((message, index) => ({
    messageId: message.messageId.trim() || `msg-${index + 1}`,
    ts: `${index + 1}.000000`,
    authorUserId: `U_MOCK_${index + 1}`,
    authorLabel: message.authorLabel.trim() || "Mock user",
    text: message.text,
    attachments: (message.attachments ?? []).map((attachment, attachmentIndex) => ({
      id: attachment.id?.trim() || `att-${index + 1}-${attachmentIndex + 1}`,
      filename: attachment.filename?.trim() || "attachment.txt",
      mediaType: attachment.mediaType?.trim() || "text/plain",
      sizeBytes: attachment.sizeBytes ?? 0,
      permalink: attachment.permalink?.trim() || "https://mock.slack.local/attachment",
    })),
  }));

  if (messages.length < 1) {
    return { input: null, error: "Add at least one chronological message." };
  }
  if (messages.length > MAX_MOCK_MESSAGES) {
    return { input: null, error: "Mock Slack threads are limited to 500 messages." };
  }
  if (new Set(messages.map((message) => message.messageId)).size !== messages.length) {
    return { input: null, error: "Every mock Slack source message needs a unique message id." };
  }
  if (input.triggerMessageIndex < 0 || input.triggerMessageIndex >= messages.length) {
    return { input: null, error: "Choose a triggering message in the thread." };
  }

  const threadKey = input.threadKey?.trim();
  const explicitThreadToken = threadKey ? encodeMockThreadKey(threadKey) : null;
  const externalEventId = input.externalEventId?.trim();
  const triggerMessage = messages[input.triggerMessageIndex]!;
  const output = {
    instanceId: input.instanceId,
    thread: {
      workspaceId: MOCK_SLACK_WORKSPACE_ID,
      channelId: explicitThreadToken === null ? "C_MOCK" : `C_MOCK_${explicitThreadToken}`,
      channelName: "mock-thread-lab",
      threadTs: explicitThreadToken === null ? (input.threadTs ?? "1.000000") : "1.000000",
      ...(threadKey ? { threadKey } : {}),
    },
    messages,
    triggerMessageId: triggerMessage.messageId,
    ...(externalEventId ? { externalEventId } : {}),
    ...(input.invocation === undefined || input.invocation.mode === "chat"
      ? {}
      : { invocation: input.invocation }),
  };
  const canonicalBytes = utf8ByteLength(
    JSON.stringify({
      workspaceId: output.thread.workspaceId,
      channelId: output.thread.channelId,
      channelName: output.thread.channelName,
      threadTs: output.thread.threadTs,
      triggerEventId: externalEventId ?? "mock-event-00000000-0000-0000-0000-000000000000",
      triggerTs: triggerMessage.ts,
      triggerMessageId: triggerMessage.messageId,
      messages,
    }),
  );
  if (canonicalBytes > MAX_CANONICAL_SNAPSHOT_BYTES) {
    return { input: null, error: "Mock Slack thread snapshots are limited to 1 MiB." };
  }

  return {
    input: output as unknown as Parameters<SlackAgentWorkflowApi["simulateSlackMention"]>[0],
    error: null,
  };
}

function instanceLabel(instance: SlackAgentInstanceView): string {
  return `@${instance.handle}`;
}

function instanceProjectId(instance: SlackAgentInstanceView | undefined): string {
  return instance?.target.projectId ?? "";
}

export function getRunnableMockSlackAgentInstances(
  instances: ReadonlyArray<SlackAgentInstanceView>,
): ReadonlyArray<SlackAgentInstanceView> {
  return instances.filter(
    (instance) =>
      instance.kind === "mock" &&
      instance.enabled &&
      instance.state === "enabled" &&
      instance.validation.valid,
  );
}

export function buildMockSlackAgentCreateInput(input: MockSlackAgentIdentityDraft): {
  readonly input: Parameters<SlackAgentWorkflowApi["createMockSlackAgentInstance"]>[0] | null;
  readonly error: string | null;
} {
  const ownerLabel = input.ownerLabel.trim();
  const handleSuffix = normalizeSlackHandleSuffix(input.handleSuffix);
  const projectId = input.projectId.trim();
  if (ownerLabel.length === 0) {
    return { input: null, error: "Enter an owner label for the mock identity." };
  }
  if (handleSuffix.length === 0 || `t3_${handleSuffix}`.length > 32) {
    return { input: null, error: "Enter a t3_ handle suffix that fits Slack limits." };
  }
  if (projectId.length === 0) {
    return { input: null, error: "Choose a project for the mock identity." };
  }
  if (!input.acknowledged) {
    return { input: null, error: "Confirm that this mock identity can start T3 turns." };
  }

  return {
    input: {
      ownerLabel,
      handleSuffix,
      target: { projectId },
      acknowledged: true,
    } as Parameters<SlackAgentWorkflowApi["createMockSlackAgentInstance"]>[0],
    error: null,
  };
}

function chatThreadUrl(environmentId: string | undefined, threadId: string | undefined) {
  if (environmentId === undefined || threadId === undefined || threadId.length === 0) {
    return undefined;
  }
  return `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

export function buildMockInvocation(input: {
  readonly mode: MockInvocationMode;
  readonly boardId: string;
  readonly initialLane: string;
  readonly laneTargets: ReadonlyArray<SlackAgentInitialLaneTarget>;
}): {
  readonly input: { readonly mode: "chat" } | SlackMockWorkflowInvocationDraft | undefined;
  readonly error: string | null;
} {
  if (input.mode === "chat") {
    return { input: undefined, error: null };
  }

  const boardId = input.boardId.trim();
  const initialLane = input.initialLane.trim();
  if (boardId.length === 0) {
    return { input: undefined, error: "Choose a workflow board." };
  }
  if (!input.laneTargets.some((target) => target.laneKey === initialLane)) {
    return { input: undefined, error: "Choose a valid workflow initial lane." };
  }

  return {
    input: {
      mode: "workflow",
      target: {
        boardId,
        initialLane,
      },
    },
    error: null,
  };
}

export function SlackMockThreadLab({
  api,
  instances,
  projects,
  onRunCreated,
  environmentId,
}: {
  readonly api: Pick<
    SlackAgentWorkflowApi,
    | "createMockSlackAgentInstance"
    | "simulateSlackMention"
    | "subscribeSlackAgentRun"
    | "subscribeMockSlackThread"
    | "listBoards"
    | "getBoardDefinition"
  >;
  readonly instances: ReadonlyArray<SlackAgentInstanceView>;
  readonly projects: ReadonlyArray<SlackAgentWizardProject>;
  readonly onRunCreated: () => void;
  readonly environmentId?: string;
}) {
  const runnableInstances = useMemo(
    () => getRunnableMockSlackAgentInstances(instances),
    [instances],
  );
  const [instanceId, setInstanceId] = useState(() => runnableInstances[0]?.instanceId ?? "");
  const [mockOwnerLabel, setMockOwnerLabel] = useState("");
  const [mockHandleSuffix, setMockHandleSuffix] = useState("");
  const [mockProjectId, setMockProjectId] = useState(() => projects[0]?.id ?? "");
  const [mockAcknowledged, setMockAcknowledged] = useState(false);
  const [creatingMock, setCreatingMock] = useState(false);
  const [mockCreateError, setMockCreateError] = useState<string | null>(null);
  const selectedInstanceId = runnableInstances.some(
    (instance) => instance.instanceId === instanceId,
  )
    ? instanceId
    : (runnableInstances[0]?.instanceId ?? "");
  const [messages, setMessages] = useState<ReadonlyArray<SlackAgentMockMessageDraft>>([
    makeMessageDraft(0),
  ]);
  const [triggerMessageIndex, setTriggerMessageIndex] = useState(0);
  const [threadKey, setThreadKey] = useState("");
  const [externalEventId, setExternalEventId] = useState("");
  const [invocationMode, setInvocationMode] = useState<MockInvocationMode>("chat");
  const [boardId, setBoardId] = useState("");
  const [initialLane, setInitialLane] = useState("");
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
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    readonly mode?: "chat" | "workflow";
    readonly threadId?: string;
    readonly chatUrl?: string;
    readonly createdThread?: boolean;
    readonly ticketId?: string;
    readonly ticketUrl?: string;
    readonly pullRequestUrl?: string;
    readonly replyText?: string;
  } | null>(null);
  const subscriptionTeardowns = useRef<ReadonlyArray<() => void>>([]);
  const nextMessageIndex = useRef(1);
  const selectedInstance = runnableInstances.find(
    (instance) => instance.instanceId === selectedInstanceId,
  );
  const selectedProjectId = instanceProjectId(selectedInstance);
  const availableBoards = useMemo(
    () => getAvailableSlackAgentBoards(selectedProjectId, boardsByProject),
    [boardsByProject, selectedProjectId],
  );
  const selectedBoardDefinition = boardId.trim().length > 0 ? boardDefinitions.get(boardId) : null;
  const laneTargets = useMemo(
    () => getSlackAgentInitialLaneTargets(selectedBoardDefinition ?? null),
    [selectedBoardDefinition],
  );

  const stopSubscriptions = () => {
    for (const teardown of subscriptionTeardowns.current) teardown();
    subscriptionTeardowns.current = [];
  };

  useEffect(
    () => () => {
      for (const teardown of subscriptionTeardowns.current) teardown();
    },
    [],
  );

  useEffect(() => {
    if (projects.length === 0) {
      if (mockProjectId !== "") setMockProjectId("");
      return;
    }
    if (!projects.some((project) => project.id === mockProjectId)) {
      setMockProjectId(projects[0]?.id ?? "");
    }
  }, [mockProjectId, projects]);

  useEffect(() => {
    if (selectedInstanceId === instanceId || selectedInstanceId === "") return;
    setInstanceId(selectedInstanceId);
  }, [instanceId, selectedInstanceId]);

  useEffect(() => {
    setBoardId("");
    setInitialLane("");
    setTargetLoadError(null);
  }, [selectedProjectId]);

  useEffect(() => {
    if (
      invocationMode !== "workflow" ||
      selectedProjectId.length === 0 ||
      boardsByProject.has(selectedProjectId)
    ) {
      return;
    }
    let active = true;
    setBoardsLoading(true);
    setTargetLoadError(null);
    void api
      .listBoards({ projectId: ProjectId.make(selectedProjectId) })
      .then((entries) => {
        if (!active) return;
        setBoardsByProject((current) => {
          const next = new Map(current);
          next.set(selectedProjectId, entries.map(coerceBoard));
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
  }, [api, boardsByProject, invocationMode, selectedProjectId]);

  useEffect(() => {
    if (invocationMode !== "workflow") return;
    if (boardId.trim().length === 0 || boardDefinitions.has(boardId)) return;
    let active = true;
    setDefinitionLoading(true);
    setTargetLoadError(null);
    void api
      .getBoardDefinition({ boardId: BoardId.make(boardId) })
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
  }, [api, boardDefinitions, boardId, invocationMode]);

  useEffect(() => {
    if (invocationMode !== "workflow") return;
    if (boardId.trim().length === 0) return;
    if (laneTargets.length === 0) {
      if (initialLane.length > 0) setInitialLane("");
      return;
    }
    if (!laneTargets.some((target) => target.laneKey === initialLane)) {
      setInitialLane(laneTargets[0]?.laneKey ?? "");
    }
  }, [boardId, initialLane, invocationMode, laneTargets]);

  const updateMessage = (
    index: number,
    patch: Partial<Pick<SlackAgentMockMessageDraft, "authorLabel" | "text">>,
  ) => {
    setMessages((current) =>
      current.map((message, messageIndex) =>
        messageIndex === index ? { ...message, ...patch } : message,
      ),
    );
  };

  const addMessage = () => {
    const message = makeMessageDraft(nextMessageIndex.current);
    nextMessageIndex.current += 1;
    setMessages((current) => [...current, message]);
  };

  const removeMessage = (index: number) => {
    setMessages((current) => current.filter((_message, messageIndex) => messageIndex !== index));
    setTriggerMessageIndex((current) => Math.max(0, Math.min(current, messages.length - 2)));
  };

  const createMockIdentity = async () => {
    const built = buildMockSlackAgentCreateInput({
      ownerLabel: mockOwnerLabel,
      handleSuffix: mockHandleSuffix,
      projectId: mockProjectId,
      acknowledged: mockAcknowledged,
    });
    if (built.error !== null || built.input === null) {
      setMockCreateError(built.error);
      return;
    }
    setCreatingMock(true);
    setMockCreateError(null);
    try {
      const response = await api.createMockSlackAgentInstance(built.input);
      setInstanceId(response.instance.instanceId);
      setMockOwnerLabel("");
      setMockHandleSuffix("");
      setMockAcknowledged(false);
      onRunCreated();
    } catch (caught: unknown) {
      setMockCreateError(
        caught instanceof Error ? caught.message : "Could not create the mock Slack identity.",
      );
    } finally {
      setCreatingMock(false);
    }
  };

  const submit = async () => {
    const invocation = buildMockInvocation({
      mode: invocationMode,
      boardId,
      initialLane,
      laneTargets,
    });
    if (invocation.error !== null) {
      setError(invocation.error);
      return;
    }
    const now = Date.now();
    const built = buildMockMentionInput({
      instanceId: selectedInstanceId,
      messages,
      triggerMessageIndex,
      threadKey,
      threadTs: `${Math.floor(now / 1_000)}.${String((now % 1_000) * 1_000).padStart(6, "0")}`,
      externalEventId,
      ...(invocation.input === undefined ? {} : { invocation: invocation.input }),
    });
    if (built.error !== null || built.input === null) {
      setError(built.error);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await api.simulateSlackMention(built.input);
      stopSubscriptions();
      const responseMode = response.mode;
      const chatUrl = chatThreadUrl(environmentId, response.threadId);
      const ticketUrl =
        environmentId === undefined ||
        invocation.input?.mode !== "workflow" ||
        response.ticketId === undefined
          ? undefined
          : `/${encodeURIComponent(environmentId)}/board?boardId=${encodeURIComponent(invocation.input.target.boardId)}&ticket=${encodeURIComponent(response.ticketId)}`;
      setResult({
        mode: responseMode,
        ...(response.threadId === undefined ? {} : { threadId: response.threadId }),
        ...(chatUrl === undefined ? {} : { chatUrl }),
        createdThread: response.createdThread,
        ...(response.ticketId === undefined ? {} : { ticketId: response.ticketId }),
        ...(ticketUrl === undefined ? {} : { ticketUrl }),
        replyText:
          response.message ??
          `${response.duplicate ? "Existing" : "Accepted"} run ${response.runId} is ${response.state}.`,
      });
      const threadId =
        `${built.input.thread.workspaceId}:${built.input.thread.channelId}:${built.input.thread.threadTs}` as Parameters<
          SlackAgentWorkflowApi["subscribeMockSlackThread"]
        >[0]["threadId"];
      subscriptionTeardowns.current = [
        api.subscribeSlackAgentRun({ runId: response.runId }, (event: SlackAgentRunStreamEvent) => {
          const run = event.type === "snapshot" ? event.run.run : event.run;
          setResult((current) => ({
            ...current,
            ...(run.ticketId === undefined ? {} : { ticketId: run.ticketId }),
            ...(ticketUrl === undefined ? {} : { ticketUrl }),
            ...(run.prUrl === undefined ? {} : { pullRequestUrl: run.prUrl }),
          }));
        }),
        api.subscribeMockSlackThread({ threadId }, (event: MockSlackThreadStreamEvent) => {
          const reply = event.thread.statusReplies.find((item) => item.runId === response.runId);
          if (reply === undefined) return;
          setResult((current) => ({
            ...current,
            ...(response.ticketId === undefined ? {} : { ticketId: response.ticketId }),
            replyText: reply.text,
          }));
        }),
      ];
      onRunCreated();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Could not send the mock mention.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3 sm:px-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">Mock thread lab</h3>
            <p className="max-w-2xl text-xs text-muted-foreground">
              Compose a bounded Slack-shaped thread, pick the triggering message, and send a Slack
              event to the selected enabled mock bot.
            </p>
          </div>
          <span className="rounded-md border border-amber-500/40 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            Code execution risk
          </span>
        </div>
      </div>
      <div className="space-y-4 px-4 py-4 sm:px-5">
        <div className="space-y-3 rounded-md border border-border px-3 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">Create mock identity</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Developer-only bot identity for exercising Slack thread intake without real tokens.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1.2fr_auto] sm:items-end">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-foreground">Owner</span>
              <Input
                value={mockOwnerLabel}
                placeholder="Chris"
                disabled={creatingMock}
                onChange={(event) => setMockOwnerLabel(event.currentTarget.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-foreground">Handle</span>
              <Input
                value={mockHandleSuffix}
                placeholder="chris"
                disabled={creatingMock}
                onChange={(event) => setMockHandleSuffix(event.currentTarget.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-foreground">Project</span>
              <select
                className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                value={mockProjectId}
                disabled={creatingMock || projects.length === 0}
                onChange={(event) => setMockProjectId(event.currentTarget.value)}
              >
                {projects.length === 0 ? <option value="">No projects</option> : null}
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              size="xs"
              disabled={creatingMock || projects.length === 0}
              onClick={() => void createMockIdentity()}
            >
              {creatingMock ? <Spinner className="size-3.5" /> : <PlusIcon className="size-3.5" />}
              Create mock
            </Button>
          </div>
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <input
              className="mt-0.5"
              type="checkbox"
              checked={mockAcknowledged}
              disabled={creatingMock}
              onChange={(event) => setMockAcknowledged(event.currentTarget.checked)}
            />
            <span>Authorized Slack users can start T3 turns through this mock identity.</span>
          </label>
          {mockCreateError !== null ? (
            <p className="text-sm text-destructive">{mockCreateError}</p>
          ) : null}
        </div>
        {runnableInstances.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
            Create and validate an enabled mock instance before running the lab.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-foreground">Bot</span>
                <select
                  className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  value={selectedInstanceId}
                  onChange={(event) => setInstanceId(event.currentTarget.value)}
                >
                  {runnableInstances.map((instance) => (
                    <option key={instance.instanceId} value={instance.instanceId}>
                      {instanceLabel(instance)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-foreground">Thread key</span>
                <Input
                  value={threadKey}
                  placeholder="Set once for follow-ups"
                  onChange={(event) => setThreadKey(event.currentTarget.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-foreground">
                  External event id
                </span>
                <Input
                  value={externalEventId}
                  placeholder="Optional replay id"
                  onChange={(event) => setExternalEventId(event.currentTarget.value)}
                />
              </label>
            </div>
            <div className="space-y-3 rounded-md border border-border px-3 py-3">
              <div>
                <span className="mb-2 block text-xs font-medium text-foreground">Mode</span>
                <div className="inline-flex rounded-md border border-border p-0.5">
                  {(["chat", "workflow"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`rounded px-3 py-1.5 text-xs font-medium ${
                        invocationMode === mode
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                      onClick={() => setInvocationMode(mode)}
                    >
                      {mode === "chat" ? "Chat" : "Workflow"}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Chat creates or continues a visible T3 Chat thread in the bot project. Later
                  messages in the linked Slack thread are forwarded as new turns. Mode applies only
                  to the first event for a thread key; follow-ups keep that link's original mode.
                </p>
              </div>
              {invocationMode === "workflow" ? (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium text-foreground">
                        Workflow board
                      </span>
                      <select
                        className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                        value={boardId}
                        disabled={boardsLoading || availableBoards.length === 0}
                        onChange={(event) => {
                          setBoardId(event.currentTarget.value);
                          setInitialLane("");
                          setTargetLoadError(null);
                        }}
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
                      <span className="mb-1 block text-xs font-medium text-foreground">
                        Initial lane/path
                      </span>
                      <select
                        className="h-8.5 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
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
                  {selectedProjectId !== "" && !boardsLoading && availableBoards.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No readable workflow boards were found for this bot project.
                    </p>
                  ) : null}
                  {boardId !== "" && !definitionLoading && laneTargets.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      This board has no automatic lane whose success path runs an agent before
                      opening a pull request.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="space-y-2">
              {messages.map((message, index) => (
                <div key={message.messageId} className="grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
                  <Input
                    aria-label={`Message ${index + 1} author`}
                    value={message.authorLabel}
                    onChange={(event) => updateMessage(index, { authorLabel: event.target.value })}
                  />
                  <Input
                    aria-label={`Message ${index + 1} text`}
                    value={message.text}
                    onChange={(event) => updateMessage(index, { text: event.target.value })}
                  />
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <input
                        type="radio"
                        name="slack-trigger-message"
                        checked={triggerMessageIndex === index}
                        onChange={() => setTriggerMessageIndex(index)}
                      />
                      Trigger
                    </label>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      disabled={messages.length === 1}
                      aria-label={`Remove message ${index + 1}`}
                      onClick={() => removeMessage(index)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={messages.length >= MAX_MOCK_MESSAGES}
                onClick={addMessage}
              >
                <PlusIcon className="size-3.5" />
                Add message
              </Button>
              <Button type="button" disabled={submitting} onClick={() => void submit()}>
                {submitting ? <Spinner className="size-3.5" /> : <PlayIcon className="size-3.5" />}
                Send Slack event
              </Button>
            </div>
          </>
        )}
        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
        {result !== null ? (
          <div className="rounded-md border border-border bg-background px-3 py-3 text-sm">
            <p className="font-medium text-foreground">Latest mock reply</p>
            {result.mode ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Effective mode: {result.mode === "chat" ? "Chat" : "Workflow"}
                {result.mode === "chat"
                  ? result.createdThread
                    ? " · created a new T3 Chat thread"
                    : " · continued the linked T3 Chat thread"
                  : " · linked workflow ticket"}
              </p>
            ) : null}
            {result.replyText ? (
              <p className="mt-1 text-muted-foreground">{result.replyText}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              {result.chatUrl ? (
                <a
                  className="text-primary underline-offset-2 hover:underline"
                  href={result.chatUrl}
                >
                  T3 Chat thread
                </a>
              ) : result.threadId ? (
                <span className="text-muted-foreground">Thread {result.threadId}</span>
              ) : null}
              {result.ticketUrl ? (
                <a
                  className="text-primary underline-offset-2 hover:underline"
                  href={result.ticketUrl}
                >
                  Workflow ticket
                </a>
              ) : result.ticketId ? (
                <span className="text-muted-foreground">Ticket {result.ticketId}</span>
              ) : null}
              {result.pullRequestUrl ? (
                <a
                  className="text-primary underline-offset-2 hover:underline"
                  href={result.pullRequestUrl}
                >
                  Pull request
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
