import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { MessageId } from "./baseSchemas.ts";
import {
  BoardListEntry,
  BoardId,
  BoardSnapshot,
  BoardTicketView,
  LaneEntryToken,
  AgentStep,
  StepOutcome,
  StepRunStatus,
  TicketAttachment,
  TicketStatus,
  TicketId,
  WorkflowStep,
  WorkflowTicketDetailView,
  WorkflowStepRunView,
  WorkflowCreateBoardInput,
  WorkflowDefinition,
  WorkflowDefinitionEncoded,
  WorkflowEvent,
  WorkflowEventId,
  WorkflowBoardVersionSummary,
  WorkflowGetBoardVersionResult,
  WorkflowGetBoardDefinitionResult,
  WorkflowImportBoardInput,
  WorkflowImportBoardResult,
  WorkflowLintCode,
  WorkflowLintError,
  WorkflowNeedsAttentionTicketView,
  WorkflowOutboundRule,
  WorkflowRenameBoardInput,
  WorkflowSaveBoardDefinitionResult,
  WorkflowBoardMetrics,
  WorkflowBoardVersionSource,
  WorkflowBoardProposalView,
  WorkflowProposeBoardImprovementInput,
  WorkflowListBoardProposalsInput,
  WorkflowGenerateWorkflowDraftInput,
  WorkflowGetBoardProposalInput,
  WorkflowResolveBoardProposalInput,
  WorkflowRevertBoardProposalInput,
  WorkflowProposeBoardImprovementResult,
  WorkflowListBoardProposalsResult,
  WorkflowGetBoardProposalResult,
  WorkflowResolveBoardProposalResult,
  WorkflowRevertBoardProposalResult,
  WorkflowTicketMessageView,
  WORKFLOW_WS_METHODS,
  WorkflowSourceConfig,
  WorkSourceAutoPull,
  WorkflowParkSubstate,
  WorkflowParkTarget,
  WorkflowRouteTarget,
  isParkTarget,
  WorkflowDryRunEnd,
  WorkflowDryRunHop,
  WorkflowDryRunResult,
  WorkflowRouteDecisionView,
  WorkflowTicketAttentionKind,
} from "./workflow.ts";
import { WorkflowTicketAttentionKind as RelayWorkflowTicketAttentionKind } from "./relay.ts";
import { WsWorkflowInvokeParkActionRpc, WorkflowParkActionResult } from "./rpc.ts";

const decodeTicketId = Schema.decodeUnknownEffect(TicketId);
const decodeStepOutcome = Schema.decodeUnknownEffect(StepOutcome);
const decodeStepRunStatus = Schema.decodeUnknownEffect(StepRunStatus);
const decodeTicketAttachment = Schema.decodeUnknownEffect(TicketAttachment);
const decodeTicketStatus = Schema.decodeUnknownEffect(TicketStatus);
const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
const decodeWorkflowDefinitionEncoded = Schema.decodeUnknownEffect(WorkflowDefinitionEncoded);
const decodeWorkflowEvent = Schema.decodeUnknownEffect(WorkflowEvent);
const decodeWorkflowTicketMessageView = Schema.decodeUnknownEffect(WorkflowTicketMessageView);
const decodeWorkflowTicketDetailView = Schema.decodeUnknownEffect(WorkflowTicketDetailView);
const decodeWorkflowStepRunView = Schema.decodeUnknownEffect(WorkflowStepRunView);
const decodeBoardSnapshot = Schema.decodeUnknownEffect(BoardSnapshot);
const decodeWorkflowLintCode = Schema.decodeUnknownEffect(WorkflowLintCode);
const decodeWorkflowLintError = Schema.decodeUnknownEffect(WorkflowLintError);
const decodeWorkflowGetBoardDefinitionResult = Schema.decodeUnknownEffect(
  WorkflowGetBoardDefinitionResult,
);
const decodeWorkflowBoardVersionSummary = Schema.decodeUnknownEffect(WorkflowBoardVersionSummary);
const decodeWorkflowGetBoardVersionResult = Schema.decodeUnknownEffect(
  WorkflowGetBoardVersionResult,
);
const decodeWorkflowSaveBoardDefinitionResult = Schema.decodeUnknownEffect(
  WorkflowSaveBoardDefinitionResult,
);
const decodeWorkflowParkTarget = Schema.decodeUnknownEffect(WorkflowParkTarget);
const decodeWorkflowRouteTarget = Schema.decodeUnknownEffect(WorkflowRouteTarget);
const decodeWorkflowDryRunResult = Schema.decodeUnknownEffect(WorkflowDryRunResult);
const decodeWorkflowRouteDecisionView = Schema.decodeUnknownEffect(WorkflowRouteDecisionView);

