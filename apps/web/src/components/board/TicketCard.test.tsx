import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  dispatchParkAction,
  splitParkActions,
  TicketCard,
  ticketTier,
  type TicketCardView,
} from "./TicketCard";

const AGED = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

const renderCard = (ticket: TicketCardView, onOpen: (id: string) => void = () => {}) =>
  renderToStaticMarkup(
    <DndContext>
      <SortableContext items={[ticket.ticketId]}>
        <TicketCard ticket={ticket} onOpen={onOpen} />
      </SortableContext>
    </DndContext>,
  );

const renderTicketCard = (status: string) =>
  renderCard({ ticketId: `ticket-${status}`, title: `Ticket ${status}`, status });

// Extract the inner HTML of the open-drawer <button> so we can prove the action
// zone lives *outside* it — the whole point of the restructure.
const openTargetHtml = (markup: string): string => {
  const start = markup.indexOf('data-testid="ticket-open"');
  const from = markup.lastIndexOf("<button", start);
  const end = markup.indexOf("</button>", start);
  return markup.slice(from, end);
};

const issuePark = {
  substate: "issue",
  label: "Issue encountered",
  reason: "The implement step exited non-zero.",
  parkedAt: AGED,
  parkedEventId: "event-1",
  actions: [
    { label: "Retry", to: "implementation" },
    { label: "Send back", to: "planning" },
    { label: "Escalate", to: "manual" },
  ],
} satisfies NonNullable<TicketCardView["parked"]>;

const waitingPark = { ...issuePark, substate: "waiting" } satisfies NonNullable<
  TicketCardView["parked"]
>;

const parkedTicket = (overrides: Partial<TicketCardView> = {}): TicketCardView => ({
  ticketId: "ticket-parked",
  title: "Ship the thing",
  status: "parked",
  parked: issuePark,
  ...overrides,
});

describe("ticketTier", () => {
  it("classifies every attention tier", () => {
    expect(ticketTier({ status: "parked", parked: issuePark })).toBe("issue");
    expect(ticketTier({ status: "parked", parked: waitingPark })).toBe("waiting");
    expect(ticketTier({ status: "waiting_on_user" })).toBe("waiting");
    expect(ticketTier({ status: "running" })).toBe("processing");
    expect(ticketTier({ status: "queued" })).toBe("enqueued");
    expect(ticketTier({ status: "idle" })).toBe("neutral");
  });
});

describe("splitParkActions", () => {
  it("keeps the first action primary and the rest in overflow with original indices", () => {
    const actions = [
      { label: "Retry", to: "a" },
      { label: "Send back", to: "b" },
      { label: "Escalate", to: "c" },
    ];
    const { primary, overflow } = splitParkActions(actions);
    expect(primary).toEqual({ action: actions[0], index: 0 });
    expect(overflow).toEqual([
      { action: actions[1], index: 1 },
      { action: actions[2], index: 2 },
    ]);
  });

  it("has no primary for an empty list", () => {
    expect(splitParkActions([])).toEqual({ primary: undefined, overflow: [] });
  });
});

describe("dispatchParkAction", () => {
  const guardFor = (state: { inFlight: boolean }) => ({
    isInFlight: () => state.inFlight,
    begin: () => {
      state.inFlight = true;
    },
    end: () => {
      state.inFlight = false;
    },
  });

  it("invokes onParkAction once with exact args and guards re-entry while in flight", async () => {
    let resolveRpc: (() => void) | undefined;
    const onParkAction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRpc = resolve;
        }),
    );
    const state = { inFlight: false };

    dispatchParkAction(
      { onParkAction, ticketId: "ticket-1", actionIndex: 2, parkedEventId: "event-9" },
      guardFor(state),
    );
    // Doubled click before the RPC settles must not fire a second time.
    dispatchParkAction(
      { onParkAction, ticketId: "ticket-1", actionIndex: 2, parkedEventId: "event-9" },
      guardFor(state),
    );

    expect(onParkAction).toHaveBeenCalledOnce();
    expect(onParkAction).toHaveBeenCalledWith("ticket-1", 2, "event-9");

    resolveRpc?.();
    await Promise.resolve();
    expect(state.inFlight).toBe(false);
  });

  it("is a no-op without a handler or a parked event id", () => {
    const onParkAction = vi.fn(async () => {});
    const state = { inFlight: false };
    dispatchParkAction(
      { onParkAction: undefined, ticketId: "t", actionIndex: 0, parkedEventId: "e" },
      guardFor(state),
    );
    dispatchParkAction(
      { onParkAction, ticketId: "t", actionIndex: 0, parkedEventId: undefined },
      guardFor(state),
    );
    expect(onParkAction).not.toHaveBeenCalled();
  });
});

