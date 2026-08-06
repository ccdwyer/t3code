import { describe, expect, it } from "vite-plus/test";

import type { WorkflowStuckDiagnosis } from "@t3tools/contracts";

import { cardUnstickActions, visibleStuckDiagnosis } from "./stuckDiagnosisView.ts";

const NOW = Date.parse("2026-08-05T12:00:00Z");

const diagnosis = (over: Partial<WorkflowStuckDiagnosis> = {}): WorkflowStuckDiagnosis =>
  ({
    kind: "wip_blocked",
    summary: "Queued behind the lane's WIP limit",
    since: "2026-08-05T11:00:00Z",
    displayAfterMs: 60_000,
    actions: [],
    ...over,
  }) as WorkflowStuckDiagnosis;

describe("visibleStuckDiagnosis", () => {
  it("hides a diagnosis younger than its display gate", () => {
    const d = diagnosis({
      since: new Date(NOW - 30_000).toISOString(),
      displayAfterMs: 60_000,
    });
    expect(visibleStuckDiagnosis(d, NOW)).toBeNull();
  });

  it("shows a diagnosis once it has aged past the gate", () => {
    const d = diagnosis({
      since: new Date(NOW - 61_000).toISOString(),
      displayAfterMs: 60_000,
    });
    expect(visibleStuckDiagnosis(d, NOW)).toBe(d);
  });

  it("shows exactly at the boundary", () => {
    const d = diagnosis({
      since: new Date(NOW - 60_000).toISOString(),
      displayAfterMs: 60_000,
    });
    expect(visibleStuckDiagnosis(d, NOW)).toBe(d);
  });

  it("fails open on an unparseable since", () => {
    const d = diagnosis({ since: "not-a-date", displayAfterMs: 999_999_999 });
    expect(visibleStuckDiagnosis(d, NOW)).toBe(d);
  });

  it("returns null for an absent diagnosis", () => {
    expect(visibleStuckDiagnosis(undefined, NOW)).toBeNull();
  });
});

describe("cardUnstickActions", () => {
  const aged = {
    since: new Date(NOW - 120_000).toISOString(),
    displayAfterMs: 60_000,
  };
  const allActions = [
    { type: "runLane", label: "Start work" },
    {
      type: "resolveApproval",
      label: "Approve",
      stepRunId: "sr1",
      approved: true,
    },
    { type: "openTicket", label: "Open" },
    { type: "openTicketFocusInput", label: "Answer" },
    { type: "openDependency", label: "Open blocker", ticketId: "t2" },
    {
      type: "clearDependencies",
      label: "Clear deps",
      expectedDependsOn: ["t2"],
    },
    { type: "moveToLane", label: "Send back", toLane: "backlog" },
    {
      type: "clearTokenBudget",
      label: "Lift budget",
      expectedTokenBudget: 1000,
    },
  ] as unknown as WorkflowStuckDiagnosis["actions"];

  it("keeps only card-safe action types", () => {
    const actions = cardUnstickActions(
      {
        status: "idle",
        diagnosis: diagnosis({ ...aged, actions: allActions }),
      },
      NOW,
    );
    expect(actions.map((a) => a.type)).toEqual(["runLane", "openDependency", "moveToLane"]);
  });

  it("offers nothing for parked or waiting tickets", () => {
    const d = diagnosis({ ...aged, actions: allActions });
    expect(cardUnstickActions({ status: "parked", diagnosis: d }, NOW)).toEqual([]);
    expect(cardUnstickActions({ status: "waiting_on_user", diagnosis: d }, NOW)).toEqual([]);
  });

  it("offers nothing while the diagnosis is display-gated", () => {
    const d = diagnosis({
      since: new Date(NOW - 10_000).toISOString(),
      displayAfterMs: 60_000,
      actions: allActions,
    });
    expect(cardUnstickActions({ status: "idle", diagnosis: d }, NOW)).toEqual([]);
  });

  it("offers nothing without a diagnosis", () => {
    expect(cardUnstickActions({ status: "idle" }, NOW)).toEqual([]);
  });
});