describe("workflow ids", () => {
  it("brands a board id from a non-empty string", () => {
    const id = BoardId.make("board-123");
    assert.equal(id, "board-123");
  });

  it.effect("rejects an empty ticket id", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(decodeTicketId(""));
      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it("brands lane-entry tokens and event ids", () => {
    assert.equal(LaneEntryToken.make("tok-1"), "tok-1");
    assert.equal(WorkflowEventId.make("evt-1"), "evt-1");
  });
});

describe("WorkflowDefinition", () => {
  const example = {
    name: "Standard delivery",
    settings: { maxConcurrentTickets: 3 },
    lanes: [
      { key: "backlog", name: "Backlog", entry: "manual" },
      {
        key: "implement",
        name: "Implement",
        entry: "auto",
        pipeline: [
          {
            key: "code",
            type: "agent",
            agent: { instance: "claude_main", model: "sonnet" },
            instruction: { file: "prompts/implement.md" },
          },
          {
            key: "review",
            type: "agent",
            agent: { instance: "codex_main", model: "gpt-5.4" },
            instruction: "Review the diff.",
          },
        ],
        on: { success: "owner_review", failure: "needs_attention" },
      },
      { key: "owner_review", name: "Owner Review", entry: "manual" },
      { key: "needs_attention", name: "Needs Attention", entry: "manual" },
      { key: "done", name: "Done", entry: "manual", terminal: true },
    ],
  };

  it.effect("decodes a valid workflow file", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflowDefinition(example);
      assert.equal(decoded.lanes.length, 5);
      assert.equal(decoded.lanes[1]?.pipeline?.length, 2);
    }),
  );

  it.effect("rejects workflow definition names longer than 128 characters", () =>
    Effect.gen(function* () {
      const overlong = yield* Effect.exit(
        decodeWorkflowDefinition({
          name: "A".repeat(129),
          lanes: [{ key: "queue", name: "Queue", entry: "manual" }],
        }),
      );

      assert.strictEqual(overlong._tag, "Failure");
    }),
  );

  it.effect("decodes captureOutput on agent steps", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflowDefinition({
        name: "x",
        lanes: [
          {
            key: "a",
            name: "A",
            entry: "auto",
            pipeline: [
              {
                key: "review",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: "Return a verdict.",
                captureOutput: true,
              },
            ],
          },
        ],
      });

      const step = decoded.lanes[0]?.pipeline?.[0];
      assert.equal(step?.type, "agent");
      assert.equal((step as any)?.captureOutput, true);
    }),
  );

  it.effect("decodes canonical effort options on agent steps", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflowDefinition({
        name: "x",
        lanes: [
          {
            key: "a",
            name: "A",
            entry: "auto",
            pipeline: [
              {
                key: "code",
                type: "agent",
                agent: {
                  instance: "claude_main",
                  model: "claude-opus-4-6",
                  options: [
                    { id: "effort", value: "high" },
                    { id: "thinking", value: true },
                  ],
                },
                instruction: "Do the thing.",
              },
            ],
          },
        ],
      });

      const step = decoded.lanes[0]?.pipeline?.[0];
      assert.equal(step?.type, "agent");
      assert.deepEqual((step as any)?.agent?.options, [
        { id: "effort", value: "high" },
        { id: "thinking", value: true },
      ]);
    }),
  );

  it.effect("rejects the legacy object form of agent options (canonical array only)", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decodeWorkflowDefinition({
          name: "x",
          lanes: [
            {
              key: "a",
              name: "A",
              entry: "auto",
              pipeline: [
                {
                  key: "code",
                  type: "agent",
                  agent: {
                    instance: "codex_main",
                    model: "gpt-5.5",
                    options: { reasoningEffort: "high", fastMode: true },
                  },
                  instruction: "Do the thing.",
                },
              ],
            },
          ],
        }),
      );

      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it.effect("omits agent options when absent", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflowDefinition({
        name: "x",
        lanes: [
          {
            key: "a",
            name: "A",
            entry: "auto",
            pipeline: [
              {
                key: "code",
                type: "agent",
                agent: { instance: "claude_main", model: "sonnet" },
                instruction: "Do the thing.",
              },
            ],
          },
        ],
      });

      const step = decoded.lanes[0]?.pipeline?.[0];
      assert.equal((step as any)?.agent?.options, undefined);
    }),
  );

  it.effect("decodes step routing and lane transitions", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflowDefinition({
        name: "smart routing",
        lanes: [
          {
            key: "implement",
            name: "Implement",
            entry: "auto",
            pipeline: [
              {
                key: "tests",
                type: "script",
                run: "pnpm test",
                on: { failure: "needs_attention", blocked: "blocked" },
              },
              {
                key: "review",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: "Review the diff.",
                captureOutput: true,
                on: { success: "done" },
              },
              {
                key: "owner",
                type: "approval",
                prompt: "Ship?",
                on: { success: "done", failure: "needs_attention" },
              },
            ],
            transitions: [
              {
                when: { "==": [{ var: "steps.review.output.verdict" }, "block"] },
                to: "needs_attention",
              },
            ],
            on: { success: "done", failure: "needs_attention" },
          },
          { key: "needs_attention", name: "Needs Attention", entry: "manual" },
          { key: "blocked", name: "Blocked", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });

      const lane = decoded.lanes[0];
      const transitionTo = lane?.transitions?.[0]?.to;
      if (transitionTo === undefined || isParkTarget(transitionTo)) {
        assert.fail("expected a plain lane-key transition target");
      } else {
        assert.equal(transitionTo, "needs_attention");
      }
      assert.deepEqual(lane?.transitions?.[0]?.when, {
        "==": [{ var: "steps.review.output.verdict" }, "block"],
      });
      assert.deepEqual((lane?.pipeline?.[0] as any)?.on, {
        failure: "needs_attention",
        blocked: "blocked",
      });
      assert.deepEqual((lane?.pipeline?.[1] as any)?.on, { success: "done" });
      assert.deepEqual((lane?.pipeline?.[2] as any)?.on, {
        success: "done",
        failure: "needs_attention",
      });
    }),
  );

  it.effect("decodes a script step with a duration timeout", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflowDefinition({
        name: "x",
        lanes: [
          {
            key: "a",
            name: "A",
            entry: "auto",
            pipeline: [
              {
                key: "s",
                type: "script",
                run: "pnpm test && pnpm lint",
                timeout: "10 minutes",
                cwd: ".",
                allowFailure: true,
              },
            ],
          },
        ],
      });

      const step = decoded.lanes[0]?.pipeline?.[0];
      assert.equal(step?.type, "script");
      if (step?.type === "script") {
        assert.equal(step.run, "pnpm test && pnpm lint");
      }
    }),
  );

  it.effect("decodes terminal lane retention with duration-string encoding", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflowDefinition({
        name: "retained terminal lanes",
        lanes: [
          { key: "backlog", name: "Backlog", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true, retention: "7 days" },
        ],
      });

      assert.isDefined(decoded.lanes[1]?.retention);
    }),
  );

  it.effect("decodes optional lane SLA with budget and escalateTo", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflowDefinition({
        name: "sla lanes",
        lanes: [
          {
            key: "review",
            name: "Review",
            entry: "manual",
            sla: { budget: "4 hours", escalateTo: "escalation" },
          },
          { key: "escalation", name: "Escalation", entry: "manual" },
          {
            key: "notify_only",
            name: "Notify only",
            entry: "manual",
            sla: { budget: "1 hour" },
          },
        ],
      });

      assert.isDefined(decoded.lanes[0]?.sla);
      assert.equal(decoded.lanes[0]?.sla?.escalateTo, "escalation");
      assert.equal(Duration.toMillis(decoded.lanes[0]!.sla!.budget), 14_400_000);
      assert.equal(decoded.lanes[2]?.sla?.escalateTo, undefined);
      assert.equal(Duration.toMillis(decoded.lanes[2]!.sla!.budget), 3_600_000);

      const encoded = yield* decodeWorkflowDefinitionEncoded({
        name: "sla lanes encoded",
        lanes: [
          {
            key: "review",
            name: "Review",
            entry: "manual",
            sla: { budget: "4 hours", escalateTo: "escalation" },
          },
          { key: "escalation", name: "Escalation", entry: "manual" },
        ],
      });
      assert.equal((encoded as any).lanes[0].sla.budget, "4 hours");
      assert.equal((encoded as any).lanes[0].sla.escalateTo, "escalation");

      const badBudget = yield* Effect.exit(
        decodeWorkflowDefinition({
          name: "bad sla",
          lanes: [
            {
              key: "review",
              name: "Review",
              entry: "manual",
              sla: { budget: "soonish", escalateTo: "escalation" },
            },
            { key: "escalation", name: "Escalation", entry: "manual" },
          ],
        }),
      );
      assert.strictEqual(badBudget._tag, "Failure");

      const badBreach = yield* Effect.exit(
        decodeWorkflowEvent({
          type: "TicketSlaBreached",
          eventId: "evt-bad",
          ticketId: "t-1",
          streamVersion: 1,
          occurredAt: "2026-06-07T04:00:00.000Z",
          payload: {
            // missing laneKey
            laneEntryToken: "tok",
            budgetMs: 14_400_000,
            enteredLaneAt: "2026-06-06T00:00:00.000Z",
          },
        }),
      );
      assert.strictEqual(badBreach._tag, "Failure");
    }),
  );

  it.effect("context pack events round-trip and reject malformed payloads", () =>
    Effect.gen(function* () {
      const compiled = yield* decodeWorkflowEvent({
        type: "TicketContextPackCompiled",
        eventId: "evt-pack-1",
        ticketId: "t-1",
        streamVersion: 7,
        occurredAt: "2026-07-25T04:00:00.000Z",
        payload: {
          forLane: "review",
          fromLane: "implement",
          sections: [
            { key: "prior_outputs", body: "### build\nok", autoGenerated: true },
            { key: "notes", body: "watch the retry loop", autoGenerated: false },
          ],
        },
      });
      assert.strictEqual(compiled.type, "TicketContextPackCompiled");

      // Full-set edit; `sections: []` is the deletion gesture.
      const edited = yield* decodeWorkflowEvent({
        type: "TicketContextPackEdited",
        eventId: "evt-pack-2",
        ticketId: "t-1",
        streamVersion: 8,
        occurredAt: "2026-07-25T04:01:00.000Z",
        payload: { forLane: "review", sections: [] },
      });
      assert.strictEqual(edited.type, "TicketContextPackEdited");

      const unknownKey = yield* Effect.exit(
        decodeWorkflowEvent({
          type: "TicketContextPackCompiled",
          eventId: "evt-pack-3",
          ticketId: "t-1",
          streamVersion: 9,
          occurredAt: "2026-07-25T04:02:00.000Z",
          payload: {
            forLane: "review",
            fromLane: "implement",
            sections: [{ key: "not_a_section", body: "x", autoGenerated: true }],
          },
        }),
      );
      assert.strictEqual(unknownKey._tag, "Failure");

      // Old streams (no pack events) must still decode — append-only union.
      const legacy = yield* decodeWorkflowEvent({
        type: "TicketDependenciesSet",
        eventId: "evt-legacy",
        ticketId: "t-1",
        streamVersion: 2,
        occurredAt: "2026-07-25T04:03:00.000Z",
        payload: { dependsOn: [] },
      });
      assert.strictEqual(legacy.type, "TicketDependenciesSet");
    }),
  );

  it.effect("exposes an encoded workflow definition schema for editor JSON", () =>
    Effect.gen(function* () {
      const encoded = yield* decodeWorkflowDefinitionEncoded({
        name: "Editor JSON",
        lanes: [
          {
            key: "implement",
            name: "Implement",
            entry: "auto",
            wipLimit: 2,
            pipeline: [
              {
                key: "tests",
                type: "script",
                run: "pnpm test",
                timeout: "5 minutes",
              },
              {
                key: "review",
                type: "agent",
                agent: { instance: "codex", model: "gpt-5.5" },
                instruction: "Review the diff.",
                captureOutput: true,
              },
            ],
            transitions: [
              {
                when: { "==": [{ var: "steps.review.output.verdict" }, "pass"] },
                to: "done",
              },
            ],
          },
          { key: "done", name: "Done", entry: "manual", terminal: true, retention: "7 days" },
        ],
      });

      const scriptStep = (encoded as any).lanes[0].pipeline[0];
      assert.equal(scriptStep.timeout, "5 minutes");
      assert.deepEqual((encoded as any).lanes[0].transitions[0].when, {
        "==": [{ var: "steps.review.output.verdict" }, "pass"],
      });
      assert.equal((encoded as any).lanes[0].wipLimit, 2);
      assert.equal((encoded as any).lanes[0].pipeline[1].captureOutput, true);
      assert.equal((encoded as any).lanes[1].retention, "7 days");
    }),
  );

  it.effect("rejects a script step with an invalid timeout", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decodeWorkflowDefinition({
          name: "x",
          lanes: [
            {
              key: "a",
              name: "A",
              entry: "auto",
              pipeline: [{ key: "s", type: "script", run: "echo hi", timeout: "soonish" }],
            },
          ],
        }),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it.effect("rejects an unknown step type", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decodeWorkflowDefinition({
          name: "x",
          lanes: [
            {
              key: "a",
              name: "A",
              entry: "auto",
              pipeline: [{ key: "s", type: "unknown", run: "echo hi" }],
            },
          ],
        }),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );
});

describe("pullRequest step and TicketPrOpened event", () => {
  const decodeBoardTicketView = Schema.decodeUnknownEffect(BoardTicketView);
  const decodeWorkflowStep = Schema.decodeUnknownEffect(WorkflowStep);

  it.effect("decodes a pullRequest step (open and land)", () =>
    Effect.gen(function* () {
      const open = yield* decodeWorkflowStep({
        key: "pr-open",
        type: "pullRequest",
        action: "open",
        base: "main",
        draft: true,
        titleTemplate: "{{ticket.title}}",
        bodyTemplate: "Closes internal ticket.",
      });
      assert.ok(open.type === "pullRequest");
      assert.equal(open.action, "open");
      assert.equal(open.base, "main");
      assert.equal(open.draft, true);

      const land = yield* decodeWorkflowStep({
        key: "pr-land",
        type: "pullRequest",
        action: "land",
        strategy: "squash",
        deleteBranch: false,
      });
      assert.ok(land.type === "pullRequest");
      assert.equal(land.action, "land");
      assert.equal(land.strategy, "squash");
      assert.equal(land.deleteBranch, false);

      const bogusAction = yield* Effect.exit(
        decodeWorkflowStep({ key: "x", type: "pullRequest", action: "bogus" }),
      );
      assert.strictEqual(bogusAction._tag, "Failure");

      const missingAction = yield* Effect.exit(
        decodeWorkflowStep({ key: "x", type: "pullRequest" }),
      );
      assert.strictEqual(missingAction._tag, "Failure");
    }),
  );

  it.effect("decodes TicketPrOpened events and ticket pr views", () =>
    Effect.gen(function* () {
      const event = yield* decodeWorkflowEvent({
        type: "TicketPrOpened",
        eventId: "e1",
        ticketId: "t1",
        streamVersion: 0,
        occurredAt: "2026-06-12T00:00:00.000Z",
        payload: {
          stepRunId: "s1",
          prNumber: 7,
          url: "https://github.com/o/r/pull/7",
          branch: "workflow/t1",
          remoteName: "origin",
          repo: "o/r",
        },
      });
      assert.ok(event.type === "TicketPrOpened");
      assert.equal(event.payload.prNumber, 7);
      assert.equal(event.payload.repo, "o/r");

      const view = yield* decodeBoardTicketView({
        ticketId: "t1",
        boardId: "b1",
        title: "T",
        currentLaneKey: "lane",
        status: "idle",
        pr: { number: 7, url: "https://github.com/o/r/pull/7", state: "open", ciState: "pending" },
      });
      assert.equal(view.pr?.number, 7);
      assert.equal(view.pr?.ciState, "pending");

      const withoutCi = yield* decodeBoardTicketView({
        ticketId: "t1",
        boardId: "b1",
        title: "T",
        currentLaneKey: "lane",
        status: "idle",
        pr: { number: 8, url: "https://github.com/o/r/pull/8", state: "merged" },
      });
      assert.equal(withoutCi.pr?.number, 8);
      assert.equal(withoutCi.pr?.state, "merged");
      assert.equal(withoutCi.pr?.ciState, undefined);

      const withSla = yield* decodeBoardTicketView({
        ticketId: "t1",
        boardId: "b1",
        title: "T",
        currentLaneKey: "lane",
        status: "idle",
        slaBreachedAt: "2026-06-12T04:00:00.000Z",
      });
      assert.equal(withSla.slaBreachedAt, "2026-06-12T04:00:00.000Z");
    }),
  );

  it.effect("decodes a StepStarted event with stepType pullRequest", () =>
    Effect.gen(function* () {
      const event = yield* decodeWorkflowEvent({
        eventId: "evt-1",
        ticketId: "ticket-1",
        streamVersion: 1,
        occurredAt: "2026-06-12T00:00:00.000Z",
        type: "StepStarted",
        payload: {
          pipelineRunId: "pipe-1",
          stepRunId: "step-1",
          stepKey: "pr-open",
          stepType: "pullRequest",
        },
      });
      assert.ok(event.type === "StepStarted");
      assert.equal(event.payload.stepType, "pullRequest");
    }),
  );
});