describe("TicketCard", () => {
  it("renders a queued badge for queued tickets", () => {
    const markup = renderCard({
      ticketId: "ticket-queued",
      title: "Wait for capacity",
      description: "Hold until the release lane has room.",
      status: "queued",
    });

    expect(markup).toContain("Wait for capacity");
    expect(markup).toContain("Hold until the release lane has room.");
    expect(markup).toContain("queued");
  });

  it("renders a waiting-on-dependencies badge when dependencies are unresolved", () => {
    const markup = renderCard({
      ticketId: "ticket-dep",
      title: "Blocked work",
      status: "queued",
      unresolvedDependencyCount: 2,
    });

    expect(markup).toContain("waiting on");
    expect(markup).toContain("2");
    expect(markup).toContain("dependencies");
  });

  it("states status once, in words, with the right tone", () => {
    const cases = [
      { status: "running", tone: "success", label: "running" },
      { status: "blocked", tone: "warning", label: "blocked" },
      { status: "waiting_on_user", tone: "warning", label: "waiting on you" },
      { status: "failed", tone: "destructive", label: "failed" },
      { status: "queued", tone: "muted", label: "queued" },
      { status: "done", tone: "settled", label: "done" },
    ];

    for (const { status, tone, label } of cases) {
      const markup = renderTicketCard(status);

      expect(markup).toContain(`data-status="${status}"`);
      expect(markup).toContain(`data-status-tone="${tone}"`);
      expect(markup).toContain('data-testid="ticket-status"');
      expect(markup).toContain(label);
      // Status is a single text element: no accent border, no status dot pile.
      expect(markup).not.toContain("border-l-4");
      expect(markup).not.toContain("ticket-status-accent");
    }
  });

  it("renders no status chrome at all for idle tickets", () => {
    const markup = renderTicketCard("idle");

    expect(markup).toContain('data-status="idle"');
    expect(markup).not.toContain('data-testid="ticket-status"');
    expect(markup).not.toContain("border-l-4");
  });

  it("shows a live indicator only while running", () => {
    expect(renderTicketCard("running")).toContain("animate-ping");
    for (const status of ["idle", "queued", "blocked", "waiting_on_user", "failed", "done"]) {
      expect(renderTicketCard(status)).not.toContain("animate-ping");
    }
  });

  it("renders the PR chip with the number when pr is present", () => {
    const markup = renderCard({
      ticketId: "ticket-pr",
      title: "Add OAuth",
      status: "done",
      pr: { number: 42, url: "https://github.com/org/repo/pull/42", state: "open" },
    });

    expect(markup).toContain('data-testid="ticket-pr-chip"');
    expect(markup).toContain("#42");
  });

  it("shows a success-colored dot when ciState=success", () => {
    const markup = renderCard({
      ticketId: "ticket-ci",
      title: "CI green",
      status: "running",
      pr: {
        number: 7,
        url: "https://github.com/org/repo/pull/7",
        state: "open",
        ciState: "success",
      },
    });

    expect(markup).toContain("bg-success");
  });

  it("shows a destructive dot when ciState=failure", () => {
    const markup = renderCard({
      ticketId: "ticket-ci-fail",
      title: "CI red",
      status: "blocked",
      pr: {
        number: 8,
        url: "https://github.com/org/repo/pull/8",
        state: "open",
        ciState: "failure",
      },
    });

    expect(markup).toContain("bg-destructive");
  });

  it("renders no PR chip when pr is absent", () => {
    const markup = renderCard({ ticketId: "ticket-no-pr", title: "No PR yet", status: "idle" });

    expect(markup).not.toContain('data-testid="ticket-pr-chip"');
  });

  // --- Structural refactor ---------------------------------------------------

  it("roots the card in a non-button container with the drag listeners on the open target", () => {
    const markup = renderTicketCard("idle");
    // The root is a div, not a button (so action controls can nest as siblings).
    expect(markup.startsWith("<div")).toBe(true);
    // dnd-kit stamps the sortable role/tabindex onto the element carrying the
    // listeners — here, the open-target button, not the root container.
    const openHtml = openTargetHtml(markup);
    expect(openHtml).toContain('data-testid="ticket-open"');
    expect(openHtml).toContain('role="button"');
  });

  it("keeps the action zone outside the open target so an action click never opens the drawer", () => {
    const markup = renderCard(parkedTicket());
    expect(markup).toContain('data-testid="ticket-actions"');
    // The action zone must NOT live inside the open-drawer button.
    expect(openTargetHtml(markup)).not.toContain('data-testid="ticket-actions"');
    expect(openTargetHtml(markup)).not.toContain("Retry");
  });

  // --- Attention tiers -------------------------------------------------------

  it("stamps the tier attribute for each attention state", () => {
    expect(renderCard(parkedTicket())).toContain('data-tier="issue"');
    expect(renderCard(parkedTicket({ parked: waitingPark }))).toContain('data-tier="waiting"');
    expect(renderTicketCard("waiting_on_user")).toContain('data-tier="waiting"');
    expect(renderTicketCard("running")).toContain('data-tier="processing"');
    expect(renderTicketCard("queued")).toContain('data-tier="enqueued"');
    expect(renderTicketCard("idle")).toContain('data-tier="neutral"');
  });

  it("tints the issue tier amber (warning) and the waiting tier blue (info)", () => {
    expect(renderCard(parkedTicket())).toContain("border-warning/50");
    expect(renderCard(parkedTicket({ parked: waitingPark }))).toContain("border-info/50");
    // Enqueued dims rather than colors.
    expect(renderTicketCard("queued")).toContain("opacity-60");
  });

  // --- Processing bar --------------------------------------------------------

  it("renders a reduced-motion-safe processing bar and the current step in the footer", () => {
    const markup = renderCard({
      ticketId: "ticket-run",
      title: "Working",
      status: "running",
      currentStepLabel: "implement",
    });
    expect(markup).toContain('data-testid="ticket-processing-bar"');
    expect(markup).toContain("motion-safe:animate-skeleton");
    expect(markup).toContain("running · implement");
  });

  it("omits the processing bar off the running state", () => {
    expect(renderTicketCard("idle")).not.toContain('data-testid="ticket-processing-bar"');
    expect(renderCard(parkedTicket())).not.toContain('data-testid="ticket-processing-bar"');
  });

  // --- Parked content + inline actions --------------------------------------

  it("shows the park label and reason, with aging appended once the clock runs", () => {
    const markup = renderCard(parkedTicket({ updatedAt: AGED }));
    expect(markup).toContain('data-testid="ticket-parked-reason"');
    expect(markup).toContain("The implement step exited non-zero.");
    // Park label wins over the raw status word; the age (AGED == 3h) is appended.
    expect(markup).toContain("Issue encountered ·");
    // An aged issue park escalates to the destructive tone.
    expect(markup).toContain('data-status-tone="destructive"');
  });

  it("keeps a fresh park showing its label without an appended clock", () => {
    const fresh = parkedTicket({
      parked: { ...issuePark, parkedAt: new Date().toISOString() },
      updatedAt: new Date().toISOString(),
    });
    const markup = renderCard(fresh);
    expect(markup).toContain("Issue encountered");
    expect(markup).not.toContain("Issue encountered ·");
    expect(markup).toContain('data-status-tone="warning"');
  });

  it("renders the primary action inline and an overflow trigger for the rest", () => {
    const markup = renderCard(parkedTicket());
    expect(markup).toContain("Retry");
    expect(markup).toContain('data-testid="ticket-actions-overflow"');
  });

  it("renders no overflow trigger for a single-action park", () => {
    const markup = renderCard(
      parkedTicket({ parked: { ...issuePark, actions: [{ label: "Retry", to: "a" }] } }),
    );
    expect(markup).toContain("Retry");
    expect(markup).not.toContain('data-testid="ticket-actions-overflow"');
  });

  it("shows an unavailable note when the park has no re-resolved actions", () => {
    const markup = renderCard(parkedTicket({ parked: { ...issuePark, actions: undefined } }));
    expect(markup).toContain('data-testid="ticket-actions-unavailable"');
    expect(markup).toContain("Actions unavailable");
    expect(markup).not.toContain('data-testid="ticket-actions"');
  });
});
