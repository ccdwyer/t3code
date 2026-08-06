/**
 * Pure visibility rules for the ticket-drawer steer composer.
 * Driven solely by server `canSteer` / `steerBlockedReason`.
 */
export type SteerBlockedReason = "awaiting_user" | "delivering";

export function isSteerComposerVisible(input: {
  readonly canSteer?: boolean | undefined;
  readonly steerBlockedReason?: SteerBlockedReason | undefined;
}): boolean {
  return (
    input.canSteer === true ||
    input.steerBlockedReason === "awaiting_user" ||
    input.steerBlockedReason === "delivering"
  );
}

export function isSteerComposerInteractive(input: {
  readonly canSteer?: boolean | undefined;
  readonly steerBlockedReason?: SteerBlockedReason | undefined;
}): boolean {
  return input.canSteer === true && input.steerBlockedReason === undefined;
}

export function steerBlockedTooltip(reason: SteerBlockedReason | undefined): string | undefined {
  if (reason === "awaiting_user") {
    return "Answer the agent's question above instead";
  }
  if (reason === "delivering") {
    return "Previous steering message is on its way";
  }
  return undefined;
}