describe("AgentStep continueSession", () => {
  const decodeAgentStep = Schema.decodeUnknownEffect(AgentStep);

  it.effect("decodes an agent step with and without continueSession", () =>
    Effect.gen(function* () {
      const base = {
        key: "implement",
        type: "agent",
        agent: { instance: "codex", model: "gpt-5.5" },
        instruction: "do work",
      };

      const without = yield* decodeAgentStep(base);
      assert.equal(without.type, "agent");
      assert.equal(without.continueSession, undefined);

      const withTrue = yield* decodeAgentStep({ ...base, continueSession: true });
      assert.equal(withTrue.continueSession, true);

      const withFalse = yield* decodeAgentStep({ ...base, continueSession: false });
      assert.equal(withFalse.continueSession, false);

      const bogus = yield* Effect.exit(decodeAgentStep({ ...base, continueSession: "yes" }));
      assert.strictEqual(bogus._tag, "Failure");
    }),
  );
});

describe("WorkflowLintCode collaboration codes", () => {
  it.effect("accepts invalid_continue_session and invalid_handoff_reference", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* decodeWorkflowLintCode("invalid_continue_session"),
        "invalid_continue_session",
      );
      assert.equal(
        yield* decodeWorkflowLintCode("invalid_handoff_reference"),
        "invalid_handoff_reference",
      );
    }),
  );
});

