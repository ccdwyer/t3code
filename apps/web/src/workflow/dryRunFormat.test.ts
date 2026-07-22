import type { WorkflowDryRunResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeDryRunEnd, describeDryRunHop } from "./dryRunFormat";

const laneName = (key: string) => (key === "work" ? "Work" : key === "done" ? "Done" : key);

describe("dryRunFormat", () => {
  it("describes hops by source", () => {
    expect(
      describeDryRunHop(
        {
          fromLane: "work",
          toLane: "done",
          source: "step_on",
          viaStepKey: "code",
          result: "success",
        } as never,
        laneName,
      ),
    ).toBe('Work → Done — step "code" success route');
    expect(
      describeDryRunHop(
        {
          fromLane: "work",
          toLane: "done",
          source: "lane_transition",
          matchedTransitionIndex: 1,
          result: "success",
        } as never,
        laneName,
      ),
    ).toBe("Work → Done — transition #2 matched");
    expect(
      describeDryRunHop(
        { fromLane: "work", toLane: "done", source: "lane_on", result: "failure" } as never,
        laneName,
      ),
    ).toBe("Work → Done — lane failure fallback");
  });

  it("describes a park hop by substate and label, never a lane move", () => {
    const withLabel = describeDryRunHop(
      {
        fromLane: "work",
        source: "step_on",
        viaStepKey: "code",
        result: "failure",
        park: { substate: "issue", label: "Needs review" },
      } as never,
      laneName,
    );
    expect(withLabel).toBe("Work — parked (issue) — Needs review");
    expect(withLabel).not.toContain("undefined");
    expect(withLabel).not.toContain("→");

    const withoutLabel = describeDryRunHop(
      {
        fromLane: "work",
        source: "lane_on",
        result: "failure",
        park: { substate: "waiting" },
      } as never,
      laneName,
    );
    expect(withoutLabel).toBe("Work — parked (waiting)");
    expect(withoutLabel).not.toContain("undefined");
  });

  it("describes end states", () => {
    const base = { startLane: "work", scenario: "success", hops: [], notes: [] };
    expect(
      describeDryRunEnd(
        { ...base, end: "terminal", endLane: "done" } as unknown as WorkflowDryRunResult,
        laneName,
      ),
    ).toBe('Reached terminal lane "Done".');
    expect(
      describeDryRunEnd(
        { ...base, end: "no_route", endLane: "work" } as unknown as WorkflowDryRunResult,
        laneName,
      ),
    ).toContain("no route matched");
    expect(
      describeDryRunEnd(
        { ...base, end: "manual", endLane: "work" } as unknown as WorkflowDryRunResult,
        laneName,
      ),
    ).toContain("manual lane");
    expect(
      describeDryRunEnd(
        { ...base, end: "cycle_cap", endLane: "work" } as unknown as WorkflowDryRunResult,
        laneName,
      ),
    ).toContain("unbounded cycle");
  });

  it("describes a parked end with the park hop's substate and label", () => {
    const base = { startLane: "work", scenario: "success", notes: [] };
    const withLabel = describeDryRunEnd(
      {
        ...base,
        end: "parked",
        endLane: "work",
        hops: [
          {
            fromLane: "work",
            source: "lane_on",
            result: "failure",
            park: { substate: "issue", label: "Needs review" },
          },
        ],
      } as unknown as WorkflowDryRunResult,
      laneName,
    );
    expect(withLabel).toBe('Parked in "Work" (issue) — Needs review.');
    expect(withLabel).not.toContain("undefined");

    const withoutLabel = describeDryRunEnd(
      {
        ...base,
        end: "parked",
        endLane: "work",
        hops: [
          { fromLane: "work", source: "lane_on", result: "failure", park: { substate: "waiting" } },
        ],
      } as unknown as WorkflowDryRunResult,
      laneName,
    );
    expect(withoutLabel).toBe('Parked in "Work" (waiting).');
    expect(withoutLabel).not.toContain("undefined");
  });
});
