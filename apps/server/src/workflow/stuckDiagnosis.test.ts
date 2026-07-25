import { assert, describe, it } from "@effect/vitest";

import { diagnoseTicket, type DiagnoseTicketInput } from "./stuckDiagnosis.ts";

const NOW = "2026-07-25T12:00:00.000Z";

const input = (over: Partial<DiagnoseTicketInput> = {}): DiagnoseTicketInput => ({
  ticket: {
    status: "idle",
    currentLaneKey: "review",
    updatedAt: NOW,
    currentLaneEntryToken: "tok",
    ...over.ticket,
  } as never,
  lane: over.lane === undefined ? undefined : over.lane,
  laneAdmittedCount: over.laneAdmittedCount ?? 0,
  latestStep: over.latestStep,
  firstUnresolvedDependency: over.firstUnresolvedDependency,
  moveTarget: over.moveTarget,
});

const lane = (over: Record<string, unknown> = {}) =>
  ({
    key: "review",
    name: "Review",
    entry: "auto",
    pipelineStepCount: 1,
    ...over,
  }) as never;

const kinds = (result: ReturnType<typeof diagnoseTicket>) =>
  (result?.actions ?? []).map((action) => action.type);

describe("diagnoseTicket", () => {
  describe("never diagnosed", () => {
    it("returns nothing for a terminal ticket even if the caller forgot to filter", () => {
      const result = diagnoseTicket(
        input({ ticket: { status: "blocked", terminalAt: NOW } as never, lane: lane() }),
      );
      assert.isUndefined(result);
    });

    it("returns nothing for parked or running tickets", () => {
      assert.isUndefined(diagnoseTicket(input({ ticket: { status: "parked" } as never })));
      assert.isUndefined(diagnoseTicket(input({ ticket: { status: "running" } as never })));
    });

    it("returns nothing for a queued ticket that is neither gated nor at the limit", () => {
      assert.isUndefined(
        diagnoseTicket(input({ ticket: { status: "queued" } as never, lane: lane() })),
      );
    });
  });

  describe("waiting on a human", () => {
    it("treats a native approval step with no response kind as an approval", () => {
      // The projector maps the absent kind to waiting_for_input, which would
      // otherwise offer an Answer action that answerTicketStep rejects.
      const result = diagnoseTicket(
        input({
          ticket: { status: "waiting_on_user", attentionKind: "waiting_for_input" } as never,
          latestStep: { stepRunId: "sr-1", status: "awaiting_user", stepType: "approval" } as never,
        }),
      );
      assert.equal(result?.kind, "waiting_approval");
      assert.deepStrictEqual(kinds(result), ["resolveApproval", "resolveApproval", "openTicket"]);
    });

    it("offers no approve/reject when the wait carries any checkpoint form", () => {
      // A bare approve cannot satisfy a decision form — the engine rejects it —
      // so the one-click buttons would be guaranteed errors.
      const result = diagnoseTicket(
        input({
          ticket: { status: "waiting_on_user", attentionKind: "waiting_for_approval" } as never,
          latestStep: {
            stepRunId: "sr-1",
            status: "awaiting_user",
            stepType: "approval",
            hasCheckpointForm: true,
          } as never,
        }),
      );
      assert.equal(result?.kind, "waiting_approval");
      assert.deepStrictEqual(kinds(result), ["openTicket"]);
    });

    it("offers no approve/reject without a live awaiting step", () => {
      // A stale stepRunId resolves nothing, so a button would lie.
      const result = diagnoseTicket(
        input({
          ticket: { status: "waiting_on_user", attentionKind: "waiting_for_approval" } as never,
          latestStep: { stepRunId: "sr-1", status: "completed", stepType: "approval" } as never,
        }),
      );
      assert.equal(result?.kind, "waiting_approval");
      assert.deepStrictEqual(kinds(result), ["openTicket"]);
    });

    it("never offers approve/reject for a user-input wait, which resolveApproval refuses", () => {
      const result = diagnoseTicket(
        input({
          ticket: { status: "waiting_on_user", attentionKind: "waiting_for_input" } as never,
          latestStep: {
            stepRunId: "sr-1",
            status: "awaiting_user",
            stepType: "agent",
            providerResponseKind: "user-input",
          } as never,
        }),
      );
      assert.equal(result?.kind, "waiting_input");
      assert.deepStrictEqual(kinds(result), ["openTicketFocusInput", "openTicket"]);
    });

    it("uses neutral copy for an unrecognized wait shape", () => {
      const result = diagnoseTicket(input({ ticket: { status: "waiting_on_user" } as never }));
      assert.equal(result?.summary, "Waiting for a response");
      assert.deepStrictEqual(kinds(result), ["openTicket"]);
    });
  });

  describe("queued", () => {
    it("prefers dependencies over WIP, because raising the limit would not admit it", () => {
      const result = diagnoseTicket(
        input({
          ticket: {
            status: "queued",
            unresolvedDependencyCount: 2,
            dependsOn: ["t-a", "t-b"],
            queuedAt: NOW,
          } as never,
          lane: lane({ wipLimit: 1 }),
          laneAdmittedCount: 5,
          firstUnresolvedDependency: "t-a" as never,
        }),
      );
      assert.equal(result?.kind, "dependency_blocked");
      assert.equal(result?.summary, "Waiting on 2 unresolved dependencies");
      assert.deepStrictEqual(kinds(result), ["openDependency", "clearDependencies", "openTicket"]);
    });

    it("singularizes one dependency", () => {
      const result = diagnoseTicket(
        input({
          ticket: { status: "queued", unresolvedDependencyCount: 1, dependsOn: ["t-a"] } as never,
          lane: lane(),
        }),
      );
      assert.equal(result?.summary, "Waiting on 1 unresolved dependency");
    });

    it("carries the exact edge set so a stale clear cannot drop an unseen edge", () => {
      const result = diagnoseTicket(
        input({
          ticket: {
            status: "queued",
            unresolvedDependencyCount: 1,
            dependsOn: ["t-a", "t-b"],
          } as never,
          lane: lane(),
        }),
      );
      const clear = result?.actions.find((action) => action.type === "clearDependencies");
      assert.deepStrictEqual(
        clear !== undefined && "expectedDependsOn" in clear ? clear.expectedDependsOn : null,
        ["t-a", "t-b"] as never,
      );
    });

    it("reports the WIP limit with its counts", () => {
      const result = diagnoseTicket(
        input({
          ticket: { status: "queued", queuedAt: NOW } as never,
          lane: lane({ name: "Build", wipLimit: 2 }),
          laneAdmittedCount: 2,
          moveTarget: { toLane: "backlog" as never, label: "Send back" },
        }),
      );
      assert.equal(result?.kind, "wip_blocked");
      assert.equal(result?.summary, 'Lane "Build" at WIP limit (2/2)');
      assert.deepStrictEqual(kinds(result), ["openTicket", "moveToLane"]);
      // Intentional short-lived queueing must not flood the strip.
      assert.isAbove(result?.displayAfterMs ?? 0, 0);
    });
  });

  describe("blocked", () => {
    it("classifies a token-budget block before anything else", () => {
      const result = diagnoseTicket(
        input({
          ticket: {
            status: "blocked",
            tokenBudget: 1000,
            totalTokens: 1000,
            attentionReason: "token budget reached (1,000 of 1,000 tokens used)",
          } as never,
          lane: lane(),
          latestStep: { stepRunId: "sr", status: "failed", stepType: "agent" } as never,
        }),
      );
      assert.equal(result?.kind, "step_blocked");
      assert.equal(result?.summary, "Token budget reached (1000/1000)");
      assert.deepStrictEqual(kinds(result), ["clearTokenBudget", "openTicket"]);
    });

    it("does not treat high usage alone as a budget block", () => {
      const result = diagnoseTicket(
        input({
          ticket: {
            status: "blocked",
            tokenBudget: 100,
            totalTokens: 500,
            attentionReason: "pipeline failed with no route",
          } as never,
          lane: lane(),
          latestStep: {
            stepRunId: "sr",
            status: "failed",
            stepType: "agent",
            error: "pipeline failed with no route",
          } as never,
        }),
      );
      assert.equal(result?.kind, "agent_failed");
    });

    it("calls it an agent failure when the reason merely echoes the step error", () => {
      const result = diagnoseTicket(
        input({
          ticket: { status: "blocked", attentionReason: "boom  \n boom" } as never,
          lane: lane(),
          latestStep: {
            stepRunId: "sr",
            status: "failed",
            stepType: "agent",
            attempt: 3,
            error: "boom boom",
            finishedAt: NOW,
          } as never,
        }),
      );
      assert.equal(result?.kind, "agent_failed");
      assert.equal(result?.summary, "Agent failed (attempt 3)");
    });

    it("surfaces a DIFFERENT reason as its own block rather than an agent failure", () => {
      // A post-step cause (definition drift, routing failure) must not be
      // mislabelled as the agent failing.
      const result = diagnoseTicket(
        input({
          ticket: {
            status: "blocked",
            attentionReason: "routed to lane 'gone' which no longer exists",
          } as never,
          lane: lane(),
          latestStep: {
            stepRunId: "sr",
            status: "failed",
            stepType: "agent",
            error: "boom",
          } as never,
        }),
      );
      assert.equal(result?.kind, "step_blocked");
      assert.include(result?.summary ?? "", "no longer exists");
    });

    it("never calls a non-agent step an agent failure", () => {
      const result = diagnoseTicket(
        input({
          ticket: { status: "blocked" } as never,
          lane: lane(),
          latestStep: {
            stepRunId: "sr",
            status: "failed",
            stepType: "approval",
            error: "rejected",
          } as never,
        }),
      );
      assert.equal(result?.kind, "step_blocked");
    });

    it("does not offer Retry for a non-retryable failure", () => {
      const result = diagnoseTicket(
        input({
          ticket: { status: "blocked" } as never,
          lane: lane(),
          latestStep: {
            stepRunId: "sr",
            status: "failed",
            stepType: "agent",
            error: "rejected",
            retryable: false,
          } as never,
        }),
      );
      assert.equal(result?.kind, "agent_failed");
      assert.deepStrictEqual(kinds(result), ["openTicket"]);
    });

    it("does not offer Retry for a non-retryable failure on the generic blocked path", () => {
      // A rejected approval or a cancelled script lands here rather than in
      // agent_failed, and Retry on either is a guaranteed no-op.
      const result = diagnoseTicket(
        input({
          ticket: { status: "blocked", attentionReason: "rejected by reviewer" } as never,
          lane: lane(),
          latestStep: {
            stepRunId: "sr",
            status: "failed",
            stepType: "approval",
            error: "rejected",
            retryable: false,
          } as never,
        }),
      );
      assert.equal(result?.kind, "step_blocked");
      assert.deepStrictEqual(kinds(result), ["openTicket"]);
    });

    it("does not offer Retry when the ticket is not admitted", () => {
      // runLane silently no-ops without a lane entry token.
      const result = diagnoseTicket(
        input({
          ticket: { status: "blocked", currentLaneEntryToken: null } as never,
          lane: lane(),
          latestStep: { stepRunId: "sr", status: "failed", stepType: "agent" } as never,
        }),
      );
      assert.deepStrictEqual(kinds(result), ["openTicket"]);
    });

    it("normalizes a multi-line reason to one truncated line", () => {
      const result = diagnoseTicket(
        input({
          ticket: { status: "blocked", attentionReason: `${"x".repeat(200)}\n\nmore` } as never,
          lane: lane(),
        }),
      );
      assert.notInclude(result?.summary ?? "", "\n");
      assert.isAtMost((result?.summary ?? "").length, 100);
    });
  });

  describe("idle", () => {
    it("flags a ticket admitted into a manual lane that has work", () => {
      const result = diagnoseTicket(
        input({
          ticket: { status: "idle", currentLaneEnteredAt: NOW } as never,
          lane: lane({ name: "Review", entry: "manual", pipelineStepCount: 2 }),
          moveTarget: { toLane: "done" as never, label: "Move on" },
        }),
      );
      assert.equal(result?.kind, "idle_unstarted");
      assert.equal(result?.summary, 'Idle in manual lane "Review" — not started');
      assert.deepStrictEqual(kinds(result), ["runLane", "moveToLane", "openTicket"]);
    });

    it("ignores a zero-pipeline holding lane, which is intentional state", () => {
      // Every ticket in a backlog column looks like this; flagging them would
      // flood the strip.
      assert.isUndefined(
        diagnoseTicket(
          input({
            ticket: { status: "idle" } as never,
            lane: lane({ entry: "manual", pipelineStepCount: 0 }),
          }),
        ),
      );
    });

    it("ignores an auto lane, which admission will start on its own", () => {
      assert.isUndefined(
        diagnoseTicket(
          input({ ticket: { status: "idle" } as never, lane: lane({ entry: "auto" }) }),
        ),
      );
    });

    it("ignores an unadmitted ticket", () => {
      assert.isUndefined(
        diagnoseTicket(
          input({
            ticket: { status: "idle", currentLaneEntryToken: null } as never,
            lane: lane({ entry: "manual", pipelineStepCount: 1 }),
          }),
        ),
      );
    });
  });
});