describe("WorkflowEvent", () => {
  const ticketCreated = {
    type: "TicketCreated",
    eventId: "evt-1",
    ticketId: "t-1",
    streamVersion: 0,
    occurredAt: "2026-06-07T00:00:00.000Z",
    payload: { boardId: "b-1", title: "Add export", laneKey: "backlog" },
  };

  it.effect("decodes a TicketCreated event", () =>
    Effect.gen(function* () {
      const event = yield* decodeWorkflowEvent(ticketCreated);
      assert.equal(event.type, "TicketCreated");
    }),
  );

  it.effect("decodes a pre-checkpoint StepAwaitingUser / StepUserResolved pair", () =>
    Effect.gen(function* () {
      // Every wait persisted before checkpoint forms looks like this. The new
      // fields must not make old streams undecodable.
      const awaiting = yield* decodeWorkflowEvent({
        type: "StepAwaitingUser",
        eventId: "evt-await",
        ticketId: "t-1",
        streamVersion: 3,
        occurredAt: "2026-07-25T00:00:00.000Z",
        payload: { stepRunId: "sr-1", waitingReason: "approval" },
      });
      assert.equal(awaiting.type, "StepAwaitingUser");
      if (awaiting.type === "StepAwaitingUser") {
        assert.isUndefined(awaiting.payload.formSnapshot);
      }

      const resolved = yield* decodeWorkflowEvent({
        type: "StepUserResolved",
        eventId: "evt-resolved",
        ticketId: "t-1",
        streamVersion: 4,
        occurredAt: "2026-07-25T00:00:01.000Z",
        payload: { stepRunId: "sr-1" },
      });
      assert.equal(resolved.type, "StepUserResolved");
      if (resolved.type === "StepUserResolved") {
        assert.isUndefined(resolved.payload.outcome);
        assert.isUndefined(resolved.payload.answers);
      }
    }),
  );

  it.effect("decodes a checkpoint wait and its structured resolution", () =>
    Effect.gen(function* () {
      const awaiting = yield* decodeWorkflowEvent({
        type: "StepAwaitingUser",
        eventId: "evt-await-form",
        ticketId: "t-1",
        streamVersion: 3,
        occurredAt: "2026-07-25T00:00:00.000Z",
        payload: {
          stepRunId: "sr-1",
          waitingReason: "approval",
          formSnapshot: {
            fields: [
              {
                kind: "decision",
                key: "verdict",
                options: [
                  { value: "ship", label: "Ship it", outcome: "success" },
                  { value: "changes", label: "Needs changes", outcome: "failure" },
                ],
              },
              { kind: "text", key: "why", label: "Why?" },
            ],
          },
        },
      });
      assert.equal(awaiting.type, "StepAwaitingUser");

      const resolved = yield* decodeWorkflowEvent({
        type: "StepUserResolved",
        eventId: "evt-resolved-form",
        ticketId: "t-1",
        streamVersion: 4,
        occurredAt: "2026-07-25T00:00:01.000Z",
        payload: {
          stepRunId: "sr-1",
          outcome: "failure",
          decision: "changes",
          answers: { why: "tests missing", checks: ["a", "b"] },
        },
      });
      assert.equal(resolved.type, "StepUserResolved");
      if (resolved.type === "StepUserResolved") {
        assert.equal(resolved.payload.outcome, "failure");
        assert.equal(resolved.payload.decision, "changes");
        assert.deepStrictEqual(resolved.payload.answers?.["checks" as never], ["a", "b"]);
      }
    }),
  );

  it.effect("rejects a field key that could not be addressed from a JsonLogic path", () =>
    Effect.gen(function* () {
      const bad = yield* decodeWorkflowEvent({
        type: "StepUserResolved",
        eventId: "evt-bad-key",
        ticketId: "t-1",
        streamVersion: 4,
        occurredAt: "2026-07-25T00:00:01.000Z",
        // A dot would break `answers.<key>` addressing in lane transitions.
        payload: { stepRunId: "sr-1", answers: { "why.not": "x" } },
      }).pipe(Effect.flip);
      assert.isDefined(bad);
    }),
  );

  it.effect("decodes a pre-replay TicketCreated event that carries no forkOf", () =>
    Effect.gen(function* () {
      // Every event persisted before time-travel replay looks exactly like this.
      // Adding forkOf must not make old streams undecodable, or replaying any
      // existing ticket would fail.
      const event = yield* decodeWorkflowEvent(ticketCreated);
      assert.equal(event.type, "TicketCreated");
      if (event.type === "TicketCreated") {
        assert.isUndefined(event.payload.forkOf);
      }
    }),
  );

  it.effect("decodes a forked TicketCreated event with its provenance", () =>
    Effect.gen(function* () {
      const event = yield* decodeWorkflowEvent({
        ...ticketCreated,
        eventId: "evt-forked",
        payload: {
          ...ticketCreated.payload,
          forkOf: { sourceTicketId: "t-source", sourceEventId: "evt-source" },
        },
      });
      assert.equal(event.type, "TicketCreated");
      if (event.type === "TicketCreated") {
        assert.deepStrictEqual(event.payload.forkOf, {
          sourceTicketId: "t-source",
          sourceEventId: "evt-source",
        });
      }
    }),
  );

  it.effect("decodes ticket collaboration message and edit events", () =>
    Effect.gen(function* () {
      const message = yield* decodeWorkflowEvent({
        type: "TicketMessagePosted",
        eventId: "evt-message-posted",
        ticketId: "t-1",
        streamVersion: 2,
        occurredAt: "2026-06-08T00:00:02.000Z",
        payload: {
          messageId: "msg-ticket-1",
          stepRunId: "sr-1",
          author: "user",
          body: "Use the experimental endpoint.",
          attachments: [
            {
              kind: "image",
              id: "img-1",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 1200,
              dataUrl: "data:image/png;base64,AAAA",
            },
          ],
          createdAt: "2026-06-08T00:00:01.000Z",
        },
      });
      const edit = yield* decodeWorkflowEvent({
        type: "TicketEdited",
        eventId: "evt-ticket-edited",
        ticketId: "t-1",
        streamVersion: 3,
        occurredAt: "2026-06-08T00:00:03.000Z",
        payload: {
          title: "Updated title",
          description: "",
        },
      });

      assert.equal(message.type, "TicketMessagePosted");
      if (message.type !== "TicketMessagePosted") {
        assert.fail("expected TicketMessagePosted");
      }
      assert.equal(message.payload.messageId, MessageId.make("msg-ticket-1"));
      assert.equal(message.payload.attachments[0]?.kind, "image");
      assert.equal(edit.type, "TicketEdited");
    }),
  );

  it.effect("decodes TicketMessageEdited + editedAt view", () =>
    Effect.gen(function* () {
      const event = yield* decodeWorkflowEvent({
        type: "TicketMessageEdited",
        eventId: "e1",
        ticketId: "t1",
        streamVersion: 1,
        occurredAt: "2026-06-17T00:00:00.000Z",
        payload: {
          messageId: "m1",
          body: "x",
          editedAt: "2026-06-17T00:00:00.000Z",
        },
      });
      assert.equal(event.type, "TicketMessageEdited");

      const view = yield* decodeWorkflowTicketMessageView({
        messageId: "m1",
        ticketId: "t1",
        author: "user",
        body: "b",
        attachments: [],
        createdAt: "2026-06-17T00:00:00.000Z",
        editedAt: "2026-06-17T00:00:00.000Z",
      });
      assert.isDefined(view.editedAt);
    }),
  );

  it.effect("accepts reserved ticket attachment variants", () =>
    Effect.gen(function* () {
      const video = yield* decodeTicketAttachment({
        kind: "video",
        id: "video-1",
        name: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 42,
        ref: "ticket-media/video-1",
      });
      const file = yield* decodeTicketAttachment({
        kind: "file",
        id: "file-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
        ref: "ticket-media/file-1",
      });

      assert.equal(video.kind, "video");
      assert.equal(file.kind, "file");
    }),
  );

  it.effect("rejects SVG image data URLs for ticket attachments", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decodeTicketAttachment({
          kind: "image",
          id: "svg-1",
          name: "payload.svg",
          mimeType: "image/svg+xml",
          sizeBytes: 1200,
          dataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        }),
      );
      assert.isTrue(result._tag === "Failure");
    }),
  );

  it.effect("decodes a TicketMovedToLane event", () =>
    Effect.gen(function* () {
      const event = yield* decodeWorkflowEvent({
        type: "TicketMovedToLane",
        eventId: "evt-2",
        ticketId: "t-1",
        streamVersion: 1,
        occurredAt: "2026-06-07T00:00:01.000Z",
        payload: { toLane: "implement", laneEntryToken: "tok-1", reason: "manual" },
      });
      assert.equal(event.type, "TicketMovedToLane");
    }),
  );

  it.effect("decodes TicketMovedToLane with reason sla and TicketSlaBreached", () =>
    Effect.gen(function* () {
      const moved = yield* decodeWorkflowEvent({
        type: "TicketMovedToLane",
        eventId: "evt-sla-move",
        ticketId: "t-1",
        streamVersion: 4,
        occurredAt: "2026-06-07T04:00:00.000Z",
        payload: { toLane: "escalation", laneEntryToken: "tok-sla", reason: "sla" },
      });
      assert.equal(moved.type, "TicketMovedToLane");
      if (moved.type === "TicketMovedToLane") {
        assert.equal(moved.payload.reason, "sla");
      }

      const breach = yield* decodeWorkflowEvent({
        type: "TicketSlaBreached",
        eventId: "evt-sla-breach",
        ticketId: "t-1",
        streamVersion: 3,
        occurredAt: "2026-06-07T04:00:00.000Z",
        payload: {
          laneKey: "review",
          laneEntryToken: "tok-entry",
          budgetMs: 14_400_000,
          enteredLaneAt: "2026-06-06T00:00:00.000Z",
          escalatedTo: "escalation",
        },
      });
      assert.equal(breach.type, "TicketSlaBreached");
      if (breach.type === "TicketSlaBreached") {
        assert.equal(breach.payload.budgetMs, 14_400_000);
        assert.equal(breach.payload.escalatedTo, "escalation");
      }

      const notifyOnly = yield* decodeWorkflowEvent({
        type: "TicketSlaBreached",
        eventId: "evt-sla-notify",
        ticketId: "t-1",
        streamVersion: 5,
        occurredAt: "2026-06-07T05:00:00.000Z",
        payload: {
          laneKey: "review",
          laneEntryToken: "tok-entry-2",
          budgetMs: 3_600_000,
          enteredLaneAt: "2026-06-07T04:00:00.000Z",
        },
      });
      assert.equal(notifyOnly.type, "TicketSlaBreached");
      if (notifyOnly.type === "TicketSlaBreached") {
        assert.equal(notifyOnly.payload.escalatedTo, undefined);
      }
    }),
  );

  it.effect("decodes StepSteered and steer-related view fields", () =>
    Effect.gen(function* () {
      const steered = yield* decodeWorkflowEvent({
        type: "StepSteered",
        eventId: "evt-steer-1",
        ticketId: "t-1",
        streamVersion: 6,
        occurredAt: "2026-06-07T06:00:00.000Z",
        payload: {
          stepRunId: "sr-1",
          messageId: "msg-steer-1",
          text: "Also update the tests",
        },
      });
      assert.equal(steered.type, "StepSteered");
      if (steered.type === "StepSteered") {
        assert.equal(steered.payload.stepRunId, "sr-1");
        assert.equal(steered.payload.messageId, "msg-steer-1");
        assert.equal(steered.payload.text, "Also update the tests");
      }

      const message = yield* decodeWorkflowTicketMessageView({
        messageId: "msg-steer-1",
        ticketId: "t-1",
        stepRunId: "sr-1",
        author: "user",
        body: "Also update the tests",
        attachments: [],
        createdAt: "2026-06-07T06:00:00.000Z",
        kind: "steering",
      });
      assert.equal(message.kind, "steering");

      const step = yield* decodeWorkflowStepRunView({
        stepRunId: "sr-1",
        stepKey: "implement",
        stepType: "agent",
        status: "running",
        waitingReason: null,
        blockedReason: null,
        scriptThreadId: null,
        terminalId: null,
        scriptStatus: null,
        exitCode: null,
        signal: null,
        steerCount: 1,
        lastSteeredAt: "2026-06-07T06:00:00.000Z",
        canSteer: false,
        steerBlockedReason: "delivering",
      });
      assert.equal(step.steerCount, 1);
      assert.equal(step.canSteer, false);
      assert.equal(step.steerBlockedReason, "delivering");
    }),
  );

  it.effect("decodes queue and admission events", () =>
    Effect.gen(function* () {
      const queued = yield* decodeWorkflowEvent({
        type: "TicketQueued",
        eventId: "evt-queued",
        ticketId: "t-1",
        streamVersion: 2,
        occurredAt: "2026-06-07T00:00:02.000Z",
        payload: { lane: "implement" },
      });
      const admitted = yield* decodeWorkflowEvent({
        type: "TicketAdmitted",
        eventId: "evt-admitted",
        ticketId: "t-1",
        streamVersion: 3,
        occurredAt: "2026-06-07T00:00:03.000Z",
        payload: { lane: "implement", laneEntryToken: "tok-2" },
      });

      assert.equal(queued.type, "TicketQueued");
      assert.equal(admitted.type, "TicketAdmitted");
    }),
  );

  it.effect("decodes queued ticket status", () =>
    Effect.gen(function* () {
      const status = yield* decodeTicketStatus("queued");
      assert.equal(status, "queued");
    }),
  );

  it.effect("decodes provider question ids on awaiting-user step metadata", () =>
    Effect.gen(function* () {
      const outcome = yield* decodeStepOutcome({
        _tag: "awaiting_user",
        waitingReason: "Which API should I use?",
        providerThreadId: "thread-ticket-answer",
        providerRequestId: "request-ticket-answer",
        providerResponseKind: "user-input",
        providerQuestionId: "question-api-choice",
      });
      assert.equal(outcome._tag, "awaiting_user");
      assert.equal((outcome as any).providerQuestionId, "question-api-choice");

      const event = yield* decodeWorkflowEvent({
        type: "StepAwaitingUser",
        eventId: "evt-awaiting-question",
        ticketId: "t-1",
        streamVersion: 2,
        occurredAt: "2026-06-07T00:00:02.000Z",
        payload: {
          stepRunId: "sr-1",
          waitingReason: "Which API should I use?",
          providerThreadId: "thread-ticket-answer",
          providerRequestId: "request-ticket-answer",
          providerResponseKind: "user-input",
          providerQuestionId: "question-api-choice",
        },
      });
      assert.equal(event.type, "StepAwaitingUser");
      assert.equal((event.payload as any).providerQuestionId, "question-api-choice");
    }),
  );

  it.effect("decodes blocked step terminal semantics", () =>
    Effect.gen(function* () {
      const status = yield* decodeStepRunStatus("blocked");
      assert.equal(status, "blocked");

      const outcome = yield* decodeStepOutcome({
        _tag: "blocked",
        reason: "Project not trusted to run scripts",
      });
      assert.equal(outcome._tag, "blocked");

      const event = yield* decodeWorkflowEvent({
        type: "StepBlocked",
        eventId: "evt-blocked",
        ticketId: "t-1",
        streamVersion: 2,
        occurredAt: "2026-06-07T00:00:02.000Z",
        payload: {
          stepRunId: "sr-1",
          reason: "Project not trusted to run scripts",
        },
      });
      assert.equal(event.type, "StepBlocked");

      const view = yield* decodeWorkflowStepRunView({
        stepRunId: "sr-1",
        stepKey: "tests",
        stepType: "script",
        status: "blocked",
        waitingReason: null,
        blockedReason: "Project not trusted to run scripts",
        scriptThreadId: null,
        terminalId: null,
        scriptStatus: null,
        exitCode: null,
        signal: null,
      });
      assert.equal(view.blockedReason, "Project not trusted to run scripts");
    }),
  );

  it.effect("carries structured output on completed steps and step run views", () =>
    Effect.gen(function* () {
      const outcome = yield* decodeStepOutcome({
        _tag: "completed",
        output: { verdict: "pass", score: 0.98 },
      });
      assert.equal(outcome._tag, "completed");
      assert.deepEqual((outcome as any).output, { verdict: "pass", score: 0.98 });

      const event = yield* decodeWorkflowEvent({
        type: "StepCompleted",
        eventId: "evt-completed-output",
        ticketId: "t-1",
        streamVersion: 3,
        occurredAt: "2026-06-07T00:00:03.000Z",
        payload: {
          stepRunId: "sr-output",
          output: { verdict: "pass", score: 0.98 },
        },
      });
      assert.equal(event.type, "StepCompleted");
      assert.deepEqual((event.payload as any).output, { verdict: "pass", score: 0.98 });

      const view = yield* decodeWorkflowStepRunView({
        stepRunId: "sr-output",
        stepKey: "review",
        stepType: "agent",
        status: "completed",
        waitingReason: null,
        blockedReason: null,
        scriptThreadId: null,
        terminalId: null,
        scriptStatus: null,
        exitCode: null,
        signal: null,
        output: { verdict: "pass", score: 0.98 },
      });
      assert.deepEqual((view as any).output, { verdict: "pass", score: 0.98 });
    }),
  );

  it.effect("decodes provider response kind on step run views", () =>
    Effect.gen(function* () {
      const view = yield* decodeWorkflowStepRunView({
        stepRunId: "sr-awaiting",
        stepKey: "review",
        stepType: "agent",
        status: "awaiting_user",
        waitingReason: "Approve this command?",
        blockedReason: null,
        providerResponseKind: "request",
        scriptThreadId: null,
        terminalId: null,
        scriptStatus: null,
        exitCode: null,
        signal: null,
      });

      assert.equal((view as any).providerResponseKind, "request");
    }),
  );

  it.effect("decodes script step start and exit events", () =>
    Effect.gen(function* () {
      const started = yield* decodeWorkflowEvent({
        type: "ScriptStepStarted",
        eventId: "evt-script-started",
        ticketId: "t-1",
        streamVersion: 3,
        occurredAt: "2026-06-07T00:00:03.000Z",
        payload: {
          scriptRunId: "script-run-1",
          stepRunId: "sr-1",
          scriptThreadId: "script-thread-1",
          terminalId: "script-terminal-1",
        },
      });
      assert.equal(started.type, "ScriptStepStarted");

      const exited = yield* decodeWorkflowEvent({
        type: "ScriptStepExited",
        eventId: "evt-script-exited",
        ticketId: "t-1",
        streamVersion: 4,
        occurredAt: "2026-06-07T00:00:04.000Z",
        payload: {
          scriptRunId: "script-run-1",
          exitCode: 1,
          signal: null,
          outcome: "exited",
        },
      });
      assert.equal(exited.type, "ScriptStepExited");
    }),
  );

  it.effect("decodes script terminal metadata on a step run view", () =>
    Effect.gen(function* () {
      const view = yield* decodeWorkflowStepRunView({
        stepRunId: "sr-script",
        stepKey: "tests",
        stepType: "script",
        status: "completed",
        waitingReason: null,
        blockedReason: null,
        scriptThreadId: "workflow-script:script-run",
        terminalId: "script-script-run",
        scriptStatus: "exited",
        exitCode: 0,
        signal: null,
      });

      assert.equal((view as any).scriptThreadId, "workflow-script:script-run");
      assert.equal((view as any).terminalId, "script-script-run");
      assert.equal((view as any).scriptStatus, "exited");
      assert.equal((view as any).exitCode, 0);
      assert.equal((view as any).signal, null);
    }),
  );

  it.effect("decodes a TicketRouteDecided audit event", () =>
    Effect.gen(function* () {
      const event = yield* decodeWorkflowEvent({
        type: "TicketRouteDecided",
        eventId: "evt-route-decided",
        ticketId: "t-1",
        streamVersion: 5,
        occurredAt: "2026-06-07T00:00:05.000Z",
        payload: {
          pipelineRunId: "pr-1",
          fromLane: "implement",
          toLane: "needs_attention",
          source: "lane_transition",
          matchedTransitionIndex: 0,
          contextSnapshot: {
            pipeline: { result: "failure" },
            status: "running",
            steps: {
              tests: { exitCode: 1, status: "completed", output: null },
              review: {
                exitCode: null,
                status: "completed",
                output: { verdict: "block" },
              },
            },
          },
        },
      });

      assert.equal(event.type, "TicketRouteDecided");
      if (event.type !== "TicketRouteDecided") {
        assert.fail("expected TicketRouteDecided");
      }
      assert.equal(event.payload.source, "lane_transition");
      assert.equal(event.payload.matchedTransitionIndex, 0);
      assert.deepEqual((event.payload.contextSnapshot as any).steps.review.output, {
        verdict: "block",
      });
    }),
  );
});

