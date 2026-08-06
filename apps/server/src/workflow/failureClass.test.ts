import { describe, expect, it } from "vite-plus/test";

import {
  classifyFallback,
  decideRetry,
  PROVIDER_USER_INPUT_LITERAL,
  RESTART_INFRA_LITERALS,
  TURN_TIMEOUT_LITERAL,
} from "./failureClass.ts";

describe("classifyFallback", () => {
  it("maps exact human/script/timeout literals", () => {
    expect(classifyFallback("rejected")).toBe("human_rejection");
    expect(classifyFallback("script cancelled")).toBe("user_cancelled");
    expect(classifyFallback("script timed out")).toBe("timeout");
    expect(classifyFallback("missing or invalid structured output")).toBe("agent_error");
    expect(classifyFallback("script exited with code 1")).toBe("script_failure");
  });

  it("maps every restart/infra constant", () => {
    expect(classifyFallback(TURN_TIMEOUT_LITERAL)).toBe("infra");
    expect(classifyFallback(PROVIDER_USER_INPUT_LITERAL)).toBe("infra");
    for (const lit of RESTART_INFRA_LITERALS) {
      expect(classifyFallback(lit)).toBe("infra");
    }
  });

  it("does not substring-guess arbitrary provider text", () => {
    expect(classifyFallback("timeout while waiting for model")).toBe("unknown");
    expect(classifyFallback("user cancelled the request")).toBe("unknown");
  });
});

describe("decideRetry", () => {
  it("hard-stops human_rejection and user_cancelled", () => {
    expect(
      decideRetry({
        failureClass: "human_rejection",
        attempt: 1,
        maxAttempts: 5,
      }),
    ).toEqual({
      kind: "give_up",
    });
    expect(
      decideRetry({
        failureClass: "user_cancelled",
        attempt: 1,
        maxAttempts: 5,
      }),
    ).toEqual({
      kind: "give_up",
    });
  });

  it("hard-stops provider user-input wait", () => {
    expect(
      decideRetry({
        failureClass: "infra",
        attempt: 1,
        maxAttempts: 5,
        error: PROVIDER_USER_INPUT_LITERAL,
      }),
    ).toEqual({ kind: "give_up" });
  });

  it("respects maxAttempts and byClass backoff/escalate_model", () => {
    expect(decideRetry({ failureClass: "agent_error", attempt: 5, maxAttempts: 5 })).toEqual({
      kind: "give_up",
    });
    expect(
      decideRetry({
        failureClass: "infra",
        attempt: 1,
        maxAttempts: 3,
        byClass: { infra: { action: "backoff", backoffMs: 2_000 } },
      }),
    ).toEqual({
      kind: "retry",
      delayMs: 2_000,
      escalate: false,
      nextAttempt: 2,
    });
    expect(
      decideRetry({
        failureClass: "agent_error",
        attempt: 1,
        maxAttempts: 3,
        byClass: { agent_error: { action: "escalate_model" } },
      }),
    ).toEqual({ kind: "retry", delayMs: 0, escalate: true, nextAttempt: 2 });
  });

  it("give_up byClass short-circuits even with attempts remaining", () => {
    expect(
      decideRetry({
        failureClass: "script_failure",
        attempt: 1,
        maxAttempts: 5,
        byClass: { script_failure: { action: "give_up" } },
      }),
    ).toEqual({ kind: "give_up" });
  });

  it("class maxAttempts caps below parent maxAttempts", () => {
    expect(
      decideRetry({
        failureClass: "timeout",
        attempt: 2,
        maxAttempts: 5,
        byClass: { timeout: { action: "retry", maxAttempts: 2 } },
      }),
    ).toEqual({ kind: "give_up" });
  });

  it("preserves legacy escalate-on-2 when stepHasEscalate and no byClass", () => {
    expect(
      decideRetry({
        failureClass: "agent_error",
        attempt: 1,
        maxAttempts: 3,
        stepHasEscalate: true,
      }),
    ).toEqual({ kind: "retry", delayMs: 0, escalate: true, nextAttempt: 2 });
    expect(
      decideRetry({
        failureClass: "script_failure",
        attempt: 1,
        maxAttempts: 3,
      }),
    ).toEqual({ kind: "retry", delayMs: 0, escalate: false, nextAttempt: 2 });
  });
});
