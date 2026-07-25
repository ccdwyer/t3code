/**
 * The literal a step emits when it stops for a ticket's token budget
 * (`RealStepExecutor`: "token budget reached (X of Y tokens used)").
 *
 * There is no structured cause marker on a blocked step, so this prefix is the
 * only trace. Keeping the literal beside the matcher means the producer and the
 * two consumers cannot drift apart silently.
 */
export const TOKEN_BUDGET_BLOCK_PREFIX = "token budget reached";

/**
 * Whether a stuck ticket is stuck because it exhausted its token budget.
 *
 * Lives in `shared`, not on the server, because BOTH sides need it: the server
 * to classify the diagnosis, and the web client to decide whether clearing the
 * budget is the right unstick action. `apps/web` cannot import from
 * `apps/server`, and contracts is schema-only.
 *
 * A bare `totalTokens >= tokenBudget` check is neither necessary nor sufficient
 * — usage can reach the budget without a step having blocked on it, and a step
 * can block for an unrelated reason while usage happens to be high — so the
 * text and the presence of a budget are both required.
 */
export const isTokenBudgetBlock = (input: {
  readonly attentionReason?: string | null | undefined;
  readonly latestStepError?: string | null | undefined;
  readonly tokenBudget?: number | null | undefined;
}): boolean => {
  if (input.tokenBudget === null || input.tokenBudget === undefined) {
    return false;
  }
  const startsWithPrefix = (value: string | null | undefined) =>
    typeof value === "string" && value.trimStart().startsWith(TOKEN_BUDGET_BLOCK_PREFIX);
  return startsWithPrefix(input.latestStepError) || startsWithPrefix(input.attentionReason);
};
