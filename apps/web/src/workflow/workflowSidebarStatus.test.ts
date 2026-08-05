import { BoardId, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attentionKindToneClass,
  compareAttentionKindPrecedence,
  dominantAttentionKind,
  groupAttentionByBoard,
  resolveWorkflowSidebarAttentionPill,
  needsAttentionSince,
  sortNeedsAttentionTickets,
  workflowBoardAttentionKey,
} from "./workflowSidebarStatus";

const env = EnvironmentId.make("environment-primary");
const boardA = BoardId.make("project-1__board-a");
const boardB = BoardId.make("project-1__board-b");

describe("workflowBoardAttentionKey", () => {
  it("joins environmentId and boardId", () => {
    expect(workflowBoardAttentionKey(env, boardA)).toBe(`${env}:${boardA}`);
  });
});

describe("dominantAttentionKind / precedence", () => {
  it("orders blocked > parked_issue > waiting_for_approval > waiting_for_input > parked_waiting > null", () => {
    expect(
      dominantAttentionKind([
        "parked_waiting",
        "waiting_for_input",
        "waiting_for_approval",
        "parked_issue",
        "blocked",
      ]),
    ).toBe("blocked");
    expect(
      dominantAttentionKind([
        "parked_waiting",
        "waiting_for_input",
        "waiting_for_approval",
        "parked_issue",
      ]),
    ).toBe("parked_issue");
    expect(
      dominantAttentionKind(["parked_waiting", "waiting_for_input", "waiting_for_approval"]),
    ).toBe("waiting_for_approval");
    expect(dominantAttentionKind(["parked_waiting", "waiting_for_input"])).toBe(
      "waiting_for_input",
    );
    expect(dominantAttentionKind(["parked_waiting"])).toBe("parked_waiting");
    expect(dominantAttentionKind([null])).toBeNull();
    expect(dominantAttentionKind([])).toBeNull();
  });

  it("compareAttentionKindPrecedence ranks higher kinds first", () => {
    expect(compareAttentionKindPrecedence("blocked", "parked_waiting")).toBeLessThan(0);
    expect(compareAttentionKindPrecedence("parked_waiting", "blocked")).toBeGreaterThan(0);
    expect(compareAttentionKindPrecedence(null, "blocked")).toBeGreaterThan(0);
    expect(compareAttentionKindPrecedence("blocked", null)).toBeLessThan(0);
    expect(compareAttentionKindPrecedence(null, null)).toBe(0);
  });
});

describe("groupAttentionByBoard", () => {
  it("groups by (environmentId, boardId) with count + dominant kind", () => {
    const grouped = groupAttentionByBoard({
      environmentId: env,
      tickets: [
        { boardId: boardA, attentionKind: "waiting_for_input" },
        { boardId: boardA, attentionKind: "blocked" },
        { boardId: boardA, attentionKind: "parked_waiting" },
        { boardId: boardB, attentionKind: "waiting_for_approval" },
        { boardId: boardB, attentionKind: null },
      ],
    });

    expect(grouped.get(workflowBoardAttentionKey(env, boardA))).toEqual({
      count: 3,
      dominantKind: "blocked",
    });
    expect(grouped.get(workflowBoardAttentionKey(env, boardB))).toEqual({
      count: 2,
      dominantKind: "waiting_for_approval",
    });
  });

  it("keeps count when all kinds are null", () => {
    const grouped = groupAttentionByBoard({
      environmentId: env,
      tickets: [
        { boardId: boardA, attentionKind: null },
        { boardId: boardA, attentionKind: null },
      ],
    });
    expect(grouped.get(workflowBoardAttentionKey(env, boardA))).toEqual({
      count: 2,
      dominantKind: null,
    });
  });
});

describe("resolveWorkflowSidebarAttentionPill", () => {
  it("returns null for zero / missing attention", () => {
    expect(resolveWorkflowSidebarAttentionPill(null)).toBeNull();
    expect(resolveWorkflowSidebarAttentionPill(undefined)).toBeNull();
    expect(resolveWorkflowSidebarAttentionPill({ count: 0, dominantKind: null })).toBeNull();
  });

  it("uses an accessible label and red ring for issue attention", () => {
    const indicator = resolveWorkflowSidebarAttentionPill({
      count: 1,
      dominantKind: "blocked",
    });
    expect(indicator?.label).toBe("1 item needs your attention; includes an issue");
    expect(indicator?.className).toBe(attentionKindToneClass("blocked"));
    expect(indicator?.className).toContain("border-red");
  });

  it("uses a yellow ring for waiting attention", () => {
    const indicator = resolveWorkflowSidebarAttentionPill({
      count: 4,
      dominantKind: "waiting_for_approval",
    });
    expect(indicator?.label).toBe("4 items need your attention");
    expect(indicator?.className).toContain("border-yellow");
  });
});

