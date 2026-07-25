/**
 * Closed failure taxonomy classification + retry decision (pure).
 * Spec: ideation/t3code-workflows/specs/failure-taxonomy-retries/SPEC.md
 */
import type { WorkflowFailureClass } from "@t3tools/contracts";

export type FailureClass = WorkflowFailureClass;

/** Exact-literal restart / infra constants (must match producers). */
export const RESTART_INFRA_LITERALS = [
  "step interrupted by server restart",
  "script interrupted by server restart",
  "review panel interrupted by restart",
  "merge interrupted by server restart",
  "PR open interrupted by restart",
  "land interrupted by restart",
  "structured output lookup failed",
  "turn did not reach a terminal state before timeout",
  "provider requested additional user input",
] as const;

/**
 * Last-resort net for classless outcomes. Exact literals only — never
 * substring-guesses arbitrary provider errors.
 */
export const classifyFallback = (error: string, _retryable?: boolean): FailureClass => {
  if (error === "rejected") return "human_rejection";
  if (error === "script cancelled") return "user_cancelled";
  if (error === "script timed out") return "timeout";
  if (error === "missing or invalid structured output") return "agent_error";
  if (error.startsWith("output contract violation")) return "agent_error";
  if ((RESTART_INFRA_LITERALS as readonly string[]).includes(error)) return "infra";
  if (error.startsWith("executor error:")) return "infra";
  if (error.startsWith("setup ")) return "infra";
  return "unknown";
};

export type RetryAction =
  | { readonly kind: "give_up" }
  | { readonly kind: "retry"; readonly delayMs: number; readonly escalate: boolean };

export type ClassRetryPolicy = {
  readonly action?: "retry" | "backoff" | "escalate" | "give_up";
  readonly backoffMs?: number;
};

/**
 * Resolve retry for a failed attempt. Hard-stops human_rejection / user_cancelled
 * and the provider-user-input infra literal regardless of flags.
 */
export const decideRetry = (input: {
  readonly failureClass: FailureClass;
  readonly attempt: number; // 1-based completed attempts
  readonly maxAttempts: number;
  readonly retryable?: boolean;
  readonly byClass?: Readonly<Partial<Record<FailureClass, ClassRetryPolicy>>>;
  readonly error?: string;
}): RetryAction => {
  if (
    input.failureClass === "human_rejection" ||
    input.failureClass === "user_cancelled" ||
    input.retryable === false ||
    input.error === "provider requested additional user input"
  ) {
    return { kind: "give_up" };
  }
  if (input.attempt >= input.maxAttempts) {
    return { kind: "give_up" };
  }

  const policy = input.byClass?.[input.failureClass];
  const action = policy?.action ?? "retry";
  if (action === "give_up") {
    return { kind: "give_up" };
  }
  if (action === "escalate") {
    return { kind: "retry", delayMs: 0, escalate: true };
  }
  if (action === "backoff") {
    const delayMs = Math.min(Math.max(0, policy?.backoffMs ?? 5_000), 20 * 60 * 1000);
    return { kind: "retry", delayMs, escalate: false };
  }
  // immediate retry (default / action: "retry")
  return { kind: "retry", delayMs: 0, escalate: false };
};
