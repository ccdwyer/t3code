import type { WorkflowEvent } from "@t3tools/contracts";

export type SlackAgentStatusKind =
  | "accepted"
  | "queued"
  | "running"
  | "waiting"
  | "blocked"
  | "failed"
  | "pr_ready"
  | "done";

export interface SlackAgentStatusInput {
  readonly runId: string;
  readonly ticketId: string;
  readonly title: string;
  readonly event: WorkflowEvent;
  readonly workflowSequence: number;
  readonly prUrl?: string | null;
  readonly isTerminal?: boolean;
}

export interface SlackAgentStatusPayload {
  readonly runId: string;
  readonly ticketId: string;
  readonly workflowSequence: number;
  readonly status: SlackAgentStatusKind;
  readonly kind: "progress" | "needs_attention" | "pr_opened" | "done";
  readonly headline: string;
  readonly body: string;
  readonly text: string;
  readonly prUrl?: string;
}

const MAX_TITLE = 120;
const MAX_BODY = 700;

const redact = (value: string): string =>
  value
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted]")
    .replace(/xapp-[A-Za-z0-9-]+/g, "[redacted]")
    .replace(/https:\/\/hooks\.slack\.com\/services\/[^\s)]+/g, "[redacted-slack-url]");

const clip = (value: string, max: number): string => {
  const clean = redact(value).replace(/\s+/g, " ").trim();
  if (clean.length <= max) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
};

const eventSummary = (
  event: WorkflowEvent,
  isTerminal: boolean,
): {
  readonly status: SlackAgentStatusKind;
  readonly kind: SlackAgentStatusPayload["kind"];
  readonly body: string;
} => {
  switch (event.type) {
    case "TicketQueued":
      return { status: "queued", kind: "progress", body: `Queued in ${event.payload.lane}` };
    case "TicketAdmitted":
      return { status: "running", kind: "progress", body: `Admitted to ${event.payload.lane}` };
    case "TicketMovedToLane":
      return isTerminal
        ? { status: "done", kind: "done", body: `Completed in ${event.payload.toLane}` }
        : { status: "running", kind: "progress", body: `Moved to ${event.payload.toLane}` };
    case "PipelineStarted":
      return { status: "running", kind: "progress", body: `Started ${event.payload.laneKey}` };
    case "StepStarted":
      return {
        status: "running",
        kind: "progress",
        body: `Started ${event.payload.stepKey}${
          event.payload.attempt === undefined || event.payload.attempt <= 1
            ? ""
            : ` (attempt ${event.payload.attempt})`
        }`,
      };
    case "StepRetryScheduled":
      return {
        status: "running",
        kind: "progress",
        body: `Retry scheduled for ${event.payload.stepKey} (attempt ${event.payload.nextAttempt}/${event.payload.maxAttempts})`,
      };
    case "StepAwaitingUser":
      return {
        status: "waiting",
        kind: "needs_attention",
        body: `Waiting on you: ${event.payload.waitingReason}`,
      };
    case "StepBlocked":
      return {
        status: "blocked",
        kind: "needs_attention",
        body: `Step blocked: ${event.payload.reason}`,
      };
    case "TicketBlocked":
      return {
        status: "blocked",
        kind: "needs_attention",
        body: `Blocked: ${event.payload.reason}`,
      };
    case "TicketParked":
      return {
        status: "blocked",
        kind: "needs_attention",
        body:
          event.payload.substate === "issue"
            ? `Parked with issue: ${event.payload.reason}`
            : `Parked waiting: ${event.payload.label}`,
      };
    case "TicketPrOpened":
      return {
        status: "pr_ready",
        kind: "pr_opened",
        body: `Pull request opened: ${event.payload.url}`,
      };
    default:
      return { status: "running", kind: "progress", body: event.type };
  }
};

export const renderSlackAgentStatus = (input: SlackAgentStatusInput): SlackAgentStatusPayload => {
  const summary = eventSummary(input.event, input.isTerminal === true);
  const title = clip(input.title, MAX_TITLE);
  const body = clip(summary.body, MAX_BODY);
  const prUrl = input.event.type === "TicketPrOpened" ? input.event.payload.url : input.prUrl;
  const ticketLine = `Ticket: t3://ticket/${input.ticketId}`;
  const text =
    prUrl === undefined || prUrl === null || prUrl === ""
      ? `${body}\n${ticketLine}`
      : `${body}\n${ticketLine}\n${prUrl}`;
  return {
    runId: input.runId,
    ticketId: input.ticketId,
    workflowSequence: input.workflowSequence,
    status: summary.status,
    kind: summary.kind,
    headline: title === "" ? "Workflow update" : title,
    body,
    text,
    ...(prUrl === undefined || prUrl === null || prUrl === "" ? {} : { prUrl }),
  };
};

export const SLACK_STATUS_EVENT_TYPES = new Set<WorkflowEvent["type"]>([
  "TicketQueued",
  "TicketAdmitted",
  "TicketMovedToLane",
  "PipelineStarted",
  "StepStarted",
  "StepAwaitingUser",
  "StepRetryScheduled",
  "StepBlocked",
  "TicketBlocked",
  "TicketParked",
  "TicketPrOpened",
]);
