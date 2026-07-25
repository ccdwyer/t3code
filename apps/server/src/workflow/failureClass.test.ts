import { describe, expect, it } from "vite-plus/test";

import { classifyFallback, decideRetry, RESTART_INFRA_LITERALS } from "./failureClass.ts";

describe("classifyFallback", () => {
  it("maps exact human/script/timeout literals", () => {
    expect(classifyFallback("rejected")).toBe("human_rejection");
    expect(classifyFallback("script cancelled")).toBe("user_cancelled");
    expect(classifyFallback("script timed out")).toBe("timeout");
    expect(classifyFallback("missing or invalid structured output")).toBe("agent_error");
  });

  it("maps every restart/infra constant", () => {
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
    ).toEqual({ kind: "give_up" });
    expect(
      decideRetry({
        failureClass: "user_cancelled",
        attempt: 1,
        maxAttempts: 5,
      }),
    ).toEqual({ kind: "give_up" });
  });

  it("hard-stops provider user-input wait", () => {
    expect(
      decideRetry({
        failureClass: "infra",
        attempt: 1,
        maxAttempts: 5,
        error: "provider requested additional user input",
      }),
    ).toEqual({ kind: "give_up" });
  });

  it("respects maxAttempts and byClass backoff/escalate", () => {
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
    ).toEqual({ kind: "retry", delayMs: 2_000, escalate: false });
    expect(
      decideRetry({
        failureClass: "agent_error",
        attempt: 1,
        maxAttempts: 3,
        byClass: { agent_error: { action: "escalate" } },
      }),
    ).toEqual({ kind: "retry", delayMs: 0, escalate: true });
  });

  it("defaults to immediate retry when no byClass", () => {
    expect(decideRetry({ failureClass: "script_failure", attempt: 1, maxAttempts: 3 })).toEqual({
      kind: "retry",
      delayMs: 0,
      escalate: false,
    });
  });
});
