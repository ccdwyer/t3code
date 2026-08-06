import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardView, resolveBoardDropLaneKey, type BoardViewState } from "./BoardView";

const boardState = {
  lanes: [
    {
      key: "backlog",
      name: "Backlog",
      entry: "manual",
      pipelineStepCount: 0,
      wipLimit: 1,
      admittedTicketIds: ["ticket-1"],
      queuedTicketIds: ["ticket-3"],
      parkedTicketIds: [],
    },
    {
      key: "done",
      name: "Done",
      entry: "manual",
      pipelineStepCount: 0,
      terminal: true,
      admittedTicketIds: ["ticket-2"],
      queuedTicketIds: [],
      parkedTicketIds: [],
    },
  ],
  ticketIds: ["ticket-1", "ticket-2", "ticket-3"],
  ticketById: {
    "ticket-1": {
      ticketId: "ticket-1",
      title: "Add board lanes",
      currentLaneKey: "backlog",
      status: "waiting_on_user",
    },
    "ticket-2": {
      ticketId: "ticket-2",
      title: "Ship milestone",
      currentLaneKey: "done",
      status: "done",
    },
    "ticket-3": {
      ticketId: "ticket-3",
      title: "Wait for review capacity",
      currentLaneKey: "backlog",
      queuedAt: "2026-06-07T00:00:00.000Z",
      status: "queued",
    },
  },
} satisfies BoardViewState;

describe("BoardView", () => {
  it("renders the Spine view by default, with lanes and tier words", () => {
    const markup = renderToStaticMarkup(<BoardView state={boardState} onOpen={() => {}} />);

    expect(markup).toContain("Backlog");
    expect(markup).toContain("Done");
    expect(markup).toContain("Add board lanes");
    expect(markup).toContain("Ship milestone");
    expect(markup).toContain("Wait for review capacity");
    // The state column speaks one five-word vocabulary rather than raw statuses.
    expect(markup).toContain("needs you");
    expect(markup).toContain("queued");
    // Admitted count over the lane's WIP limit.
    expect(markup).toContain("1/1");
  });

  it("offers both views and marks the active one", () => {
    const markup = renderToStaticMarkup(<BoardView state={boardState} onOpen={() => {}} />);
    expect(markup).toContain("Spine");
    expect(markup).toContain("Console");
    expect(markup).toContain('aria-pressed="true"');
  });

  it("renders the Console view as one ranked queue when selected", () => {
    const markup = renderToStaticMarkup(
      <BoardView state={boardState} onOpen={() => {}} mode="console" />,
    );

    // Every ticket appears in a single list rather than per-lane columns, and
    // the lane becomes a label on the row.
    expect(markup).toContain("Add board lanes");
    expect(markup).toContain("Ship milestone");
    expect(markup).toContain("Wait for review capacity");
    expect(markup).toContain("Backlog");
  });

  it("ranks the ticket needing a human above settled work in Console", () => {
    const markup = renderToStaticMarkup(
      <BoardView state={boardState} onOpen={() => {}} mode="console" />,
    );
    // "waiting_on_user" outranks "done", so it must come first in the queue.
    expect(markup.indexOf("Add board lanes")).toBeLessThan(markup.indexOf("Ship milestone"));
  });

  it("hosts the supplied ticket detail inside Console's subject pane", () => {
    const markup = renderToStaticMarkup(
      <BoardView
        state={boardState}
        onOpen={() => {}}
        mode="console"
        renderTicketDetail={(ticketId) => <p>detail for {ticketId}</p>}
      />,
    );
    // The pane IS the detail; there is no separate link out to it.
    expect(markup).toContain("detail for");
    expect(markup).not.toContain("Open full details");
  });

  it("says so rather than rendering an empty pane when no detail is supplied", () => {
    const markup = renderToStaticMarkup(
      <BoardView state={boardState} onOpen={() => {}} mode="console" />,
    );
    expect(markup).toContain("Ticket detail is unavailable");
  });

  it("shows a parked ticket's recovery actions inline, never hidden", () => {
    const parkedState = {
      ...boardState,
      ticketById: {
        ...boardState.ticketById,
        "ticket-1": {
          ...boardState.ticketById["ticket-1"],
          status: "parked",
          parked: {
            substate: "issue" as const,
            label: "tests failing",
            reason: "The suite failed on the second attempt.",
            parkedAt: "2026-06-07T00:00:00.000Z",
            parkedEventId: "evt-1",
            actions: [{ label: "Retry", to: "backlog" }],
          },
        },
      },
    } satisfies BoardViewState;

    const markup = renderToStaticMarkup(
      <BoardView state={parkedState} onOpen={() => {}} onParkAction={async () => undefined} />,
    );
    expect(markup).toContain("blocked");
    expect(markup).toContain("Retry");
  });

  it("says so when a parked ticket has no resolvable actions", () => {
    const driftedState = {
      ...boardState,
      ticketById: {
        ...boardState.ticketById,
        "ticket-1": {
          ...boardState.ticketById["ticket-1"],
          status: "parked",
          parked: {
            substate: "issue" as const,
            label: "tests failing",
            reason: "The suite failed.",
            parkedAt: "2026-06-07T00:00:00.000Z",
            parkedEventId: "evt-1",
          },
        },
      },
    } satisfies BoardViewState;

    // The board definition changed under the park, so there is nothing safe to
    // offer; the view must say that rather than render an empty action row.
    const markup = renderToStaticMarkup(
      <BoardView state={driftedState} onOpen={() => {}} onParkAction={async () => undefined} />,
    );
    expect(markup).toContain("no recovery actions available");
  });
});
it("hosts the supplied ticket detail inside Console's subject pane", () => {
  const markup = renderToStaticMarkup(
    <BoardView
      state={boardState}
      onOpen={() => {}}
      mode="console"
      renderTicketDetail={(ticketId) => <p>detail for {ticketId}</p>}
    />,
  );
  // The pane IS the detail; there is no separate link out to it.
  expect(markup).toContain("detail for");
  expect(markup).not.toContain("Open full details");
});

it("says so rather than rendering an empty pane when no detail is supplied", () => {
  const markup = renderToStaticMarkup(
    <BoardView state={boardState} onOpen={() => {}} mode="console" />,
  );
  expect(markup).toContain("Ticket detail is unavailable");
});
