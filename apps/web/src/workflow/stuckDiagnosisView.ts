import type { WorkflowStuckDiagnosis, WorkflowUnstickActionView } from "@t3tools/contracts";

/**
 * Client-side presentation rules for the server-derived stuck diagnosis
 * (`BoardTicketView.diagnosis`). The server computes WHY a ticket is stuck and
 * which unstick actions apply; these helpers decide WHEN a card may show it and
 * WHICH actions are safe to offer from a card surface.
 */

/**
 * Gate a diagnosis behind its own `displayAfterMs`: intentional short-lived
 * states (a ticket that just queued, an approval that just appeared) must not
 * flash a "stuck" chip. An unparseable `since` fails open — the server said the
 * ticket is stuck, so a broken clock should not hide that.
 */
export const visibleStuckDiagnosis = (
  diagnosis: WorkflowStuckDiagnosis | undefined,
  nowMs: number,
): WorkflowStuckDiagnosis | null => {
  if (diagnosis === undefined) {
    return null;
  }
  const since = Date.parse(diagnosis.since);
  if (Number.isFinite(since) && nowMs - since < diagnosis.displayAfterMs) {
    return null;
  }
  return diagnosis;
};

/**
 * The unstick actions a CARD may offer directly. Everything else stays in the
 * ticket detail:
 *
 * - `resolveApproval` / `openTicket` / `openTicketFocusInput` belong to the
 *   detail's forms (and the board's digit keys are owned by question forms
 *   while a ticket is waiting on a human);
 * - `clearDependencies` / `clearTokenBudget` carry exact-set preconditions the
 *   board state cannot verify (it does not track `dependsOn` edges), so a card
 *   click could clear an edge the user never saw.
 */
export type CardUnstickAction = Extract<
  WorkflowUnstickActionView,
  { readonly type: "runLane" | "moveToLane" | "openDependency" }
>;

const CARD_ACTION_TYPES: ReadonlySet<WorkflowUnstickActionView["type"]> = new Set([
  "runLane",
  "moveToLane",
  "openDependency",
]);

/**
 * Card-offerable unstick actions for a ticket. Empty unless the diagnosis has
 * aged past its display gate. Parked tickets keep their park-recovery actions
 * (one owner for the numbered digits), and waiting tickets leave the digits to
 * the question/approval forms.
 */
export const cardUnstickActions = (
  ticket: {
    readonly status: string;
    readonly diagnosis?: WorkflowStuckDiagnosis | undefined;
  },
  nowMs: number,
): ReadonlyArray<CardUnstickAction> => {
  if (ticket.status === "parked" || ticket.status === "waiting_on_user") {
    return [];
  }
  const diagnosis = visibleStuckDiagnosis(ticket.diagnosis, nowMs);
  if (diagnosis === null) {
    return [];
  }
  return diagnosis.actions.filter((action): action is CardUnstickAction =>
    CARD_ACTION_TYPES.has(action.type),
  );
};
