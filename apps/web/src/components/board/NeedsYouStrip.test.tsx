import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ticketAging } from "~/workflow/agingFormat";

import { type BoardViewTicket } from "./BoardView";
import { NeedsYouStrip, selectNeedsYouTickets } from "./NeedsYouStrip";

const AGED = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

const issuePark = {
  substate: "issue",
  label: "Issue encountered",
  reason: "The implement step exited non-zero.",
  parkedAt: "2026-01-02T00:00:00.000Z",
  parkedEventId: "event-issue",
  actions: [
    { label: "Retry", to: "implementation" },
    { label: "Send back", to: "planning" },
  ],
} satisfies NonNullable<BoardViewTicket["parked"]>;

const waitingPark = {
  substate: "waiting",
  label: "Waiting on review",
  reason: "Paused for a manual sign-off.",
  parkedAt: "2026-01-03T00:00:00.000Z",
  parkedEventId: "event-waiting",
  actions: [{ label: "Approve", to: "done" }],
} satisfies NonNullable<BoardViewTicket["parked"]>;

const ticket = (overrides: Partial<BoardViewTicket>): BoardViewTicket => ({
  ticketId: "ticket-default",
  title: "Untitled",
  currentLaneKey: "lane-1",
  status: "idle",
  ...overrides,
});

describe("selectNeedsYouTickets", () => {
  it("filters to parked/waiting_on_user, issue tier first, then oldest-first within a tier", () => {
    const issueOlder = ticket({
      ticketId: "issue-older",
      title: "Issue older",
      status: "parked",
      parked: { ...issuePark, parkedAt: "2026-01-01T00:00:00.000Z" },
    });
    const issueNewer = ticket({
      ticketId: "issue-newer",
      title: "Issue newer",
      status: "parked",
      parked: { ...issuePark, parkedAt: "2026-01-02T00:00:00.000Z" },
    });
    const waitingOnUserOlder = ticket({
      ticketId: "waiting-on-user-older",
      title: "Waiting on user, older",
      status: "waiting_on_user",
      updatedAt: "2026-01-01T12:00:00.000Z",
    });
    const waitingParkedNewer = ticket({
      ticketId: "waiting-parked-newer",
      title: "Waiting parked, newer",
      status: "parked",
      parked: { ...waitingPark, parkedAt: "2026-01-03T00:00:00.000Z" },
    });
    const idle = ticket({ ticketId: "idle", title: "Idle", status: "idle" });
    const running = ticket({ ticketId: "running", title: "Running", status: "running" });

    const selected = selectNeedsYouTickets([
      running,
      waitingParkedNewer,
      idle,
      issueNewer,
      waitingOnUserOlder,
      issueOlder,
    ]);

    expect(selected.map((t) => t.ticketId)).toEqual([
      "issue-older",
      "issue-newer",
      "waiting-on-user-older",
      "waiting-parked-newer",
    ]);
  });

  it("includes SLA-only breaches below parked/waiting, ordered by breach time", () => {
    const slaOlder = ticket({
      ticketId: "sla-older",
      title: "SLA older",
      status: "idle",
      slaBreachedAt: "2026-01-01T00:00:00.000Z",
    });
    const slaNewer = ticket({
      ticketId: "sla-newer",
      title: "SLA newer",
      status: "running",
      slaBreachedAt: "2026-01-02T00:00:00.000Z",
    });
    const issue = ticket({
      ticketId: "issue",
      title: "Issue",
      status: "parked",
      parked: { ...issuePark, parkedAt: "2026-01-03T00:00:00.000Z" },
    });
    const selected = selectNeedsYouTickets([slaNewer, issue, slaOlder]);
    expect(selected.map((t) => t.ticketId)).toEqual(["issue", "sla-older", "sla-newer"]);
  });
});

