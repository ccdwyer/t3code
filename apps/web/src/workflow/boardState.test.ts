import { describe, expect, it } from "vite-plus/test";

import { applyBoardStreamItem, emptyBoardState } from "./boardState.ts";

describe("boardState", () => {
  it("applies a snapshot then a ticket delta", () => {
    let state = applyBoardStreamItem(emptyBoardState, {
      kind: "snapshot",
      snapshot: {
        projectId: "project-1",
        board: {
          boardId: "b-1",
          name: "Delivery",
          lanes: [
            { key: "backlog", name: "Backlog", entry: "manual", pipelineStepCount: 0, wipLimit: 1 },
            { key: "done", name: "Done", entry: "manual", pipelineStepCount: 0, terminal: true },
          ],
        },
        tickets: [
          {
            ticketId: "t-1",
            boardId: "b-1",
            title: "X",
            description: "Snapshot description",
            currentLaneKey: "backlog",
            status: "idle",
          },
          {
            ticketId: "t-queued",
            boardId: "b-1",
            title: "Queued",
            currentLaneKey: "backlog",
            queuedAt: "2026-06-07T00:00:00.000Z",
            status: "queued",
          },
        ],
      },
    } as never);
    expect(state.projectId).toBe("project-1");
    expect(state.ticketIds).toEqual(["t-1", "t-queued"]);
    expect(state.lanes[0]?.wipLimit).toBe(1);
    expect(state.lanes[0]?.admittedTicketIds).toEqual(["t-1"]);
    expect(state.lanes[0]?.queuedTicketIds).toEqual(["t-queued"]);
    expect(state.ticketById["t-1"]?.description).toBe("Snapshot description");
    expect(state.ticketById["t-queued"]?.queuedAt).toBe("2026-06-07T00:00:00.000Z");

    state = applyBoardStreamItem(state, {
      kind: "ticket",
      ticket: {
        ticketId: "t-queued",
        boardId: "b-1",
        title: "Queued",
        description: "",
        currentLaneKey: "done",
        status: "done",
      },
    } as never);
    expect(state.ticketById["t-queued"]?.currentLaneKey).toBe("done");
    expect(state.ticketById["t-queued"]?.description).toBe("");
    expect(state.ticketById["t-queued"]?.queuedAt).toBeUndefined();
    expect(state.lanes[0]?.queuedTicketIds).toEqual([]);
    expect(state.lanes[1]?.admittedTicketIds).toEqual(["t-queued"]);
  });

  const parkedFields = {
    attentionKind: "parked_waiting",
    currentStepLabel: "Waiting for CI",
    parked: {
      substate: "waiting",
      label: "Waiting for CI",
      reason: "parked",
      parkedAt: "2026-07-22T00:00:00.000Z",
      parkedEventId: "evt-parked-1",
      actions: [{ label: "Resume", to: "in-progress" }],
    },
  };

  it("threads slaBreachedAt from snapshot and ticket delta", () => {
    let state = applyBoardStreamItem(emptyBoardState, {
      kind: "snapshot",
      snapshot: {
        projectId: "project-1",
        board: {
          boardId: "b-1",
          name: "Delivery",
          lanes: [{ key: "review", name: "Review", entry: "manual", pipelineStepCount: 0 }],
        },
        tickets: [
          {
            ticketId: "t-sla",
            boardId: "b-1",
            title: "Slow",
            currentLaneKey: "review",
            status: "idle",
            slaBreachedAt: "2026-07-24T04:00:00.000Z",
          },
        ],
      },
    } as never);
    expect(state.ticketById["t-sla"]?.slaBreachedAt).toBe("2026-07-24T04:00:00.000Z");

    state = applyBoardStreamItem(state, {
      kind: "ticket",
      ticket: {
        ticketId: "t-sla",
        boardId: "b-1",
        title: "Slow",
        currentLaneKey: "review",
        status: "idle",
        slaBreachedAt: "2026-07-24T05:00:00.000Z",
      },
    } as never);
    expect(state.ticketById["t-sla"]?.slaBreachedAt).toBe("2026-07-24T05:00:00.000Z");
  });

  it("retains parked, currentStepLabel, and attentionKind from a snapshot", () => {
    const state = applyBoardStreamItem(emptyBoardState, {
      kind: "snapshot",
      snapshot: {
        projectId: "project-1",
        board: {
          boardId: "b-1",
          name: "Delivery",
          lanes: [
            {
              key: "in-progress",
              name: "In progress",
              entry: "auto",
              pipelineStepCount: 1,
              wipLimit: 2,
            },
          ],
        },
        tickets: [
          {
            ticketId: "t-parked",
            boardId: "b-1",
            title: "Parked ticket",
            currentLaneKey: "in-progress",
            status: "parked",
            ...parkedFields,
          },
        ],
      },
    } as never);

    const ticket = state.ticketById["t-parked"];
    expect(ticket?.attentionKind).toBe("parked_waiting");
    expect(ticket?.currentStepLabel).toBe("Waiting for CI");
    expect(ticket?.parked?.substate).toBe("waiting");
    expect(ticket?.parked?.parkedEventId).toBe("evt-parked-1");
    expect(ticket?.parked?.actions).toEqual([{ label: "Resume", to: "in-progress" }]);
  });

  it("retains parked, currentStepLabel, and attentionKind across an incremental update", () => {
    let state = applyBoardStreamItem(emptyBoardState, {
      kind: "snapshot",
      snapshot: {
        projectId: "project-1",
        board: {
          boardId: "b-1",
          name: "Delivery",
          lanes: [
            {
              key: "in-progress",
              name: "In progress",
              entry: "auto",
              pipelineStepCount: 1,
              wipLimit: 2,
            },
          ],
        },
        tickets: [
          {
            ticketId: "t-1",
            boardId: "b-1",
            title: "Ticket",
            currentLaneKey: "in-progress",
            status: "running",
          },
        ],
      },
    } as never);

    state = applyBoardStreamItem(state, {
      kind: "ticket",
      ticket: {
        ticketId: "t-1",
        boardId: "b-1",
        title: "Ticket",
        currentLaneKey: "in-progress",
        status: "parked",
        ...parkedFields,
      },
    } as never);

    const ticket = state.ticketById["t-1"];
    expect(ticket?.attentionKind).toBe("parked_waiting");
    expect(ticket?.currentStepLabel).toBe("Waiting for CI");
    expect(ticket?.parked?.reason).toBe("parked");
    expect(ticket?.parked?.parkedAt).toBe("2026-07-22T00:00:00.000Z");
    expect(ticket?.parked?.actions).toEqual([{ label: "Resume", to: "in-progress" }]);
  });

  it("groups a parked ticket into its lane's render list but excludes it from WIP counting", () => {
    const state = applyBoardStreamItem(emptyBoardState, {
      kind: "snapshot",
      snapshot: {
        projectId: "project-1",
        board: {
          boardId: "b-1",
          name: "Delivery",
          lanes: [
            {
              key: "in-progress",
              name: "In progress",
              entry: "auto",
              pipelineStepCount: 1,
              wipLimit: 2,
            },
          ],
        },
        tickets: [
          {
            ticketId: "t-running",
            boardId: "b-1",
            title: "Running",
            currentLaneKey: "in-progress",
            status: "running",
          },
          {
            ticketId: "t-parked",
            boardId: "b-1",
            title: "Parked",
            currentLaneKey: "in-progress",
            status: "parked",
            ...parkedFields,
          },
        ],
      },
    } as never);

    const lane = state.lanes[0];
    // Renders in-lane alongside the running ticket, in stable order.
    expect(lane?.admittedTicketIds).toEqual(["t-running", "t-parked"]);
    expect(lane?.queuedTicketIds).toEqual([]);
    // But is excluded from the WIP-counted set.
    expect(lane?.parkedTicketIds).toEqual(["t-parked"]);
    const wipCount = (lane?.admittedTicketIds.length ?? 0) - (lane?.parkedTicketIds.length ?? 0);
    expect(wipCount).toBe(1);
  });

  it("leaves queued/admitted classification unchanged for non-parked tickets", () => {
    const state = applyBoardStreamItem(emptyBoardState, {
      kind: "snapshot",
      snapshot: {
        projectId: "project-1",
        board: {
          boardId: "b-1",
          name: "Delivery",
          lanes: [
            { key: "backlog", name: "Backlog", entry: "manual", pipelineStepCount: 0, wipLimit: 2 },
          ],
        },
        tickets: [
          {
            ticketId: "t-admitted",
            boardId: "b-1",
            title: "Admitted",
            currentLaneKey: "backlog",
            status: "idle",
          },
          {
            ticketId: "t-queued",
            boardId: "b-1",
            title: "Queued",
            currentLaneKey: "backlog",
            queuedAt: "2026-06-07T00:00:00.000Z",
            status: "queued",
          },
        ],
      },
    } as never);

    const lane = state.lanes[0];
    expect(lane?.admittedTicketIds).toEqual(["t-admitted"]);
    expect(lane?.queuedTicketIds).toEqual(["t-queued"]);
    expect(lane?.parkedTicketIds).toEqual([]);
  });
});
