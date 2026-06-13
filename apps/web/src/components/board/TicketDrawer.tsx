import {
  ProjectId,
  StepRunId,
  type TicketAttachment,
  ThreadId,
  TicketId,
  type EnvironmentApi,
  type TerminalHistoryAttachStreamEvent,
} from "@t3tools/contracts";
import { CheckIcon, ImageIcon, PencilIcon, PlayIcon, SendIcon, XIcon } from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { cn, randomUUID } from "~/lib/utils";
import { stepUsageSummary } from "~/workflow/usageFormat";

import {
  describeRouteDecision,
  extractVerdict,
  truncateLabel,
  type RouteDecisionView,
} from "~/workflow/routeDecision";

import { readFileAsDataUrl } from "../ChatView.logic";
import { AgentSessionDialog } from "./AgentSessionDialog";
import { TicketArtifacts } from "./TicketArtifacts";
import { StepActivityFeed } from "./StepActivityFeed";
import { TicketDiff } from "./TicketDiff";

const SAFE_REPLY_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type TicketDrawerAttachment =
  | {
      readonly kind: "image";
      readonly id: string;
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      readonly dataUrl: string;
    }
  | {
      readonly kind: "video" | "file";
      readonly id: string;
      readonly name: string;
      readonly mimeType: string;
      readonly sizeBytes: number;
      readonly ref: string;
    };

export interface TicketDrawerAnswerInput {
  readonly stepRunId: string;
  readonly text?: string | undefined;
  readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
}

export interface TicketDrawerEditInput {
  readonly ticketId: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
}

export interface TicketDrawerDetail {
  readonly ticket: {
    readonly ticketId: string;
    readonly boardId?: string | undefined;
    readonly title: string;
    readonly description?: string | undefined;
    readonly currentLaneKey: string;
    readonly status: string;
    readonly pr?:
      | {
          readonly number: number;
          readonly url: string;
          readonly state: "open" | "merged" | "closed";
          readonly ciState?: "pending" | "success" | "failure" | undefined;
        }
      | undefined;
  };
  readonly steps: ReadonlyArray<{
    readonly stepRunId: string;
    readonly stepKey: string;
    readonly stepType: string;
    readonly attempt?: number | undefined;
    readonly status: string;
    readonly waitingReason: string | null;
    readonly blockedReason?: string | null | undefined;
    readonly providerResponseKind?: "request" | "user-input" | null | undefined;
    readonly scriptThreadId?: string | null | undefined;
    readonly terminalId?: string | null | undefined;
    readonly scriptStatus?: string | null | undefined;
    readonly exitCode?: number | null | undefined;
    readonly signal?: number | null | undefined;
    readonly startedAt?: string | undefined;
    readonly finishedAt?: string | undefined;
    readonly usage?: { readonly totalTokens?: number | undefined } | undefined;
    readonly providerThreadId?: string | undefined;
    readonly output?: unknown;
  }>;
  readonly routeHistory?: ReadonlyArray<RouteDecisionView> | undefined;
  readonly messages?: ReadonlyArray<{
    readonly messageId: string;
    readonly ticketId: string;
    readonly stepRunId?: string | undefined;
    readonly author: "agent" | "user";
    readonly body: string;
    readonly attachments: ReadonlyArray<TicketDrawerAttachment>;
    readonly createdAt: string;
  }>;
  readonly syncedSource?:
    | {
        readonly provider: string;
        readonly url: string;
        readonly assignees?: ReadonlyArray<string> | undefined;
        readonly labels?: ReadonlyArray<string> | undefined;
      }
    | undefined;
}

export interface TicketDrawerCommentInput {
  readonly ticketId: string;
  readonly text?: string | undefined;
  readonly attachments?: ReadonlyArray<TicketAttachment> | undefined;
}

/** Returns true when the ticket is owned by an external work-source sync and its
 *  title/description fields should be read-only in the UI. */
export function isTicketSourceOwned(detail: Pick<TicketDrawerDetail, "syncedSource">): boolean {
  return Boolean(detail.syncedSource);
}

export interface TicketDrawerLaneAction {
  readonly label: string;
  readonly to: string;
  readonly hint?: string | undefined;
}

