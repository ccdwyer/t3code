import { assert, describe, it } from "@effect/vitest";
import {
  WorkflowDefinition,
  type WorkflowDefinition as WorkflowDefinitionType,
} from "@t3tools/contracts";
import { AsanaSelector, GithubSelector } from "@t3tools/contracts/workSource";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { encodeWorkflowDefinitionJson, lintWorkflowDefinition } from "./workflowFile.ts";

const base = (lanes: unknown): WorkflowDefinitionType =>
  ({ name: "wf", lanes }) as unknown as WorkflowDefinitionType;

const ctx = {
  providerInstanceExists: (id: string) => id === "claude_main",
  instructionFileExists: (path: string) => path === "prompts/ok.md",
};

const decodeWorkflowDefinition = Schema.decodeUnknownEffect(WorkflowDefinition);
const decodeWorkflowDefinitionJson = Schema.decodeEffect(Schema.fromJsonString(WorkflowDefinition));

describe("lintWorkflowDefinition", () => {
  it.effect("exports an encoder that serializes decodable workflow JSON", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([
          {
            key: "implement",
            name: "Implement",
            entry: "auto",
            pipeline: [{ key: "tests", type: "script", run: "pnpm test", timeout: "5 minutes" }],
          },
        ]),
      );
      const contents = encodeWorkflowDefinitionJson(definition);
      const decoded = yield* decodeWorkflowDefinitionJson(contents);
      assert.equal(decoded.name, "wf");
      assert.equal((decoded.lanes[0]?.pipeline?.[0] as any)?.type, "script");
    }),
  );

  it("passes a valid definition", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "s",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: { file: "prompts/ok.md" },
            },
          ],
          on: { success: "done" },
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );
    assert.deepEqual(errors, []);
  });

  it("flags duplicate lane keys", () => {
    const errors = lintWorkflowDefinition(
      base([
        { key: "a", name: "A", entry: "manual" },
        { key: "a", name: "A2", entry: "manual" },
      ]),
      ctx,
    );
    assert.isTrue(errors.some((e) => e.code === "duplicate_lane_key"));
  });

  it("flags routing to a missing lane", () => {
    const errors = lintWorkflowDefinition(
      base([{ key: "a", name: "A", entry: "auto", on: { success: "ghost" } }]),
      ctx,
    );
    assert.isTrue(errors.some((e) => e.code === "missing_lane_ref"));
  });

  it("flags step routing and transition targets that reference missing lanes", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "review",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "hi",
              on: { failure: "missing-step-target" },
            },
          ],
          transitions: [{ when: { "==": [{ var: "pipeline.result" }, "success"] }, to: "ghost" }],
        },
      ]),
      ctx,
    );

    assert.isTrue(
      errors.some(
        (e) =>
          e.code === "missing_lane_ref" &&
          e.stepKey === "review" &&
          e.message.includes("missing-step-target"),
      ),
    );
    assert.isTrue(
      errors.some(
        (e) =>
          e.code === "missing_lane_ref" &&
          e.message.includes("ghost") &&
          (e as any).transitionIndex === 0,
      ),
    );
  });

  it("accepts well-formed predicate paths and explicit step precedence", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "tests",
              type: "script",
              run: "pnpm test",
              on: { failure: "needs" },
            },
            {
              key: "review",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "hi",
              captureOutput: true,
            },
          ],
          transitions: [
            {
              when: {
                and: [
                  { "!=": [{ var: "steps.tests.exitCode" }, 0] },
                  { "==": [{ var: "steps.review.output.verdict" }, "block"] },
                  { in: [{ var: "pipeline.result" }, ["success", "failure"]] },
                  { "!": { var: "status" } },
                ],
              },
              to: "needs",
            },
          ],
          on: { success: "done", failure: "needs" },
        },
        { key: "needs", name: "Needs", entry: "manual" },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );

    assert.deepEqual(errors, []);
  });

  it("flags disallowed predicate operators and invalid var forms", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [{ key: "tests", type: "script", run: "pnpm test" }],
          transitions: [
            { when: { cat: ["a", "b"] }, to: "done" },
            { when: { var: ["steps.tests.exitCode", 0] }, to: "done" },
            { when: { var: 123 }, to: "done" },
          ],
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );

    assert.deepEqual(
      errors.filter((e) => e.code === "invalid_json_logic").map((e) => (e as any).transitionIndex),
      [0, 1, 2],
    );
  });

  it("flags unknown and ill-typed predicate paths", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "review",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "hi",
            },
            { key: "approval", type: "approval", prompt: "Ship?" },
          ],
          transitions: [
            { when: { var: "steps.missing.status" }, to: "done" },
            { when: { var: "steps.review.exitCode" }, to: "done" },
            { when: { var: "steps.review.output.verdict" }, to: "done" },
            { when: { var: "steps.approval.output.verdict" }, to: "done" },
            { when: { var: "pipeline.unknown" }, to: "done" },
          ],
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );

    assert.deepEqual(
      errors
        .filter((e) => e.code === "unknown_predicate_path")
        .map((e) => (e as any).transitionIndex),
      [0, 1, 2, 3, 4],
    );
  });

  it("flags path-unsafe step keys when predicates are present", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "bad.key",
              type: "agent",
              agent: { instance: "claude_main", model: "sonnet" },
              instruction: "hi",
              captureOutput: true,
            },
          ],
          transitions: [{ when: { var: "steps.bad.key.output.verdict" }, to: "done" }],
        },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );

    assert.isTrue(
      errors.some(
        (e) =>
          e.code === "unsafe_step_key" &&
          e.stepKey === "bad.key" &&
          (e as any).transitionIndex === 0,
      ),
    );
  });

  it("flags an unknown provider instance", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "s",
              type: "agent",
              agent: { instance: "nope", model: "x" },
              instruction: "hi",
            },
          ],
        },
      ]),
      ctx,
    );
    assert.isTrue(errors.some((e) => e.code === "unknown_provider_instance"));
  });

  it("flags a missing instruction file", () => {
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "s",
              type: "agent",
              agent: { instance: "claude_main", model: "x" },
              instruction: { file: "prompts/missing.md" },
            },
          ],
        },
      ]),
      ctx,
    );
    assert.isTrue(errors.some((e) => e.code === "missing_instruction_file"));
  });

  it("flags unsafe instruction file paths before checking file existence", () => {
    let existenceChecks = 0;
    const errors = lintWorkflowDefinition(
      base([
        {
          key: "a",
          name: "A",
          entry: "auto",
          pipeline: [
            {
              key: "s",
              type: "agent",
              agent: { instance: "claude_main", model: "x" },
              instruction: { file: "../escape.md" },
            },
          ],
        },
      ]),
      {
        providerInstanceExists: ctx.providerInstanceExists,
        instructionFileExists: () => {
          existenceChecks += 1;
          return true;
        },
      },
    );

    assert.deepEqual(
      errors.map((error) => ({
        code: error.code,
        laneKey: error.laneKey,
        stepKey: error.stepKey,
      })),
      [{ code: "unsafe_instruction_path", laneKey: "a", stepKey: "s" }],
    );
    assert.equal(existenceChecks, 0);
  });

  it("flags an auto-lane cycle with no human/terminal break", () => {
    const errors = lintWorkflowDefinition(
      base([
        { key: "a", name: "A", entry: "auto", on: { success: "b" } },
        { key: "b", name: "B", entry: "auto", on: { success: "a" } },
      ]),
      ctx,
    );
    assert.isTrue(errors.some((e) => e.code === "auto_lane_cycle"));
  });

  it("flags invalid WIP limits and accepts positive limits on non-terminal lanes", () => {
    const invalidErrors = lintWorkflowDefinition(
      base([
        { key: "zero", name: "Zero", entry: "manual", wipLimit: 0 },
        { key: "done", name: "Done", entry: "manual", terminal: true, wipLimit: 1 },
      ]),
      ctx,
    );

    assert.deepEqual(
      invalidErrors
        .filter((error) => error.code === "invalid_wip_limit")
        .map((error) => error.laneKey),
      ["zero", "done"],
    );

    const validErrors = lintWorkflowDefinition(
      base([
        { key: "backlog", name: "Backlog", entry: "manual", wipLimit: 2 },
        { key: "done", name: "Done", entry: "manual", terminal: true },
      ]),
      ctx,
    );
    assert.deepEqual(validErrors, []);
  });

  it.effect("accepts retention only on terminal lanes with positive duration", () =>
    Effect.gen(function* () {
      const valid = yield* decodeWorkflowDefinition(
        base([
          { key: "backlog", name: "Backlog", entry: "manual" },
          {
            key: "done",
            name: "Done",
            entry: "manual",
            terminal: true,
            retention: "7 days",
          },
        ]),
      );
      assert.deepEqual(lintWorkflowDefinition(valid, ctx), []);

      const nonTerminal = yield* decodeWorkflowDefinition(
        base([
          {
            key: "backlog",
            name: "Backlog",
            entry: "manual",
            retention: "7 days",
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      assert.deepEqual(
        lintWorkflowDefinition(nonTerminal, ctx).map((error) => error.code),
        ["invalid_retention"],
      );

      const zeroRetention = yield* decodeWorkflowDefinition(
        base([
          {
            key: "done",
            name: "Done",
            entry: "manual",
            terminal: true,
            retention: "0 millis",
          },
        ]),
      );
      assert.deepEqual(
        lintWorkflowDefinition(zeroRetention, ctx).map((error) => error.code),
        ["invalid_retention"],
      );
    }),
  );
});

describe("lintWorkflowDefinition retry + templates", () => {
  const agentStep = (retry?: unknown, instruction: unknown = "Do the work.") => ({
    key: "s",
    type: "agent",
    agent: { instance: "claude_main", model: "sonnet" },
    instruction,
    ...(retry === undefined ? {} : { retry }),
  });

  const lintLane = (pipeline: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([{ key: "a", name: "A", entry: "manual", pipeline }]),
      );
      return lintWorkflowDefinition(definition, ctx);
    });

  it.effect("accepts retry within 2..5 on agent and script steps", () =>
    Effect.gen(function* () {
      const errors = yield* lintLane([
        agentStep({ maxAttempts: 3, escalate: { model: "opus" } }),
        { key: "t", type: "script", run: "pnpm test", retry: { maxAttempts: 2 } },
      ]);
      assert.deepEqual(errors, []);
    }),
  );

  it.effect("rejects maxAttempts outside 2..5", () =>
    Effect.gen(function* () {
      const tooLow = yield* lintLane([agentStep({ maxAttempts: 1 })]);
      assert.deepEqual(
        tooLow.map((error) => error.code),
        ["invalid_retry"],
      );

      const tooHigh = yield* lintLane([agentStep({ maxAttempts: 6 })]);
      assert.deepEqual(
        tooHigh.map((error) => error.code),
        ["invalid_retry"],
      );
    }),
  );

  it.effect("rejects escalation on script steps", () =>
    Effect.gen(function* () {
      const errors = yield* lintLane([
        {
          key: "t",
          type: "script",
          run: "pnpm test",
          retry: { maxAttempts: 2, escalate: { model: "opus" } },
        },
      ]);
      assert.deepEqual(
        errors.map((error) => error.code),
        ["invalid_retry"],
      );
    }),
  );

  it.effect("rejects unknown escalation provider instances", () =>
    Effect.gen(function* () {
      const errors = yield* lintLane([
        agentStep({ maxAttempts: 2, escalate: { instance: "nope" } }),
      ]);
      assert.deepEqual(
        errors.map((error) => error.code),
        ["unknown_provider_instance"],
      );
      assert.match(errors[0]?.message ?? "", /retry escalation/);
    }),
  );

  it.effect("accepts known ticket placeholders in inline instructions", () =>
    Effect.gen(function* () {
      const errors = yield* lintLane([
        agentStep(
          undefined,
          "Review {{ticket.title}} ({{ticket.id}}): {{ticket.description}} vs {{ticket.baseRef}} and {{not.a.template}}",
        ),
      ]);
      assert.deepEqual(errors, []);
    }),
  );

  it.effect("flags unknown ticket placeholders in inline instructions", () =>
    Effect.gen(function* () {
      const errors = yield* lintLane([agentStep(undefined, "Check {{ticket.priority}}")]);
      assert.deepEqual(
        errors.map((error) => error.code),
        ["unknown_template_placeholder"],
      );
      assert.match(errors[0]?.message ?? "", /ticket\.priority/);
    }),
  );
});