describe("NeedsYouStrip", () => {
  it("renders nothing when no ticket needs attention", () => {
    const markup = renderToStaticMarkup(
      <NeedsYouStrip
        tickets={[ticket({ status: "idle" }), ticket({ ticketId: "t2", status: "running" })]}
        onOpen={() => {}}
        onParkAction={vi.fn(async () => {})}
      />,
    );
    expect(markup).toBe("");
  });

  it("shows a count badge for the number of entries needing attention", () => {
    const markup = renderToStaticMarkup(
      <NeedsYouStrip
        tickets={[
          ticket({ ticketId: "t1", status: "parked", parked: issuePark }),
          ticket({ ticketId: "t2", status: "waiting_on_user", updatedAt: AGED }),
        ]}
        onOpen={() => {}}
        onParkAction={vi.fn(async () => {})}
      />,
    );
    expect(markup).toContain("Needs you");
    expect(markup).toContain('data-testid="needs-you-count"');
    expect(markup).toContain("· 2");
  });

  it("renders the parked label, reason, and title (click target) for a parked entry", () => {
    const markup = renderToStaticMarkup(
      <NeedsYouStrip
        tickets={[
          ticket({
            ticketId: "t1",
            title: "Ship the thing",
            status: "parked",
            parked: issuePark,
          }),
        ]}
        onOpen={() => {}}
        onParkAction={vi.fn(async () => {})}
      />,
    );
    expect(markup).toContain("Ship the thing");
    expect(markup).toContain("Issue encountered");
    expect(markup).toContain("The implement step exited non-zero.");
    expect(markup).toContain('data-tier="issue"');
    expect(markup).toContain('data-testid="needs-you-open"');
  });

  it("renders a 'waiting on you' line for a waiting_on_user entry (not parked)", () => {
    const markup = renderToStaticMarkup(
      <NeedsYouStrip
        tickets={[
          ticket({
            ticketId: "t1",
            title: "Answer this question",
            status: "waiting_on_user",
            updatedAt: AGED,
          }),
        ]}
        onOpen={() => {}}
        onParkAction={vi.fn(async () => {})}
      />,
    );
    expect(markup).toContain("Answer this question");
    expect(markup).toContain("waiting on you");
    expect(markup).toContain('data-tier="waiting"');
    // No action zone for a plain waiting_on_user entry — it isn't parked.
    expect(markup).not.toContain('data-testid="needs-you-actions"');
    expect(markup).not.toContain('data-testid="needs-you-actions-unavailable"');
  });

  it("shows the age once the clock has run, reusing agingFormat's duration label", () => {
    const agedTicket = ticket({
      ticketId: "t1",
      title: "Aged",
      status: "parked",
      parked: issuePark,
      updatedAt: AGED,
    });
    const markup = renderToStaticMarkup(
      <NeedsYouStrip
        tickets={[agedTicket]}
        onOpen={() => {}}
        onParkAction={vi.fn(async () => {})}
      />,
    );
    const expectedAging = ticketAging(agedTicket, Date.now());
    expect(expectedAging).not.toBeNull();
    expect(markup).toContain('data-testid="needs-you-age"');
    expect(markup).toContain(expectedAging?.durationLabel ?? "");
  });

  it("renders the primary action inline and an overflow trigger for the rest", () => {
    const markup = renderToStaticMarkup(
      <NeedsYouStrip
        tickets={[ticket({ ticketId: "t1", status: "parked", parked: issuePark })]}
        onOpen={() => {}}
        onParkAction={vi.fn(async () => {})}
      />,
    );
    expect(markup).toContain('data-testid="needs-you-actions"');
    expect(markup).toContain("Retry");
    expect(markup).toContain('data-testid="needs-you-actions-overflow"');
  });

  it("disables an entry's recovery buttons while a shared park action is in flight", () => {
    const parkedTicket = ticket({ ticketId: "t1", status: "parked", parked: issuePark });
    const idle = renderToStaticMarkup(
      <NeedsYouStrip
        tickets={[parkedTicket]}
        onOpen={() => {}}
        onParkAction={vi.fn(async () => {})}
        pendingParkActionTicketIds={new Set()}
      />,
    );
    const pending = renderToStaticMarkup(
      <NeedsYouStrip
        tickets={[parkedTicket]}
        onOpen={() => {}}
        onParkAction={vi.fn(async () => {})}
        pendingParkActionTicketIds={new Set(["t1"])}
      />,
    );
    // Assert the `disabled=""` ATTRIBUTE, not the className's `disabled:` variants.
    expect(idle).not.toContain('disabled=""');
    expect(pending).toContain('disabled=""');
  });

  it("renders no overflow trigger for a single-action park", () => {
    const markup = renderToStaticMarkup(
      <NeedsYouStrip
        tickets={[
          ticket({
            ticketId: "t1",
            status: "parked",
            parked: { ...issuePark, actions: [{ label: "Retry", to: "implementation" }] },
          }),
        ]}
        onOpen={() => {}}
        onParkAction={vi.fn(async () => {})}
      />,
    );
    expect(markup).toContain("Retry");
    expect(markup).not.toContain('data-testid="needs-you-actions-overflow"');
  });

  it("shows the same muted 'actions unavailable' note as the card when actions are absent", () => {
    const markup = renderToStaticMarkup(
      <NeedsYouStrip
        tickets={[
          ticket({
            ticketId: "t1",
            status: "parked",
            parked: { ...issuePark, actions: undefined },
          }),
        ]}
        onOpen={() => {}}
        onParkAction={vi.fn(async () => {})}
      />,
    );
    expect(markup).toContain('data-testid="needs-you-actions-unavailable"');
    expect(markup).toContain("Actions unavailable");
    expect(markup).not.toContain('data-testid="needs-you-actions"');
  });

  it("tints the issue tier red and the waiting tier blue, matching TicketCard's tokens", () => {
    const markup = renderToStaticMarkup(
      <NeedsYouStrip
        tickets={[
          ticket({ ticketId: "t1", status: "parked", parked: issuePark }),
          ticket({ ticketId: "t2", status: "parked", parked: waitingPark }),
        ]}
        onOpen={() => {}}
        onParkAction={vi.fn(async () => {})}
      />,
    );
    expect(markup).toContain("bg-destructive");
    expect(markup).not.toContain("bg-warning");
    expect(markup).toContain("bg-info");
  });
});
