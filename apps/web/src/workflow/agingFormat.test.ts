import { describe, expect, it } from "vite-plus/test";

import { countNeedsAttention, ticketAging } from "./agingFormat.ts";

const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60 * 1000).toISOString();

describe("ticketAging", () => {
  it("ignores healthy and fresh tickets", () => {
    expect(ticketAging({ status: "running", updatedAt: minutesAgo(600) }, NOW)).toBeNull();
    expect(ticketAging({ status: "waiting_on_user", updatedAt: minutesAgo(5) }, NOW)).toBeNull();
    expect(ticketAging({ status: "waiting_on_user" }, NOW)).toBeNull();
  });

  it("warns after 30 minutes and alerts after 2 hours", () => {
    const warn = ticketAging({ status: "waiting_on_user", updatedAt: minutesAgo(45) }, NOW);
    expect(warn?.level).toBe("warn");
    expect(warn?.label).toContain("needs you");

    const alert = ticketAging({ status: "blocked", updatedAt: minutesAgo(180) }, NOW);
    expect(alert?.level).toBe("alert");
    expect(alert?.label).toContain("blocked");
  });

  it("ages parked tickets, taking the verb from the parked substate", () => {
    const issue = ticketAging(
      { status: "parked", updatedAt: minutesAgo(45), parked: { substate: "issue" } },
      NOW,
    );
    expect(issue?.level).toBe("warn");
    expect(issue?.label).toContain("issue");
    expect(issue?.durationLabel).toBe(issue?.label.split(" · ")[1]);

    const waiting = ticketAging(
      { status: "parked", updatedAt: minutesAgo(180), parked: { substate: "waiting" } },
      NOW,
    );
    expect(waiting?.level).toBe("alert");
    expect(waiting?.label).toContain("needs you");
  });

  it("ages a parked ticket from its own parkedAt, not a bumped updatedAt", () => {
    // A parked ticket edited in the drawer bumps updatedAt to ~now while the
    // park itself is 45m old. The clock must key off parkedAt, not updatedAt.
    const aged = ticketAging(
      {
        status: "parked",
        updatedAt: minutesAgo(1),
        parked: { substate: "issue", parkedAt: minutesAgo(45) },
      },
      NOW,
    );
    expect(aged?.level).toBe("warn");
    expect(aged?.label).toContain("issue");
  });

  it("does not age a parked ticket whose parkedAt is fresh even if updatedAt is old", () => {
    expect(
      ticketAging(
        {
          status: "parked",
          updatedAt: minutesAgo(600),
          parked: { substate: "waiting", parkedAt: minutesAgo(2) },
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("still ages a waiting_on_user ticket from updatedAt (not park-scoped)", () => {
    const aged = ticketAging({ status: "waiting_on_user", updatedAt: minutesAgo(45) }, NOW);
    expect(aged?.level).toBe("warn");
    expect(aged?.label).toContain("needs you");
  });

  it("leaves fresh parked tickets un-aged", () => {
    expect(
      ticketAging(
        { status: "parked", updatedAt: minutesAgo(5), parked: { substate: "issue" } },
        NOW,
      ),
    ).toBeNull();
  });

  it("counts tickets needing attention", () => {
    expect(
      countNeedsAttention(
        [
          { status: "waiting_on_user", updatedAt: minutesAgo(45) },
          { status: "running", updatedAt: minutesAgo(45) },
          { status: "blocked", updatedAt: minutesAgo(200) },
        ],
        NOW,
      ),
    ).toBe(2);
  });
});