describe("lintWorkflowDefinition file instruction templates", () => {
  it.effect("flags unknown placeholders inside instruction files when content is available", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([
          {
            key: "a",
            name: "A",
            entry: "manual",
            pipeline: [
              {
                key: "s",
                type: "agent",
                agent: { instance: "claude_main", model: "sonnet" },
                instruction: { file: "prompts/ok.md" },
              },
            ],
          },
        ]),
      );

      const withBadContent = lintWorkflowDefinition(definition, {
        ...ctx,
        readInstructionFile: (path) =>
          path === "prompts/ok.md" ? "Review {{ticket.titel}}" : null,
      });
      assert.deepEqual(
        withBadContent.map((error) => error.code),
        ["unknown_template_placeholder"],
      );

      const withGoodContent = lintWorkflowDefinition(definition, {
        ...ctx,
        readInstructionFile: (path) =>
          path === "prompts/ok.md" ? "Review {{ticket.title}} vs {{ticket.baseRef}}" : null,
      });
      assert.deepEqual(withGoodContent, []);

      const withoutContent = lintWorkflowDefinition(definition, ctx);
      assert.deepEqual(withoutContent, []);
    }),
  );
});

describe("lintWorkflowDefinition auto self-loop bounds", () => {
  const selfLoopLane = (when: unknown) => [
    {
      key: "impl",
      name: "Impl",
      entry: "auto",
      pipeline: [
        {
          key: "review",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "review",
          captureOutput: true,
        },
      ],
      transitions: [{ when, to: "impl" }],
      on: { success: "done" },
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ];

  it.effect("rejects unbounded auto self-transitions", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base(selfLoopLane({ "==": [{ var: "steps.review.output.verdict" }, "revise"] })),
      );
      const errors = lintWorkflowDefinition(definition, ctx);
      assert.deepEqual(
        errors.map((error) => error.code),
        ["auto_lane_cycle"],
      );
    }),
  );

  it.effect("accepts auto self-transitions bounded by lane.runCount", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base(
          selfLoopLane({
            and: [
              { "==": [{ var: "steps.review.output.verdict" }, "revise"] },
              { "<": [{ var: "lane.runCount" }, 3] },
            ],
          }),
        ),
      );
      assert.deepEqual(lintWorkflowDefinition(definition, ctx), []);
    }),
  );
});

