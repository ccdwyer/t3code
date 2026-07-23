import { BoardId, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attentionKindToneClass,
  compareAttentionKindPrecedence,
  dominantAttentionKind,
  groupAttentionByBoard,
  resolveWorkflowSidebarAttentionPill,
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

  it("formats count label and error tone for blocked", () => {
    const pill = resolveWorkflowSidebarAttentionPill({ count: 1, dominantKind: "blocked" });
    expect(pill?.label).toBe("1 need you");
    expect(pill?.className).toBe(attentionKindToneClass("blocked"));
    expect(pill?.className).toContain("text-red");

    const multi = resolveWorkflowSidebarAttentionPill({
      count: 4,
      dominantKind: "waiting_for_approval",
    });
    expect(multi?.label).toBe("4 need you");
    expect(multi?.className).toContain("text-amber");
  });
});

describe("attentionKindToneClass", () => {
  it("maps each kind to a distinct calm tone family", () => {
    expect(attentionKindToneClass("waiting_for_approval")).toContain("amber");
    expect(attentionKindToneClass("waiting_for_input")).toContain("indigo");
    expect(attentionKindToneClass("blocked")).toContain("red");
    expect(attentionKindToneClass("parked_issue")).toContain("amber");
    expect(attentionKindToneClass("parked_waiting")).toContain("sky");
    expect(attentionKindToneClass(null)).toContain("muted");
  });
});
