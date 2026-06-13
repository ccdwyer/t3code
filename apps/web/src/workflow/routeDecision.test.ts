import { describe, expect, it } from "vite-plus/test";

import { describeRouteDecision, extractVerdict, type RouteDecisionView } from "./routeDecision.ts";

const laneName = (key: string): string =>
  ({ implement: "Implementation", review: "Review", stuck: "Stuck" })[key] ?? key;

const decision = (overrides: Partial<RouteDecisionView>): RouteDecisionView => ({
  occurredAt: "2026-06-09T10:00:00.000Z",
  toLane: "review",
  source: "lane_transition",
  ...overrides,
});

describe("extractVerdict", () => {
  it("reads a string verdict from captured output", () => {
    expect(extractVerdict({ verdict: "approve" })).toBe("approve");
    expect(extractVerdict({ verdict: "revise", notes: "x" })).toBe("revise");
  });

  it("returns null for everything else", () => {
    expect(extractVerdict(null)).toBeNull();
    expect(extractVerdict("approve")).toBeNull();
    expect(extractVerdict({ verdict: 3 })).toBeNull();
    expect(extractVerdict(undefined)).toBeNull();
  });
});

describe("describeRouteDecision", () => {
  it("describes a matched transition with verdict and run count", () => {
    const described = describeRouteDecision(
      decision({
        fromLane: "implement",
        matchedTransitionIndex: 1,
        pipelineResult: "success",
        laneRunCount: 2,
        steps: {
          verdict: { status: "completed", exitCode: 0, verdict: "approve" },
        },
      }),
      laneName,
    );

    expect(described.title).toBe("Implementation → Review");
    expect(described.details).toContain("Matched transition #2");
    expect(described.details).toContain("Pipeline succeeded");
    expect(described.details).toContain("Run 2 in this lane");
    expect(described.details).toContain("verdict: approve");
  });

  it("describes manual moves", () => {
    const described = describeRouteDecision(decision({ source: "manual" }), laneName);
    expect(described.title).toBe("Moved to Review");
    expect(described.details).toEqual(["Moved manually"]);
  });

  it("describes default lane routing after a failure with exit codes", () => {
    const described = describeRouteDecision(
      decision({
        fromLane: "implement",
        toLane: "stuck",
        source: "lane_on",
        pipelineResult: "failure",
        steps: { gate: { status: "failed", exitCode: 1 } },
      }),
      laneName,
    );

    expect(described.title).toBe("Implementation → Stuck");
    expect(described.details).toContain("Default route");
    expect(described.details).toContain("Pipeline failed");
    expect(described.details).toContain("gate: exit 1");
  });

  it("describes step-driven routing", () => {
    const described = describeRouteDecision(
      decision({ fromLane: "implement", source: "step_on" }),
      laneName,
    );
    expect(described.details).toContain("Routed by a step outcome");
  });

  it("describes external events with their name", () => {
    const described = describeRouteDecision(
      decision({ fromLane: "implement", source: "external_event", eventName: "ci.passed" }),
      laneName,
    );
    expect(described.details).toContain('External event "ci.passed"');
  });

  it("truncates runaway verdict strings", () => {
    const described = describeRouteDecision(
      decision({
        fromLane: "implement",
        steps: { review: { status: "completed", verdict: "x".repeat(500) } },
      }),
      laneName,
    );
    const verdictDetail = described.details.find((detail) => detail.startsWith("review:"));
    expect(verdictDetail?.length).toBeLessThanOrEqual(48);
    expect(verdictDetail?.endsWith("…")).toBe(true);
  });
});