describe("lintWorkflowDefinition pullRequest steps", () => {
  const lintLane = (pipeline: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([
          { key: "a", name: "A", entry: "manual", pipeline },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      return lintWorkflowDefinition(definition, ctx);
    });

  it.effect("lints pullRequest steps", () =>
    Effect.gen(function* () {
      // open step with land-only fields → invalid_step
      const openWithLandFields = yield* lintLane([
        { key: "pr", type: "pullRequest", action: "open", strategy: "squash", deleteBranch: true },
      ]);
      assert.isTrue(openWithLandFields.some((e) => e.code === "invalid_step"));

      // land step with open-only fields → invalid_step
      const landWithOpenFields = yield* lintLane([
        { key: "pr", type: "pullRequest", action: "land", base: "main", draft: false, titleTemplate: "My PR", bodyTemplate: "Body" },
      ]);
      assert.isTrue(landWithOpenFields.some((e) => e.code === "invalid_step"));

      // open step with unknown placeholder in titleTemplate → unknown_template_placeholder
      const badTitle = yield* lintLane([
        { key: "pr", type: "pullRequest", action: "open", titleTemplate: "PR: {{ticket.bogus.path}}" },
      ]);
      assert.isTrue(badTitle.some((e) => e.code === "unknown_template_placeholder"));

      // open step with unknown placeholder in bodyTemplate → unknown_template_placeholder
      const badBody = yield* lintLane([
        { key: "pr", type: "pullRequest", action: "open", bodyTemplate: "Fixes {{ticket.unknown}}" },
      ]);
      assert.isTrue(badBody.some((e) => e.code === "unknown_template_placeholder"));

      // clean open step → no errors
      const cleanOpen = yield* lintLane([
        { key: "pr", type: "pullRequest", action: "open", base: "main", titleTemplate: "PR: {{ticket.title}}", bodyTemplate: "{{ticket.description}}" },
      ]);
      assert.deepEqual(cleanOpen, []);

      // clean land step → no errors
      const cleanLand = yield* lintLane([
        { key: "pr", type: "pullRequest", action: "land", strategy: "squash", deleteBranch: true },
      ]);
      assert.deepEqual(cleanLand, []);
    }),
  );

  it.effect("allows steps.<key>.output for pullRequest open steps", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([
          {
            key: "a",
            name: "A",
            entry: "auto",
            pipeline: [
              { key: "openPr", type: "pullRequest", action: "open" },
              { key: "landPr", type: "pullRequest", action: "land" },
            ],
            transitions: [
              { when: { var: "steps.openPr.output.prNumber" }, to: "done" },
            ],
            on: { success: "done" },
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      const errors = lintWorkflowDefinition(definition, ctx);
      // reading output from open step is fine
      assert.isFalse(errors.some((e) => e.code === "unknown_predicate_path" && e.message?.includes("openPr")));

      // reading output from land step → error
      const definitionWithLandOutput = yield* decodeWorkflowDefinition(
        base([
          {
            key: "a",
            name: "A",
            entry: "auto",
            pipeline: [
              { key: "landPr", type: "pullRequest", action: "land" },
            ],
            transitions: [
              { when: { var: "steps.landPr.output.prNumber" }, to: "done" },
            ],
            on: { success: "done" },
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      const landOutputErrors = lintWorkflowDefinition(definitionWithLandOutput, ctx);
      assert.isTrue(landOutputErrors.some((e) => e.code === "unknown_predicate_path" && e.message?.includes("can only read output")));
    }),
  );

  it.effect("allows pr.* in onEvent.when", () =>
    Effect.gen(function* () {
      // pr.ciState and pr.reviewDecision lint clean
      const definitionClean = yield* decodeWorkflowDefinition(
        base([
          {
            key: "review",
            name: "Review",
            entry: "manual",
            onEvent: [
              { name: "pr_update", when: { var: "pr.ciState" }, to: "done" },
              { name: "pr_review", when: { var: "pr.reviewDecision" }, to: "done" },
            ],
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      assert.deepEqual(lintWorkflowDefinition(definitionClean, ctx), []);

      // pr.bogus → unknown_predicate_path
      const definitionBogus = yield* decodeWorkflowDefinition(
        base([
          {
            key: "review",
            name: "Review",
            entry: "manual",
            onEvent: [
              { name: "pr_update", when: { var: "pr.bogus" }, to: "done" },
            ],
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      const bogusErrors = lintWorkflowDefinition(definitionBogus, ctx);
      assert.isTrue(bogusErrors.some((e) => e.code === "unknown_predicate_path"));
      // error message mentions the allowed pr.* paths
      const prError = bogusErrors.find((e) => e.code === "unknown_predicate_path");
      assert.match(prError?.message ?? "", /pr\.ciState/);
      assert.match(prError?.message ?? "", /pr\.reviewDecision/);
    }),
  );
});

describe("lintWorkflowDefinition lane actions", () => {
  it.effect("rejects actions targeting missing lanes", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([
          {
            key: "review",
            name: "Review",
            entry: "manual",
            actions: [{ label: "Land it", to: "nope" }],
          },
        ]),
      );
      const errors = lintWorkflowDefinition(definition, ctx);
      assert.deepEqual(
        errors.map((error) => error.code),
        ["missing_lane_ref"],
      );
      assert.match(errors[0]?.message ?? "", /Land it/);
    }),
  );

  it.effect("accepts actions targeting real lanes", () =>
    Effect.gen(function* () {
      const definition = yield* decodeWorkflowDefinition(
        base([
          {
            key: "review",
            name: "Review",
            entry: "manual",
            actions: [{ label: "Land it", to: "done", hint: "Merge the work." }],
          },
          { key: "done", name: "Done", entry: "manual", terminal: true },
        ]),
      );
      assert.deepEqual(lintWorkflowDefinition(definition, ctx), []);
    }),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Source lint tests
// ─────────────────────────────────────────────────────────────────────────────

const baseWithSources = (
  lanes: unknown,
  sources: unknown,
): WorkflowDefinitionType =>
  ({ name: "wf", lanes, sources }) as unknown as WorkflowDefinitionType;

const selectorCtx = {
  providerInstanceExists: () => true,
  instructionFileExists: () => true,
  selectorSchemaFor: (p: string) =>
    p === "github" ? GithubSelector : p === "asana" ? AsanaSelector : null,
};

const twoLanes = [
  { key: "backlog", name: "Backlog", entry: "manual" },
  { key: "done", name: "Done", entry: "manual", terminal: true },
];

describe("lintWorkflowDefinition sources", () => {
  it("flags destinationLane referencing a missing lane", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "gh1",
        provider: "github",
        connectionRef: "conn-1",
        selector: { owner: "acme", repo: "api" },
        destinationLane: "nonexistent",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(errors.some((e) => e.code === "missing_lane_ref" && /destinationLane/.test(e.message)));
  });

  it("flags closedLane referencing a missing lane", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "gh1",
        provider: "github",
        connectionRef: "conn-1",
        selector: { owner: "acme", repo: "api" },
        destinationLane: "backlog",
        closedLane: "ghost",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(errors.some((e) => e.code === "missing_lane_ref" && /closedLane/.test(e.message)));
  });

  it("flags closedLane that exists but is not terminal", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "gh1",
        provider: "github",
        connectionRef: "conn-1",
        selector: { owner: "acme", repo: "api" },
        destinationLane: "backlog",
        closedLane: "backlog", // exists but not terminal
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(errors.some((e) => e.code === "invalid_source" && /terminal/.test(e.message)));
  });

  it("flags a github selector missing required fields (owner/repo)", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "gh1",
        provider: "github",
        connectionRef: "conn-1",
        selector: { labels: ["bug"] }, // missing owner and repo
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(errors.some((e) => e.code === "invalid_source"));
  });

  it("flags an unknown provider", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "jira1",
        provider: "jira" as any,
        connectionRef: "conn-1",
        selector: {},
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(errors.some((e) => e.code === "invalid_source" && /unknown provider/.test(e.message)));
  });

  it("flags duplicate source ids", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "gh1",
        provider: "github",
        connectionRef: "conn-1",
        selector: { owner: "acme", repo: "api" },
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
      {
        id: "gh1", // duplicate
        provider: "github",
        connectionRef: "conn-2",
        selector: { owner: "acme", repo: "web" },
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(errors.some((e) => e.code === "duplicate_source_id"));
  });

  it("flags an asana source with sectionGid set", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "asana1",
        provider: "asana",
        connectionRef: "conn-1",
        selector: { projectGid: "1234567890", sectionGid: "999", includeCompleted: false },
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(errors.some((e) => e.code === "invalid_source" && /sectionGid/.test(e.message)));
  });

  it("flags an asana source with tagGid set", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "asana1",
        provider: "asana",
        connectionRef: "conn-1",
        selector: { projectGid: "1234567890", tagGid: "777", includeCompleted: true },
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.isTrue(errors.some((e) => e.code === "invalid_source" && /tagGid/.test(e.message)));
  });

  it("accepts a valid github source and a valid asana source", () => {
    const def = baseWithSources(twoLanes, [
      {
        id: "gh1",
        provider: "github",
        connectionRef: "conn-1",
        selector: { owner: "acme", repo: "api", labels: ["bug"], state: "open" },
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
      {
        id: "asana1",
        provider: "asana",
        connectionRef: "conn-2",
        selector: { projectGid: "1234567890", includeCompleted: false },
        destinationLane: "backlog",
        closedLane: "done",
        enabled: true,
      },
    ]);
    const errors = lintWorkflowDefinition(def, selectorCtx);
    assert.deepEqual(errors, []);
  });
});
