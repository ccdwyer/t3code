import { describe, expect, it } from "vite-plus/test";
import type { StepOutputContract } from "@t3tools/contracts";

import {
  lintContractShape,
  renderContractInstruction,
  renderRepairPrompt,
  validateStepOutput,
} from "./stepOutputContract.ts";

const contract = {
  fields: {
    verdict: { type: "enum", values: ["pass", "fail"] },
    summary: { type: "string" },
    score: { type: "number", required: false },
    tags: { type: "string[]", required: false },
  },
  allowUnknown: false,
} as StepOutputContract;

describe("validateStepOutput", () => {
  it("accepts a valid object", () => {
    expect(
      validateStepOutput(contract, {
        output: { verdict: "pass", summary: "ok", score: 1, tags: ["a"] },
      }),
    ).toEqual([]);
  });

  it("rejects missing required fields", () => {
    const errors = validateStepOutput(contract, { output: { verdict: "pass" } });
    expect(errors.some((e) => e.includes('field "summary": required but missing'))).toBe(true);
  });

  it("rejects null as a type error, not optional-missing", () => {
    const errors = validateStepOutput(contract, {
      output: { verdict: "pass", summary: null },
    });
    expect(errors.some((e) => e.includes("null"))).toBe(true);
  });

  it("rejects non-finite numbers", () => {
    const errors = validateStepOutput(contract, {
      output: { verdict: "pass", summary: "x", score: Number.POSITIVE_INFINITY },
    });
    expect(errors.some((e) => e.includes("finite"))).toBe(true);
  });

  it("rejects bad enum and unexpected keys", () => {
    const errors = validateStepOutput(contract, {
      output: { verdict: "maybe", summary: "x", extra: 1 },
    });
    expect(errors.some((e) => e.includes("expected one of"))).toBe(true);
    expect(errors.some((e) => e.includes('unexpected field "extra"'))).toBe(true);
  });

  it("uses Object.hasOwn so prototype keys do not satisfy fields", () => {
    const protoContract = {
      fields: { toString: { type: "string" } },
    } as StepOutputContract;
    const errors = validateStepOutput(protoContract, { output: {} });
    expect(errors.some((e) => e.includes("required but missing"))).toBe(true);
  });

  it("reports structural failures from diagnostic", () => {
    expect(validateStepOutput(contract, { failure: "no_block" })[0]).toMatch(/no fenced/);
    expect(validateStepOutput(contract, { failure: "parse_error" })[0]).toMatch(/parse/);
  });
});

describe("renderContractInstruction / renderRepairPrompt", () => {
  it("renders a compact shape", () => {
    const s = renderContractInstruction(contract);
    expect(s).toContain("verdict");
    expect(s).toContain('"pass"');
    expect(s).toContain("summary");
  });

  it("fits repair prompt under budget and fails closed when impossible", () => {
    const errors = ["field summary missing"];
    const ok = renderRepairPrompt(
      contract,
      { rawBlock: '{"verdict":"x"}', failure: "parse_error" },
      errors,
      8_000,
    );
    expect(ok).not.toBeNull();
    expect(ok!.length).toBeLessThanOrEqual(8_000);

    const tiny = renderRepairPrompt(contract, {}, errors, 20);
    expect(tiny).toBeNull();
  });
});

describe("lintContractShape", () => {
  it("rejects empty fields and enum without values", () => {
    expect(lintContractShape({ fields: {} } as StepOutputContract).length).toBeGreaterThan(0);
    expect(
      lintContractShape({
        fields: { v: { type: "enum" } },
      } as StepOutputContract).some((e) => e.includes("requires values")),
    ).toBe(true);
  });
});