describe("attentionKindToneClass", () => {
  it("maps issue kinds to red and every waiting kind to yellow", () => {
    expect(attentionKindToneClass("waiting_for_approval")).toContain("border-yellow");
    expect(attentionKindToneClass("waiting_for_input")).toContain("border-yellow");
    expect(attentionKindToneClass("blocked")).toContain("border-red");
    expect(attentionKindToneClass("parked_issue")).toContain("border-red");
    expect(attentionKindToneClass("parked_waiting")).toContain("border-yellow");
    expect(attentionKindToneClass(null)).toContain("border-yellow");
  });
});

describe("sortNeedsAttentionTickets", () => {
  const ticket = (
    id: string,
    kind: Parameters<typeof attentionKindToneClass>[0],
    over: Partial<{ updatedAt: string; parkedAt: string | null }> = {},
  ) =>
    ({
      ticketId: id,
      boardId: BoardId.make("p__b"),
      boardName: "Board",
      title: id,
      status: "blocked",
      currentLaneKey: "work",
      attentionKind: kind,
      attentionReason: null,
      updatedAt: over.updatedAt ?? "2026-08-05T10:00:00Z",
      parkedAt: over.parkedAt ?? null,
      slaBreachedAt: null,
      slaBreachedReason: null,
    }) as never;

  it("orders by kind precedence, then longest-waiting, then ticketId", () => {
    const sorted = sortNeedsAttentionTickets([
      ticket("waiting-new", "waiting_for_input", { updatedAt: "2026-08-05T11:00:00Z" }),
      ticket("blocked-1", "blocked"),
      ticket("waiting-old", "waiting_for_input", { updatedAt: "2026-08-05T09:00:00Z" }),
      ticket("tie-b", "parked_waiting"),
      ticket("tie-a", "parked_waiting"),
    ]);
    expect(sorted.map((t: { ticketId: string }) => t.ticketId)).toEqual([
      "blocked-1",
      "waiting-old",
      "waiting-new",
      "tie-a",
      "tie-b",
    ]);
  });

  it("ages parked rows from parkedAt, not updatedAt", () => {
    const sorted = sortNeedsAttentionTickets([
      ticket("parked-recent", "parked_issue", {
        updatedAt: "2026-08-05T09:00:00Z",
        parkedAt: "2026-08-05T11:30:00Z",
      }),
      ticket("parked-old", "parked_issue", {
        updatedAt: "2026-08-05T11:59:00Z",
        parkedAt: "2026-08-05T08:00:00Z",
      }),
    ]);
    expect(sorted.map((t: { ticketId: string }) => t.ticketId)).toEqual([
      "parked-old",
      "parked-recent",
    ]);
  });
});

describe("needsAttentionSince", () => {
  it("prefers parkedAt, then slaBreachedAt, then updatedAt", () => {
    expect(
      needsAttentionSince({
        parkedAt: "2026-08-05T08:00:00Z",
        slaBreachedAt: "2026-08-05T09:00:00Z",
        updatedAt: "2026-08-05T11:00:00Z",
      }),
    ).toBe("2026-08-05T08:00:00Z");
    expect(
      needsAttentionSince({
        parkedAt: null,
        slaBreachedAt: "2026-08-05T09:00:00Z",
        updatedAt: "2026-08-05T11:00:00Z",
      }),
    ).toBe("2026-08-05T09:00:00Z");
    expect(
      needsAttentionSince({
        parkedAt: null,
        slaBreachedAt: null,
        updatedAt: "2026-08-05T11:00:00Z",
      }),
    ).toBe("2026-08-05T11:00:00Z");
  });

  it("sorts an edited SLA-only breach by its breach time, not the edit", () => {
    const sla = (id: string, breached: string, updated: string) =>
      ({
        ticketId: id,
        boardId: BoardId.make("p__b"),
        boardName: "Board",
        title: id,
        status: "running",
        currentLaneKey: "work",
        attentionKind: null,
        attentionReason: null,
        updatedAt: updated,
        parkedAt: null,
        slaBreachedAt: breached,
        slaBreachedReason: "over budget",
      }) as never;
    const sorted = sortNeedsAttentionTickets([
      sla("breached-recent", "2026-08-05T11:00:00Z", "2026-08-05T11:00:00Z"),
      // Breached two hours earlier but edited a minute ago.
      sla("breached-old-edited", "2026-08-05T09:00:00Z", "2026-08-05T11:59:00Z"),
    ]);
    expect(sorted.map((t: { ticketId: string }) => t.ticketId)).toEqual([
      "breached-old-edited",
      "breached-recent",
    ]);
  });
});