describe("board creation contracts", () => {
  const decodeBoardListEntry = Schema.decodeUnknownEffect(BoardListEntry);

  it.effect("decodes a BoardListEntry", () =>
    Effect.gen(function* () {
      const entry = yield* decodeBoardListEntry({
        boardId: "p1__board",
        name: "Board",
        filePath: ".t3/boards/board.json",
        error: null,
      });
      assert.equal(entry.error, null);
    }),
  );

  it("BoardSnapshot carries projectId", () => {
    assert.isTrue(Object.keys(BoardSnapshot.fields).includes("projectId"));
  });

  describe("WorkflowGenerateWorkflowDraftInput.description cap", () => {
    const decodeDraftInput = Schema.decodeUnknownEffect(WorkflowGenerateWorkflowDraftInput);
    const baseInput = {
      projectId: "project-1",
      name: "Release Flow",
      agent: { instance: "codex_main", model: "gpt-5.5" },
    };

    it.effect("accepts a 4000-character description", () =>
      Effect.gen(function* () {
        const decoded = yield* decodeDraftInput({
          ...baseInput,
          description: "x".repeat(4000),
        });
        assert.equal(decoded.description.length, 4000);
      }),
    );

    it.effect("rejects a 4001-character description", () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          decodeDraftInput({ ...baseInput, description: "x".repeat(4001) }),
        );
        assert.isTrue(exit._tag === "Failure");
      }),
    );
  });

  it.effect("decodes lane WIP limits and queued ticket timestamps in board snapshots", () =>
    Effect.gen(function* () {
      const snapshot = yield* decodeBoardSnapshot({
        projectId: "project-1",
        board: {
          boardId: "board-1",
          name: "Board",
          lanes: [
            {
              key: "implement",
              name: "Implement",
              entry: "auto",
              pipelineStepCount: 1,
              wipLimit: 2,
            },
          ],
        },
        tickets: [
          {
            ticketId: "ticket-1",
            boardId: "board-1",
            title: "Queued work",
            description: "Carry this context into the drawer",
            currentLaneKey: "implement",
            status: "queued",
            queuedAt: "2026-06-07T00:00:02.000Z",
          },
        ],
      });

      assert.equal(snapshot.board.lanes[0]?.wipLimit, 2);
      assert.equal(snapshot.tickets[0]?.queuedAt, "2026-06-07T00:00:02.000Z");
      assert.equal(snapshot.tickets[0]?.description, "Carry this context into the drawer");
    }),
  );

  it.effect("decodes ticket detail messages", () =>
    Effect.gen(function* () {
      const detail = yield* decodeWorkflowTicketDetailView({
        ticket: {
          ticketId: "ticket-1",
          boardId: "board-1",
          title: "Queued work",
          description: "Ticket context",
          currentLaneKey: "implement",
          status: "waiting_on_user",
        },
        steps: [
          {
            stepRunId: "sr-1",
            stepKey: "agent",
            stepType: "agent",
            status: "awaiting_user",
            waitingReason: "Need endpoint choice",
            blockedReason: null,
            scriptThreadId: null,
            terminalId: null,
            scriptStatus: null,
            exitCode: null,
            signal: null,
          },
        ],
        messages: [
          {
            messageId: "msg-agent-1",
            ticketId: "ticket-1",
            stepRunId: "sr-1",
            author: "agent",
            body: "Which endpoint should I use?",
            attachments: [],
            createdAt: "2026-06-08T00:00:01.000Z",
          },
        ],
      });

      assert.equal(detail.ticket.description, "Ticket context");
      assert.equal(detail.messages[0]?.body, "Which endpoint should I use?");
    }),
  );

  it.effect("decodes ticket detail route history", () =>
    Effect.gen(function* () {
      const detail = yield* decodeWorkflowTicketDetailView({
        ticket: {
          ticketId: "ticket-1",
          boardId: "board-1",
          title: "Queued work",
          currentLaneKey: "review",
          status: "idle",
        },
        steps: [],
        messages: [],
        routeHistory: [
          {
            occurredAt: "2026-06-08T00:00:01.000Z",
            fromLane: "implement",
            toLane: "review",
            source: "lane_transition",
            matchedTransitionIndex: 1,
            pipelineResult: "success",
            laneRunCount: 2,
            steps: {
              verdict: { status: "completed", exitCode: 0, verdict: "approve" },
            },
          },
          {
            occurredAt: "2026-06-08T00:00:02.000Z",
            toLane: "implement",
            source: "manual",
          },
        ],
      });

      const first = detail.routeHistory?.[0];
      assert.equal(first?.source, "lane_transition");
      assert.equal(first?.matchedTransitionIndex, 1);
      assert.equal(first?.laneRunCount, 2);
      assert.equal(first?.steps?.["verdict"]?.verdict, "approve");
      assert.equal(detail.routeHistory?.[1]?.source, "manual");
      assert.equal(detail.routeHistory?.[1]?.fromLane, undefined);
    }),
  );

  it("exposes the new methods", () => {
    assert.equal(WORKFLOW_WS_METHODS.listBoards, "workflow.listBoards");
    assert.equal(WORKFLOW_WS_METHODS.createBoard, "workflow.createBoard");
    assert.equal(WORKFLOW_WS_METHODS.deleteBoard, "workflow.deleteBoard");
    assert.equal(
      (WORKFLOW_WS_METHODS as Record<string, string>).renameBoard,
      "workflow.renameBoard",
    );
    assert.equal(
      (WORKFLOW_WS_METHODS as Record<string, string>).getBoardDefinition,
      "workflow.getBoardDefinition",
    );
    assert.equal(
      (WORKFLOW_WS_METHODS as Record<string, string>).saveBoardDefinition,
      "workflow.saveBoardDefinition",
    );
    assert.equal(
      (WORKFLOW_WS_METHODS as Record<string, string>).listBoardVersions,
      "workflow.listBoardVersions",
    );
    assert.equal(
      (WORKFLOW_WS_METHODS as Record<string, string>).getBoardVersion,
      "workflow.getBoardVersion",
    );
    assert.equal(
      (WORKFLOW_WS_METHODS as Record<string, string>).setProjectScriptTrust,
      "workflow.setProjectScriptTrust",
    );
    assert.equal((WORKFLOW_WS_METHODS as Record<string, string>).cancelStep, "workflow.cancelStep");
    assert.equal(
      (WORKFLOW_WS_METHODS as Record<string, string>).answerTicketStep,
      "workflow.answerTicketStep",
    );
    assert.equal(
      (WORKFLOW_WS_METHODS as Record<string, string>).steerTicketStep,
      "workflow.steerTicketStep",
    );
    assert.equal((WORKFLOW_WS_METHODS as Record<string, string>).editTicket, "workflow.editTicket");
    assert.equal(WORKFLOW_WS_METHODS.deleteTicket, "workflow.deleteTicket");
  });

  it.effect("decodes workflow editor result contracts", () =>
    Effect.gen(function* () {
      assert.equal(yield* decodeWorkflowLintCode("invalid_wip_limit"), "invalid_wip_limit");
      assert.equal(yield* decodeWorkflowLintCode("invalid_sla"), "invalid_sla");
      assert.equal(
        yield* decodeWorkflowLintCode("unsafe_instruction_path"),
        "unsafe_instruction_path",
      );
      const lintError = yield* decodeWorkflowLintError({
        code: "invalid_json_logic",
        message: "Lane route is invalid",
        laneKey: "implement",
        stepKey: "review",
        transitionIndex: 1,
      });
      assert.equal((lintError as any).transitionIndex, 1);

      const definition = {
        name: "Editable",
        lanes: [
          {
            key: "implement",
            name: "Implement",
            entry: "auto",
            pipeline: [{ key: "tests", type: "script", run: "pnpm test", timeout: "5 minutes" }],
            transitions: [{ when: { var: "pipeline.result" }, to: "done" }],
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      };
      const snapshot = {
        projectId: "project-1",
        board: {
          boardId: "project-1__editable",
          name: "Editable",
          lanes: [{ key: "implement", name: "Implement", entry: "auto", pipelineStepCount: 1 }],
        },
        tickets: [],
      };

      const getResult = yield* decodeWorkflowGetBoardDefinitionResult({
        definition,
        versionHash: "hash-1",
      });
      assert.equal((getResult as any).definition.lanes[0].pipeline[0].timeout, "5 minutes");

      const versionSummary = yield* decodeWorkflowBoardVersionSummary({
        versionId: 42,
        versionHash: "hash-42",
        source: "revert",
        createdAt: "2026-06-08T12:00:00.000Z",
        isCurrent: true,
      });
      assert.equal((versionSummary as any).versionId, 42);
      assert.equal((versionSummary as any).source, "revert");
      assert.equal((versionSummary as any).isCurrent, true);

      const versionResult = yield* decodeWorkflowGetBoardVersionResult({
        versionId: 41,
        definition,
        versionHash: "hash-41",
        source: "import",
        createdAt: "2026-06-08T11:00:00.000Z",
      });
      assert.equal((versionResult as any).definition.lanes[0].pipeline[0].timeout, "5 minutes");
      assert.equal((versionResult as any).source, "import");

      const okResult = yield* decodeWorkflowSaveBoardDefinitionResult({
        ok: true,
        definition,
        versionHash: "hash-2",
        snapshot,
      });
      assert.equal((okResult as any).ok, true);
      assert.equal((okResult as any).definition.lanes[0].pipeline[0].timeout, "5 minutes");

      const lintResult = yield* decodeWorkflowSaveBoardDefinitionResult({
        ok: false,
        lintErrors: [
          {
            code: "invalid_json_logic",
            message: "Invalid transition",
            laneKey: "implement",
            transitionIndex: 0,
          },
        ],
      });
      assert.equal((lintResult as any).ok, false);
      assert.equal((lintResult as any).lintErrors[0].transitionIndex, 0);

      const conflictResult = yield* decodeWorkflowSaveBoardDefinitionResult({
        ok: false,
        conflict: true,
        currentVersionHash: "hash-current",
      });
      assert.equal((conflictResult as any).ok, false);
      assert.equal((conflictResult as any).conflict, true);
      assert.equal((conflictResult as any).currentVersionHash, "hash-current");
    }),
  );

  it.effect("decodes workflow board create input and rejects overlong names", () =>
    Effect.gen(function* () {
      assert.isDefined(WorkflowCreateBoardInput);
      const decodeWorkflowCreateBoardInput = Schema.decodeUnknownEffect(WorkflowCreateBoardInput);
      const input = yield* decodeWorkflowCreateBoardInput({
        projectId: "project-create",
        name: "Created Board",
        agent: { instance: "codex_main", model: "gpt-5.5" },
      });
      assert.equal(input.name, "Created Board");

      const overlong = yield* Effect.exit(
        decodeWorkflowCreateBoardInput({
          projectId: "project-create",
          name: "A".repeat(129),
          agent: { instance: "codex_main", model: "gpt-5.5" },
        }),
      );
      assert.strictEqual(overlong._tag, "Failure");
    }),
  );

  it.effect("decodes workflow board rename input and rejects blank and overlong names", () =>
    Effect.gen(function* () {
      assert.isDefined(WorkflowRenameBoardInput);
      const decodeWorkflowRenameBoardInput = Schema.decodeUnknownEffect(WorkflowRenameBoardInput);
      const input = yield* decodeWorkflowRenameBoardInput({
        boardId: "board-rename",
        name: "Renamed Board",
      });
      assert.equal(input.name, "Renamed Board");

      const blank = yield* Effect.exit(
        decodeWorkflowRenameBoardInput({
          boardId: "board-rename",
          name: "   ",
        }),
      );
      assert.strictEqual(blank._tag, "Failure");

      const overlong = yield* Effect.exit(
        decodeWorkflowRenameBoardInput({
          boardId: "board-rename",
          name: "A".repeat(129),
        }),
      );
      assert.strictEqual(overlong._tag, "Failure");
    }),
  );
});

