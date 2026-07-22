import type { WorkflowNeedsAttentionTicketView } from "@t3tools/contracts";

/**
 * Pure label-derivation helper for the NeedsYouInboxScreen's attention pill.
 *
 * Parked substates get their own copy distinct from the pre-existing
 * approval/input/blocked kinds ("issue" for `parked_issue`, "waiting on you"
 * for `parked_waiting`). An unrecognized/absent attentionKind on a ticket
 * whose status is "parked" (e.g. an older payload) falls back to the literal
 * "parked" — never the raw status string, which would otherwise leak an
 * internal status onto the pill for every other status too.
 */
export function attentionLabel(
  ticket: Pick<WorkflowNeedsAttentionTicketView, "attentionKind" | "status">,
): string {
  switch (ticket.attentionKind) {
    case "waiting_for_approval":
      return "Needs approval";
    case "waiting_for_input":
      return "Needs input";
    case "blocked":
      return "Blocked";
    case "parked_issue":
      return "issue";
    case "parked_waiting":
      return "waiting on you";
    default:
      return ticket.status === "parked" ? "parked" : ticket.status;
  }
}

/**
 * The stable timestamp a needs-attention row ages and sorts by. A parked ticket
 * ages from its OWN park time (`parkedAt`) — the projection bumps `updatedAt` on
 * any edit, so using it would reset a parked ticket's clock to "just now" after
 * an unrelated title edit (and disagree with the web board, which ages from
 * `parkedAt`). Non-parked rows have no `parkedAt` and keep `updatedAt`.
 */
export function attentionAgeSource(
  ticket: Pick<WorkflowNeedsAttentionTicketView, "parkedAt" | "updatedAt">,
): string {
  return ticket.parkedAt ?? ticket.updatedAt;
}
