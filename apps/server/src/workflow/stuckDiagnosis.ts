import type {
  LaneKey,
  StepRunId,
  TicketId,
  WorkflowStuckDiagnosis,
  WorkflowUnstickActionView,
} from "@t3tools/contracts";
import { isTokenBudgetBlock } from "@t3tools/shared/tokenBudgetBlock";

export interface ProjectedTicketLite {
  readonly status: string;
  readonly currentLaneKey: string;
  readonly queuedAt?: string | null | undefined;
  readonly currentLaneEnteredAt?: string | null | undefined;
  readonly updatedAt: string;
  readonly terminalAt?: string | null | undefined;
  readonly attentionKind?: string | null | undefined;
  readonly attentionReason?: string | null | undefined;
  readonly unresolvedDependencyCount?: number | undefined;
  /** The FULL edge set: `expectedDependsOn` cannot be rebuilt from a count. */
  readonly dependsOn?: ReadonlyArray<TicketId> | undefined;
  readonly tokenBudget?: number | null | undefined;
  readonly totalTokens?: number | null | undefined;
  /** Null means the ticket is not admitted, which gates every runLane action. */
  readonly currentLaneEntryToken?: string | null | undefined;
}

export interface LaneLite {
  readonly key: LaneKey;
  readonly name: string;
  readonly entry: "auto" | "manual";
  readonly wipLimit?: number | undefined;
  readonly pipelineStepCount: number;
  readonly terminal?: boolean | undefined;
}

export interface StepRunLite {
  readonly stepRunId: StepRunId;
  readonly status: string;
  readonly stepType: string;
  readonly waitingReason?: string | null | undefined;
  readonly providerResponseKind?: string | null | undefined;
  readonly error?: string | null | undefined;
  readonly retryable?: boolean | null | undefined;
  readonly attempt?: number | null | undefined;
  readonly startedAt?: string | null | undefined;
  readonly finishedAt?: string | null | undefined;
  /**
   * The wait carries a checkpoint form of ANY shape.
   *
   * The unstick action contract carries no answers, so a bare approve/reject
   * cannot satisfy a form wait: a decision field rejects it for want of a
   * decision, and a required text/select/checklist rejects it for want of that
   * answer. Suppressing only decision forms would still leave required-field
   * forms erroring, so the whole class is excluded.
   */
  readonly hasCheckpointForm?: boolean | undefined;
}

export interface DiagnoseTicketInput {
  readonly ticket: ProjectedTicketLite;
  /** Undefined means the lane is gone from the current board definition. */
  readonly lane: LaneLite | undefined;
  readonly laneAdmittedCount: number;
  readonly latestStep: StepRunLite | undefined;
  readonly firstUnresolvedDependency: TicketId | undefined;
  /**
   * Pre-resolved by the caller: the current lane's first declared action whose
   * target lane still exists. The pure function cannot see other lanes, so it
   * can neither validate nor label a move target itself.
   */
  readonly moveTarget: { readonly toLane: LaneKey; readonly label: string } | undefined;
}

const TEN_MINUTES = 10 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;