describe("StepRetryPolicy", () => {
  const lanesWith = (pipeline: ReadonlyArray<unknown>) => ({
    name: "Retry board",
    lanes: [
      { key: "work", name: "Work", entry: "auto", pipeline },
      { key: "done", name: "Done", entry: "manual", terminal: true },
    ],
  });

  it.effect("decodes retry with escalation on agent steps", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflowDefinition(
        lanesWith([
          {
            key: "implement",
            type: "agent",
            agent: { instance: "claude_main", model: "sonnet" },
            instruction: "Do the work.",
            retry: {
              maxAttempts: 3,
              escalate: {
                model: "opus",
                options: [{ id: "effort", value: "high" }],
              },
            },
          },
        ]),
      );
      const step = decoded.lanes[0]?.pipeline?.[0];
      assert.ok(step?.type === "agent");
      assert.equal(step.retry?.maxAttempts, 3);
      assert.equal(step.retry?.escalate?.model, "opus");
      assert.equal(step.retry?.escalate?.options?.[0]?.id, "effort");
    }),
  );

  it.effect("decodes retry on script steps", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflowDefinition(
        lanesWith([
          {
            key: "test",
            type: "script",
            run: "pnpm test",
            retry: { maxAttempts: 2 },
          },
        ]),
      );
      const step = decoded.lanes[0]?.pipeline?.[0];
      assert.ok(step?.type === "script");
      assert.equal(step.retry?.maxAttempts, 2);
    }),
  );

  it.effect("rejects non-integer maxAttempts", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decodeWorkflowDefinition(
          lanesWith([
            {
              key: "test",
              type: "script",
              run: "pnpm test",
              retry: { maxAttempts: 2.5 },
            },
          ]),
        ),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it.effect("decodes the new lint codes", () =>
    Effect.gen(function* () {
      assert.equal(yield* decodeWorkflowLintCode("invalid_retry"), "invalid_retry");
      assert.equal(
        yield* decodeWorkflowLintCode("unknown_template_placeholder"),
        "unknown_template_placeholder",
      );
    }),
  );
});

describe("StepStarted attempt", () => {
  it.effect("decodes StepStarted with and without attempt", () =>
    Effect.gen(function* () {
      const base = {
        eventId: "evt-1",
        ticketId: "ticket-1",
        streamVersion: 1,
        occurredAt: "2026-06-09T00:00:00.000Z",
        type: "StepStarted",
        payload: {
          pipelineRunId: "pipe-1",
          stepRunId: "step-1",
          stepKey: "implement",
          stepType: "agent",
        },
      };
      const legacy = yield* decodeWorkflowEvent(base);
      assert.ok(legacy.type === "StepStarted");
      assert.equal(legacy.payload.attempt, undefined);

      const retried = yield* decodeWorkflowEvent({
        ...base,
        payload: { ...base.payload, attempt: 2 },
      });
      assert.ok(retried.type === "StepStarted");
      assert.equal(retried.payload.attempt, 2);
    }),
  );

  it.effect("decodes step run views with attempt", () =>
    Effect.gen(function* () {
      const view = yield* decodeWorkflowStepRunView({
        stepRunId: "step-1",
        stepKey: "implement",
        stepType: "agent",
        attempt: 2,
        status: "failed",
        waitingReason: null,
        blockedReason: null,
        scriptThreadId: null,
        terminalId: null,
        scriptStatus: null,
        exitCode: null,
        signal: null,
      });
      assert.equal(view.attempt, 2);
    }),
  );
});

describe("MergeStep", () => {
  it.effect("decodes merge steps and the merge step type", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflowDefinition({
        name: "Merge board",
        lanes: [
          {
            key: "land",
            name: "Land",
            entry: "auto",
            pipeline: [
              {
                key: "merge",
                type: "merge",
                target: "main",
                commitMessage: "Land ticket work",
                on: { success: "done", blocked: "needs" },
              },
            ],
          },
          { key: "needs", name: "Needs", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      const step = decoded.lanes[0]?.pipeline?.[0];
      assert.ok(step?.type === "merge");
      assert.equal(step.target, "main");
      assert.equal(step.commitMessage, "Land ticket work");
    }),
  );

  it.effect("decodes non-retryable failed step outcomes", () =>
    Effect.gen(function* () {
      const outcome = yield* decodeStepOutcome({
        _tag: "failed",
        error: "script cancelled",
        retryable: false,
      });
      assert.ok(outcome._tag === "failed");
      assert.equal(outcome.retryable, false);

      const legacy = yield* decodeStepOutcome({ _tag: "failed", error: "boom" });
      assert.ok(legacy._tag === "failed");
      assert.equal(legacy.retryable, undefined);
    }),
  );
});

describe("WorkflowLaneAction", () => {
  it.effect("decodes lane actions and snapshot lanes carrying them", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflowDefinition({
        name: "Action board",
        lanes: [
          {
            key: "review",
            name: "Review",
            entry: "manual",
            actions: [
              { label: "Approve & land", to: "land", hint: "Merges the ticket branch." },
              { label: "Send back", to: "impl" },
            ],
          },
          { key: "impl", name: "Impl", entry: "auto" },
          { key: "land", name: "Land", entry: "manual" },
        ],
      });
      const review = decoded.lanes[0];
      assert.equal(review?.actions?.length, 2);
      assert.equal(review?.actions?.[0]?.label, "Approve & land");
      assert.equal(review?.actions?.[1]?.hint, undefined);

      const snapshot = yield* decodeBoardSnapshot({
        projectId: "project-1",
        board: {
          boardId: "board-1",
          name: "Action board",
          lanes: [
            {
              key: "review",
              name: "Review",
              entry: "manual",
              pipelineStepCount: 0,
              actions: [{ label: "Approve & land", to: "land" }],
            },
          ],
        },
        tickets: [],
      });
      assert.equal(snapshot.board.lanes[0]?.actions?.[0]?.to, "land");
    }),
  );

  it.effect("rejects overlong action labels", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decodeWorkflowDefinition({
          name: "Action board",
          lanes: [
            {
              key: "review",
              name: "Review",
              entry: "manual",
              actions: [{ label: "A".repeat(49), to: "review" }],
            },
          ],
        }),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );
});

describe("WorkflowOutboundRule", () => {
  const decodeRule = Schema.decodeUnknownSync(WorkflowOutboundRule);

  it("decodes a full rule", () => {
    const rule = decodeRule({
      id: "notify-blocked",
      on: "blocked",
      when: { "==": [{ var: "toLane" }, "needs-attention"] },
      to: "conn-abc",
      as: "slack",
      enabled: true,
    });
    assert.equal(rule.id, "notify-blocked");
    assert.equal(rule.on, "blocked");
    assert.equal(rule.as, "slack");
  });

  it("decodes a rule without when (optional)", () => {
    const rule = decodeRule({ id: "x", on: "done", to: "conn", as: "generic", enabled: true });
    assert.strictEqual(rule.when, undefined);
  });

  it("rejects an unknown trigger", () => {
    assert.throws(() =>
      decodeRule({ id: "x", on: "pr_merged", to: "c", as: "generic", enabled: true }),
    );
  });

  it("rejects an empty `to`", () => {
    assert.throws(() =>
      decodeRule({ id: "x", on: "blocked", to: "", as: "generic", enabled: true }),
    );
  });

  it.effect("definition accepts an optional outbound array and defaults to undefined", () =>
    Effect.gen(function* () {
      const def = yield* decodeWorkflowDefinition({
        name: "Standard delivery",
        settings: { maxConcurrentTickets: 3 },
        lanes: [
          { key: "backlog", name: "Backlog", entry: "manual" },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ],
      });
      assert.equal(def.outbound, undefined);
    }),
  );
});

describe("WorkflowNeedsAttentionTicketView", () => {
  const decode = Schema.decodeUnknownEffect(WorkflowNeedsAttentionTicketView);

  it.effect("decodes a needs-attention ticket view with attentionKind blocked", () =>
    Effect.gen(function* () {
      const view = yield* decode({
        ticketId: "t1",
        boardId: "b1",
        boardName: "Delivery",
        title: "Fix login",
        status: "blocked",
        currentLaneKey: "needs_attention",
        attentionKind: "blocked",
        attentionReason: "Merge conflict",
        updatedAt: "2026-06-13T00:00:00.000Z",
        parkedAt: null,
        slaBreachedAt: null,
        slaBreachedReason: null,
      });
      assert.equal(view.attentionKind, "blocked");
      assert.equal(view.ticketId, "t1");
      assert.equal(view.parkedAt, null);
      assert.equal(view.slaBreachedAt, null);
    }),
  );

  it.effect("decodes a needs-attention ticket view with null attentionKind", () =>
    Effect.gen(function* () {
      const view = yield* decode({
        ticketId: "t2",
        boardId: "b1",
        boardName: "Delivery",
        title: "Review PR",
        status: "waiting_on_user",
        currentLaneKey: "review",
        attentionKind: null,
        attentionReason: null,
        updatedAt: "2026-06-13T00:00:00.000Z",
        parkedAt: null,
        slaBreachedAt: null,
        slaBreachedReason: null,
      });
      assert.equal(view.attentionKind, null);
    }),
  );

  it.effect("carries parkedAt for a parked ticket so consumers age from it", () =>
    Effect.gen(function* () {
      const view = yield* decode({
        ticketId: "t3",
        boardId: "b1",
        boardName: "Delivery",
        title: "Parked ticket",
        status: "parked",
        currentLaneKey: "implementation",
        attentionKind: "parked_issue",
        attentionReason: "Hit a snag",
        updatedAt: "2026-06-13T05:00:00.000Z",
        parkedAt: "2026-06-13T00:00:00.000Z",
        slaBreachedAt: null,
        slaBreachedReason: null,
      });
      assert.equal(view.parkedAt, "2026-06-13T00:00:00.000Z");
      assert.equal(view.attentionKind, "parked_issue");
    }),
  );

  it.effect("decodes an SLA-only needs-attention row with null attentionKind", () =>
    Effect.gen(function* () {
      const view = yield* decode({
        ticketId: "t4",
        boardId: "b1",
        boardName: "Delivery",
        title: "Stuck in review",
        status: "idle",
        currentLaneKey: "review",
        attentionKind: null,
        attentionReason: null,
        updatedAt: "2026-06-13T05:00:00.000Z",
        parkedAt: null,
        slaBreachedAt: "2026-06-13T04:00:00.000Z",
        slaBreachedReason: "SLA breached: over 4 hours in Review",
      });
      assert.equal(view.attentionKind, null);
      assert.equal(view.slaBreachedAt, "2026-06-13T04:00:00.000Z");
      assert.equal(view.slaBreachedReason, "SLA breached: over 4 hours in Review");
    }),
  );
});

