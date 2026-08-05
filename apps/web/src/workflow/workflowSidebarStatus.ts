import type {
  BoardId,
  EnvironmentId,
  WorkflowNeedsAttentionTicketView,
  WorkflowTicketAttentionKind,
} from "@t3tools/contracts";

/**
 * Total precedence for the dominant attention kind shown on a workflow
 * sidebar row. Higher rank wins; null when the board has no attention tickets.
 * There is no "failed" attention kind — needs-attention only returns
 * waiting/blocked/parked tickets.
 */
const ATTENTION_KIND_RANK: ReadonlyRecord<WorkflowTicketAttentionKind, number> = {
  blocked: 5,
  parked_issue: 4,
  waiting_for_approval: 3,
  waiting_for_input: 2,
  parked_waiting: 1,
};

type ReadonlyRecord<K extends string, V> = { readonly [P in K]: V };

export type WorkflowSidebarAttentionKind = WorkflowTicketAttentionKind;

export interface WorkflowSidebarAttentionSummary {
  readonly count: number;
  /** Dominant kind by total precedence; null when count is 0. */
  readonly dominantKind: WorkflowSidebarAttentionKind | null;
}

export interface WorkflowSidebarAttentionPill {
  readonly label: string;
  readonly className: string;
}

/** Board identity used for attention grouping and active-route highlight. */
export function workflowBoardAttentionKey(
  environmentId: EnvironmentId | string,
  boardId: BoardId | string,
): string {
  return `${environmentId}:${boardId}`;
}

/**
 * Group needs-attention tickets by (environmentId, boardId) into a count +
 * dominant kind. Tickets without an attentionKind are counted but cannot
 * become the dominant kind unless every ticket for that board is null-kind
 * (then dominant stays null).
 */
export function groupAttentionByBoard(input: {
  readonly environmentId: EnvironmentId | string;
  readonly tickets: ReadonlyArray<
    Pick<WorkflowNeedsAttentionTicketView, "boardId" | "attentionKind">
  >;
}): ReadonlyMap<string, WorkflowSidebarAttentionSummary> {
  const byBoard = new Map<
    string,
    { count: number; dominantKind: WorkflowSidebarAttentionKind | null; rank: number }
  >();

  for (const ticket of input.tickets) {
    const key = workflowBoardAttentionKey(input.environmentId, ticket.boardId);
    const current = byBoard.get(key) ?? { count: 0, dominantKind: null, rank: 0 };
    current.count += 1;
    const kind = ticket.attentionKind;
    if (kind !== null) {
      const rank = ATTENTION_KIND_RANK[kind];
      if (rank > current.rank) {
        current.dominantKind = kind;
        current.rank = rank;
      }
    }
    byBoard.set(key, current);
  }

  const result = new Map<string, WorkflowSidebarAttentionSummary>();
  for (const [key, value] of byBoard) {
    result.set(key, { count: value.count, dominantKind: value.dominantKind });
  }
  return result;
}

/** Map a dominant attention kind + count into the compact right-slot indicator. */
export function resolveWorkflowSidebarAttentionPill(
  summary: WorkflowSidebarAttentionSummary | null | undefined,
): WorkflowSidebarAttentionPill | null {
  if (summary === null || summary === undefined || summary.count <= 0) {
    return null;
  }

  const itemLabel = summary.count === 1 ? "1 item needs" : `${summary.count} items need`;
  const includesIssue =
    summary.dominantKind === "blocked" || summary.dominantKind === "parked_issue";
  const label = `${itemLabel} your attention${includesIssue ? "; includes an issue" : ""}`;
  const className = attentionKindToneClass(summary.dominantKind);
  return { label, className };
}

/** Waiting is yellow; blocked or parked issue attention escalates to red. */
export function attentionKindToneClass(
  kind: WorkflowSidebarAttentionKind | null | undefined,
): string {
  switch (kind) {
    case "blocked":
    case "parked_issue":
      return "border-red-500 dark:border-red-400";
    case "waiting_for_approval":
    case "waiting_for_input":
    case "parked_waiting":
    case null:
    case undefined:
      return "border-yellow-500 dark:border-yellow-400";
  }
}

/**
 * Compare two attention kinds by total precedence (higher first).
 * Null ranks below every concrete kind.
 */
export function compareAttentionKindPrecedence(
  left: WorkflowSidebarAttentionKind | null,
  right: WorkflowSidebarAttentionKind | null,
): number {
  const leftRank = left === null ? 0 : ATTENTION_KIND_RANK[left];
  const rightRank = right === null ? 0 : ATTENTION_KIND_RANK[right];
  return rightRank - leftRank;
}

/**
 * The stable clock a needs-attention row has been waiting since. Parked rows
 * age from `parkedAt` and SLA-only rows (null attentionKind) from
 * `slaBreachedAt`, because the projection bumps `updatedAt` on ANY edit — an
 * edited two-hour-old breach must not look freshly waiting. `updatedAt` is the
 * last resort.
 */
export function needsAttentionSince(
  ticket: Pick<WorkflowNeedsAttentionTicketView, "parkedAt" | "slaBreachedAt" | "updatedAt">,
): string {
  return ticket.parkedAt ?? ticket.slaBreachedAt ?? ticket.updatedAt;
}

/**
 * Inbox ordering for the cross-board Needs You list: most urgent kind first
 * (total precedence), then whoever has been waiting longest (see
 * needsAttentionSince). Ties fall back to ticketId so the order is stable
 * across refreshes.
 */
export function sortNeedsAttentionTickets(
  tickets: ReadonlyArray<WorkflowNeedsAttentionTicketView>,
): ReadonlyArray<WorkflowNeedsAttentionTicketView> {
  return [...tickets].sort((left, right) => {
    const byKind = compareAttentionKindPrecedence(left.attentionKind, right.attentionKind);
    if (byKind !== 0) return byKind;
    const bySince = needsAttentionSince(left).localeCompare(needsAttentionSince(right));
    if (bySince !== 0) return bySince;
    return left.ticketId.localeCompare(right.ticketId);
  });
}

/**
 * Pick the dominant kind from a list (total precedence). Used by tests and
 * callers that already have kinds without ticket rows.
 */
export function dominantAttentionKind(
  kinds: ReadonlyArray<WorkflowSidebarAttentionKind | null>,
): WorkflowSidebarAttentionKind | null {
  let best: WorkflowSidebarAttentionKind | null = null;
  let bestRank = 0;
  for (const kind of kinds) {
    if (kind === null) continue;
    const rank = ATTENTION_KIND_RANK[kind];
    if (rank > bestRank) {
      best = kind;
      bestRank = rank;
    }
  }
  return best;
}
