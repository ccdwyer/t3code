import { reduceTicketReplay } from "~/workflow/replayModel";
import {
  ProjectId,
  StepRunId,
  type TicketAttachment,
  ThreadId,
  TicketId,
  type EnvironmentApi,
  type TerminalHistoryAttachStreamEvent,
  type CheckpointForm,
  toTimelineEntry,
  type WorkflowTimelineBase,
  type WorkflowTimelineItem,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ImageIcon,
  Maximize2Icon,
  Minimize2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  SendIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Textarea } from "~/components/ui/textarea";
import { cn, randomUUID } from "~/lib/utils";
import { ticketAging } from "~/workflow/agingFormat";
import { useNowTick } from "~/workflow/useNowTick";
import { stepUsageSummary } from "~/workflow/usageFormat";

import {
  describeRouteDecision,
  extractVerdict,
  truncateLabel,
  type RouteDecisionView,
} from "~/workflow/routeDecision";

import { readFileAsDataUrl } from "../ChatView.logic";
import ChatMarkdown from "../ChatMarkdown";
import { AgentSessionDialog } from "./AgentSessionDialog";
import { MarkdownComposerField } from "./MarkdownComposerField";
import { pickAgentConversationStep } from "./pickAgentConversationStep";
import { TicketArtifacts } from "./TicketArtifacts";
import { SteerComposer } from "./SteerComposer";
import { StepActivityFeed } from "./StepActivityFeed";
import { dispatchParkAction, splitParkActions } from "./TicketCard";
import { TicketDiff } from "./TicketDiff";
import { WorkflowEditorFullscreen } from "./editor/WorkflowEditorFullscreen";

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

/** Park-in-place details for a parked ticket, mirroring `BoardTicketView.parked`.
 *  `actions` is re-resolved from the current board definition at read time —
 *  absent means the definition changed and inline recovery is unavailable. */
export interface TicketDrawerParkedView {
  readonly substate: "issue" | "waiting";
  readonly label: string;
  readonly reason: string;
  readonly parkedAt: string;
  readonly parkedEventId: string;
  readonly actions?: ReadonlyArray<TicketDrawerLaneAction> | undefined;
}