describe("WorkflowBoardMetrics", () => {
  const decode = Schema.decodeUnknownEffect(WorkflowBoardMetrics);

  it("getBoardMetrics method name is correct", () => {
    assert.equal(WORKFLOW_WS_METHODS.getBoardMetrics, "workflow.getBoardMetrics");
  });

  it.effect("decodes a full WorkflowBoardMetrics object", () =>
    Effect.gen(function* () {
      const metrics = yield* decode({
        windowDays: 7,
        generatedAt: "2026-06-14T00:00:00.000Z",
        throughput: { created: 12, shipped: 8 },
        cycleTime: { count: 8, p50Ms: 3600000, p90Ms: 7200000, avgMs: 4000000 },
        wipByLane: [
          { laneKey: "implement", admitted: 3, queued: 1 },
          { laneKey: "review", admitted: 1, queued: 0 },
        ],
        statusBreakdown: { idle: 4, running: 2, done: 6, blocked: 1 },
        attention: {
          blocked: 1,
          waitingOnUser: 2,
          parked: 0,
          oldest: [
            { ticketId: "t1", title: "Old ticket", laneKey: "review", ageMs: 86400000 },
            { ticketId: "t2", title: "Another old ticket", laneKey: null, ageMs: 172800000 },
          ],
        },
        routeOutcomes: [
          {
            fromLane: "implement",
            toLane: "review",
            source: "lane_on",
            result: "success",
            count: 5,
          },
          {
            fromLane: null,
            toLane: "implement",
            source: "work_source",
            result: "success",
            count: 3,
          },
        ],
        manualMoveCount: 2,
        stepStats: [
          {
            laneKey: "implement",
            stepKey: "code",
            stepType: "agent",
            succeeded: 7,
            failed: 1,
            retries: 2,
            totalTokens: 50000,
            avgDurationMs: 120000,
          },
        ],
      });

      assert.equal(metrics.throughput.created, 12);
      assert.equal(metrics.cycleTime.p50Ms, 3600000);
      assert.equal(metrics.wipByLane[0]?.laneKey, "implement");
      assert.equal((metrics.statusBreakdown as Record<string, number>)["idle"], 4);
      assert.equal(metrics.routeOutcomes[0]?.result, "success");
      assert.equal(metrics.stepStats[0]?.retries, 2);
      assert.equal(metrics.attention.oldest[1]?.laneKey, null);
    }),
  );
});

describe("importBoard contracts", () => {
  it("exposes importBoard WS method", () => {
    assert.equal(
      (WORKFLOW_WS_METHODS as Record<string, string>).importBoard,
      "workflow.importBoard",
    );
  });

  it.effect("decodes WorkflowImportBoardInput", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowImportBoardInput);
      const input = yield* decode({
        projectId: "project-import",
        definition: {
          name: "X",
          lanes: [{ key: "todo", name: "To do", entry: "manual" }],
        },
      });
      assert.equal((input as any).projectId, "project-import");
      assert.equal((input as any).definition.name, "X");
    }),
  );

  it.effect("decodes WorkflowImportBoardResult ok variant", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowImportBoardResult);
      const result = yield* decode({ ok: true, boardId: "p__b", warnings: [] });
      assert.equal((result as any).ok, true);
      assert.equal((result as any).boardId, "p__b");
      assert.deepEqual((result as any).warnings, []);
    }),
  );

  it.effect("decodes WorkflowImportBoardResult lintErrors variant", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowImportBoardResult);
      const result = yield* decode({
        ok: false,
        lintErrors: [
          {
            code: "invalid_json_logic",
            message: "Invalid transition",
            laneKey: "todo",
            transitionIndex: 0,
          },
        ],
      });
      assert.equal((result as any).ok, false);
      assert.equal((result as any).lintErrors[0].code, "invalid_json_logic");
    }),
  );
});

describe("WorkflowBoardVersionSource", () => {
  const decode = Schema.decodeUnknownEffect(WorkflowBoardVersionSource);

  it.effect("decodes existing sources", () =>
    Effect.gen(function* () {
      assert.equal(yield* decode("create"), "create");
      assert.equal(yield* decode("save"), "save");
      assert.equal(yield* decode("revert"), "revert");
      assert.equal(yield* decode("import"), "import");
      assert.equal(yield* decode("rename"), "rename");
    }),
  );

  it.effect("decodes self-improve", () =>
    Effect.gen(function* () {
      assert.equal(yield* decode("self-improve"), "self-improve");
    }),
  );

  it.effect("decodes self-improve-revert", () =>
    Effect.gen(function* () {
      assert.equal(yield* decode("self-improve-revert"), "self-improve-revert");
    }),
  );
});

describe("WorkflowBoardProposalView", () => {
  const decode = Schema.decodeUnknownEffect(WorkflowBoardProposalView);

  const exampleProposal = {
    proposalId: "prop-1",
    boardId: "board-abc",
    status: "pending",
    rationale: "Improve the backlog lane throughput.",
    validation: {
      preservationOk: true,
      lintOk: true,
      dryRunOk: true,
      laneDiffCount: 1,
      lintErrors: [],
      dryRunRegressions: [],
      messages: ["No issues found."],
    },
    baseVersionHash: "abc123",
    appliedVersionHash: null,
    outdated: false,
    agent: { instance: "claude_main", model: "claude-sonnet-4-6" },
    createdAt: "2026-06-14T00:00:00.000Z",
    resolvedAt: null,
  };

  it.effect("decodes a full proposal view", () =>
    Effect.gen(function* () {
      const result = yield* decode(exampleProposal);
      assert.equal(result.proposalId, "prop-1");
      assert.equal(result.status, "pending");
      assert.equal(result.validation.lintOk, true);
      assert.equal(result.appliedVersionHash, null);
      assert.equal(result.resolvedAt, null);
    }),
  );

  it.effect("decodes proposal with appliedVersionHash set", () =>
    Effect.gen(function* () {
      const result = yield* decode({
        ...exampleProposal,
        status: "approved",
        appliedVersionHash: "def456",
        resolvedAt: "2026-06-14T01:00:00.000Z",
      });
      assert.equal(result.status, "approved");
      assert.equal(result.appliedVersionHash, "def456");
      assert.equal(result.resolvedAt, "2026-06-14T01:00:00.000Z");
    }),
  );

  it.effect("decodes validation with lint errors", () =>
    Effect.gen(function* () {
      const result = yield* decode({
        ...exampleProposal,
        status: "invalid",
        validation: {
          ...exampleProposal.validation,
          lintOk: false,
          lintErrors: [{ code: "duplicate_lane_key", message: "Duplicate lane key 'backlog'" }],
        },
      });
      assert.equal(result.validation.lintOk, false);
      assert.equal(result.validation.lintErrors[0]?.code, "duplicate_lane_key");
    }),
  );
});

describe("self-improve RPC shapes", () => {
  const minimalDef = {
    name: "Board",
    lanes: [{ key: "todo", name: "Todo", entry: "manual" as const }],
  };
  const encodedDef = Schema.encodeUnknownSync(WorkflowDefinitionEncoded)(minimalDef);

  const exampleProposal = {
    proposalId: "prop-1",
    boardId: "board-abc",
    status: "pending",
    rationale: "Improve throughput.",
    validation: {
      preservationOk: true,
      lintOk: true,
      dryRunOk: true,
      laneDiffCount: 0,
      lintErrors: [],
      dryRunRegressions: [],
      messages: [],
    },
    baseVersionHash: "abc123",
    appliedVersionHash: null,
    outdated: false,
    agent: { instance: "claude_main", model: "claude-sonnet-4-6" },
    createdAt: "2026-06-14T00:00:00.000Z",
    resolvedAt: null,
  };

  it.effect("decodes WorkflowProposeBoardImprovementInput", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowProposeBoardImprovementInput);
      const result = yield* decode({
        boardId: "board-abc",
        agent: { instance: "claude_main", model: "sonnet" },
      });
      assert.equal(result.boardId, "board-abc");
      assert.equal(result.agent.instance, "claude_main");
    }),
  );

  it.effect("decodes WorkflowListBoardProposalsInput", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowListBoardProposalsInput);
      const result = yield* decode({ boardId: "board-abc" });
      assert.equal(result.boardId, "board-abc");
    }),
  );

  it.effect("decodes WorkflowGetBoardProposalInput", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowGetBoardProposalInput);
      const result = yield* decode({ proposalId: "prop-1" });
      assert.equal(result.proposalId, "prop-1");
    }),
  );

  it.effect("decodes WorkflowResolveBoardProposalInput with approve", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowResolveBoardProposalInput);
      const result = yield* decode({ proposalId: "prop-1", action: "approve" });
      assert.equal(result.proposalId, "prop-1");
      assert.equal(result.action, "approve");
    }),
  );

  it.effect("decodes WorkflowResolveBoardProposalInput with reject", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowResolveBoardProposalInput);
      const result = yield* decode({ proposalId: "prop-1", action: "reject" });
      assert.equal(result.action, "reject");
    }),
  );

  it.effect("decodes WorkflowRevertBoardProposalInput", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowRevertBoardProposalInput);
      const result = yield* decode({ proposalId: "prop-1" });
      assert.equal(result.proposalId, "prop-1");
    }),
  );

  it.effect("decodes WorkflowProposeBoardImprovementResult", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowProposeBoardImprovementResult);
      const result = yield* decode({ proposal: exampleProposal });
      assert.equal((result as any).proposal.proposalId, "prop-1");
    }),
  );

  it.effect("decodes WorkflowListBoardProposalsResult", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowListBoardProposalsResult);
      const result = yield* decode({ proposals: [exampleProposal] });
      assert.equal((result as any).proposals.length, 1);
      assert.equal((result as any).proposals[0].status, "pending");
    }),
  );

  it.effect("decodes WorkflowGetBoardProposalResult", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowGetBoardProposalResult);
      const result = yield* decode({
        proposal: exampleProposal,
        proposedDefinition: encodedDef,
        baseDefinition: encodedDef,
      });
      assert.equal((result as any).proposal.proposalId, "prop-1");
    }),
  );

  it.effect("decodes WorkflowResolveBoardProposalResult ok variant", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowResolveBoardProposalResult);
      const result = yield* decode({ ok: true, proposal: exampleProposal });
      assert.equal((result as any).ok, true);
      assert.equal((result as any).proposal.proposalId, "prop-1");
    }),
  );

  it.effect("decodes WorkflowResolveBoardProposalResult false/conflict variant", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowResolveBoardProposalResult);
      const result = yield* decode({
        ok: false,
        reason: "conflict",
        message: "Conflict detected.",
      });
      assert.equal((result as any).ok, false);
      assert.equal((result as any).reason, "conflict");
    }),
  );

  it.effect("decodes WorkflowResolveBoardProposalResult false/lint variant", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowResolveBoardProposalResult);
      const result = yield* decode({
        ok: false,
        reason: "lint",
        message: "Lint failed.",
        lintErrors: [{ code: "duplicate_step_key", message: "Duplicate step key 'code'" }],
      });
      assert.equal((result as any).ok, false);
      assert.equal((result as any).reason, "lint");
      assert.equal((result as any).lintErrors[0].code, "duplicate_step_key");
    }),
  );

  it.effect("decodes WorkflowRevertBoardProposalResult ok variant", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowRevertBoardProposalResult);
      const result = yield* decode({
        ok: true,
        proposal: { ...exampleProposal, status: "reverted" },
      });
      assert.equal((result as any).ok, true);
      assert.equal((result as any).proposal.status, "reverted");
    }),
  );

  it.effect("decodes WorkflowRevertBoardProposalResult false variant", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowRevertBoardProposalResult);
      const result = yield* decode({ ok: false, reason: "invalid", message: "Already reverted." });
      assert.equal((result as any).ok, false);
      assert.equal((result as any).reason, "invalid");
    }),
  );
});