export interface TicketDrawerLane {
  readonly key: string;
  readonly name: string;
  readonly entry: string;
  readonly pipelineStepCount: number;
  readonly actions?: ReadonlyArray<TicketDrawerLaneAction> | undefined;
}

export function TicketDrawer({
  api,
  detail,
  lanes = [],
  onAnswerStep,
  onPostComment,
  onApprove,
  onEditTicket,
  onMove,
  onRunLane,
  projectId,
}: {
  readonly api?: EnvironmentApi | undefined;
  readonly detail: TicketDrawerDetail;
  readonly lanes?: ReadonlyArray<TicketDrawerLane>;
  readonly onAnswerStep?: ((input: TicketDrawerAnswerInput) => Promise<void>) | undefined;
  readonly onPostComment?: ((input: TicketDrawerCommentInput) => Promise<void>) | undefined;
  readonly onApprove: (stepRunId: string, approved: boolean) => Promise<void>;
  readonly onEditTicket?: ((input: TicketDrawerEditInput) => Promise<void>) | undefined;
  readonly onMove?: ((toLane: string) => void) | undefined;
  readonly onRunLane: () => void;
  readonly projectId?: ProjectId | undefined;
}) {
  const sourceOwned = isTicketSourceOwned(detail);
  const [editingTicket, setEditingTicket] = useState(false);
  const [draftTitle, setDraftTitle] = useState(detail.ticket.title);
  const [draftDescription, setDraftDescription] = useState(detail.ticket.description ?? "");
  const [editError, setEditError] = useState<string | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replyAttachments, setReplyAttachments] = useState<ReadonlyArray<TicketDrawerAttachment>>(
    [],
  );
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replySubmitting, setReplySubmitting] = useState(false);
  const [approvalSubmittingStepRunId, setApprovalSubmittingStepRunId] = useState<string | null>(
    null,
  );
  const [approvalError, setApprovalError] = useState<{
    readonly stepRunId: string;
    readonly message: string;
  } | null>(null);
  const waitingStepCount = detail.steps.filter((step) => step.status === "awaiting_user").length;
  const currentLane = lanes.find((lane) => lane.key === detail.ticket.currentLaneKey) ?? null;
  const laneActions = currentLane?.actions ?? [];
  const canRunLane =
    currentLane !== null && currentLane.entry === "manual" && currentLane.pipelineStepCount > 0;
  const runLaneTitle = canRunLane
    ? `Run ${currentLane.name}`
    : "This lane has no manual pipeline to run.";
  const ticketDescription = detail.ticket.description?.trim() ?? "";
  const replyStep = detail.steps.find(isAwaitingUserInputStep) ?? null;
  const canReply = replyStep !== null && detail.ticket.status === "waiting_on_user";
  const laneDisplayName = (key: string): string =>
    lanes.find((lane) => lane.key === key)?.name ?? key;
  const routeHistory = detail.routeHistory ?? [];
  const latestRouteEntry = routeHistory.at(-1);
  const latestRouteDecision =
    latestRouteEntry === undefined
      ? null
      : describeRouteDecision(latestRouteEntry, laneDisplayName);

  useEffect(() => {
    if (editingTicket) {
      return;
    }
    setDraftTitle(detail.ticket.title);
    setDraftDescription(detail.ticket.description ?? "");
  }, [detail.ticket.description, detail.ticket.title, editingTicket]);

  const saveTicketEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = draftTitle.trim();
    if (!title || !onEditTicket) {
      return;
    }

    setEditSubmitting(true);
    setEditError(null);
    try {
      await onEditTicket({
        ticketId: detail.ticket.ticketId,
        title,
        description: draftDescription.trim(),
      });
      setEditingTicket(false);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Could not save ticket.");
    } finally {
      setEditSubmitting(false);
    }
  };

  const attachReplyImages = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length === 0) {
      return;
    }

    const images = files.filter((file) => SAFE_REPLY_IMAGE_MIME_TYPES.has(file.type));
    if (images.length !== files.length) {
      setReplyError("Only PNG, JPEG, GIF, or WebP image attachments are supported.");
    } else {
      setReplyError(null);
    }

    const nextAttachments = await Promise.all(
      images.map(async (file) => ({
        kind: "image" as const,
        id: randomUUID(),
        name: file.name || "image",
        mimeType: file.type || "image/png",
        sizeBytes: file.size,
        dataUrl: await readFileAsDataUrl(file),
      })),
    );
    if (nextAttachments.length > 0) {
      setReplyAttachments((current) => [...current, ...nextAttachments]);
    }
  };

  const sendReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = replyText.trim();
    if (!text && replyAttachments.length === 0) {
      return;
    }
    const attachmentsInput =
      replyAttachments.length > 0
        ? { attachments: replyAttachments as ReadonlyArray<TicketAttachment> }
        : {};

    setReplySubmitting(true);
    setReplyError(null);
    try {
      if (canReply && replyStep && onAnswerStep) {
        await onAnswerStep({
          stepRunId: replyStep.stepRunId,
          ...(text ? { text } : {}),
          ...attachmentsInput,
        });
      } else if (onPostComment) {
        await onPostComment({
          ticketId: detail.ticket.ticketId,
          ...(text ? { text } : {}),
          ...attachmentsInput,
        });
      } else {
        return;
      }
      setReplyText("");
      setReplyAttachments([]);
    } catch (error) {
      setReplyError(error instanceof Error ? error.message : "Could not send message.");
    } finally {
      setReplySubmitting(false);
    }
  };

  const submitApproval = async (stepRunId: string, approved: boolean) => {
    setApprovalSubmittingStepRunId(stepRunId);
    setApprovalError(null);
    try {
      await onApprove(stepRunId, approved);
    } catch (error) {
      setApprovalError({
        stepRunId,
        message: error instanceof Error ? error.message : "Could not submit approval decision.",
      });
    } finally {
      setApprovalSubmittingStepRunId(null);
    }
  };

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-background">
      <header className="shrink-0 border-b border-border px-4 py-3">
        {editingTicket ? (
          <form className="space-y-2" onSubmit={saveTicketEdit}>
            <label className="block space-y-1 text-xs font-medium text-muted-foreground">
              Ticket title
              <Input
                size="sm"
                value={draftTitle}
                disabled={sourceOwned || editSubmitting}
                onChange={(event) => setDraftTitle(event.currentTarget.value)}
              />
            </label>
            <label className="block space-y-1 text-xs font-medium text-muted-foreground">
              Ticket description
              <Textarea
                size="sm"
                value={draftDescription}
                disabled={sourceOwned || editSubmitting}
                onChange={(event) => setDraftDescription(event.currentTarget.value)}
              />
            </label>
            {editError ? <p className="text-xs text-destructive-foreground">{editError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                type="submit"
                disabled={!draftTitle.trim() || !onEditTicket || editSubmitting}
              >
                <CheckIcon className="size-3.5" />
                Save ticket
              </Button>
              <Button
                size="xs"
                type="button"
                variant="outline"
                disabled={editSubmitting}
                onClick={() => {
                  setDraftTitle(detail.ticket.title);
                  setDraftDescription(detail.ticket.description ?? "");
                  setEditError(null);
                  setEditingTicket(false);
                }}
              >
                <XIcon className="size-3.5" />
                Cancel edit
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {detail.syncedSource ? (
                <p className="mb-1">
                  <a
                    href={detail.syncedSource.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-sm border border-info/40 bg-info/8 px-1.5 py-0.5 text-[10px] font-medium text-info-foreground underline-offset-2 hover:underline"
                    data-testid="ticket-synced-source-badge"
                  >
                    Synced from {detail.syncedSource.provider} ↗
                  </a>
                </p>
              ) : null}
              <h2 className="truncate text-sm font-semibold text-foreground">
                {detail.ticket.title}
              </h2>
              {ticketDescription ? (
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{ticketDescription}</p>
              ) : null}
              <p className="mt-1 text-xs text-muted-foreground">
                {detail.ticket.currentLaneKey} / {formatStatusLabel(detail.ticket.status)}
              </p>
              {detail.ticket.pr !== undefined ? (
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs" data-testid="ticket-pr-row">
                  <a
                    href={detail.ticket.pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                    data-testid="ticket-pr-link"
                  >
                    PR #{detail.ticket.pr.number}
                  </a>
                  <span
                    className={cn(
                      "rounded-sm border px-1 py-0.5 text-[10px] font-medium",
                      detail.ticket.pr.state === "merged"
                        ? "border-muted-foreground/30 text-muted-foreground"
                        : detail.ticket.pr.state === "closed"
                          ? "border-muted-foreground/30 text-muted-foreground/70"
                          : "border-success/40 text-success-foreground",
                    )}
                    data-testid="ticket-pr-state"
                  >
                    {detail.ticket.pr.state}
                  </span>
                  {detail.ticket.pr.ciState !== undefined ? (
                    <span
                      className={cn(
                        "rounded-sm border px-1 py-0.5 text-[10px] font-medium",
                        detail.ticket.pr.ciState === "failure"
                          ? "border-destructive/40 text-destructive-foreground"
                          : detail.ticket.pr.ciState === "success"
                            ? "border-success/40 text-success-foreground"
                            : "border-muted-foreground/30 text-muted-foreground",
                      )}
                      data-testid="ticket-pr-ci-state"
                    >
                      CI: {detail.ticket.pr.ciState}
                    </span>
                  ) : null}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              {waitingStepCount > 0 ? (
                <Badge variant="warning" size="sm">
                  waiting on you
                </Badge>
              ) : null}
              {!sourceOwned ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!onEditTicket}
                  onClick={() => {
                    setEditError(null);
                    setEditingTicket(true);
                  }}
                >
                  <PencilIcon className="size-3.5" />
                  Edit ticket
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        {latestRouteDecision ? (
          <section
            className="rounded-md border border-info/40 bg-info/5 p-3"
            data-testid="ticket-route-why"
          >
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Why is this ticket here?
            </h3>
            <p className="mt-1 text-sm font-medium text-foreground">{latestRouteDecision.title}</p>
            {latestRouteDecision.details.length > 0 ? (
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {latestRouteDecision.details.join(" · ")}
              </p>
            ) : null}
            {routeHistory.length > 1 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground select-none">
                  Route history ({routeHistory.length})
                </summary>
                <ol className="mt-2 space-y-1.5">
                  {routeHistory
                    .map((entry) => describeRouteDecision(entry, laneDisplayName))
                    .toReversed()
                    .map((described, index) => {
                      const entry = routeHistory[routeHistory.length - 1 - index];
                      return (
                        <li
                          key={`${entry?.occurredAt ?? index}-${index}`}
                          className="rounded-md border border-border/60 bg-background/70 p-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-foreground">
                              {described.title}
                            </span>
                            {entry ? (
                              <time
                                dateTime={entry.occurredAt}
                                className="text-[11px] text-muted-foreground"
                              >
                                {formatMessageTimestamp(entry.occurredAt)}
                              </time>
                            ) : null}
                          </div>
                          {described.details.length > 0 ? (
                            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                              {described.details.join(" · ")}
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                </ol>
              </details>
            ) : null}
          </section>
        ) : null}
        <section className="rounded-md border border-border/70 bg-card/35 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-foreground">Discussion</h3>
            <span className="text-xs text-muted-foreground">{detail.messages?.length ?? 0}</span>
          </div>
          {detail.messages && detail.messages.length > 0 ? (
            <ol className="space-y-2">
              {detail.messages.map((message) => (
                <li
                  key={message.messageId}
                  className={cn(
                    "rounded-md border border-border/60 bg-background/70 p-2",
                    message.author === "user" && "ml-5 bg-accent/20",
                    message.author === "agent" && "mr-5",
                  )}
                >
                  <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span className="font-medium uppercase tracking-wide">
                      {message.author === "agent" ? "Agent" : "You"}
                    </span>
                    <time dateTime={message.createdAt}>
                      {formatMessageTimestamp(message.createdAt)}
                    </time>
                  </div>
                  {message.body ? (
                    <p className="whitespace-pre-wrap break-words text-sm leading-5 text-foreground">
                      {message.body}
                    </p>
                  ) : null}
                  {message.attachments.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {message.attachments.map((attachment) => (
                        <TicketAttachmentPreview key={attachment.id} attachment={attachment} />
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">
              No discussion yet — leave a note below for the agent or your future self.
            </p>
          )}
        </section>

        {canReply || onPostComment ? (
          <form
            className={cn(
              "rounded-md border p-3",
              canReply ? "border-warning/40 bg-warning/5" : "border-border/70 bg-card/35",
            )}
            onSubmit={sendReply}
          >
            <label className="block space-y-1 text-xs font-medium text-muted-foreground">
              {canReply ? "Ticket reply" : "Add a comment"}
              <Textarea
                size="sm"
                value={replyText}
                disabled={replySubmitting}
                onChange={(event) => setReplyText(event.currentTarget.value)}
              />
            </label>
            {replyAttachments.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {replyAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="group relative overflow-hidden rounded-md border border-border/70 bg-background"
                  >
                    {attachment.kind === "image" ? (
                      <img
                        src={attachment.dataUrl}
                        alt={attachment.name}
                        className="size-16 object-cover"
                      />
                    ) : null}
                    <span className="block max-w-24 truncate px-1.5 py-1 text-[10px] text-muted-foreground">
                      {attachment.name}
                    </span>
                    <Button
                      className="absolute right-1 top-1 bg-background/85"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Remove ${attachment.name}`}
                      disabled={replySubmitting}
                      onClick={() =>
                        setReplyAttachments((current) =>
                          current.filter((candidate) => candidate.id !== attachment.id),
                        )
                      }
                    >
                      <XIcon />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            {replyError ? (
              <p className="mt-2 text-xs text-destructive-foreground">{replyError}</p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border border-input bg-background px-2 text-xs font-medium text-foreground shadow-xs/5 hover:bg-accent/50">
                <ImageIcon className="size-3.5" aria-hidden />
                Attach image
                <input
                  className="sr-only"
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  multiple
                  disabled={replySubmitting}
                  onChange={attachReplyImages}
                />
              </label>
              <Button
                size="xs"
                type="submit"
                disabled={
                  (canReply ? !onAnswerStep : !onPostComment) ||
                  replySubmitting ||
                  (!replyText.trim() && replyAttachments.length === 0)
                }
              >
                <SendIcon className="size-3.5" />
                {canReply ? "Send reply" : "Comment"}
              </Button>
            </div>
          </form>
        ) : null}

        <section className="rounded-md border border-border/70 bg-card/35 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-foreground">Steps</h3>
            <span className="text-xs text-muted-foreground">{detail.steps.length}</span>
          </div>
          <ol className="space-y-2">
            {detail.steps.map((step) => (
              <li
                key={step.stepRunId}
                className={cn(
                  "rounded-md border border-border/60 bg-background/70 p-2",
                  (step.status === "awaiting_user" || step.status === "blocked") &&
                    "border-warning/45 bg-warning/5",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{step.stepKey}</p>
                    <p className="text-xs text-muted-foreground">
                      {step.stepType}
                      {step.attempt !== undefined && step.attempt > 1
                        ? ` · attempt ${step.attempt}`
                        : null}
                      {stepUsageSummary(step) !== null ? ` · ${stepUsageSummary(step)}` : null}
                    </p>
                  </div>
                  <Badge size="sm" variant={stepBadgeVariant(step)}>
                    {formatStepBadgeLabel(step)}
                  </Badge>
                </div>
                {step.waitingReason ? (
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {step.waitingReason}
                  </p>
                ) : null}
                {step.blockedReason ? (
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {step.blockedReason}
                  </p>
                ) : null}
                {step.output !== undefined && step.output !== null ? (
                  <div className="mt-2" data-testid="step-captured-output">
                    {extractVerdict(step.output) !== null ? (
                      <Badge
                        size="sm"
                        variant={extractVerdict(step.output) === "approve" ? "success" : "warning"}
                      >
                        verdict: {truncateLabel(extractVerdict(step.output) ?? "")}
                      </Badge>
                    ) : null}
                    <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-border/60 bg-background/70 p-2 text-[11px] leading-4 text-muted-foreground">
                      {JSON.stringify(step.output, null, 2)}
                    </pre>
                  </div>
                ) : null}
                {isScriptStepWithTerminal(step) ? (
                  <ScriptStepLogViewer api={api} step={step} />
                ) : null}
                {step.stepType === "agent" &&
                step.providerThreadId !== undefined &&
                (step.status === "running" ||
                  step.status === "dispatch_requested" ||
                  step.status === "awaiting_user") ? (
                  <StepActivityFeed api={api} threadId={step.providerThreadId as never} live />
                ) : null}
                {step.stepType === "agent" && step.providerThreadId !== undefined ? (
                  <div className="mt-2">
                    <AgentSessionDialog
                      api={api}
                      threadId={step.providerThreadId as never}
                      stepKey={step.stepKey}
                    />
                  </div>
                ) : null}
                {isAwaitingApprovalRequestStep(step) ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="xs"
                      disabled={approvalSubmittingStepRunId === step.stepRunId}
                      onClick={() => {
                        void submitApproval(step.stepRunId, true);
                      }}
                    >
                      <CheckIcon className="size-3.5" />
                      Approve
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={approvalSubmittingStepRunId === step.stepRunId}
                      onClick={() => {
                        void submitApproval(step.stepRunId, false);
                      }}
                    >
                      <XIcon className="size-3.5" />
                      Reject
                    </Button>
                    {approvalError?.stepRunId === step.stepRunId ? (
                      <p className="basis-full text-xs text-destructive-foreground">
                        {approvalError.message}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {step.stepType === "script" && step.scriptStatus === "running" ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      disabled={!api}
                      onClick={() => {
                        void api?.workflow.cancelStep({
                          stepRunId: StepRunId.make(step.stepRunId),
                        });
                      }}
                    >
                      <XIcon className="size-3.5" />
                      Cancel
                    </Button>
                  </div>
                ) : null}
                {isTrustBlockedScriptStep(step) ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="xs"
                      disabled={!api || !projectId}
                      onClick={() => {
                        if (!api || !projectId) {
                          return;
                        }
                        void api.workflow
                          .setProjectScriptTrust({ projectId, trusted: true })
                          .then(onRunLane);
                      }}
                    >
                      <CheckIcon className="size-3.5" />
                      Trust this project &amp; run
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        </section>

        {api ? <TicketArtifacts api={api} ticketId={detail.ticket.ticketId} /> : null}
        {api ? <TicketDiff api={api} ticketId={TicketId.make(detail.ticket.ticketId)} /> : null}
      </div>
      <footer className="shrink-0 space-y-2 border-t border-border px-3 py-2">
        {onMove && laneActions.length > 0 ? (
          <div className="flex flex-wrap gap-2" data-testid="ticket-lane-actions">
            {laneActions.map((action) => {
              const targetLane = lanes.find((lane) => lane.key === action.to);
              const hint = [action.hint, targetLane ? `Moves to ${targetLane.name}.` : null]
                .filter(Boolean)
                .join(" ");
              return (
                <Button
                  key={`${action.label}:${action.to}`}
                  size="sm"
                  variant="outline"
                  title={hint}
                  onClick={() => onMove(action.to)}
                >
                  {action.label}
                  {targetLane ? (
                    <span className="text-[11px] font-normal text-muted-foreground">
                      → {targetLane.name}
                    </span>
                  ) : null}
                </Button>
              );
            })}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!canRunLane} title={runLaneTitle} onClick={onRunLane}>
            <PlayIcon className="size-4" />
            Run lane
          </Button>
          {onMove && lanes.length > 0 ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Move
              <select
                className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
                value={detail.ticket.currentLaneKey}
                onChange={(event) => onMove(event.currentTarget.value)}
              >
                {lanes.map((lane) => (
                  <option key={lane.key} value={lane.key}>
                    {lane.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </footer>
    </aside>
  );
}

function TicketAttachmentPreview({ attachment }: { readonly attachment: TicketDrawerAttachment }) {
  if (attachment.kind === "image") {
    return (
      <div className="overflow-hidden rounded-md border border-border/70 bg-background">
        <img src={attachment.dataUrl} alt={attachment.name} className="size-20 object-cover" />
        <span className="block max-w-24 truncate px-1.5 py-1 text-[10px] text-muted-foreground">
          {attachment.name}
        </span>
      </div>
    );
  }

  return (
    <span className="rounded-md border border-border/70 bg-background px-2 py-1 text-xs text-muted-foreground">
      {attachment.name}
    </span>
  );
}

function formatStatusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function formatMessageTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatStepBadgeLabel(step: TicketDrawerDetail["steps"][number]): string {
  if (step.stepType !== "script") {
    return formatStatusLabel(step.status);
  }

  switch (step.scriptStatus) {
    case "running":
      return "running";
    case "exited":
      return typeof step.exitCode === "number" ? `exit ${step.exitCode}` : "exited";
    case "timeout":
      return "timed out";
    case "cancelled":
      return "cancelled";
    case null:
    case undefined:
      return formatStatusLabel(step.status);
    default:
      return formatStatusLabel(step.scriptStatus);
  }
}

function stepBadgeVariant(step: TicketDrawerDetail["steps"][number]) {
  if (step.status === "awaiting_user" || step.status === "blocked") {
    return "warning";
  }
  if (step.status === "failed" || step.scriptStatus === "timeout") {
    return "error";
  }
  if (step.status === "completed") {
    return "success";
  }
  if (step.scriptStatus === "running" || step.status === "running") {
    return "info";
  }
  return "outline";
}

function isScriptStepWithTerminal(
  step: TicketDrawerDetail["steps"][number],
): step is TicketDrawerDetail["steps"][number] & {
  readonly scriptThreadId: string;
  readonly terminalId: string;
} {
  return (
    step.stepType === "script" &&
    typeof step.scriptThreadId === "string" &&
    step.scriptThreadId.length > 0 &&
    typeof step.terminalId === "string" &&
    step.terminalId.length > 0
  );
}

function isTrustBlockedScriptStep(step: TicketDrawerDetail["steps"][number]): boolean {
  return (
    step.stepType === "script" &&
    step.status === "blocked" &&
    (step.blockedReason ?? "").toLowerCase().includes("not trusted")
  );
}

function isAwaitingUserInputStep(step: TicketDrawerDetail["steps"][number]): boolean {
  return step.status === "awaiting_user" && step.providerResponseKind === "user-input";
}

function isAwaitingApprovalRequestStep(step: TicketDrawerDetail["steps"][number]): boolean {
  return (
    step.status === "awaiting_user" &&
    (step.providerResponseKind === "request" ||
      (step.stepType === "approval" &&
        (step.providerResponseKind === null || step.providerResponseKind === undefined)))
  );
}

function ScriptStepLogViewer({
  api,
  step,
}: {
  readonly api?: EnvironmentApi | undefined;
  readonly step: TicketDrawerDetail["steps"][number] & {
    readonly scriptThreadId: string;
    readonly terminalId: string;
  };
}) {
  const [history, setHistory] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) {
      setHistory("");
      setError(null);
      return;
    }

    setHistory("");
    setError(null);
    return api.terminal.attachHistory(
      {
        threadId: ThreadId.make(step.scriptThreadId),
        terminalId: step.terminalId,
      },
      (event) => {
        applyHistoryEvent(event, setHistory, setError);
      },
    );
  }, [api, step.scriptThreadId, step.terminalId]);

  return (
    <section className="mt-2 overflow-hidden rounded-md border border-border/60 bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2 py-1.5">
        <h4 className="text-xs font-medium text-foreground">Script output</h4>
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {step.terminalId}
        </span>
      </div>
      {error ? (
        <p className="px-2 py-2 text-xs text-destructive-foreground">{error}</p>
      ) : (
        <pre className="max-h-64 min-h-16 overflow-auto whitespace-pre-wrap break-words p-2 font-mono text-[11px] leading-relaxed text-foreground/85">
          {history || "No output yet."}
        </pre>
      )}
    </section>
  );
}

function applyHistoryEvent(
  event: TerminalHistoryAttachStreamEvent,
  setHistory: (updater: string | ((current: string) => string)) => void,
  setError: (error: string | null) => void,
) {
  switch (event.type) {
    case "snapshot":
      setHistory(event.snapshot.history);
      setError(null);
      return;
    case "output":
      setHistory((current) => `${current}${event.data}`);
      return;
    case "cleared":
      setHistory("");
      return;
    case "error":
      setError(event.message);
      return;
    case "exited":
    case "closed":
    case "activity":
      return;
  }
}
