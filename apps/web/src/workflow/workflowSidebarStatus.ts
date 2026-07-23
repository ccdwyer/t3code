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

/**
 * Map a dominant attention kind + count into the calm right-slot pill.
 * Zero count → null (nothing rendered).
 */
export function resolveWorkflowSidebarAttentionPill(
  summary: WorkflowSidebarAttentionSummary | null | undefined,
): WorkflowSidebarAttentionPill | null {
  if (summary === null || summary === undefined || summary.count <= 0) {
    return null;
  }

  const label = summary.count === 1 ? "1 need you" : `${summary.count} need you`;
  const className = attentionKindToneClass(summary.dominantKind);
  return { label, className };
}

/** Tone classes for the dominant attention kind (color signals, not noise). */
export function attentionKindToneClass(
  kind: WorkflowSidebarAttentionKind | null | undefined,
): string {
  switch (kind) {
    case "waiting_for_approval":
      return "text-amber-700 dark:text-amber-300";
    case "waiting_for_input":
      return "text-indigo-600 dark:text-indigo-300";
    case "blocked":
      return "text-red-700 dark:text-red-300";
    case "parked_issue":
      // Parked issue: warning/amber family (matches board ticket tier "issue").
      return "text-amber-700 dark:text-amber-300";
    case "parked_waiting":
      // Parked waiting: info/sky family (board waiting tier).
      return "text-sky-700 dark:text-sky-300";
    case null:
    case undefined:
      return "text-muted-foreground";
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
