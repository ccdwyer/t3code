import { DndContext } from "@dnd-kit/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LaneColumn, type LaneColumnView } from "./LaneColumn";
import type { TicketCardView } from "./TicketCard";

const lane = {
  key: "in-progress",
  name: "In progress",
  entry: "auto",
  pipelineStepCount: 1,
  wipLimit: 2,
  admittedTicketIds: ["ticket-running", "ticket-parked"],
  queuedTicketIds: [],
  parkedTicketIds: ["ticket-parked"],
} satisfies LaneColumnView;

const admittedTickets: ReadonlyArray<TicketCardView> = [
  { ticketId: "ticket-running", title: "Running ticket", status: "running" },
  { ticketId: "ticket-parked", title: "Parked ticket", status: "parked" },
];

describe("LaneColumn", () => {
  it("shows the WIP header count excluding a parked card, while still rendering it in-lane", () => {
    const markup = renderToStaticMarkup(
      <DndContext>
        <LaneColumn
          lane={lane}
          admittedTickets={admittedTickets}
          queuedTickets={[]}
          onOpen={() => {}}
        />
      </DndContext>,
    );

    // Both cards render in the lane...
    expect(markup).toContain("Running ticket");
    expect(markup).toContain("Parked ticket");
    // ...but the WIP header excludes the parked ticket from the count (1 of 2, not 2 of 2).
    expect(markup).toContain("1/2");
    expect(markup).not.toContain("2/2");
  });

  it("shows the full admitted count against the limit when no ticket is parked", () => {
    const laneWithoutParked = {
      ...lane,
      admittedTicketIds: ["ticket-running"],
      parkedTicketIds: [],
    } satisfies LaneColumnView;

    const markup = renderToStaticMarkup(
      <DndContext>
        <LaneColumn
          lane={laneWithoutParked}
          admittedTickets={[admittedTickets[0]!]}
          queuedTickets={[]}
          onOpen={() => {}}
        />
      </DndContext>,
    );

    expect(markup).toContain("1/2");
  });
});
