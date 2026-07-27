import { describe, expect, it } from "vite-plus/test";

import type { BoardViewTicket } from "../BoardView";
import { optionsFor, tierOf } from "./boardModel";

const parkedDetails = {
  substate: "issue" as const,
  label: "Blocked",
  reason: "needs a decision",
  parkedAt: "2026-07-26T00:00:00.000Z",
  parkedEventId: "event-1",
  actions: [{ label: "Retry", to: "backlog" }],
};

const ticket = (overrides: Partial<BoardViewTicket>): BoardViewTicket =>
  ({
    ticketId: "ticket-1",
    title: "A ticket",
    currentLaneKey: "backlog",
    status: "idle",
    ...overrides,
  }) as BoardViewTicket;

describe("optionsFor", () => {
  const onParkAction = () => {};

  it("offers the park actions of a parked ticket", () => {
    const options = optionsFor(ticket({ status: "parked", parked: parkedDetails }), onParkAction);
    expect(options.map((option) => option.label)).toEqual(["Retry"]);
  });

  it("offers nothing when the ticket is not parked", () => {
    expect(optionsFor(ticket({ status: "running" }), onParkAction)).toHaveLength(0);
  });

  /**
   * The digits can only ever belong to ONE feature at a time.
   *
   * A park and an open agent-question wait genuinely coexist — the server's
   * projection handles a StepAwaitingUser landing on a parked row rather than
   * treating it as impossible. So a ticket can carry stale `parked` details
   * while its live status has moved on to waiting on a question. If park
   * actions still bound the digits there, pressing "1" would fire a park action
   * instead of answering, and the engine rejects answers on parked tickets
   * anyway — so the two must never both be live.
   */
  it("does not offer park actions when the ticket is waiting on a question", () => {
    const waiting = ticket({
      status: "waiting_on_user",
      parked: parkedDetails,
    });
    expect(optionsFor(waiting, onParkAction)).toHaveLength(0);
  });

  it("offers nothing without a park-action handler", () => {
    expect(optionsFor(ticket({ status: "parked", parked: parkedDetails }), undefined)).toHaveLength(
      0,
    );
  });
});

describe("tierOf", () => {
  it("treats a waiting_on_user ticket as needing you", () => {
    expect(tierOf(ticket({ status: "waiting_on_user" }))).toBe("waiting");
  });

  it("keeps a parked issue in the issue tier", () => {
    expect(tierOf(ticket({ status: "parked", parked: parkedDetails }))).toBe("issue");
  });
});
