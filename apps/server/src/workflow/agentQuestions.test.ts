import { assert, describe, it } from "@effect/vitest";

import {
  MAX_AGENT_QUESTIONS,
  OTHER_SENTINEL,
  QUESTION_DECISION_KEY,
  mapAgentQuestions,
  questionsWaitingReason,
} from "./agentQuestions.ts";

const ok = (raw: unknown) => {
  const result = mapAgentQuestions(raw);
  if (!result.ok) throw new Error(`expected mapping to succeed: ${result.message}`);
  return result.form;
};

const rejection = (raw: unknown) => {
  const result = mapAgentQuestions(raw);
  if (result.ok) throw new Error("expected mapping to be rejected");
  return result.message;
};

describe("mapAgentQuestions", () => {
  it("maps a choice question to a select that also accepts freeform", () => {
    const form = ok([{ key: "db", label: "Which database?", options: ["Postgres", "SQLite"] }]);
    const field = form.fields[0];
    if (field?.kind !== "select") throw new Error("expected a select field");
    assert.deepStrictEqual(
      field.options.map((option) => option.value),
      ["Postgres", "SQLite"],
    );
    // The user asked for freeform whenever no proposed answer fits, so every
    // choice question carries it.
    assert.strictEqual(field.allowOther, true);
  });

  it("maps multi to a checklist", () => {
    const form = ok([{ key: "targets", label: "Which targets?", options: ["ios"], multi: true }]);
    assert.strictEqual(form.fields[0]?.kind, "checklist");
  });

  it("maps a question with no options to freeform text", () => {
    const form = ok([{ key: "why", label: "Why did you pick that?" }]);
    assert.strictEqual(form.fields[0]?.kind, "text");
  });

  it("accepts {value,label} options alongside bare strings", () => {
    const form = ok([
      { key: "k", label: "Pick", options: [{ value: "a", label: "Option A" }, "b"] },
    ]);
    const field = form.fields[0];
    if (field?.kind !== "select") throw new Error("expected a select field");
    assert.deepStrictEqual(
      field.options.map((option) => `${option.value}:${option.label}`),
      ["a:Option A", "b:b"],
    );
  });

  it("appends a Continue/Cancel decision that cannot choose a route", () => {
    const form = ok([{ key: "a", label: "A" }]);
    const decision = form.fields.at(-1);
    if (decision?.kind !== "decision") throw new Error("expected a decision field");
    assert.strictEqual(decision.key, QUESTION_DECISION_KEY);
    // SPEC §6: an agent-raised question must never carry an action. The only
    // outcomes available are continuing or cancelling THIS step.
    assert.deepStrictEqual(decision.options.map((option) => option.outcome).toSorted(), [
      "failure",
      "success",
    ]);
  });

  it("rejects duplicate keys so one answer cannot serve two questions", () => {
    const message = rejection([
      { key: "same", label: "First" },
      { key: "same", label: "Second" },
    ]);
    assert.include(message, "repeats key");
  });

  it("rejects prototype-special keys that would swallow the answer", () => {
    // `__proto__` matches the key pattern, but writing it on a plain object
    // hits the prototype setter instead of creating an own property — the
    // operator's answer would validate and then silently vanish.
    assert.include(rejection([{ key: "__proto__", label: "Sneaky" }]), 'may not use "__proto__"');
    assert.include(rejection([{ key: "constructor", label: "Sneaky" }]), "may not use");
    assert.include(rejection([{ key: "prototype", label: "Sneaky" }]), "may not use");
  });

  it("rejects the reserved decision key", () => {
    assert.include(rejection([{ key: QUESTION_DECISION_KEY, label: "Sneaky" }]), "reserved");
  });

  it("rejects keys outside the CheckpointFieldKey pattern", () => {
    assert.include(rejection([{ key: "has spaces", label: "x" }]), "must match");
    assert.include(rejection([{ key: "a".repeat(41), label: "x" }]), "must match");
    assert.include(rejection([{ key: "", label: "x" }]), "must match");
  });

  it("rejects a missing or oversized label", () => {
    assert.include(rejection([{ key: "k" }]), "no label");
    assert.include(rejection([{ key: "k", label: "x".repeat(81) }]), "too long");
  });

  it("rejects an empty, non-array, or oversized question set", () => {
    assert.include(rejection([]), "empty");
    assert.include(rejection({ key: "k" }), "must be an array");
    const tooMany = Array.from({ length: MAX_AGENT_QUESTIONS + 1 }, (_unused, index) => ({
      key: `k${String(index)}`,
      label: "x",
    }));
    assert.include(rejection(tooMany), "max");
  });

  it("rejects an explicitly empty option label", () => {
    // Absent means "use the value"; empty violates CheckpointOption and would
    // otherwise reach the event commit as a runtime-invalid form.
    assert.include(
      rejection([{ key: "k", label: "x", options: [{ value: "a", label: "" }] }]),
      "empty label",
    );
  });

  it("reserves the freeform sentinel so an agent option cannot collide with it", () => {
    // A real option with this value would open the drawer's "Something else…"
    // box and replace the answer, making the agent's own choice unsubmittable.
    assert.include(rejection([{ key: "k", label: "x", options: [OTHER_SENTINEL] }]), "may not use");
    assert.include(
      rejection([{ key: "k", label: "x", options: [{ value: OTHER_SENTINEL, label: "Other" }] }]),
      "may not use",
    );
  });

  it("rejects malformed options rather than raising a half-formed question", () => {
    assert.include(rejection([{ key: "k", label: "x", options: [] }]), "no options");
    assert.include(rejection([{ key: "k", label: "x", options: "nope" }]), "must be an array");
    assert.include(rejection([{ key: "k", label: "x", options: ["a", "a"] }]), "repeats option");
    assert.include(rejection([{ key: "k", label: "x", options: [""] }]), "empty option");
    assert.include(rejection([{ key: "k", label: "x", options: ["a".repeat(41)] }]), "too long");
  });
});

describe("questionsWaitingReason", () => {
  it("names a single question", () => {
    const reason = questionsWaitingReason(ok([{ key: "k", label: "Which database?" }]));
    assert.strictEqual(reason, "Agent asked: Which database?");
  });

  it("counts and lists several, ignoring the decision field", () => {
    const reason = questionsWaitingReason(
      ok([
        { key: "a", label: "First?" },
        { key: "b", label: "Second?" },
      ]),
    );
    assert.strictEqual(reason, "Agent asked 2 questions: First? · Second?");
    // The appended decision field is machinery, not something the agent asked.
    assert.notInclude(reason, "Answer");
  });
});