describe("WORKFLOW_WS_METHODS self-improve entries", () => {
  it("has proposeBoardImprovement method", () => {
    assert.equal(WORKFLOW_WS_METHODS.proposeBoardImprovement, "workflow.proposeBoardImprovement");
  });

  it("has listBoardProposals method", () => {
    assert.equal(WORKFLOW_WS_METHODS.listBoardProposals, "workflow.listBoardProposals");
  });

  it("has getBoardProposal method", () => {
    assert.equal(WORKFLOW_WS_METHODS.getBoardProposal, "workflow.getBoardProposal");
  });

  it("has resolveBoardProposal method", () => {
    assert.equal(WORKFLOW_WS_METHODS.resolveBoardProposal, "workflow.resolveBoardProposal");
  });

  it("has revertBoardProposal method", () => {
    assert.equal(WORKFLOW_WS_METHODS.revertBoardProposal, "workflow.revertBoardProposal");
  });
});

describe("WorkflowSourceConfig autoPull", () => {
  it("decodes with autoPull present and enabled omitted", () => {
    const s = Schema.decodeUnknownSync(WorkflowSourceConfig)({
      id: "s1",
      provider: "github",
      connectionRef: "c",
      selector: { owner: "a", repo: "b", state: "all" },
      destinationLane: "inbox",
      closedLane: "done",
      autoPull: { rule: true },
    });
    assert.deepEqual(s.autoPull, { rule: true });
    assert.equal(s.enabled, undefined);
  });

  it("still decodes a legacy source with enabled and no autoPull", () => {
    const s = Schema.decodeUnknownSync(WorkflowSourceConfig)({
      id: "s1",
      provider: "github",
      connectionRef: "c",
      selector: { owner: "a", repo: "b", state: "all" },
      destinationLane: "inbox",
      closedLane: "done",
      enabled: true,
    });
    assert.equal(s.enabled, true);
    assert.equal(s.autoPull, undefined);
  });
});

describe("Workflow park sub-states (WorkflowRouteTarget)", () => {
  const boardWithParkTargets = {
    name: "Park board",
    lanes: [
      {
        key: "implement",
        name: "Implement",
        entry: "auto",
        on: {
          failure: { park: "issue", actions: [{ label: "Retry", to: "implement" }] },
        },
        transitions: [
          {
            when: true,
            to: {
              park: "waiting",
              label: "Needs a decision",
              actions: [{ label: "Continue", to: "review" }],
            },
          },
        ],
      },
      { key: "review", name: "Review", entry: "manual" },
    ],
  } as const;

  const decodeWorkflowDefinitionEncodedUnknown =
    Schema.decodeUnknownEffect(WorkflowDefinitionEncoded);
  const encodeWorkflowDefinitionEncoded = Schema.encodeUnknownEffect(WorkflowDefinitionEncoded);

  it.effect("decodes and re-encodes a definition with park targets byte-equal", () =>
    Effect.gen(function* () {
      const decoded = yield* decodeWorkflowDefinitionEncodedUnknown(boardWithParkTargets);
      const encoded = yield* encodeWorkflowDefinitionEncoded(decoded);
      assert.deepEqual(encoded, boardWithParkTargets);
    }),
  );

  it.effect("WorkflowParkSubstate accepts issue and waiting only", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowParkSubstate);
      assert.equal(yield* decode("issue"), "issue");
      assert.equal(yield* decode("waiting"), "waiting");
      const rejected = yield* Effect.exit(decode("other"));
      assert.strictEqual(rejected._tag, "Failure");
    }),
  );

  it.effect("rejects a park target with empty actions", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(decodeWorkflowParkTarget({ park: "issue", actions: [] }));
      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it.effect("rejects an empty-actions park target embedded in a definition", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        decodeWorkflowDefinition({
          name: "Park board",
          lanes: [
            {
              key: "implement",
              name: "Implement",
              entry: "auto",
              on: { failure: { park: "issue", actions: [] } },
            },
          ],
        }),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );

  it.effect("decodes TicketParked and TicketExternalEventSkipped events", () =>
    Effect.gen(function* () {
      const parked = yield* decodeWorkflowEvent({
        type: "TicketParked",
        eventId: "evt-parked-1",
        ticketId: "t-1",
        streamVersion: 4,
        occurredAt: "2026-07-22T00:00:04.000Z",
        payload: {
          substate: "issue",
          label: "Issue encountered",
          reason: "Tests failed twice",
          parkOrigin: '{"src":"step","stepKey":"tests","fp":"abc123"}',
          pipelineRunId: "pr-1",
          actionsSnapshot: [{ label: "Retry", to: "implement" }],
        },
      });
      assert.equal(parked.type, "TicketParked");
      if (parked.type !== "TicketParked") {
        assert.fail("expected TicketParked");
      }
      assert.equal(parked.payload.substate, "issue");
      assert.equal(parked.payload.actionsSnapshot[0]?.to, "implement");

      const skipped = yield* decodeWorkflowEvent({
        type: "TicketExternalEventSkipped",
        eventId: "evt-skipped-1",
        ticketId: "t-1",
        streamVersion: 5,
        occurredAt: "2026-07-22T00:00:05.000Z",
        payload: { eventName: "ci.passed", reason: "parked" },
      });
      assert.equal(skipped.type, "TicketExternalEventSkipped");
      if (skipped.type !== "TicketExternalEventSkipped") {
        assert.fail("expected TicketExternalEventSkipped");
      }
      assert.equal(skipped.payload.reason, "parked");
    }),
  );

  it.effect("TicketStatus accepts parked", () =>
    Effect.gen(function* () {
      const status = yield* decodeTicketStatus("parked");
      assert.equal(status, "parked");
    }),
  );

  it("workflow.ts and relay.ts attention-kind literal lists match and include parked kinds", () => {
    const workflowLiterals = [...WorkflowTicketAttentionKind.literals].sort();
    const relayLiterals = [...RelayWorkflowTicketAttentionKind.literals].sort();
    assert.deepEqual(workflowLiterals, relayLiterals);
    assert.isTrue(workflowLiterals.includes("parked_issue"));
    assert.isTrue(workflowLiterals.includes("parked_waiting"));
  });

  it.effect("WorkflowDryRunEnd accepts parked", () =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(WorkflowDryRunEnd)("parked");
      assert.equal(decoded, "parked");
    }),
  );

  it.effect("WorkflowDryRunHop supports a park hop with no toLane", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowDryRunHop);
      const hop = yield* decode({
        fromLane: "implement",
        source: "step_on",
        result: "failure",
        park: { substate: "issue", label: "Issue encountered" },
      });
      assert.equal(hop.toLane, undefined);
      assert.equal(hop.park?.substate, "issue");
    }),
  );

  it.effect("WorkflowDryRunResult can end parked in the starting lane", () =>
    Effect.gen(function* () {
      const result = yield* decodeWorkflowDryRunResult({
        startLane: "implement",
        scenario: "failure",
        hops: [
          {
            fromLane: "implement",
            source: "step_on",
            result: "failure",
            park: { substate: "issue", label: "Issue encountered" },
          },
        ],
        end: "parked",
        endLane: "implement",
        notes: [],
      });
      assert.equal(result.end, "parked");
      assert.equal(result.hops[0]?.toLane, undefined);
    }),
  );

  it.effect("WorkflowRouteDecisionView park variant round-trips with optional toLane", () =>
    Effect.gen(function* () {
      const view = yield* decodeWorkflowRouteDecisionView({
        occurredAt: "2026-07-22T00:00:06.000Z",
        fromLane: "implement",
        source: "step_on",
        park: { substate: "issue", label: "Issue encountered", reason: "Tests failed twice" },
      });
      assert.equal(view.toLane, undefined);
      assert.equal(view.park?.substate, "issue");
      assert.equal(view.park?.reason, "Tests failed twice");
    }),
  );

  it.effect("WorkflowRouteDecisionView sla variant covers notify-only and escalation", () =>
    Effect.gen(function* () {
      const notifyOnly = yield* decodeWorkflowRouteDecisionView({
        occurredAt: "2026-07-22T04:00:00.000Z",
        fromLane: "review",
        source: "sla",
        sla: { budgetMs: 14_400_000 },
      });
      assert.equal(notifyOnly.source, "sla");
      assert.equal(notifyOnly.toLane, undefined);
      assert.equal(notifyOnly.sla?.budgetMs, 14_400_000);
      assert.equal(notifyOnly.sla?.escalatedTo, undefined);

      const escalated = yield* decodeWorkflowRouteDecisionView({
        occurredAt: "2026-07-22T04:00:00.000Z",
        fromLane: "review",
        toLane: "escalation",
        source: "sla",
        sla: { budgetMs: 14_400_000, escalatedTo: "escalation" },
      });
      assert.equal(escalated.source, "sla");
      assert.equal(escalated.toLane, "escalation");
      assert.equal(escalated.sla?.escalatedTo, "escalation");
    }),
  );

  it.effect("isParkTarget narrows WorkflowRouteTarget", () =>
    Effect.gen(function* () {
      const laneTarget = yield* decodeWorkflowRouteTarget("implement");
      const parkTarget = yield* decodeWorkflowRouteTarget({
        park: "issue",
        actions: [{ label: "Retry", to: "implement" }],
      });
      assert.isFalse(isParkTarget(laneTarget));
      assert.isTrue(isParkTarget(parkTarget));
    }),
  );

  it("invokeParkAction RPC is registered", () => {
    assert.equal(WORKFLOW_WS_METHODS.invokeParkAction, "workflow.invokeParkAction");
    assert.equal(WsWorkflowInvokeParkActionRpc._tag, "workflow.invokeParkAction");
  });

  it.effect("WorkflowParkActionResult accepts moved/queued/stale", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(WorkflowParkActionResult);
      assert.equal(yield* decode("moved"), "moved");
      assert.equal(yield* decode("queued"), "queued");
      assert.equal(yield* decode("stale"), "stale");
    }),
  );
});
