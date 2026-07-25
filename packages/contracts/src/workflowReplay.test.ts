import { assert, describe, it } from "@effect/vitest";

import type { WorkflowEvent } from "./workflow.ts";
import { applyReplayEvent, reduceReplayEvents } from "./workflowReplay.ts";

let version = 0;
const ev = (type: string, payload: Record<string, unknown> = {}): WorkflowEvent =>
  ({
    type,
    eventId: `evt-${String(version)}`,
    ticketId: "t-1",
    streamVersion: version++,
    occurredAt: `2026-07-25T00:00:${String(version).padStart(2, "0")}.000Z`,
    payload,
  }) as never;

const created = () => {
  version = 0;
  return ev("TicketCreated", { boardId: "b-1", title: "Add export", laneKey: "backlog" });
};

describe("workflowReplay", () => {
  describe("seeding", () => {
    it("seeds lane, title and idle status from TicketCreated", () => {
      const state = applyReplayEvent(null, created());
      assert.equal(state?.laneKey, "backlog");
      assert.equal(state?.title, "Add export");
      assert.equal(state?.status, "idle");
      assert.equal(state?.asOfStreamVersion, 0);
    });

    it("carries optional description and tokenBudget only when present", () => {
      version = 0;
      const withOptionals = applyReplayEvent(
        null,
        ev("TicketCreated", {
          boardId: "b-1",
          title: "T",
          laneKey: "backlog",
          description: "why",
          tokenBudget: 500,
        }),
      );
      assert.equal(withOptionals?.description, "why");
      assert.equal(withOptionals?.tokenBudget, 500);

      const without = applyReplayEvent(null, created());
      assert.isUndefined(without?.description);
      assert.isUndefined(without?.tokenBudget);
    });

    it("cannot fold an event that precedes TicketCreated", () => {
      version = 5;
      assert.isNull(applyReplayEvent(null, ev("PipelineStarted", {})));
    });
  });

  describe("lane transitions", () => {
    it("follows TicketMovedToLane, TicketQueued and TicketAdmitted", () => {
      const state = reduceReplayEvents([
        created(),
        ev("TicketMovedToLane", { toLane: "implement", laneEntryToken: "tok", reason: "manual" }),
        ev("TicketQueued", { lane: "review" }),
        ev("TicketAdmitted", { lane: "review", laneEntryToken: "tok2" }),
      ]);
      assert.equal(state?.laneKey, "review");
      assert.equal(state?.status, "idle");
    });

    it("follows the legacy TicketRouted event, which old streams still carry", () => {
      const state = reduceReplayEvents([
        created(),
        ev("TicketRouted", { fromLane: "backlog", toLane: "done" }),
      ]);
      assert.equal(state?.laneKey, "done");
    });

    it("leaves status alone on TicketRouted, exactly as the projection does", () => {
      // The projection's TicketRouted case writes current_lane_key and
      // terminal_at only. A reducer that also set a status here would make a
      // replayed card disagree with the live board.
      const state = reduceReplayEvents([
        created(),
        ev("PipelineStarted", { pipelineRunId: "pr", laneKey: "backlog", laneEntryToken: "tok" }),
        ev("TicketRouted", { fromLane: "backlog", toLane: "done" }),
      ]);
      assert.equal(state?.status, "running");
    });

    it("queues then admits, which is the WIP-gated entry order", () => {
      const queued = reduceReplayEvents([created(), ev("TicketQueued", { lane: "review" })]);
      assert.equal(queued?.status, "queued");
      assert.equal(queued?.laneKey, "review");
    });
  });

  describe("status transitions", () => {
    const after = (...events: ReadonlyArray<WorkflowEvent>) =>
      reduceReplayEvents([created(), ...events]);

    it("runs on PipelineStarted", () => {
      assert.equal(
        after(ev("PipelineStarted", { pipelineRunId: "pr", laneKey: "l", laneEntryToken: "t" }))
          ?.status,
        "running",
      );
    });

    it("does NOT change status on StepStarted", () => {
      // The projection's StepStarted case writes only current_step_label.
      const state = after(
        ev("PipelineStarted", { pipelineRunId: "pr", laneKey: "l", laneEntryToken: "t" }),
        ev("StepStarted", {
          pipelineRunId: "pr",
          stepRunId: "sr",
          stepKey: "k",
          stepType: "agent",
        }),
      );
      assert.equal(state?.status, "running");
    });

    it("does NOT change ticket status on StepFailed", () => {
      // StepFailed writes to projection_step_run. The ticket stays running until
      // the engine blocks or routes it.
      const state = after(
        ev("PipelineStarted", { pipelineRunId: "pr", laneKey: "l", laneEntryToken: "t" }),
        ev("StepFailed", { stepRunId: "sr", error: "boom" }),
      );
      assert.equal(state?.status, "running");
    });

    it("waits and resumes across StepAwaitingUser / StepUserResolved", () => {
      const waiting = after(ev("StepAwaitingUser", { stepRunId: "sr", waitingReason: "input" }));
      assert.equal(waiting?.status, "waiting_on_user");
      const resumed = reduceReplayEvents([ev("StepUserResolved", { stepRunId: "sr" })], waiting);
      assert.equal(resumed?.status, "running");
    });

    it("blocks on TicketBlocked and parks on TicketParked", () => {
      assert.equal(after(ev("TicketBlocked", { reason: "no route" }))?.status, "blocked");
      assert.equal(
        after(ev("TicketParked", { substate: "issue", label: "L", reason: "r" }))?.status,
        "parked",
      );
    });

    it("ignores lifecycle events while parked, as the projection's guards do", () => {
      const parked = after(ev("TicketParked", { substate: "issue", label: "L", reason: "r" }));
      const stillParked = reduceReplayEvents(
        [
          ev("PipelineStarted", { pipelineRunId: "pr", laneKey: "l", laneEntryToken: "t" }),
          ev("TicketBlocked", { reason: "x" }),
        ],
        parked,
      );
      assert.equal(stillParked?.status, "parked");
    });

    it("tracks fork spawn and resolve", () => {
      const forked = after(ev("TicketForkSpawned", { stepRunId: "sr", children: [] }));
      assert.equal(forked?.status, "forked");
      const resolved = reduceReplayEvents(
        [ev("TicketForkResolved", { stepRunId: "sr", result: "success" })],
        forked,
      );
      assert.equal(resolved?.status, "running");
    });
  });

  describe("edits", () => {
    it("applies title, description and budget edits", () => {
      const state = reduceReplayEvents([
        created(),
        ev("TicketEdited", { title: "Renamed", description: "new why", tokenBudget: 900 }),
      ]);
      assert.equal(state?.title, "Renamed");
      assert.equal(state?.description, "new why");
      assert.equal(state?.tokenBudget, 900);
    });

    it("clears the budget on an explicit null and leaves untouched fields alone", () => {
      const state = reduceReplayEvents([
        created(),
        ev("TicketEdited", { tokenBudget: 900 }),
        ev("TicketEdited", { tokenBudget: null }),
      ]);
      assert.isUndefined(state?.tokenBudget);
      assert.equal(state?.title, "Add export");
    });
  });

  describe("position tracking", () => {
    it("advances version and timestamp even for events that change nothing", () => {
      // The scrubber positions by these, so a no-op event must still move them.
      const state = reduceReplayEvents([
        created(),
        ev("TicketMessagePosted", { messageId: "m", author: "user", body: "hi", attachments: [] }),
      ]);
      assert.equal(state?.asOfStreamVersion, 1);
      assert.equal(state?.status, "idle");
    });

    it("folds forward from a server-computed base", () => {
      // The truncated-timeline path: the client never sees the head events.
      const base = {
        laneKey: "review" as never,
        title: "From base",
        status: "idle" as never,
        asOfStreamVersion: 400,
        occurredAt: "2026-07-25T00:00:00.000Z",
      };
      version = 401;
      const state = reduceReplayEvents([ev("TicketQueued", { lane: "verify" })], base);
      assert.equal(state?.laneKey, "verify");
      assert.equal(state?.title, "From base");
      assert.equal(state?.asOfStreamVersion, 401);
    });
  });
});
