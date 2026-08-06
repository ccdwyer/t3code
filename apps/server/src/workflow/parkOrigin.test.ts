import { assert, describe, it } from "@effect/vitest";

import { LaneKey, type WorkflowParkTarget } from "@t3tools/contracts";

import { buildParkOrigin, parkTargetFingerprint, parseParkOrigin } from "./parkOrigin.ts";

const to = (key: string) => LaneKey.make(key);

const target = (over: Partial<WorkflowParkTarget> = {}): WorkflowParkTarget => ({
  park: "issue",
  label: "Issue encountered",
  actions: [{ label: "Retry", to: to("impl") }],
  ...over,
});

describe("parkTargetFingerprint", () => {
  it("is 16 lowercase hex chars", () => {
    const fp = parkTargetFingerprint(target());
    assert.match(fp, /^[0-9a-f]{16}$/);
  });

  it("is stable regardless of key insertion order", () => {
    const a: WorkflowParkTarget = {
      park: "waiting",
      label: "Waiting on you",
      actions: [{ label: "Approve", to: to("done"), hint: "ship it" }],
    };
    // Same data, keys constructed in a different order.
    const b: WorkflowParkTarget = {
      actions: [{ to: to("done"), hint: "ship it", label: "Approve" }],
      label: "Waiting on you",
      park: "waiting",
    };
    assert.equal(parkTargetFingerprint(a), parkTargetFingerprint(b));
  });

  it("treats an absent label and an explicit-undefined label identically", () => {
    const withKey: WorkflowParkTarget = {
      park: "issue",
      label: undefined,
      actions: [{ label: "Retry", to: to("impl") }],
    };
    const withoutKey: WorkflowParkTarget = {
      park: "issue",
      actions: [{ label: "Retry", to: to("impl") }],
    };
    assert.equal(parkTargetFingerprint(withKey), parkTargetFingerprint(withoutKey));
  });

  it("changes when the label changes", () => {
    assert.notEqual(
      parkTargetFingerprint(target({ label: "One" })),
      parkTargetFingerprint(target({ label: "Two" })),
    );
  });

  it("changes when the substate changes", () => {
    assert.notEqual(
      parkTargetFingerprint(target({ park: "issue" })),
      parkTargetFingerprint(target({ park: "waiting" })),
    );
  });

  it("changes when an action label changes", () => {
    assert.notEqual(
      parkTargetFingerprint(target({ actions: [{ label: "Retry", to: to("impl") }] })),
      parkTargetFingerprint(target({ actions: [{ label: "Redo", to: to("impl") }] })),
    );
  });

  it("changes when an action target changes", () => {
    assert.notEqual(
      parkTargetFingerprint(target({ actions: [{ label: "Retry", to: to("impl") }] })),
      parkTargetFingerprint(target({ actions: [{ label: "Retry", to: to("review") }] })),
    );
  });

  it("changes when an action is added", () => {
    assert.notEqual(
      parkTargetFingerprint(target({ actions: [{ label: "Retry", to: to("impl") }] })),
      parkTargetFingerprint(
        target({
          actions: [
            { label: "Retry", to: to("impl") },
            { label: "Skip", to: to("done") },
          ],
        }),
      ),
    );
  });
});

describe("buildParkOrigin / parseParkOrigin", () => {
  it("round-trips a step origin (stepKey + key)", () => {
    const t = target();
    const json = buildParkOrigin({
      src: "step",
      target: t,
      stepKey: "code",
      key: "failure",
    });
    const parsed = parseParkOrigin(json);
    assert.deepEqual(parsed, {
      src: "step",
      stepKey: "code",
      key: "failure",
      fp: parkTargetFingerprint(t),
    });
  });

  it("round-trips a lane_on origin (key only)", () => {
    const t = target();
    const json = buildParkOrigin({ src: "lane_on", target: t, key: "success" });
    const parsed = parseParkOrigin(json);
    assert.deepEqual(parsed, {
      src: "lane_on",
      key: "success",
      fp: parkTargetFingerprint(t),
    });
  });

  it("round-trips a transition origin (no positional index, fp is identity)", () => {
    const t = target({ park: "waiting" });
    const json = buildParkOrigin({ src: "transition", target: t });
    const parsed = parseParkOrigin(json);
    assert.deepEqual(parsed, {
      src: "transition",
      fp: parkTargetFingerprint(t),
    });
    assert.notInclude(json, "index");
  });

  it("round-trips an event origin (name)", () => {
    const t = target();
    const json = buildParkOrigin({
      src: "event",
      target: t,
      name: "ci.failed",
    });
    const parsed = parseParkOrigin(json);
    assert.deepEqual(parsed, {
      src: "event",
      name: "ci.failed",
      fp: parkTargetFingerprint(t),
    });
  });

  it("returns null on malformed JSON", () => {
    assert.isNull(parseParkOrigin("{not json"));
    assert.isNull(parseParkOrigin(""));
  });

  it("returns null on a JSON array", () => {
    assert.isNull(parseParkOrigin("[1,2,3]"));
  });

  it("returns null when src is missing or unknown", () => {
    assert.isNull(parseParkOrigin(JSON.stringify({ fp: "abc" })));
    assert.isNull(parseParkOrigin(JSON.stringify({ src: "bogus", fp: "abc" })));
  });

  it("returns null when fp is missing", () => {
    assert.isNull(parseParkOrigin(JSON.stringify({ src: "transition" })));
  });
});
