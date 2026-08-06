/**
 * Picks which agent step's hidden provider thread to open as the ticket's
 * "conversation" when a card is selected. Workflow dispatch threads stay out of
 * the main threads list; this is the board-side entry point into them.
 *
 * Preference order:
 * 1. The latest *active* agent step with a `providerThreadId`
 *    (running / dispatch_requested / awaiting_user / blocked)
 * 2. Otherwise the latest agent step that has a `providerThreadId` at all
 *    (completed runs still expose a transcript)
 */
export function pickAgentConversationStep(
  steps: ReadonlyArray<{
    readonly stepKey: string;
    readonly stepType: string;
    readonly status: string;
    readonly providerThreadId?: string | undefined;
  }>,
): { readonly stepKey: string; readonly threadId: string } | null {
  const withThread = steps.filter(
    (
      step,
    ): step is {
      readonly stepKey: string;
      readonly stepType: string;
      readonly status: string;
      readonly providerThreadId: string;
    } =>
      step.stepType === "agent" &&
      step.providerThreadId !== undefined &&
      step.providerThreadId.length > 0,
  );
  if (withThread.length === 0) {
    return null;
  }

  const active = withThread.filter(
    (step) =>
      step.status === "running" ||
      step.status === "dispatch_requested" ||
      step.status === "awaiting_user" ||
      step.status === "blocked",
  );
  const pick = active.at(-1) ?? withThread.at(-1);
  if (pick === undefined) {
    return null;
  }
  return { stepKey: pick.stepKey, threadId: pick.providerThreadId };
}