export interface TicketDrawerDetail {
  readonly ticket: {
    readonly ticketId: string;
    readonly boardId?: string | undefined;
    readonly title: string;
    readonly description?: string | undefined;
    readonly currentLaneKey: string;
    readonly status: string;
    readonly updatedAt?: string | undefined;
    readonly pr?:
      | {
          readonly number: number;
          readonly url: string;
          readonly state: "open" | "merged" | "closed";
          readonly ciState?: "pending" | "success" | "failure" | undefined;
        }
      | undefined;
    readonly attentionKind?: string | undefined;
    readonly attentionReason?: string | undefined;
    readonly currentStepLabel?: string | undefined;
    readonly slaBreachedAt?: string | undefined;
    // Park-in-place details — present while status is "parked".
    readonly parked?: TicketDrawerParkedView | undefined;
  };
  readonly steps: ReadonlyArray<{
    readonly stepRunId: string;
    readonly stepKey: string;
    readonly stepType: string;
    readonly attempt?: number | undefined;
    readonly status: string;
    readonly waitingReason: string | null;
    readonly blockedReason?: string | null | undefined;
    readonly error?: string | null | undefined;
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
    // Server-derived steer eligibility; `steerBlockedReason` shows the composer
    // disabled with a reason rather than hiding it.
    readonly canSteer?: boolean | undefined;
    readonly steerBlockedReason?: "awaiting_user" | "delivering" | undefined;
    // Checkpoint form on an approval wait, plus what was answered once resolved.
    readonly form?: CheckpointForm | undefined;
    readonly formDecision?: string | undefined;
    readonly formAnswers?: Record<string, string | ReadonlyArray<string>> | undefined;
    readonly steerCount?: number | undefined;
    readonly lastSteeredAt?: string | undefined;
    readonly output?: unknown;
  }>;
  readonly routeHistory?: ReadonlyArray<RouteDecisionView> | undefined;
  /** Handoff context compiled when the ticket was routed into its current lane. */
  readonly contextPack?:
    | {
        readonly forLane: string;
        readonly fromLane: string;
        readonly compiledAt: string;
        readonly editedAt?: string | undefined;
        readonly sections: ReadonlyArray<{
          readonly key: string;
          readonly body: string;
          readonly autoGenerated: boolean;
        }>;
      }
    | undefined;
  readonly messages?: ReadonlyArray<{
    readonly messageId: string;
    readonly ticketId: string;
    readonly stepRunId?: string | undefined;
    readonly author: "agent" | "user";
    readonly body: string;
    readonly attachments: ReadonlyArray<TicketDrawerAttachment>;
    readonly createdAt: string;
    readonly editedAt?: string | undefined;
    readonly kind?: "steering" | undefined;
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
  onEditMessage,
  onEditContextPack,
  onLoadTimeline,
  onApprove,
  onEditTicket,
  onDeleteTicket,
  onMove,
  onRunLane,
  onSteered,
  onParkAction,
  parkActionPending = false,
  projectId,
  cwd,
}: {
  readonly api?: EnvironmentApi | undefined;
  readonly detail: TicketDrawerDetail;
  readonly lanes?: ReadonlyArray<TicketDrawerLane>;
  readonly onAnswerStep?: ((input: TicketDrawerAnswerInput) => Promise<void>) | undefined;
  readonly onPostComment?: ((input: TicketDrawerCommentInput) => Promise<void>) | undefined;
  /**
   * Save edited handoff sections. Resolves with the PERSISTED sections, which
   * can differ from what was submitted because the server redacts secrets on
   * save — the form renders what came back and says so.
   */
  /**
   * Lazily loads this ticket's event history. Absent means the History section
   * is not offered at all — the drawer never renders an empty shell for a
   * capability the host did not wire up.
   */
  readonly onLoadTimeline?:
    | ((ticketId: string) => Promise<{
        readonly events: ReadonlyArray<WorkflowTimelineItem>;
        readonly truncated: boolean;
        readonly base?: WorkflowTimelineBase | undefined;
      }>)
    | undefined;
  readonly onEditContextPack?:
    | ((input: {
        readonly ticketId: string;
        readonly forLane: string;
        readonly sections: ReadonlyArray<{ readonly key: string; readonly body: string }>;
      }) => Promise<
        ReadonlyArray<{
          readonly key: string;
          readonly body: string;
          readonly autoGenerated: boolean;
        }>
      >)
    | undefined;
  readonly onEditMessage?: ((messageId: string, body: string) => Promise<void>) | undefined;
  readonly onApprove: (
    stepRunId: string,
    approved: boolean,
    submission?: {
      readonly decision?: string | undefined;
      readonly answers?: Record<string, string | ReadonlyArray<string>> | undefined;
    },
  ) => Promise<void>;
  readonly onEditTicket?: ((input: TicketDrawerEditInput) => Promise<void>) | undefined;
  readonly onDeleteTicket?: (() => Promise<void>) | undefined;
  readonly onMove?: ((toLane: string) => void) | undefined;
  readonly onRunLane: () => void;
  /** Refresh ticket detail after a successful steer (must NOT be onRunLane). */
  readonly onSteered?: (() => void) | undefined;
  readonly onParkAction?:
    | ((ticketId: string, actionIndex: number, parkedEventId: string) => Promise<void>)
    | undefined;
  // True while a park action for THIS ticket is in flight from any surface
  // (card / strip / drawer). Shared from the route so every recovery control
  // for the ticket disables together, not just the surface that was clicked.
  readonly parkActionPending?: boolean | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly cwd?: string | undefined;
}) {
  const sourceOwned = isTicketSourceOwned(detail);
  const [fullscreen, setFullscreen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
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
  // Board cards select a ticket into this drawer; when that ticket has an agent
  // dispatch thread, surface "Open conversation" in the header so the user
  // doesn't have to dig into the step list (those threads are hidden from the
  // main threads sidebar).
  const conversationStep = pickAgentConversationStep(detail.steps);
  const currentLane = lanes.find((lane) => lane.key === detail.ticket.currentLaneKey) ?? null;
  const laneActions = currentLane?.actions ?? [];
  // A parked ticket is non-admitted (no lane entry token), so the server's
  // runLane fails typed rather than starting anything. Gate the affordance so
  // the drawer never advertises a Run lane that would no-op/error — recovery is
  // the park actions above or a manual move.
  const isParked = detail.ticket.parked !== undefined;
  const canRunLane =
    !isParked &&
    currentLane !== null &&
    currentLane.entry === "manual" &&
    currentLane.pipelineStepCount > 0;
  const runLaneTitle = isParked
    ? "Parked — use the recovery actions above."
    : canRunLane
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
  const now = useNowTick(60_000);

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

  const confirmDeleteTicket = async () => {
    if (!onDeleteTicket) {
      return;
    }
    setDeleteSubmitting(true);
    setDeleteError(null);
    try {
      await onDeleteTicket();
      setDeleteConfirmOpen(false);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Could not delete ticket.");
    } finally {
      setDeleteSubmitting(false);
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

  const submitApproval = async (
    stepRunId: string,
    approved: boolean,
    submission?: {
      readonly decision?: string | undefined;
      readonly answers?: Record<string, string | ReadonlyArray<string>> | undefined;
    },
  ) => {
    setApprovalSubmittingStepRunId(stepRunId);
    setApprovalError(null);
    try {
      await onApprove(stepRunId, approved, submission);
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
      {/* Minimal header — always visible so the expand/collapse control is always reachable. */}
      <header className="shrink-0 border-b border-border px-4 py-3">
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
            <p className="mt-1 text-xs text-muted-foreground">
              {detail.ticket.currentLaneKey} / {formatStatusLabel(detail.ticket.status)}
              {detail.ticket.slaBreachedAt !== undefined ? (
                <span
                  className="ml-2 inline-flex items-center rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive-foreground"
                  data-testid="drawer-sla-badge"
                  title={`SLA breached at ${detail.ticket.slaBreachedAt}`}
                >
                  SLA breached
                </span>
              ) : null}
            </p>
            {detail.ticket.pr !== undefined ? (
              <TicketPrBadges pr={detail.ticket.pr} rowClassName="mt-1" testIds />
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {waitingStepCount > 0 ? (
              <Badge variant="warning" size="sm">
                waiting on you
              </Badge>
            ) : null}
            <div className="flex items-center gap-1.5">
              {conversationStep !== null ? (
                <AgentSessionDialog
                  api={api}
                  threadId={ThreadId.make(conversationStep.threadId)}
                  stepKey={conversationStep.stepKey}
                  label="Open conversation"
                  title={`Open conversation for step ${conversationStep.stepKey}`}
                  testId="ticket-open-conversation"
                />
              ) : null}
              {!sourceOwned && !fullscreen ? (
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
              {onDeleteTicket ? (
                <Button
                  size="xs"
                  variant="destructive-outline"
                  data-testid="ticket-delete"
                  aria-label={`Delete ticket ${detail.ticket.title}`}
                  onClick={() => {
                    setDeleteError(null);
                    setDeleteConfirmOpen(true);
                  }}
                >
                  <Trash2Icon className="size-3.5" />
                  Delete
                </Button>
              ) : null}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Expand ticket to full screen"
                title="Full screen"
                onClick={() => setFullscreen(true)}
              >
                <Maximize2Icon className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Parked banner (collapsed view): sits right after the header, ahead
          of the collapsed body. TicketFullscreen renders its own copy of this
          banner under its own header — the fullscreen view is a portal to
          document.body (see WorkflowEditorFullscreen) and #root is inert
          while it's open, so this collapsed-view render is NOT reachable when
          fullscreen is true. */}
      {!fullscreen && detail.ticket.parked !== undefined ? (
        <TicketParkedBanner
          ticketId={detail.ticket.ticketId}
          parked={detail.ticket.parked}
          now={now}
          onParkAction={onParkAction}
          parkActionPending={parkActionPending}
        />
      ) : null}
      {!fullscreen && detail.ticket.status === "blocked" ? (
        <TicketBlockedBanner reason={ticketBlockedReason(detail)} />
      ) : null}

      {/*
       * When fullscreen is true: render only the TicketFullscreen overlay.
       * The heavy body (live thread subscriptions via StepActivityFeed, TicketDiff
       * fetches, TicketArtifacts) must NOT be mounted at the same time as the
       * fullscreen view to avoid duplicate live subscriptions and duplicate testids.
       */}
      {fullscreen ? (
        <TicketFullscreen
          api={api}
          detail={detail}
          conversationStep={conversationStep}
          lanes={lanes}
          laneDisplayName={laneDisplayName}
          laneActions={laneActions}
          canRunLane={canRunLane}
          runLaneTitle={runLaneTitle}
          routeHistory={routeHistory}
          latestRouteDecision={latestRouteDecision}
          ticketDescription={ticketDescription}
          editState={
            editingTicket
              ? {
                  draftTitle,
                  draftDescription,
                  editError,
                  editSubmitting,
                  setDraftTitle,
                  setDraftDescription,
                  saveTicketEdit,
                  cancelEdit: () => {
                    setDraftTitle(detail.ticket.title);
                    setDraftDescription(detail.ticket.description ?? "");
                    setEditError(null);
                    setEditingTicket(false);
                  },
                }
              : null
          }
          sourceOwned={sourceOwned}
          onStartEdit={
            !sourceOwned
              ? () => {
                  setEditError(null);
                  setEditingTicket(true);
                }
              : undefined
          }
          onEditTicket={onEditTicket}
          replyState={{
            canReply,
            replyText,
            setReplyText,
            replyAttachments,
            setReplyAttachments,
            replyError,
            replySubmitting,
            onAnswerStep,
            onPostComment,
            attachReplyImages,
            sendReply,
          }}
          approvalState={{
            approvalSubmittingStepRunId,
            approvalError,
            submitApproval,
          }}
          waitingStepCount={waitingStepCount}
          projectId={projectId}
          cwd={cwd}
          onEditMessage={onEditMessage}
          onMove={onMove}
          onRunLane={onRunLane}
          onSteered={onSteered}
          onParkAction={onParkAction}
          parkActionPending={parkActionPending}
          now={now}
          onRequestDelete={
            onDeleteTicket
              ? () => {
                  setDeleteError(null);
                  setDeleteConfirmOpen(true);
                }
              : undefined
          }
          onClose={() => setFullscreen(false)}
        />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
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
                {editError ? (
                  <p className="text-xs text-destructive-foreground">{editError}</p>
                ) : null}
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
              <TicketDescriptionView description={ticketDescription} density="compact" />
            )}
            {latestRouteDecision ? (
              <section
                className="rounded-md border border-info/40 bg-info/5 p-3"
                data-testid="ticket-route-why"
              >
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Why is this ticket here?
                </h3>
                <p className="mt-1 text-sm font-medium text-foreground">
                  {latestRouteDecision.title}
                </p>
                {latestRouteDecision.details.length > 0 ? (
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {latestRouteDecision.details.join(" · ")}
                  </p>
                ) : null}
                <TicketRouteHistoryDetails
                  routeHistory={routeHistory}
                  laneDisplayName={laneDisplayName}
                  detailsClassName="mt-2"
                />
              </section>
            ) : null}
            <TicketContextPackSection
              pack={detail.contextPack}
              onSave={onEditContextPack}
              ticketId={detail.ticket.ticketId}
            />
            <TicketHistorySection
              ticketId={detail.ticket.ticketId}
              onLoadTimeline={onLoadTimeline}
            />
            <TicketDiscussionSection
              messages={detail.messages}
              density="compact"
              cwd={cwd}
              onEditMessage={onEditMessage}
            />

            {canReply || onPostComment ? (
              <TicketReplyComposer
                canReply={canReply}
                replyText={replyText}
                setReplyText={setReplyText}
                replyAttachments={replyAttachments}
                setReplyAttachments={setReplyAttachments}
                replyError={replyError}
                replySubmitting={replySubmitting}
                onAnswerStep={onAnswerStep}
                onPostComment={onPostComment}
                attachReplyImages={attachReplyImages}
                sendReply={sendReply}
                cwd={cwd}
                formClassName="p-3"
              />
            ) : null}

            <section className="rounded-md border border-border/70 bg-card/35 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium text-foreground">Steps</h3>
                <span className="text-xs text-muted-foreground">{detail.steps.length}</span>
              </div>
              <ol className="space-y-2">
                {detail.steps.map((step, index) => (
                  <TicketStepRow
                    key={step.stepRunId}
                    step={presentTicketStep(detail, index)}
                    api={api}
                    projectId={projectId}
                    ticketId={detail.ticket.ticketId}
                    approvalSubmittingStepRunId={approvalSubmittingStepRunId}
                    approvalError={approvalError}
                    stepOutputTestId="step-captured-output"
                    onRunLane={onRunLane}
                    submitApproval={submitApproval}
                    onSteered={onSteered}
                    liClassName="p-2"
                  />
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
        </>
      )}

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete ticket &ldquo;{detail.ticket.title}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the ticket, its step history, messages, and agent sessions
              from the board.
              {sourceOwned
                ? " This ticket is synced from an external work source and may reappear on the next source pull."
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? <p className="px-6 text-sm text-destructive">{deleteError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={deleteSubmitting} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={deleteSubmitting || !onDeleteTicket}
              data-testid="ticket-delete-confirm"
              onClick={() => void confirmDeleteTicket()}
            >
              {deleteSubmitting ? "Deleting…" : "Delete ticket"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </aside>
  );
}

/**
 * The parked-ticket banner: tier-colored (destructive for "issue", info for
 * "waiting" — the same token families as the card/strip), with the label
 * prominent, the full reason (the drawer has room, unlike the card's
 * `line-clamp-2`), an age readout, and the re-resolved recovery actions.
 * When actions are unavailable (board definition changed), the note points
 * at the "Move" select in the footer as the escape hatch.
 */
function TicketParkedBanner({
  ticketId,
  parked,
  now,
  onParkAction,
  parkActionPending = false,
}: {
  readonly ticketId: string;
  readonly parked: TicketDrawerParkedView;
  readonly now: number;
  readonly onParkAction?:
    | ((ticketId: string, actionIndex: number, parkedEventId: string) => Promise<void>)
    | undefined;
  readonly parkActionPending?: boolean | undefined;
}) {
  const aging = ticketAging(
    { status: "parked", parked: { substate: parked.substate, parkedAt: parked.parkedAt } },
    now,
  );
  const parkActions = parked.actions;
  const { primary, overflow } =
    parkActions !== undefined
      ? splitParkActions(parkActions)
      : { primary: undefined, overflow: [] };

  const inFlightRef = useRef(false);
  const [pending, setPending] = useState(false);
  const runAction = (index: number): void => {
    dispatchParkAction(
      {
        onParkAction,
        ticketId,
        actionIndex: index,
        parkedEventId: parked.parkedEventId,
      },
      {
        isInFlight: () => inFlightRef.current,
        begin: () => {
          inFlightRef.current = true;
          setPending(true);
        },
        end: () => {
          inFlightRef.current = false;
          setPending(false);
        },
      },
    );
  };

  const isIssue = parked.substate === "issue";
  // Disable while EITHER the local double-click guard or the shared route-level
  // in-flight flag is set, so this banner's buttons go dead the moment the card
  // or strip fires an action for the same ticket (belt-and-suspenders).
  const disabled = pending || parkActionPending;

  return (
    <div
      className={cn(
        "shrink-0 border-b px-4 py-3",
        isIssue ? "border-destructive/40 bg-destructive/8" : "border-info/40 bg-info/8",
      )}
      data-testid="ticket-parked-banner"
      data-tier={parked.substate}
    >
      <p
        className={cn(
          "text-sm font-semibold",
          isIssue ? "text-destructive-foreground" : "text-info-foreground",
        )}
        data-testid="ticket-parked-label"
      >
        {parked.label}
      </p>
      <p
        className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground"
        data-testid="ticket-parked-reason"
      >
        {parked.reason}
      </p>
      {aging !== null ? (
        <p
          className="mt-1 text-[11px] tabular-nums text-muted-foreground/80"
          data-testid="ticket-parked-age"
        >
          {aging.durationLabel}
        </p>
      ) : null}
      {parkActions !== undefined && primary !== undefined ? (
        <div
          className="mt-2 flex flex-wrap items-center gap-1.5"
          data-testid="ticket-parked-actions"
        >
          <Button
            size="xs"
            variant="secondary"
            disabled={disabled}
            onClick={() => runAction(primary.index)}
            {...(primary.action.hint !== undefined ? { title: primary.action.hint } : {})}
          >
            {primary.action.label}
          </Button>
          {overflow.length > 0 ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    disabled={disabled}
                    aria-label="More recovery actions"
                    data-testid="ticket-parked-actions-overflow"
                  />
                }
              >
                <MoreHorizontalIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                {overflow.map(({ action, index }) => (
                  <MenuItem
                    key={action.to + index}
                    onClick={() => runAction(index)}
                    {...(action.hint !== undefined ? { title: action.hint } : {})}
                  >
                    {action.label}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      ) : (
        <p
          className="mt-2 text-[11px] leading-4 text-muted-foreground"
          data-testid="ticket-parked-actions-unavailable"
        >
          Actions unavailable — board changed. Use "Move" below to recover.
        </p>
      )}
    </div>
  );
}

function TicketBlockedBanner({ reason }: { readonly reason?: string | undefined }) {
  const { summary, details } = blockedReasonParts(reason);
  return (
    <div
      className="shrink-0 border-b border-destructive/40 bg-destructive/8 px-4 py-3"
      data-testid="ticket-blocked-banner"
    >
      <p className="text-sm font-semibold text-destructive-foreground">Blocked</p>
      <p
        className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground"
        data-testid="ticket-blocked-reason"
      >
        {summary}
      </p>
      {details ? (
        <details className="mt-2 text-[11px] text-muted-foreground">
          <summary className="cursor-pointer font-medium text-destructive-foreground">
            Technical details
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-destructive/25 bg-background/55 p-2 leading-4">
            {details}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function blockedReasonParts(reason?: string | undefined): {
  readonly summary: string;
  readonly details: string | null;
} {
  const normalized = reason?.trim();
  if (!normalized) {
    return {
      summary: "This ticket is blocked, but no reason was reported.",
      details: null,
    };
  }
  const [summary = normalized, ...detailLines] = normalized.split("\n");
  const details = detailLines.join("\n").trim();
  return { summary, details: details || null };
}

function ticketBlockedReason(detail: TicketDrawerDetail): string | undefined {
  const ticketReason = detail.ticket.attentionReason?.trim();
  const stepError = [...detail.steps]
    .toReversed()
    .find((step) => step.error?.trim())
    ?.error?.trim();
  if (!stepError || ticketReason?.includes(stepError)) {
    return ticketReason;
  }
  return ticketReason ? `${ticketReason}\n${stepError}` : stepError;
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

// ---------------------------------------------------------------------------
// Shared sub-components used by both TicketDrawer and TicketFullscreen.
// Extracting these prevents JSX duplication and ensures bug fixes/additions
// only need to happen in one place.
// ---------------------------------------------------------------------------

/** Read-only description display. Used by both the drawer body and the fullscreen left column.
 *  `density="compact"` uses the drawer's tighter spacing (p-3, leading-5, h3).
 *  `density="spacious"` uses the fullscreen's roomier spacing (p-4, leading-6, h2). */
function TicketDescriptionView({
  description,
  density,
}: {
  readonly description: string;
  readonly density: "compact" | "spacious";
}) {
  if (!description) {
    return null;
  }
  if (density === "spacious") {
    return (
      <section
        className="rounded-md border border-border/70 bg-card/35 p-4"
        data-testid="ticket-description"
      >
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Description
        </h2>
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
          {description}
        </p>
      </section>
    );
  }
  return (
    <section
      className="rounded-md border border-border/70 bg-card/35 p-3"
      data-testid="ticket-description"
    >
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Description
      </h3>
      <p className="whitespace-pre-wrap break-words text-sm leading-5 text-foreground">
        {description}
      </p>
    </section>
  );
}

type TicketPrShape = NonNullable<TicketDrawerDetail["ticket"]["pr"]>;

/** The PR number link + state badge + optional CI-state badge row.
 *  Used in both the drawer header (with conditional `data-testid`s) and the
 *  fullscreen header (always with `data-testid`s). Pass `testIds` to render
 *  the `data-testid` attributes. `rowClassName` is applied to the outer `<p>`. */
function TicketPrBadges({
  pr,
  rowClassName,
  testIds,
}: {
  readonly pr: TicketPrShape;
  readonly rowClassName?: string | undefined;
  /** When true, renders `data-testid` attributes for automated tests. */
  readonly testIds?: boolean | undefined;
}) {
  return (
    <p
      className={cn("flex flex-wrap items-center gap-1.5 text-xs", rowClassName)}
      data-testid={testIds ? "ticket-pr-row" : undefined}
    >
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-foreground underline-offset-2 hover:underline"
        data-testid={testIds ? "ticket-pr-link" : undefined}
      >
        PR #{pr.number}
      </a>
      <span
        className={cn(
          "rounded-sm border px-1 py-0.5 text-[10px] font-medium",
          pr.state === "merged"
            ? "border-muted-foreground/30 text-muted-foreground"
            : pr.state === "closed"
              ? "border-muted-foreground/30 text-muted-foreground/70"
              : "border-success/40 text-success-foreground",
        )}
        data-testid={testIds ? "ticket-pr-state" : undefined}
      >
        {pr.state}
      </span>
      {pr.ciState !== undefined ? (
        <span
          className={cn(
            "rounded-sm border px-1 py-0.5 text-[10px] font-medium",
            pr.ciState === "failure"
              ? "border-destructive/40 text-destructive-foreground"
              : pr.ciState === "success"
                ? "border-success/40 text-success-foreground"
                : "border-muted-foreground/30 text-muted-foreground",
          )}
          data-testid={testIds ? "ticket-pr-ci-state" : undefined}
        >
          CI: {pr.ciState}
        </span>
      ) : null}
    </p>
  );
}

type DiscussionMessage = NonNullable<TicketDrawerDetail["messages"]>[number];

/** True when the viewer may edit a comment: it is their own free-form comment
 *  (`author === "user"`) and not an answer captured against an agent step. */
function canEditDiscussionMessage(message: DiscussionMessage): boolean {
  return message.author === "user" && message.stepRunId == null;
}

/** The Discussion `<section>` with the message thread.
 *  `density="compact"` uses the drawer's tighter spacing (p-3 / ml-5).
 *  `density="spacious"` uses the fullscreen's roomier spacing (p-4 / ml-6). */
type ContextPackView = NonNullable<TicketDrawerDetail["contextPack"]>;

const CONTEXT_PACK_SECTION_LABELS: Record<string, string> = {
  prior_outputs: "Prior step outputs",
  diff_summary: "Diff summary",
  failed_attempts: "Failed attempts",
  notes: "Notes",
};

/**
 * The "Handoff context" section: what the previous lane passed to this one.
 *
 * Renders nothing when there is no pack — every non-routed lane entry clears it,
 * so absence is the normal state for a manually-moved ticket.
 */
function TicketContextPackSection({
  pack,
  onSave,
  ticketId,
}: {
  readonly pack?: ContextPackView | undefined;
  readonly onSave?:
    | ((input: {
        readonly ticketId: string;
        readonly forLane: string;
        readonly sections: ReadonlyArray<{ readonly key: string; readonly body: string }>;
      }) => Promise<
        ReadonlyArray<{
          readonly key: string;
          readonly body: string;
          readonly autoGenerated: boolean;
        }>
      >)
    | undefined;
  readonly ticketId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [redacted, setRedacted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // What the server actually stored, shown until the parent's refetch lands.
  // Rendering the pre-save bodies instead would keep claiming text is stored
  // that is not — and would sit under a "redacted on save" note saying so.
  const [persisted, setPersisted] = useState<ContextPackView["sections"] | null>(null);

  // Identity of the pack currently on screen. A route into a new lane compiles a
  // fresh pack, and the post-save override must not outlive the pack it came
  // from — it would show one lane's handoff text under another lane's heading.
  const packKey =
    pack === undefined ? "" : `${pack.forLane}\u0000${pack.compiledAt}\u0000${pack.editedAt ?? ""}`;
  const [shownPackKey, setShownPackKey] = useState(packKey);
  if (shownPackKey !== packKey) {
    setShownPackKey(packKey);
    setPersisted(null);
    setRedacted(false);
    setSaveError(null);
    setEditing(false);
  }

  if (pack === undefined) {
    return null;
  }

  const shownSections = persisted ?? pack.sections;

  const startEditing = () => {
    // From what is on screen, which after a save is what the server STORED —
    // seeding from pack.sections would put the pre-save text back in the boxes.
    setDrafts(Object.fromEntries(shownSections.map((section) => [section.key, section.body])));
    setRedacted(false);
    setEditing(true);
  };

  const submit = (sections: ReadonlyArray<{ readonly key: string; readonly body: string }>) => {
    if (onSave === undefined) {
      return;
    }
    // An all-blank submission IS the delete gesture on the server, so it needs
    // the same confirmation as the explicit "Remove pack" button — otherwise
    // clearing the textareas and pressing Save destroys the pack silently.
    const meaningful = sections.filter((section) => section.body.trim().length > 0);
    if (meaningful.length === 0 && !window.confirm("Remove this handoff context pack?")) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    void onSave({ ticketId, forLane: pack.forLane, sections })
      .then((stored) => {
        // The server redacts secrets on save, so what came back can differ from
        // what was typed. Say so rather than silently showing different text.
        setRedacted(
          stored.some((section) => {
            const submitted = sections.find((candidate) => candidate.key === section.key);
            return submitted !== undefined && submitted.body.trim() !== section.body;
          }),
        );
        setPersisted(stored);
        setEditing(false);
      })
      .catch((error: unknown) => {
        // Keep the form open with the user's text: a failed save usually means
        // the ticket left the lane, and silently closing would lose the edit.
        setSaveError(error instanceof Error ? error.message : "Could not save handoff context.");
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <section
      className="rounded-md border border-border/70 bg-card/35 p-3"
      data-testid="ticket-context-pack"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">Handoff context</h3>
        <div className="flex items-center gap-2">
          {/* Pack-level badge keys off editedAt, not per-section flags: an edit
              that only removes or reorders sections stamps editedAt without
              marking any section, and that pack is still not pristine. */}
          {pack.editedAt !== undefined ? (
            <span className="text-2xs uppercase tracking-wide text-warning">edited</span>
          ) : null}
          {onSave !== undefined && !editing ? (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={startEditing}
            >
              Edit
            </button>
          ) : null}
        </div>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {`From ${pack.fromLane} · compiled ${pack.compiledAt}`}
      </p>
      {redacted ? (
        <p className="mt-1 text-xs text-warning">
          Some text was redacted on save; the stored version is shown.
        </p>
      ) : null}
      {saveError !== null ? (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {saveError}
        </p>
      ) : null}

      {editing ? (
        <div className="mt-2 space-y-2">
          {Object.entries(drafts).map(([key, body]) => (
            <label key={key} className="block">
              <span className="text-xs text-muted-foreground">
                {CONTEXT_PACK_SECTION_LABELS[key] ?? key}
              </span>
              <textarea
                className="mt-0.5 w-full rounded border border-border/70 bg-background p-2 font-mono text-xs"
                rows={6}
                value={body}
                onChange={(event) => {
                  setDrafts((prior) => ({ ...prior, [key]: event.target.value }));
                }}
              />
            </label>
          ))}
          {drafts["notes"] === undefined ? (
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => {
                setDrafts((prior) => ({ ...prior, notes: "" }));
              }}
            >
              Add notes section
            </button>
          ) : null}
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={saving}
              className="text-xs font-medium text-primary"
              onClick={() => {
                submit(Object.entries(drafts).map(([key, body]) => ({ key, body })));
              }}
            >
              Save
            </button>
            <button
              type="button"
              disabled={saving}
              className="text-xs text-muted-foreground"
              onClick={() => {
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              className="text-xs text-destructive"
              onClick={() => {
                // submit() confirms an empty submission for us.
                submit([]);
              }}
            >
              Remove pack
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {shownSections.map((section) => (
            <div key={section.key}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-foreground">
                  {CONTEXT_PACK_SECTION_LABELS[section.key] ?? section.key}
                </span>
                {section.autoGenerated ? null : (
                  <span className="text-2xs uppercase tracking-wide text-warning">edited</span>
                )}
              </div>
              <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-xs">
                {section.body}
              </pre>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * "History" — scrub this ticket's event stream and see the state it was in at
 * each point.
 *
 * Fetches lazily on first expand: a ticket's timeline can be thousands of
 * events, and most drawer opens never look at it.
 */
function TicketHistorySection({
  ticketId,
  onLoadTimeline,
}: {
  readonly ticketId: string;
  readonly onLoadTimeline?:
    | ((ticketId: string) => Promise<{
        readonly events: ReadonlyArray<WorkflowTimelineItem>;
        readonly truncated: boolean;
        readonly base?: WorkflowTimelineBase | undefined;
      }>)
    | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<{
    readonly events: ReadonlyArray<WorkflowTimelineItem>;
    readonly truncated: boolean;
    readonly base?: WorkflowTimelineBase | undefined;
  } | null>(null);
  const [selected, setSelected] = useState(0);

  if (onLoadTimeline === undefined) {
    return null;
  }

  const expand = () => {
    setOpen(true);
    // Refetch on every expand. Caching the first read made History a permanent
    // point-in-time snapshot: a step completing while the drawer stayed mounted
    // never appeared, and hide/show did not help.
    if (loading) {
      return;
    }
    setLoading(true);
    setError(null);
    void onLoadTimeline(ticketId)
      .then((result) => {
        setTimeline(result);
        // Open at the newest event: "what happened last" is the common question.
        setSelected(Math.max(0, result.events.length - 1));
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not load history.");
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const asOf =
    timeline === null ? null : reduceTicketReplay(timeline.events, timeline.base, selected);

  return (
    <section
      className="rounded-md border border-border/70 bg-card/35 p-3"
      data-testid="ticket-history"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">History</h3>
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => {
            if (open) {
              setOpen(false);
            } else {
              expand();
            }
          }}
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open ? (
        <div className="mt-2 space-y-2">
          {loading ? <p className="text-xs text-muted-foreground">Loading history…</p> : null}
          {error !== null ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {timeline !== null && timeline.events.length === 0 && !loading ? (
            <p className="text-xs text-muted-foreground">No history for this ticket.</p>
          ) : null}
          {timeline?.truncated === true ? (
            <p className="text-xs text-warning">
              Showing the most recent events only; earlier history is summarized.
            </p>
          ) : null}

          {timeline !== null && timeline.events.length > 0 ? (
            <>
              {asOf !== null ? (
                <div className="rounded bg-muted/40 p-2 text-xs" data-testid="ticket-history-as-of">
                  <div className="font-medium text-foreground">As of this event</div>
                  <div className="mt-0.5 text-muted-foreground">
                    {`lane ${asOf.laneKey} · ${asOf.status} · ${asOf.title}`}
                  </div>
                </div>
              ) : null}
              <ol className="max-h-64 space-y-0.5 overflow-auto">
                {timeline.events.map((entry, index) => (
                  <li key={entry.event.eventId}>
                    <button
                      type="button"
                      aria-current={index === selected}
                      className={cn(
                        "w-full rounded px-1.5 py-1 text-left font-mono text-xs",
                        index === selected
                          ? "bg-primary/15 text-foreground"
                          : "text-muted-foreground hover:bg-muted/40",
                      )}
                      onClick={() => {
                        setSelected(index);
                      }}
                    >
                      {(() => {
                        const mapped = toTimelineEntry(entry.event);
                        return (
                          <>
                            <span className="text-muted-foreground">
                              {`${mapped.occurredAt} · ${mapped.actor} · `}
                            </span>
                            <span className="text-foreground">{mapped.summary}</span>
                            {mapped.detail === undefined ? null : (
                              <span className="block truncate text-2xs text-muted-foreground">
                                {mapped.detail}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </button>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The reviewer-facing checkpoint form.
 *
 * The decision buttons ARE the submit: each carries its own routing outcome, so
 * there is no separate approve/reject. Required fields are enforced server-side
 * against the snapshot, and only for a success outcome; this form mirrors that
 * rather than blocking a rejection on an unfilled field.
 */
/**
 * Sentinel for the "Something else…" entry on an `allowOther` select.
 *
 * Deliberately not a plausible option value: it never leaves the component —
 * `submittedAnswers` swaps it for the typed text before submitting.
 */
const OTHER_VALUE = "__other__";

function CheckpointFormFields({
  form,
  disabled,
  onSubmit,
}: {
  readonly form: CheckpointForm;
  readonly disabled: boolean;
  readonly onSubmit: (
    decision: string | undefined,
    answers: Record<string, string | ReadonlyArray<string>>,
    /** Only meaningful for a form with no decision field. */
    approved?: boolean,
  ) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string | ReadonlyArray<string>>>({});
  // Free text typed against an `allowOther` select, kept apart from `answers`
  // so switching back to a listed option does not silently resubmit it.
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const decisionField = form.fields.find((field) => field.kind === "decision");

  const setAnswer = (key: string, value: string | ReadonlyArray<string>) => {
    setAnswers((prior) => ({ ...prior, [key]: value }));
  };

  const setOther = (key: string, value: string) => {
    setOtherText((prior) => ({ ...prior, [key]: value }));
  };

  /**
   * What actually goes to the server.
   *
   * An `allowOther` select whose selection is the sentinel submits the typed
   * text instead — the sentinel is a UI affordance and must never be persisted
   * as an answer.
   */
  const submittedAnswers = (): Record<string, string | ReadonlyArray<string>> => {
    const result: Record<string, string | ReadonlyArray<string>> = { ...answers };
    for (const field of form.fields) {
      if (field.kind !== "select" || field.allowOther !== true) continue;
      if (result[field.key] !== OTHER_VALUE) continue;
      const typed = (otherText[field.key] ?? "").trim();
      if (typed.length > 0) {
        result[field.key] = typed;
      } else {
        delete result[field.key];
      }
    }
    return result;
  };

  return (
    <div className="mt-2 space-y-2" data-testid="checkpoint-form">
      {form.fields.map((field) => {
        if (field.kind === "decision") {
          return null;
        }
        if (field.kind === "text") {
          return (
            <label key={field.key} className="block">
              <span className="text-xs text-muted-foreground">
                {field.label}
                {field.required === true ? " *" : ""}
              </span>
              <textarea
                className="mt-0.5 w-full rounded border border-border/70 bg-background p-2 text-xs"
                rows={2}
                placeholder={field.placeholder ?? ""}
                value={typeof answers[field.key] === "string" ? (answers[field.key] as string) : ""}
                onChange={(event) => {
                  setAnswer(field.key, event.target.value);
                }}
              />
            </label>
          );
        }
        if (field.kind === "select") {
          return (
            <label key={field.key} className="block">
              <span className="text-xs text-muted-foreground">
                {field.label}
                {field.required === true ? " *" : ""}
              </span>
              <select
                className="mt-0.5 w-full rounded border border-border/70 bg-background p-1.5 text-xs"
                value={typeof answers[field.key] === "string" ? (answers[field.key] as string) : ""}
                onChange={(event) => {
                  setAnswer(field.key, event.target.value);
                }}
              >
                <option value="">—</option>
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
                {field.allowOther === true ? (
                  <option value={OTHER_VALUE}>Something else…</option>
                ) : null}
              </select>
              {field.allowOther === true && answers[field.key] === OTHER_VALUE ? (
                // "None of these" — the answer sent is whatever is typed here,
                // not the sentinel, which exists only to reveal the input.
                <input
                  type="text"
                  autoFocus
                  className="mt-1 w-full rounded border border-border/70 bg-background p-1.5 text-xs"
                  placeholder="Your answer"
                  onChange={(event) => {
                    setOther(field.key, event.target.value);
                  }}
                  value={otherText[field.key] ?? ""}
                />
              ) : null}
            </label>
          );
        }
        const checked = Array.isArray(answers[field.key])
          ? (answers[field.key] as ReadonlyArray<string>)
          : [];
        return (
          <fieldset key={field.key} className="block">
            <legend className="text-xs text-muted-foreground">
              {field.label}
              {field.requireAll === true ? " (all)" : field.required === true ? " *" : ""}
            </legend>
            {field.items.map((item) => (
              <label key={item.value} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={checked.includes(item.value)}
                  onChange={(event) => {
                    setAnswer(
                      field.key,
                      event.target.checked
                        ? [...checked, item.value]
                        : checked.filter((value) => value !== item.value),
                    );
                  }}
                />
                {item.label}
              </label>
            ))}
          </fieldset>
        );
      })}

      <div className="flex flex-wrap gap-2">
        {decisionField !== undefined && decisionField.kind === "decision" ? (
          decisionField.options.map((option) => (
            <Button
              key={option.value}
              size="xs"
              variant={option.outcome === "success" ? "default" : "outline"}
              disabled={disabled}
              title={option.hint ?? ""}
              onClick={() => {
                onSubmit(option.value, submittedAnswers(), true);
              }}
            >
              {option.label}
            </Button>
          ))
        ) : (
          // A form with no decision field still needs BOTH outcomes: a single
          // Submit would always send success, leaving a reviewer no way to
          // reject while filling the form in.
          <>
            <Button
              size="xs"
              disabled={disabled}
              onClick={() => {
                onSubmit(undefined, submittedAnswers(), true);
              }}
            >
              <CheckIcon className="size-3.5" />
              Approve
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                onSubmit(undefined, submittedAnswers(), false);
              }}
            >
              <XIcon className="size-3.5" />
              Reject
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function TicketDiscussionSection({
  messages,
  density,
  cwd,
  onEditMessage,
}: {
  readonly messages?: ReadonlyArray<DiscussionMessage> | undefined;
  readonly density: "compact" | "spacious";
  readonly cwd?: string | undefined;
  readonly onEditMessage?: ((messageId: string, body: string) => Promise<void>) | undefined;
}) {
  const sectionPadding = density === "spacious" ? "p-4" : "p-3";
  const headerMargin = density === "spacious" ? "mb-3" : "mb-2";
  const itemPadding = density === "spacious" ? "p-3" : "p-2";
  const userIndent = density === "spacious" ? "ml-6" : "ml-5";
  const agentIndent = density === "spacious" ? "mr-6" : "mr-5";
  const Heading = density === "spacious" ? "h2" : "h3";
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  return (
    <section className={cn("rounded-md border border-border/70 bg-card/35", sectionPadding)}>
      <div className={cn("flex items-center justify-between gap-2", headerMargin)}>
        <Heading className="text-sm font-medium text-foreground">Discussion</Heading>
        <span className="text-xs text-muted-foreground">{messages?.length ?? 0}</span>
      </div>
      {messages && messages.length > 0 ? (
        <ol className="space-y-2">
          {messages.map((message) => (
            <li
              key={message.messageId}
              className={cn(
                "rounded-md border border-border/60 bg-background/70",
                itemPadding,
                message.author === "user" && `${userIndent} bg-accent/20`,
                message.author === "agent" && agentIndent,
              )}
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5 font-medium uppercase tracking-wide">
                  {message.author === "agent" ? "Agent" : "You"}
                  {"kind" in message && message.kind === "steering" ? (
                    <Badge size="sm" variant="warning" data-testid="steer-message-badge">
                      steered mid-run
                    </Badge>
                  ) : null}
                </span>
                <span className="flex items-center gap-1">
                  <time dateTime={message.createdAt}>
                    {formatMessageTimestamp(message.createdAt)}
                  </time>
                  {message.editedAt ? (
                    <span className="text-[11px] text-muted-foreground">· edited</span>
                  ) : null}
                  {onEditMessage &&
                  canEditDiscussionMessage(message) &&
                  editingMessageId !== message.messageId ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Edit comment"
                      title="Edit comment"
                      onClick={() => setEditingMessageId(message.messageId)}
                    >
                      <PencilIcon className="size-3" />
                    </Button>
                  ) : null}
                </span>
              </div>
              {onEditMessage && editingMessageId === message.messageId ? (
                <DiscussionMessageEditForm
                  initialBody={message.body}
                  cwd={cwd}
                  onSave={(body) => onEditMessage(message.messageId, body)}
                  onClose={() => setEditingMessageId(null)}
                />
              ) : (
                <>
                  {message.body ? (
                    <ChatMarkdown
                      text={message.body}
                      cwd={cwd}
                      lineBreaks
                      className="text-sm leading-5"
                    />
                  ) : null}
                  {message.attachments.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {message.attachments.map((attachment) => (
                        <TicketAttachmentPreview key={attachment.id} attachment={attachment} />
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">
          No discussion yet — leave a note below for the agent or your future self.
        </p>
      )}
    </section>
  );
}

/** Inline edit form for a single discussion comment. Mirrors the reply
 *  composer's Write/Preview affordance and surfaces save failures inline. */
function DiscussionMessageEditForm({
  initialBody,
  cwd,
  onSave,
  onClose,
}: {
  readonly initialBody: string;
  readonly cwd?: string | undefined;
  readonly onSave: (body: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState(initialBody);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) {
      setError("Comment cannot be empty.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSave(body);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the comment.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="space-y-2" onSubmit={handleSubmit}>
      <MarkdownComposerField
        value={draft}
        onChange={setDraft}
        disabled={submitting}
        ariaLabel="Edit comment"
        cwd={cwd}
      />
      {error ? <p className="text-xs text-destructive-foreground">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="xs" type="submit" disabled={submitting || !draft.trim()}>
          <CheckIcon className="size-3.5" />
          Save
        </Button>
        <Button size="xs" type="button" variant="outline" disabled={submitting} onClick={onClose}>
          <XIcon className="size-3.5" />
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The collapsible `<details>` route-history list rendered inside the "Why is
 *  this ticket here?" section. Both drawer and fullscreen share this block. */
function TicketRouteHistoryDetails({
  routeHistory,
  laneDisplayName,
  detailsClassName,
}: {
  readonly routeHistory: ReadonlyArray<RouteDecisionView>;
  readonly laneDisplayName: (key: string) => string;
  readonly detailsClassName?: string | undefined;
}) {
  if (routeHistory.length <= 1) {
    return null;
  }
  return (
    <details className={detailsClassName}>
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
                  <span className="text-xs font-medium text-foreground">{described.title}</span>
                  {entry ? (
                    <time dateTime={entry.occurredAt} className="text-[11px] text-muted-foreground">
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
  );
}

/** The reply / comment composer `<form>`. Both drawer (`p-3`) and fullscreen
 *  (`p-4`) use this form with their own padding class passed via `formClassName`. */
function TicketReplyComposer({
  canReply,
  replyText,
  setReplyText,
  replyAttachments,
  setReplyAttachments,
  replyError,
  replySubmitting,
  onAnswerStep,
  onPostComment,
  attachReplyImages,
  sendReply,
  cwd,
  formClassName,
}: {
  readonly canReply: boolean;
  readonly replyText: string;
  readonly setReplyText: (value: string) => void;
  readonly replyAttachments: ReadonlyArray<TicketDrawerAttachment>;
  readonly setReplyAttachments: (
    updater: (
      current: ReadonlyArray<TicketDrawerAttachment>,
    ) => ReadonlyArray<TicketDrawerAttachment>,
  ) => void;
  readonly replyError: string | null;
  readonly replySubmitting: boolean;
  readonly onAnswerStep?: ((input: TicketDrawerAnswerInput) => Promise<void>) | undefined;
  readonly onPostComment?: ((input: TicketDrawerCommentInput) => Promise<void>) | undefined;
  readonly attachReplyImages: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  readonly sendReply: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly cwd?: string | undefined;
  readonly formClassName?: string | undefined;
}) {
  return (
    <form
      className={cn(
        "rounded-md border",
        canReply ? "border-warning/40 bg-warning/5" : "border-border/70 bg-card/35",
        formClassName,
      )}
      onSubmit={sendReply}
    >
      <MarkdownComposerField
        value={replyText}
        onChange={setReplyText}
        disabled={replySubmitting}
        label={canReply ? "Ticket reply" : "Add a comment"}
        cwd={cwd}
      />
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
      {replyError ? <p className="mt-2 text-xs text-destructive-foreground">{replyError}</p> : null}
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
  );
}

type StepRowStep = TicketDrawerDetail["steps"][number];

const OPEN_STEP_STATUSES = new Set(["pending", "dispatch_requested", "running", "awaiting_user"]);

function presentTicketStep(detail: TicketDrawerDetail, index: number): StepRowStep {
  const step = detail.steps[index];
  if (step === undefined || !OPEN_STEP_STATUSES.has(step.status)) {
    return step as StepRowStep;
  }

  const hasLaterStartedStep = detail.steps
    .slice(index + 1)
    .some((candidate) => candidate.startedAt !== undefined);
  if (hasLaterStartedStep) {
    return {
      ...step,
      status: "superseded",
      waitingReason: null,
      blockedReason: null,
    };
  }

  if (detail.ticket.status === "blocked") {
    return {
      ...step,
      status: "blocked",
      waitingReason: null,
      blockedReason:
        (detail.ticket.attentionReason
          ? blockedReasonParts(detail.ticket.attentionReason).summary
          : null) ||
        step.blockedReason ||
        "This step stopped because the ticket is blocked.",
    };
  }

  return step;
}

/** A single step row `<li>`. Shared between the drawer and the fullscreen right
 *  column. The `liClassName` lets each context supply its own padding. */
function TicketStepRow({
  step,
  api,
  projectId,
  ticketId,
  approvalSubmittingStepRunId,
  approvalError,
  stepOutputTestId,
  onRunLane,
  submitApproval,
  onSteered,
  liClassName,
}: {
  readonly step: StepRowStep;
  readonly api?: EnvironmentApi | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly ticketId?: string | undefined;
  readonly approvalSubmittingStepRunId: string | null;
  readonly approvalError: { readonly stepRunId: string; readonly message: string } | null;
  /** data-testid applied to the step output `<div>`. Pass undefined to omit. */
  readonly stepOutputTestId?: string | undefined;
  readonly onRunLane: () => void;
  readonly submitApproval: (
    stepRunId: string,
    approved: boolean,
    submission?: {
      readonly decision?: string | undefined;
      readonly answers?: Record<string, string | ReadonlyArray<string>> | undefined;
    },
  ) => Promise<void>;
  readonly onSteered?: (() => void) | undefined;
  readonly liClassName?: string | undefined;
}) {
  return (
    <li
      className={cn(
        "rounded-md border border-border/60 bg-background/70",
        step.status === "awaiting_user" && "border-warning/45 bg-warning/5",
        step.status === "blocked" && "border-destructive/45 bg-destructive/5",
        liClassName,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{step.stepKey}</p>
          <p className="text-xs text-muted-foreground">
            {step.stepType}
            {step.attempt !== undefined && step.attempt > 1 ? ` · attempt ${step.attempt}` : null}
            {stepUsageSummary(step) !== null ? ` · ${stepUsageSummary(step)}` : null}
            {step.startedAt ? ` · started ${formatMessageTimestamp(step.startedAt)}` : null}
          </p>
        </div>
        <Badge size="sm" variant={stepBadgeVariant(step)}>
          {formatStepBadgeLabel(step)}
        </Badge>
      </div>
      {step.waitingReason ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.waitingReason}</p>
      ) : null}
      {step.blockedReason ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.blockedReason}</p>
      ) : null}
      {step.error && step.error !== step.blockedReason ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-destructive-foreground">
          {step.error}
        </p>
      ) : null}
      {step.output !== undefined && step.output !== null ? (
        <div className="mt-2" data-testid={stepOutputTestId}>
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
      {isScriptStepWithTerminal(step) ? <ScriptStepLogViewer api={api} step={step} /> : null}
      {step.stepType === "agent" &&
      step.providerThreadId !== undefined &&
      (step.status === "running" ||
        step.status === "dispatch_requested" ||
        step.status === "awaiting_user") ? (
        <StepActivityFeed api={api} threadId={step.providerThreadId as never} live />
      ) : null}
      {api && ticketId !== undefined && step.stepType === "agent" ? (
        <SteerComposer api={api} ticketId={ticketId} step={step} onSteered={onSteered} />
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
      {isAwaitingApprovalRequestStep(step) && step.form !== undefined ? (
        <>
          <CheckpointFormFields
            form={step.form}
            disabled={approvalSubmittingStepRunId === step.stepRunId}
            onSubmit={(decision, answers, approved) => {
              // The server ignores `approved` when a decision is present; the
              // chosen option's outcome decides the routing.
              void submitApproval(step.stepRunId, approved ?? true, { decision, answers });
            }}
          />
          {approvalError?.stepRunId === step.stepRunId ? (
            // Required-field and unknown-option rejections come back from the
            // server; without this the button just re-enables silently.
            <p className="mt-1 text-xs text-destructive" role="alert">
              {approvalError.message}
            </p>
          ) : null}
        </>
      ) : null}
      {isAwaitingApprovalRequestStep(step) && step.form === undefined ? (
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
              void api.workflow.setProjectScriptTrust({ projectId, trusted: true }).then(onRunLane);
            }}
          >
            <CheckIcon className="size-3.5" />
            Trust this project &amp; run
          </Button>
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Grouped prop shapes used by TicketFullscreen to reduce the call-site surface.
// ---------------------------------------------------------------------------

interface TicketFullscreenEditState {
  readonly draftTitle: string;
  readonly draftDescription: string;
  readonly editError: string | null;
  readonly editSubmitting: boolean;
  readonly setDraftTitle: (value: string) => void;
  readonly setDraftDescription: (value: string) => void;
  readonly saveTicketEdit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly cancelEdit: () => void;
}

interface TicketFullscreenReplyState {
  readonly canReply: boolean;
  readonly replyText: string;
  readonly setReplyText: (value: string) => void;
  readonly replyAttachments: ReadonlyArray<TicketDrawerAttachment>;
  readonly setReplyAttachments: (
    updater: (
      current: ReadonlyArray<TicketDrawerAttachment>,
    ) => ReadonlyArray<TicketDrawerAttachment>,
  ) => void;
  readonly replyError: string | null;
  readonly replySubmitting: boolean;
  readonly onAnswerStep?: ((input: TicketDrawerAnswerInput) => Promise<void>) | undefined;
  readonly onPostComment?: ((input: TicketDrawerCommentInput) => Promise<void>) | undefined;
  readonly attachReplyImages: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  readonly sendReply: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}

interface TicketFullscreenApprovalState {
  readonly approvalSubmittingStepRunId: string | null;
  readonly approvalError: { readonly stepRunId: string; readonly message: string } | null;
  readonly submitApproval: (
    stepRunId: string,
    approved: boolean,
    submission?: {
      readonly decision?: string | undefined;
      readonly answers?: Record<string, string | ReadonlyArray<string>> | undefined;
    },
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Full-screen overlay — renders all ticket fields in a spacious multi-column
// layout. Reuses the drawer's inner sub-components and helper functions.
// Composes WorkflowEditorFullscreen for Escape-to-close, body-overflow lock,
// and focus-trap behaviour.
// ---------------------------------------------------------------------------

/** Exported for direct testing — the parent `TicketDrawer`'s `fullscreen`
 *  state can only be reached via a button click, which the test suite here
 *  (Node, no DOM) cannot dispatch through `renderToStaticMarkup`. */
export function TicketFullscreen({
  api,
  detail,
  conversationStep = null,
  lanes,
  laneDisplayName,
  laneActions,
  canRunLane,
  runLaneTitle,
  routeHistory,
  latestRouteDecision,
  ticketDescription,
  editState,
  sourceOwned,
  onStartEdit,
  onEditTicket,
  replyState,
  approvalState,
  waitingStepCount,
  projectId,
  cwd,
  onEditMessage,
  onMove,
  onRunLane,
  onSteered,
  onParkAction,
  parkActionPending = false,
  now,
  onRequestDelete,
  onClose,
}: {
  readonly api?: EnvironmentApi | undefined;
  readonly detail: TicketDrawerDetail;
  readonly conversationStep?: { readonly stepKey: string; readonly threadId: string } | null;
  readonly lanes: ReadonlyArray<TicketDrawerLane>;
  readonly laneDisplayName: (key: string) => string;
  readonly laneActions: ReadonlyArray<TicketDrawerLaneAction>;
  readonly canRunLane: boolean;
  readonly runLaneTitle: string;
  readonly routeHistory: ReadonlyArray<RouteDecisionView>;
  readonly latestRouteDecision: ReturnType<typeof describeRouteDecision> | null;
  readonly ticketDescription: string;
  /** Non-null when the user has clicked "Edit ticket" in the drawer before opening fullscreen. */
  readonly editState: TicketFullscreenEditState | null;
  readonly sourceOwned: boolean;
  readonly onStartEdit?: (() => void) | undefined;
  readonly onEditTicket?: ((input: TicketDrawerEditInput) => Promise<void>) | undefined;
  readonly replyState: TicketFullscreenReplyState;
  readonly approvalState: TicketFullscreenApprovalState;
  readonly waitingStepCount: number;
  readonly projectId?: ProjectId | undefined;
  readonly cwd?: string | undefined;
  readonly onEditMessage?: ((messageId: string, body: string) => Promise<void>) | undefined;
  readonly onMove?: ((toLane: string) => void) | undefined;
  readonly onRunLane: () => void;
  readonly onSteered?: (() => void) | undefined;
  readonly onParkAction?:
    | ((ticketId: string, actionIndex: number, parkedEventId: string) => Promise<void>)
    | undefined;
  readonly parkActionPending?: boolean | undefined;
  readonly now: number;
  readonly onRequestDelete?: (() => void) | undefined;
  readonly onClose: () => void;
}) {
  const ticket = detail.ticket;

  return (
    <WorkflowEditorFullscreen open ariaLabel="Ticket detail" onClose={onClose}>
      {/* Header */}
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0 flex-1">
          {ticket.pr !== undefined ? (
            <TicketPrBadges pr={ticket.pr} rowClassName="mb-1" testIds />
          ) : null}
          <h1 className="text-xl font-semibold text-foreground">{ticket.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span>
              {laneDisplayName(ticket.currentLaneKey)} / {formatStatusLabel(ticket.status)}
            </span>
            {ticket.boardId ? (
              <span className="font-mono text-xs opacity-60">board:{ticket.boardId}</span>
            ) : null}
            {detail.syncedSource ? (
              <a
                href={detail.syncedSource.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-sm border border-info/40 bg-info/8 px-1.5 py-0.5 text-[10px] font-medium text-info-foreground underline-offset-2 hover:underline"
                data-testid="ticket-synced-source-badge"
              >
                Synced from {detail.syncedSource.provider} ↗
              </a>
            ) : null}
            {detail.syncedSource?.assignees && detail.syncedSource.assignees.length > 0 ? (
              <span className="text-xs">Assignees: {detail.syncedSource.assignees.join(", ")}</span>
            ) : null}
            {detail.syncedSource?.labels && detail.syncedSource.labels.length > 0 ? (
              <span className="text-xs">Labels: {detail.syncedSource.labels.join(", ")}</span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {waitingStepCount > 0 ? (
            <Badge variant="warning" size="sm">
              waiting on you
            </Badge>
          ) : null}
          {conversationStep !== null ? (
            <AgentSessionDialog
              api={api}
              threadId={ThreadId.make(conversationStep.threadId)}
              stepKey={conversationStep.stepKey}
              label="Open conversation"
              title={`Open conversation for step ${conversationStep.stepKey}`}
              testId="ticket-open-conversation"
            />
          ) : null}
          {!sourceOwned && onStartEdit ? (
            <Button size="xs" variant="outline" disabled={!onEditTicket} onClick={onStartEdit}>
              <PencilIcon className="size-3.5" />
              Edit ticket
            </Button>
          ) : null}
          {onRequestDelete ? (
            <Button
              size="xs"
              variant="destructive-outline"
              data-testid="ticket-delete"
              aria-label={`Delete ticket ${ticket.title}`}
              onClick={onRequestDelete}
            >
              <Trash2Icon className="size-3.5" />
              Delete
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Collapse ticket to drawer"
            title="Exit full screen"
            onClick={onClose}
          >
            <Minimize2Icon className="size-3.5" />
          </Button>
        </div>
      </header>

      {/* Parked banner (fullscreen view): the fullscreen overlay is a portal
          to document.body (WorkflowEditorFullscreen) rendered while the
          drawer's own `<aside>` (and its collapsed-view banner) is inert and
          eclipsed — so this fullscreen view needs its own copy, right under
          its own header, to keep label/reason/age/actions reachable. */}
      {ticket.parked !== undefined ? (
        <TicketParkedBanner
          ticketId={ticket.ticketId}
          parked={ticket.parked}
          now={now}
          onParkAction={onParkAction}
          parkActionPending={parkActionPending}
        />
      ) : null}
      {ticket.status === "blocked" ? (
        <TicketBlockedBanner reason={ticketBlockedReason(detail)} />
      ) : null}

      {/* Body — two-column on wide screens. Columns own their scroll; the
          outer shell stays overflow-hidden so a tall right-column diff cannot
          push lane controls into an overlapping paint stack. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {/* Left column: description, route, discussion, reply */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto border-b border-border/60 p-6 lg:border-b-0 lg:border-r">
          {editState ? (
            <form className="space-y-2" onSubmit={editState.saveTicketEdit}>
              <label className="block space-y-1 text-xs font-medium text-muted-foreground">
                Ticket title
                <Input
                  size="sm"
                  value={editState.draftTitle}
                  disabled={sourceOwned || editState.editSubmitting}
                  onChange={(event) => editState.setDraftTitle(event.currentTarget.value)}
                />
              </label>
              <label className="block space-y-1 text-xs font-medium text-muted-foreground">
                Ticket description
                <Textarea
                  size="sm"
                  value={editState.draftDescription}
                  disabled={sourceOwned || editState.editSubmitting}
                  onChange={(event) => editState.setDraftDescription(event.currentTarget.value)}
                />
              </label>
              {editState.editError ? (
                <p className="text-xs text-destructive-foreground">{editState.editError}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="xs"
                  type="submit"
                  disabled={
                    !editState.draftTitle.trim() || !onEditTicket || editState.editSubmitting
                  }
                >
                  <CheckIcon className="size-3.5" />
                  Save ticket
                </Button>
                <Button
                  size="xs"
                  type="button"
                  variant="outline"
                  disabled={editState.editSubmitting}
                  onClick={editState.cancelEdit}
                >
                  <XIcon className="size-3.5" />
                  Cancel edit
                </Button>
              </div>
            </form>
          ) : (
            <TicketDescriptionView description={ticketDescription} density="spacious" />
          )}

          {latestRouteDecision ? (
            <section
              className="rounded-md border border-info/40 bg-info/5 p-4"
              data-testid="ticket-route-why"
            >
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Why is this ticket here?
              </h2>
              <p className="mt-1 text-sm font-medium text-foreground">
                {latestRouteDecision.title}
              </p>
              {latestRouteDecision.details.length > 0 ? (
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {latestRouteDecision.details.join(" · ")}
                </p>
              ) : null}
              <TicketRouteHistoryDetails
                routeHistory={routeHistory}
                laneDisplayName={laneDisplayName}
                detailsClassName="mt-3"
              />
            </section>
          ) : null}

          {/* Discussion */}
          <TicketDiscussionSection
            messages={detail.messages}
            density="spacious"
            cwd={cwd}
            onEditMessage={onEditMessage}
          />

          {/* Reply / comment composer */}
          {replyState.canReply || replyState.onPostComment ? (
            <TicketReplyComposer
              canReply={replyState.canReply}
              replyText={replyState.replyText}
              setReplyText={replyState.setReplyText}
              replyAttachments={replyState.replyAttachments}
              setReplyAttachments={replyState.setReplyAttachments}
              replyError={replyState.replyError}
              replySubmitting={replyState.replySubmitting}
              onAnswerStep={replyState.onAnswerStep}
              onPostComment={replyState.onPostComment}
              attachReplyImages={replyState.attachReplyImages}
              sendReply={replyState.sendReply}
              cwd={cwd}
              formClassName="p-4"
            />
          ) : null}
        </div>

        {/* Right column: scrollable steps/artifacts/diff + pinned lane controls.
            Mirrors the drawer (scroll body + shrink-0 footer) so a tall
            accumulated diff cannot paint over Run lane / Move. Children of the
            scroll region are shrink-0 so flex shrink never clips a card mid-
            title — the column scrolls instead. */}
        <div className="flex min-h-0 w-full flex-col lg:w-[480px] xl:w-[560px]">
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden p-6">
            {/* Steps */}
            <section className="shrink-0 rounded-md border border-border/70 bg-card/35 p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-foreground">Steps</h2>
                <span className="text-xs text-muted-foreground">{detail.steps.length}</span>
              </div>
              <ol className="space-y-2">
                {detail.steps.map((step, index) => (
                  <TicketStepRow
                    key={step.stepRunId}
                    step={presentTicketStep(detail, index)}
                    api={api}
                    projectId={projectId}
                    ticketId={detail.ticket.ticketId}
                    approvalSubmittingStepRunId={approvalState.approvalSubmittingStepRunId}
                    approvalError={approvalState.approvalError}
                    stepOutputTestId="step-captured-output"
                    onRunLane={onRunLane}
                    submitApproval={approvalState.submitApproval}
                    onSteered={onSteered}
                    liClassName="p-3"
                  />
                ))}
              </ol>
            </section>

            {api ? (
              <div className="shrink-0">
                <TicketArtifacts api={api} ticketId={detail.ticket.ticketId} />
              </div>
            ) : null}
            {api ? (
              <div className="shrink-0">
                <TicketDiff api={api} ticketId={TicketId.make(detail.ticket.ticketId)} />
              </div>
            ) : null}
          </div>

          {/* Lane actions + move controls — pinned below the scroll region */}
          <footer
            className="shrink-0 space-y-3 border-t border-border bg-background px-6 py-4"
            data-testid="ticket-fullscreen-lane-controls"
          >
            <h2 className="text-sm font-medium text-foreground">Lane controls</h2>
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
        </div>
      </div>
    </WorkflowEditorFullscreen>
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
  if (step.status === "awaiting_user") {
    return "warning";
  }
  if (step.status === "blocked" || step.status === "failed" || step.scriptStatus === "timeout") {
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

/**
 * A wait the operator answers with the checkpoint form (or Approve/Reject).
 *
 * Three shapes reach here, and the third is easy to miss: a provider permission
 * prompt, a board-authored approval step, and an AGENT step that paused to ask
 * a question. The last one is an agent step whose wait carries a form and no
 * provider kind — it deliberately sets none, which is what lets the ordinary
 * resolve path accept it. Without this arm the ticket would say "needs you"
 * while the drawer offered nothing to answer with.
 */
function isAwaitingApprovalRequestStep(step: TicketDrawerDetail["steps"][number]): boolean {
  const noProviderKind =
    step.providerResponseKind === null || step.providerResponseKind === undefined;
  return (
    step.status === "awaiting_user" &&
    (step.providerResponseKind === "request" ||
      (step.stepType === "approval" && noProviderKind) ||
      (step.stepType === "agent" && noProviderKind && step.form !== undefined))
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
    if (!api?.terminal) {
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