/** Collapse newlines and runs of whitespace so a reason renders as one line. */
const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`;

const openAction: WorkflowUnstickActionView = {
  type: "openTicket",
  label: "Open",
};

/**
 * Whether a `runLane` action would actually do anything.
 *
 * `WorkflowEngine.runLane` silently no-ops unless the ticket holds a lane entry
 * token and the lane has steps, so offering the button outside those conditions
 * would give the user a control that does nothing.
 */
const canRunLane = (input: DiagnoseTicketInput): boolean =>
  input.ticket.currentLaneEntryToken !== null &&
  input.ticket.currentLaneEntryToken !== undefined &&
  input.lane !== undefined &&
  input.lane.pipelineStepCount > 0;

/**
 * Why a ticket is stuck, or undefined when it is not.
 *
 * Pure over already-projected rows: no daemon, no new events, no table. It runs
 * wherever a ticket view is assembled, so the diagnosis can never disagree with
 * the row it ships beside.
 *
 * Parked, running and terminal tickets are never diagnosed. Parked tickets keep
 * their existing park-action UX, and a terminal ticket sitting still is finished
 * rather than stuck — the terminal guard lives HERE rather than only in the
 * caller's filter so no caller can forget it.
 */
export const diagnoseTicket = (input: DiagnoseTicketInput): WorkflowStuckDiagnosis | undefined => {
  const { ticket, lane, latestStep } = input;
  if (ticket.terminalAt !== null && ticket.terminalAt !== undefined) {
    return undefined;
  }
  if (ticket.status === "parked" || ticket.status === "running") {
    return undefined;
  }

  if (ticket.status === "waiting_on_user") {
    const liveApprovalStep =
      latestStep?.status === "awaiting_user" &&
      latestStep.providerResponseKind !== "user-input" &&
      latestStep.stepRunId !== undefined
        ? latestStep
        : undefined;
    const isApproval =
      ticket.attentionKind === "waiting_for_approval" ||
      (latestStep?.status === "awaiting_user" &&
        (latestStep.providerResponseKind === "request" ||
          // A native approval step emits StepAwaitingUser with no kind, and the
          // projector maps that absence to waiting_for_input — which would route
          // it to an Answer action that answerTicketStep rejects.
          (latestStep.stepType === "approval" &&
            (latestStep.providerResponseKind === null ||
              latestStep.providerResponseKind === undefined))));

    if (isApproval) {
      const actions: Array<WorkflowUnstickActionView> = [];
      if (liveApprovalStep !== undefined && liveApprovalStep.hasCheckpointForm !== true) {
        // Only with a live awaiting step, and never for a form wait: a stale
        // stepRunId resolves nothing, and a bare approve on any form is rejected
        // for a missing decision or a missing required answer. Either way the
        // button would lie.
        actions.push(
          {
            type: "resolveApproval",
            label: "Approve",
            stepRunId: liveApprovalStep.stepRunId,
            approved: true,
          },
          {
            type: "resolveApproval",
            label: "Reject",
            stepRunId: liveApprovalStep.stepRunId,
            approved: false,
          },
        );
      }
      actions.push(openAction);
      return {
        kind: "waiting_approval",
        summary: "Approval waiting",
        since: ticket.updatedAt as WorkflowStuckDiagnosis["since"],
        displayAfterMs: 0,
        actions,
      };
    }

    // attentionKind alone cannot tell an agent question from a native approval:
    // the projector stamps BOTH as waiting_for_input, because a native approval
    // emits no response kind. Without a step row to disambiguate, say the
    // neutral thing rather than offering an Answer box for an approval.
    // An agent that paused to ask its own question also projects
    // waiting_for_input, but it is answered with the FORM through the approval
    // path — the freeform answer RPC hard-rejects anything that is not a
    // provider `user-input` wait. Offering an Answer box for it would be an
    // action that can only fail, so it takes the neutral summary and the plain
    // open action.
    const isAgentQuestion =
      latestStep?.stepType === "agent" &&
      latestStep.hasCheckpointForm === true &&
      (latestStep.providerResponseKind === null || latestStep.providerResponseKind === undefined);
    const isInput =
      !isAgentQuestion &&
      (latestStep?.providerResponseKind === "user-input" ||
        (ticket.attentionKind === "waiting_for_input" && latestStep !== undefined));
    return {
      kind: "waiting_input",
      summary: isInput ? "Agent question waiting" : "Waiting for a response",
      since: ticket.updatedAt as WorkflowStuckDiagnosis["since"],
      displayAfterMs: 0,
      actions: isInput
        ? [{ type: "openTicketFocusInput", label: "Answer" }, openAction]
        : [openAction],
    };
  }

  if (ticket.status === "queued") {
    const unresolved = ticket.unresolvedDependencyCount ?? 0;
    // Dependency wins over WIP: raising the limit would not admit a
    // dependency-gated ticket, so offering a WIP remedy would mislead.
    if (unresolved > 0) {
      const actions: Array<WorkflowUnstickActionView> = [];
      if (input.firstUnresolvedDependency !== undefined) {
        actions.push({
          type: "openDependency",
          label: "Open blocker",
          ticketId: input.firstUnresolvedDependency,
        });
      }
      if (ticket.dependsOn !== undefined && ticket.dependsOn.length > 0) {
        actions.push({
          type: "clearDependencies",
          label: "Clear dependencies",
          expectedDependsOn: ticket.dependsOn,
        });
      }
      actions.push(openAction);
      return {
        kind: "dependency_blocked",
        summary: `Waiting on ${String(unresolved)} unresolved ${
          unresolved === 1 ? "dependency" : "dependencies"
        }`,
        since: (ticket.queuedAt ?? ticket.updatedAt) as WorkflowStuckDiagnosis["since"],
        displayAfterMs: TEN_MINUTES,
        actions,
      };
    }
    if (lane?.wipLimit !== undefined && input.laneAdmittedCount >= lane.wipLimit) {
      const actions: Array<WorkflowUnstickActionView> = [openAction];
      if (input.moveTarget !== undefined) {
        actions.push({
          type: "moveToLane",
          label: input.moveTarget.label,
          toLane: input.moveTarget.toLane,
        });
      }
      return {
        kind: "wip_blocked",
        summary: `Lane "${lane.name}" at WIP limit (${String(input.laneAdmittedCount)}/${String(
          lane.wipLimit,
        )})`,
        since: (ticket.queuedAt ?? ticket.updatedAt) as WorkflowStuckDiagnosis["since"],
        displayAfterMs: TEN_MINUTES,
        actions,
      };
    }
    return undefined;
  }

  if (ticket.status === "blocked" || ticket.status === "failed") {
    // Budget is checked FIRST: its remedy (clear the budget) is different from
    // every other blocked remedy, and the underlying step also looks "failed".
    if (
      isTokenBudgetBlock({
        attentionReason: ticket.attentionReason,
        latestStepError: latestStep?.error,
        tokenBudget: ticket.tokenBudget,
      })
    ) {
      const actions: Array<WorkflowUnstickActionView> = [];
      if (canRunLane(input) && ticket.tokenBudget !== null && ticket.tokenBudget !== undefined) {
        actions.push({
          type: "clearTokenBudget",
          label: "Clear budget & retry",
          expectedTokenBudget: ticket.tokenBudget as never,
        });
      }
      actions.push(openAction);
      return {
        kind: "step_blocked",
        summary: `Token budget reached (${String(ticket.totalTokens ?? 0)}/${String(
          ticket.tokenBudget ?? 0,
        )})`,
        since: ticket.updatedAt as WorkflowStuckDiagnosis["since"],
        displayAfterMs: 0,
        actions,
      };
    }

    const reason = ticket.attentionReason ?? "";
    const stepError = latestStep?.error ?? "";
    // The engine's generic no-route path echoes the step error verbatim, so an
    // identical reason means an ordinary agent failure. A DIFFERENT reason means
    // a post-step cause — definition drift, a routing failure — which has to
    // surface on its own rather than be labelled "agent failed".
    const hasDistinctReason = reason.trim().length > 0 && oneLine(reason) !== oneLine(stepError);
    const isAgentFailure =
      latestStep !== undefined &&
      latestStep.status === "failed" &&
      latestStep.stepType === "agent" &&
      !hasDistinctReason;

    if (isAgentFailure) {
      const actions: Array<WorkflowUnstickActionView> = [];
      // Retry on a non-retryable failure (a rejection, a cancelled script) is a
      // guaranteed no-op, so it is not offered.
      if (canRunLane(input) && latestStep.retryable !== false) {
        actions.push({ type: "runLane", label: "Retry lane" });
      }
      actions.push(openAction);
      return {
        kind: "agent_failed",
        summary: `Agent failed (attempt ${String(latestStep.attempt ?? 1)})`,
        ...(stepError === "" ? {} : { detail: truncate(oneLine(stepError), 400) }),
        since: (latestStep.finishedAt ?? ticket.updatedAt) as WorkflowStuckDiagnosis["since"],
        displayAfterMs: 0,
        actions,
      };
    }

    const blockedText = oneLine(reason.length > 0 ? reason : stepError);
    const actions: Array<WorkflowUnstickActionView> = [];
    // The non-retryable guard belongs on this branch too: a rejected approval or
    // a cancelled script lands here, and Retry on either is a guaranteed no-op.
    if (canRunLane(input) && latestStep?.retryable !== false) {
      actions.push({ type: "runLane", label: "Retry lane" });
    }
    actions.push(openAction);
    return {
      kind: "step_blocked",
      summary: blockedText === "" ? "Blocked" : `Blocked: ${truncate(blockedText, 80)}`,
      ...(blockedText === "" ? {} : { detail: truncate(blockedText, 400) }),
      since: ticket.updatedAt as WorkflowStuckDiagnosis["since"],
      displayAfterMs: 0,
      actions,
    };
  }

  if (ticket.status === "idle") {
    // Admitted into a manual-entry lane that HAS work defined: nothing will
    // auto-start it, because only auto lanes are auto-started. A zero-pipeline
    // holding lane (a backlog column) is intentional and must not be flagged.
    const stranded =
      ticket.currentLaneEntryToken !== null &&
      ticket.currentLaneEntryToken !== undefined &&
      lane !== undefined &&
      lane.entry === "manual" &&
      lane.pipelineStepCount > 0;
    if (!stranded) {
      return undefined;
    }
    const actions: Array<WorkflowUnstickActionView> = [{ type: "runLane", label: "Run lane" }];
    if (input.moveTarget !== undefined) {
      actions.push({
        type: "moveToLane",
        label: input.moveTarget.label,
        toLane: input.moveTarget.toLane,
      });
    }
    actions.push(openAction);
    return {
      kind: "idle_unstarted",
      summary: `Idle in manual lane "${lane.name}" — not started`,
      since: (ticket.currentLaneEnteredAt ?? ticket.updatedAt) as WorkflowStuckDiagnosis["since"],
      displayAfterMs: THIRTY_MINUTES,
      actions,
    };
  }

  return undefined;
};
