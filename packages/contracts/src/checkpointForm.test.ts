import { assert, describe, it } from "@effect/vitest";

import { validateCheckpointSubmission } from "./checkpointForm.ts";
import type { CheckpointForm } from "./workflow.ts";

const form = (...fields: ReadonlyArray<unknown>): CheckpointForm => ({ fields }) as never;

const decision = {
  kind: "decision",
  key: "verdict",
  options: [
    { value: "ship", label: "Ship it", outcome: "success" },
    { value: "changes", label: "Needs changes", outcome: "failure" },
    { value: "hold", label: "Hold", outcome: "blocked" },
  ],
};

describe("validateCheckpointSubmission", () => {
  describe("formless approvals", () => {
    it("passes the caller's outcome through untouched", () => {
      const ok = validateCheckpointSubmission(undefined, {}, "failure");
      assert.deepStrictEqual(ok, { ok: true, outcome: "failure", answers: {} });
    });
  });

  describe("decision", () => {
    it("maps the chosen option to its routing outcome", () => {
      for (const [value, outcome] of [
        ["ship", "success"],
        ["changes", "failure"],
        ["hold", "blocked"],
      ] as const) {
        const result = validateCheckpointSubmission(form(decision), { decision: value }, "success");
        assert.isTrue(result.ok);
        if (result.ok) {
          assert.equal(result.outcome, outcome);
          // The decision is recorded as an answer so routing can read it.
          assert.equal(result.answers["verdict" as never], value);
        }
      }
    });

    it("rejects a decision that is not on the snapshot", () => {
      // The board may have been edited since; the snapshot is the authority.
      const result = validateCheckpointSubmission(form(decision), { decision: "merge" }, "success");
      assert.isFalse(result.ok);
      if (!result.ok) {
        assert.include(result.message, "not an option");
      }
    });

    it("requires a decision when the form declares one", () => {
      const result = validateCheckpointSubmission(form(decision), {}, "success");
      assert.isFalse(result.ok);
    });
  });

  describe("text", () => {
    const text = { kind: "text", key: "why", label: "Why?", required: true, maxLength: 10 };

    it("trims and keeps a filled answer", () => {
      const result = validateCheckpointSubmission(
        form(decision, text),
        { decision: "ship", answers: { why: "  ok  " } as never },
        "success",
      );
      assert.isTrue(result.ok);
      if (result.ok) {
        assert.equal(result.answers["why" as never], "ok");
      }
    });

    it("enforces the field's own maxLength, not just the schema envelope", () => {
      const result = validateCheckpointSubmission(
        form(decision, text),
        { decision: "ship", answers: { why: "x".repeat(11) } as never },
        "success",
      );
      assert.isFalse(result.ok);
    });

    it("requires a required field on success but NOT on rejection", () => {
      // A reviewer saying "no" must not be trapped by a field that only matters
      // when approving.
      assert.isFalse(
        validateCheckpointSubmission(form(decision, text), { decision: "ship" }, "success").ok,
      );
      assert.isTrue(
        validateCheckpointSubmission(form(decision, text), { decision: "changes" }, "success").ok,
      );
    });
  });

  describe("select", () => {
    const select = {
      kind: "select",
      key: "severity",
      label: "Severity",
      options: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
    };

    it("rejects a value outside the snapshot's options", () => {
      const result = validateCheckpointSubmission(
        form(decision, select),
        { decision: "ship", answers: { severity: "critical" } as never },
        "success",
      );
      assert.isFalse(result.ok);
    });

    it("accepts a declared value", () => {
      const result = validateCheckpointSubmission(
        form(decision, select),
        { decision: "ship", answers: { severity: "high" } as never },
        "success",
      );
      assert.isTrue(result.ok);
    });
  });

  describe("checklist", () => {
    const checklist = {
      kind: "checklist",
      key: "checks",
      label: "Checks",
      items: [
        { value: "tests", label: "Tests" },
        { value: "docs", label: "Docs" },
      ],
      requireAll: true,
    };

    it("requires every item on success", () => {
      assert.isFalse(
        validateCheckpointSubmission(
          form(decision, checklist),
          { decision: "ship", answers: { checks: ["tests"] } as never },
          "success",
        ).ok,
      );
      assert.isTrue(
        validateCheckpointSubmission(
          form(decision, checklist),
          { decision: "ship", answers: { checks: ["tests", "docs"] } as never },
          "success",
        ).ok,
      );
    });

    it("cannot be satisfied by repeating one item", () => {
      // Duplicates would otherwise make a partially checked list pass requireAll.
      const result = validateCheckpointSubmission(
        form(decision, checklist),
        { decision: "ship", answers: { checks: ["tests", "tests"] } as never },
        "success",
      );
      assert.isFalse(result.ok);
    });

    it("de-duplicates what it stores", () => {
      const result = validateCheckpointSubmission(
        form(decision, { ...checklist, requireAll: false }),
        { decision: "ship", answers: { checks: ["tests", "tests", "docs"] } as never },
        "success",
      );
      assert.isTrue(result.ok);
      if (result.ok) {
        assert.deepStrictEqual(result.answers["checks" as never], ["tests", "docs"]);
      }
    });

    it("rejects an item that is not on the snapshot", () => {
      assert.isFalse(
        validateCheckpointSubmission(
          form(decision, checklist),
          { decision: "ship", answers: { checks: ["deploy"] } as never },
          "success",
        ).ok,
      );
    });

    it("does not enforce requireAll when the decision is not a success", () => {
      assert.isTrue(
        validateCheckpointSubmission(
          form(decision, checklist),
          { decision: "changes", answers: { checks: [] } as never },
          "success",
        ).ok,
      );
    });
  });

  describe("unknown fields", () => {
    it("drops answers the snapshot does not declare rather than storing them", () => {
      // A newer client must not be able to smuggle arbitrary keys into the event
      // log or into routing input.
      const result = validateCheckpointSubmission(
        form(decision),
        { decision: "ship", answers: { smuggled: "value" } as never },
        "success",
      );
      assert.isTrue(result.ok);
      if (result.ok) {
        assert.deepStrictEqual(Object.keys(result.answers), ["verdict"]);
      }
    });
  });
});
