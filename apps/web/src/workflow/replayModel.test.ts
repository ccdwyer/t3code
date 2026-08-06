import { describe, expect, it } from "vite-plus/test";

import type { WorkflowTimelineItem } from "@t3tools/contracts";
import { reduceBoardReplay, reduceTicketReplay } from "./replayModel.ts";

let seq = 0;
const item = (
  ticketId: string,
  type: string,
  payload: Record<string, unknown>,
  streamVersion: number,
): WorkflowTimelineItem =>
  ({
    sequence: ++seq,
    event: {
      type,
      eventId: `evt-${String(seq)}`,
      ticketId,
      streamVersion,
      occurredAt: "2026-07-25T00:00:00.000Z",
      payload,
    },
  }) as never;

const created = (ticketId: string, laneKey = "backlog") =>
  item(ticketId, "TicketCreated", { boardId: "b-1", title: `T ${ticketId}`, laneKey }, 0);

const moved = (ticketId: string, toLane: string, streamVersion: number) =>
  item(
    ticketId,
    "TicketMovedToLane",
    { toLane, laneEntryToken: "tok", reason: "manual" },
    streamVersion,
  );

describe("reduceTicketReplay", () => {
  it("folds up to and including the scrub index, not past it", () => {
    seq = 0;
    const items = [created("t-1"), moved("t-1", "implement", 1), moved("t-1", "review", 2)];

    expect(reduceTicketReplay(items, undefined, 0)?.laneKey).toBe("backlog");
    expect(reduceTicketReplay(items, undefined, 1)?.laneKey).toBe("implement");
    expect(reduceTicketReplay(items, undefined, 2)?.laneKey).toBe("review");
  });

  it("clamps an index past the end rather than throwing", () => {
    seq = 0;
    const items = [created("t-1"), moved("t-1", "implement", 1)];
    expect(reduceTicketReplay(items, undefined, 99)?.laneKey).toBe("implement");
  });

  it("seeds from a server base and marks the history partial", () => {
    seq = 0;
    const base = {
      laneKey: "review",
      title: "From base",
      description: "why",
      tokenBudget: 500,
      status: "idle",
      asOfStreamVersion: 400,
      occurredAt: "2026-07-25T00:00:00.000Z",
    } as never;
    const items = [item("t-1", "TicketQueued", { lane: "verify" }, 401)];

    const state = reduceTicketReplay(items, base, 0);
    expect(state?.laneKey).toBe("verify");
    expect(state?.title).toBe("From base");
    // The fork preview needs these, so they must survive the base seeding.
    expect(state?.description).toBe("why");
    expect(state?.tokenBudget).toBe(500);
    expect(state?.partialHistory).toBe(true);
  });

  it("is not partial when the whole stream was returned", () => {
    seq = 0;
    expect(reduceTicketReplay([created("t-1")], undefined, 0)?.partialHistory).toBe(false);
  });

  it("returns null when the window has no TicketCreated and no base", () => {
    seq = 0;
    const items = [moved("t-1", "implement", 7)];
    expect(reduceTicketReplay(items, undefined, 0)).toBeNull();
  });

  it("returns null for an empty timeline", () => {
    expect(reduceTicketReplay([], undefined, 0)).toBeNull();
  });
});

describe("reduceBoardReplay", () => {
  it("groups tickets by their lane as of the scrub position", () => {
    seq = 0;
    const items = [
      created("t-1"),
      created("t-2"),
      moved("t-1", "implement", 1),
      moved("t-2", "implement", 1),
      moved("t-1", "review", 2),
    ];

    const state = reduceBoardReplay(items, ["backlog", "implement", "review"] as never, 999);
    expect([...(state.lanes.get("review" as never) ?? [])].map((t) => t.ticketId)).toEqual(["t-1"]);
    expect([...(state.lanes.get("implement" as never) ?? [])].map((t) => t.ticketId)).toEqual([
      "t-2",
    ]);
    expect(state.ghostLanes).toEqual([]);
  });

  it("stops at uptoSequence, so scrubbing backwards shows the earlier position", () => {
    seq = 0;
    const items = [created("t-1"), moved("t-1", "implement", 1), moved("t-1", "review", 2)];
    const midpoint = items[1]?.sequence ?? 0;

    const state = reduceBoardReplay(items, ["backlog", "implement", "review"] as never, midpoint);
    expect([...(state.lanes.get("implement" as never) ?? [])].map((t) => t.ticketId)).toEqual([
      "t-1",
    ]);
    expect(state.lanes.get("review" as never)).toBeUndefined();
  });

  it("classifies a lane the current definition no longer has as a ghost lane", () => {
    seq = 0;
    const items = [created("t-1"), moved("t-1", "deleted-lane", 1)];

    // The reducer, not the component, decides this — it is given the live lanes.
    const state = reduceBoardReplay(items, ["backlog", "implement"] as never, 999);
    expect(state.ghostLanes).toEqual(["deleted-lane"]);
    expect([...(state.lanes.get("deleted-lane" as never) ?? [])].map((t) => t.ticketId)).toEqual([
      "t-1",
    ]);
  });

  it("orders by global sequence rather than the order it was handed", () => {
    seq = 0;
    const create = created("t-1");
    const first = moved("t-1", "implement", 1);
    const second = moved("t-1", "review", 2);
    // Shuffled: occurredAt is identical, so only `sequence` can order these.
    const state = reduceBoardReplay([second, create, first], ["review"] as never, 999);
    expect([...(state.lanes.get("review" as never) ?? [])].map((t) => t.ticketId)).toEqual(["t-1"]);
  });

  it("drops a ticket whose creation falls outside the window", () => {
    seq = 0;
    // A board window that opens mid-stream cannot place this ticket on a lane;
    // inventing a position would be worse than omitting it.
    const state = reduceBoardReplay(
      [moved("t-orphan", "implement", 5)],
      ["implement"] as never,
      999,
    );
    expect(state.lanes.size).toBe(0);
  });
});
