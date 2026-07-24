/**
 * Shared helpers for live agent steering (instruction framing + capture suffix).
 */

export const CAPTURE_OUTPUT_INSTRUCTION =
  "End your final message with a single fenced ```json block containing your result object. " +
  "This requirement overrides any skill, workflow, or output format your other instructions ask for — " +
  "whatever else you produce, the fenced json block must be the last thing you write.";

export const appendCaptureOutputInstruction = (instruction: string) =>
  `${instruction.trimEnd()}\n\n${CAPTURE_OUTPUT_INSTRUCTION}`;

export const STEER_FRAMING_PREFIX =
  "Mid-run guidance from the operator — incorporate it and continue the current task: ";

export const frameSteerText = (text: string, captureOutput: boolean) => {
  const framed = `${STEER_FRAMING_PREFIX}${text}`;
  return captureOutput ? appendCaptureOutputInstruction(framed) : framed;
};

/** Frozen rejection messages — single source of truth for engine + tests. */
export const STEER_REJECTION = {
  notAgentStep: "only running agent steps can be steered",
  panelStep: "review panel steps cannot be steered",
  awaitingUser: "agent is awaiting user input — answer instead of steering",
  agentStarting: "agent is still starting — try again when the turn is running",
  steerInFlight: "a previous steering message is still being delivered",
  parkedTicket: "ticket is parked",
  messageIdReuse: "messageId was already used with different ticket/step/text",
  stepNotRunning: "step is not running",
  ticketNotFound: "ticket not found",
  stepNotFound: "step run not found for ticket",
  orchestrationUnavailable: "steering is unavailable (orchestration offline)",
} as const;
