/**
 * Closed failure taxonomy classification + retry decision (pure).
 * Spec: ideation/t3code-workflows/specs/failure-taxonomy-retries/SPEC.md
 */
import type { WorkflowFailureClass } from "@t3tools/contracts";

export type FailureClass = WorkflowFailureClass;

export const TURN_TIMEOUT_LITERAL = "turn did not reach a terminal state before timeout" as const;
export const PROVIDER_USER_INPUT_LITERAL = "provider requested additional user input" as const;

/** Exact-literal restart / infra constants (must match producers). */
export const RESTART_INFRA_LITERALS = [
  "step interrupted by server restart",
  "script interrupted by server restart",
  "review panel interrupted by restart",
  "merge interrupted by server restart",
  "PR open interrupted by restart",
  "land interrupted by restart",
  "structured output lookup failed",
  TURN_TIMEOUT_LITERAL,
  PROVIDER_USER_INPUT_LITERAL,
] as const;

/**
 * Last-resort net for classless outcomes. Exact literals only — never
 * substring-guesses arbitrary provider errors.
 */
export const classifyFallback = (
  error: string,
  _retryable?: boolean, // unused: human_rejection / user_cancelled match regardless
): FailureClass => {
  if (error === "rejected") return "human_rejection";
  if (error === "script cancelled") return "user_cancelled";
  if (error === "script timed out") return "timeout";
  if (error === "missing or invalid structured output") return "agent_error";
  if (error.startsWith("output contract violation")) return "agent_error";
  // script exited with code N — exact prefix from ScriptStepExecutor mapCommandResult
  if (/^script exited with code \d+$/.test(error)) return "script_failure";
  if ((RESTART_INFRA_LITERALS as readonly string[]).includes(error)) return "infra";
  return "unknown";
};

export type RetryAction =
  | { readonly kind: "give_up" }
  | {
      readonly kind: "retry";
      readonly delayMs: number;
      readonly escalate: boolean;
      readonly nextAttempt: number;
    };

export type ClassRetryPolicy = {
  // `| undefined` on each optional keeps this structurally compatible with the
  // schema-derived board definition type under `exactOptionalPropertyTypes`.
  readonly action?: "retry" | "backoff" | "escalate_model" | "give_up" | undefined;
  readonly backoffMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
};

/**
 * Resolve retry for a failed attempt.
 * - Hard-stops human_rejection / user_cancelled / retryable:false / user-input wait.
 * - When byClass is absent, preserves legacy escalate-on-attempt>=2 if stepHasEscalate.
 */
export const decideRetry = (input: {
  readonly failureClass: FailureClass;
  readonly attempt: number; // 1-based completed attempts
  readonly maxAttempts: number;
  readonly retryable?: boolean | undefined;
  readonly byClass?:
    | Readonly<
        Partial<
          Record<
            "agent_error" | "script_failure" | "timeout" | "infra" | "unknown",
            ClassRetryPolicy | undefined
          >
        >
      >
    | undefined;
  readonly error?: string | undefined;
  /** Legacy boards: step.retry.escalate is set → escalate from attempt 2. */
  readonly stepHasEscalate?: boolean | undefined;
  /** recovery mode never sleeps */
  readonly mode?: "live" | "recovery" | undefined;
}): RetryAction => {
  if (
    input.failureClass === "human_rejection" ||
    input.failureClass === "user_cancelled" ||
    input.retryable === false ||
    input.error === PROVIDER_USER_INPUT_LITERAL
  ) {
    return { kind: "give_up" };
  }
  if (input.attempt >= input.maxAttempts) {
    return { kind: "give_up" };
  }

  const nextAttempt = input.attempt + 1;
  const policy =
    input.byClass?.[
      input.failureClass as "agent_error" | "script_failure" | "timeout" | "infra" | "unknown"
    ];
  const classCap = policy?.maxAttempts;
  if (classCap !== undefined && input.attempt >= classCap) {
    return { kind: "give_up" };
  }

  const action = policy?.action ?? "retry";
  if (action === "give_up") {
    return { kind: "give_up" };
  }

  const recovery = input.mode === "recovery";
  if (action === "escalate_model" || action === ("escalate" as string)) {
    return {
      kind: "retry",
      delayMs: 0,
      escalate: true,
      nextAttempt,
    };
  }
  if (action === "backoff") {
    const delayMs = recovery ? 0 : Math.min(Math.max(0, policy?.backoffMs ?? 5_000), 300_000);
    return { kind: "retry", delayMs, escalate: false, nextAttempt };
  }

  // Default immediate retry; preserve legacy escalate-on-2+ when no byClass.
  const escalate =
    input.byClass === undefined && input.stepHasEscalate === true && nextAttempt >= 2;
  return { kind: "retry", delayMs: 0, escalate, nextAttempt };
};
