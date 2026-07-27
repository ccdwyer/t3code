import type {
  StepRunId,
  WorkflowLaneActionView,
  WorkflowParkSubstate,
  WorkflowStepRunView,
  WorkflowTicketDetailView,
} from "@t3tools/contracts";

/**
 * Returns true when the ticket is owned by an external sync source
 * (i.e. its title/description are managed by the source provider and
 * should be treated as read-only in the UI).
 */
export function isTicketSourceOwned(
  detail: Pick<WorkflowTicketDetailView, "syncedSource">,
): boolean {
  return Boolean(detail.syncedSource);
}

/**
 * Discriminated union describing what the human can do with a ticket that
 * surfaced in the "Needs you" inbox / notification deep-link. The `kind` is
 * driven primarily off the server-projected `ticket.attentionKind`; the awaiting
 * step's `providerResponseKind` is only consulted as a fallback. Every variant
 * carries `laneActions` so the action sheet can always offer manual lane moves.
 */
export type TicketAffordance =
  | {
      readonly kind: "answer";
      readonly stepRunId: StepRunId;
      readonly question: string | null;
      readonly laneActions: readonly WorkflowLaneActionView[];
    }
  | {
      readonly kind: "approve";
      readonly stepRunId: StepRunId;
      readonly question: string | null;
      readonly laneActions: readonly WorkflowLaneActionView[];
    }
  | {
      readonly kind: "blocked";
      readonly blockReason: string | null;
      readonly laneActions: readonly WorkflowLaneActionView[];
    }
  | {
      readonly kind: "parked";
      readonly substate: WorkflowParkSubstate;
      readonly label: string | null;
      readonly reason: string | null;
      readonly laneActions: readonly WorkflowLaneActionView[];
    }
  | {
      readonly kind: "comment";
      readonly laneActions: readonly WorkflowLaneActionView[];
    };

function findAwaitingStep(detail: WorkflowTicketDetailView): WorkflowStepRunView | undefined {
  return detail.steps.find((step) => step.status === "awaiting_user");
}

/**
 * Maps a ticket detail view onto the single best human affordance.
 *
 * Mapping rules (see TicketActionSheetScreen for the UI):
 * - `waiting_for_input` (or awaiting step `providerResponseKind === "user-input"`)
 *   → `answer`, requires the awaiting step's `stepRunId`; degrades to `comment`
 *   when no awaiting step is present.
 * - `waiting_for_approval` (or `providerResponseKind === "request"`) → `approve`,
 *   same `stepRunId` requirement / degrade.
 * - `parked_issue`/`parked_waiting` attention (or `ticket.status === "parked"`
 *   fallback when attentionKind is absent, e.g. an older payload) → `parked`,
 *   sourcing `label`/`reason` from the ticket's `parked` object when present,
 *   falling back to `attentionReason` for `reason` (no invoke affordance in
 *   v1 — see spec "Attention, notifications, mobile — honest surface").
 * - `blocked` attention OR `ticket.status === "blocked"` → `blocked`.
 * - otherwise → `comment`.
 */
export function selectTicketAffordance(detail: WorkflowTicketDetailView): TicketAffordance {
  const ticket = detail.ticket;
  const awaitingStep = findAwaitingStep(detail);
  const laneActions = ticket.currentLane?.actions ?? [];

  const attentionKind = ticket.attentionKind;
  const providerResponseKind = awaitingStep?.providerResponseKind ?? null;

  /**
   * An agent that paused to ask the operator a question.
   *
   * It projects `waiting_for_input` like a provider prompt, but it is answered
   * with the checkpoint FORM through the approval path — the freeform answer RPC
   * hard-rejects anything that is not a provider `user-input` wait. Offering
   * "Answer" here would be a button that can only fail, so mobile shows the
   * question and sends the user to the board (SPEC §5).
   */
  const isAgentQuestion =
    awaitingStep?.stepType === "agent" &&
    providerResponseKind === null &&
    awaitingStep.form !== undefined;

  const wantsInput =
    !isAgentQuestion &&
    (attentionKind === "waiting_for_input" ||
      (attentionKind === undefined && providerResponseKind === "user-input"));
  const wantsApproval =
    attentionKind === "waiting_for_approval" ||
    (attentionKind === undefined &&
      (providerResponseKind === "request" ||
        // Mirror web's isAwaitingApprovalRequestStep fallback: an explicit
        // approval step awaiting the user with no providerResponseKind is
        // still an approval request.
        (awaitingStep?.stepType === "approval" && providerResponseKind === null)));
  // Not blocked's fourth+fifth attention kinds and not `comment` — a distinct
  // variant so callers can't confuse a park-in-place ticket with a genuinely
  // blocked one (codex #13 review requirement). Resolve substate off the
  // attentionKind first; only fall back to `ticket.status === "parked"` (using
  // the re-resolved `ticket.parked.substate` when the server includes it) for
  // an older/degraded payload that lost its attentionKind.
  const parkedSubstate: WorkflowParkSubstate | null =
    attentionKind === "parked_issue"
      ? "issue"
      : attentionKind === "parked_waiting"
        ? "waiting"
        : attentionKind === undefined && ticket.status === "parked"
          ? (ticket.parked?.substate ?? "issue")
          : null;

  const isBlocked = attentionKind === "blocked" || ticket.status === "blocked";

  if (wantsInput) {
    if (awaitingStep) {
      return {
        kind: "answer",
        stepRunId: awaitingStep.stepRunId,
        question: awaitingStep.waitingReason ?? ticket.attentionReason ?? null,
        laneActions,
      };
    }
    return { kind: "comment", laneActions };
  }

  if (wantsApproval) {
    if (awaitingStep) {
      return {
        kind: "approve",
        stepRunId: awaitingStep.stepRunId,
        question: awaitingStep.waitingReason ?? ticket.attentionReason ?? null,
        laneActions,
      };
    }
    return { kind: "comment", laneActions };
  }

  if (parkedSubstate !== null) {
    return {
      kind: "parked",
      substate: parkedSubstate,
      label: ticket.parked?.label ?? null,
      reason: ticket.parked?.reason ?? ticket.attentionReason ?? null,
      laneActions,
    };
  }

  if (isBlocked) {
    return {
      kind: "blocked",
      blockReason: awaitingStep?.blockedReason ?? ticket.attentionReason ?? null,
      laneActions,
    };
  }

  return { kind: "comment", laneActions };
}
