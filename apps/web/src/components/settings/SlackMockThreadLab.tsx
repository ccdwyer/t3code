import {
  MOCK_SLACK_WORKSPACE_ID,
  type MockSlackThreadStreamEvent,
  type SlackAgentRunStreamEvent,
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
    text: index === 0 ? "Can @t3_chris turn this thread into a PR?" : "",
    attachments: [],
  };
}

export function buildMockMentionInput(input: {
  readonly instanceId: string;
  readonly messages: ReadonlyArray<SlackAgentMockMessageDraft>;
  readonly triggerMessageIndex: number;
  readonly threadKey?: string;
  readonly threadTs?: string;
  readonly externalEventId?: string;
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

export function SlackMockThreadLab({
  api,
  instances,
  onRunCreated,
  environmentId,
}: {
  readonly api: Pick<
    SlackAgentWorkflowApi,
    "simulateSlackMention" | "subscribeSlackAgentRun" | "subscribeMockSlackThread"
  >;
  readonly instances: ReadonlyArray<SlackAgentInstanceView>;
  readonly onRunCreated: () => void;
  readonly environmentId?: string;
}) {
  const runnableInstances = useMemo(
    () =>
      instances.filter(
        (instance) => instance.enabled && instance.state === "enabled" && instance.validation.valid,
      ),
    [instances],
  );
  const [instanceId, setInstanceId] = useState(() => runnableInstances[0]?.instanceId ?? "");
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    readonly ticketId?: string;
    readonly ticketUrl?: string;
    readonly pullRequestUrl?: string;
    readonly replyText?: string;
  } | null>(null);
  const subscriptionTeardowns = useRef<ReadonlyArray<() => void>>([]);
  const nextMessageIndex = useRef(1);

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

  const submit = async () => {
    const now = Date.now();
    const built = buildMockMentionInput({
      instanceId: selectedInstanceId,
      messages,
      triggerMessageIndex,
      threadKey,
      threadTs: `${Math.floor(now / 1_000)}.${String((now % 1_000) * 1_000).padStart(6, "0")}`,
      externalEventId,
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
      const selectedInstance = runnableInstances.find(
        (instance) => instance.instanceId === selectedInstanceId,
      );
      const ticketUrl =
        environmentId === undefined || selectedInstance === undefined
          ? undefined
          : `/${encodeURIComponent(environmentId)}/board?boardId=${encodeURIComponent(selectedInstance.target.boardId)}&ticket=${encodeURIComponent(response.ticketId)}`;
      setResult({
        ticketId: response.ticketId,
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
            ...(current ?? { ticketId: run.ticketId }),
            ticketId: run.ticketId,
            ...(ticketUrl === undefined ? {} : { ticketUrl }),
            ...(run.prUrl === undefined ? {} : { pullRequestUrl: run.prUrl }),
          }));
        }),
        api.subscribeMockSlackThread({ threadId }, (event: MockSlackThreadStreamEvent) => {
          const reply = event.thread.statusReplies.find((item) => item.runId === response.runId);
          if (reply === undefined) return;
          setResult((current) => ({
            ...(current ?? { ticketId: response.ticketId }),
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
              Compose a bounded Slack-shaped thread, pick the triggering message, and start one
              workflow ticket for the selected enabled mock bot.
            </p>
          </div>
          <span className="rounded-md border border-amber-500/40 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            Code execution risk
          </span>
        </div>
      </div>
      <div className="space-y-4 px-4 py-4 sm:px-5">
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
                  placeholder="Auto-generate"
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
                Send mention
              </Button>
            </div>
          </>
        )}
        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
        {result !== null ? (
          <div className="rounded-md border border-border bg-background px-3 py-3 text-sm">
            <p className="font-medium text-foreground">Latest mock reply</p>
            {result.replyText ? (
              <p className="mt-1 text-muted-foreground">{result.replyText}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              {result.ticketUrl ? (
                <a
                  className="text-primary underline-offset-2 hover:underline"
                  href={result.ticketUrl}
                >
                  T3 ticket
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
