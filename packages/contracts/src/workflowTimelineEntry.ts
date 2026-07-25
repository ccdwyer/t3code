import type { WorkflowEvent } from "./workflow.ts";

/**
 * Who caused an entry. Coarse on purpose: the journal has no actor column, so
 * this is derived from event semantics rather than identity. Attributing to a
 * named user would be a write-path change.
 */
export type TimelineActor = "user" | "agent" | "system" | "external";

/** Groups entries for filtering and iconography. */
export type TimelineCategory =
  | "lifecycle"
  | "pipeline"
  | "step"
  | "routing"
  | "repo"
  | "human"
  | "external"
  | "unknown";

export interface TimelineEntry {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly streamVersion: number;
  readonly category: TimelineCategory;
  readonly actor: TimelineActor;
  /** One line, past tense, no relative time — the client adds age. */
  readonly summary: string;
  readonly detail?: string | undefined;
  /** Set when the entry can deep-link to a step's agent conversation. */
  readonly stepRunId?: string | undefined;
  readonly providerThreadId?: string | undefined;
}

const clip = (value: string, max = 160): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
};

/**
 * Map one journal event to a timeline entry.
 *
 * Every case falls through to an `unknown` entry rather than disappearing, so a
 * mapper this build has not caught up with still renders a row.
 *
 * That is NOT protection against a genuinely new server event: `WorkflowEvent`
 * is a closed union, so an older client rejects the RPC result at decode time
 * before this function ever runs. Widening the wire schema is the only thing
 * that would buy forward compatibility; this fallback only covers variants the
 * union already has and this mapper has not enumerated.
 */
export const toTimelineEntry = (event: WorkflowEvent): TimelineEntry => {
  const base = {
    eventId: event.eventId as string,
    occurredAt: event.occurredAt as string,
    streamVersion: event.streamVersion,
  };
  const payload = event.payload as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof payload[key] === "string" ? (payload[key] as string) : undefined;

  switch (event.type) {
    case "TicketCreated":
      return {
        ...base,
        category: "lifecycle",
        actor: "user",
        summary: `Ticket created in "${str("laneKey") ?? "?"}"`,
      };
    case "TicketEdited":
      return { ...base, category: "human", actor: "user", summary: "Ticket edited" };
    case "TicketMovedToLane": {
      const reason = str("reason");
      return {
        ...base,
        category: "routing",
        // A routed move is the engine acting; a manual one is a person.
        actor: reason === "manual" ? "user" : reason === "external" ? "external" : "system",
        summary: `Moved to "${str("toLane") ?? "?"}"${reason === undefined ? "" : ` (${reason})`}`,
      };
    }
    case "TicketRouted":
      return {
        ...base,
        category: "routing",
        actor: "system",
        summary: `Routed to "${str("toLane") ?? "?"}"`,
      };
    case "TicketQueued":
      return {
        ...base,
        category: "routing",
        actor: "system",
        summary: `Queued for "${str("lane") ?? "?"}"`,
      };
    case "TicketAdmitted":
      return {
        ...base,
        category: "routing",
        actor: "system",
        summary: `Admitted into "${str("lane") ?? "?"}"`,
      };
    case "TicketRouteDecided":
      return {
        ...base,
        category: "routing",
        actor: "system",
        summary: `Route decided: ${str("fromLane") ?? "?"} → ${str("toLane") ?? "?"}`,
        ...(str("source") === undefined ? {} : { detail: `source: ${str("source") ?? ""}` }),
      };
    case "TicketBlocked":
      return {
        ...base,
        category: "lifecycle",
        actor: "system",
        summary: "Blocked",
        ...(str("reason") === undefined ? {} : { detail: clip(str("reason") ?? "") }),
      };
    case "TicketParked":
      return {
        ...base,
        category: "lifecycle",
        actor: "system",
        summary: `Parked: ${str("label") ?? str("substate") ?? "issue"}`,
        ...(str("reason") === undefined ? {} : { detail: clip(str("reason") ?? "") }),
      };
    case "PipelineStarted":
      return { ...base, category: "pipeline", actor: "system", summary: "Pipeline started" };
    case "PipelineCompleted":
      return {
        ...base,
        category: "pipeline",
        actor: "system",
        summary: `Pipeline ${str("result") ?? "finished"}`,
      };
    case "StepStarted": {
      const attempt = typeof payload["attempt"] === "number" ? payload["attempt"] : undefined;
      const stepType = str("stepType");
      return {
        ...base,
        category: "step",
        // An approval step is a human gate and a script step is the machine;
        // calling either "agent" misattributes who is about to act.
        actor: stepType === "approval" ? "user" : stepType === "script" ? "system" : "agent",
        summary: `Step "${str("stepKey") ?? "?"}" started${
          attempt !== undefined && attempt > 1 ? ` (attempt ${String(attempt)})` : ""
        }`,
        ...(str("stepRunId") === undefined ? {} : { stepRunId: str("stepRunId") }),
      };
    }
    case "StepCompleted":
      return {
        ...base,
        category: "step",
        actor: "agent",
        summary: "Step completed",
        ...(str("stepRunId") === undefined ? {} : { stepRunId: str("stepRunId") }),
      };
    case "StepFailed":
      return {
        ...base,
        category: "step",
        actor: "agent",
        summary: "Step failed",
        ...(str("error") === undefined ? {} : { detail: clip(str("error") ?? "") }),
        ...(str("stepRunId") === undefined ? {} : { stepRunId: str("stepRunId") }),
      };
    case "StepBlocked":
      return {
        ...base,
        category: "step",
        actor: "system",
        summary: "Step blocked",
        ...(str("reason") === undefined ? {} : { detail: clip(str("reason") ?? "") }),
        ...(str("stepRunId") === undefined ? {} : { stepRunId: str("stepRunId") }),
      };
    case "StepAwaitingUser":
      return {
        ...base,
        category: "human",
        actor: "agent",
        summary: "Waiting on a human",
        ...(str("waitingReason") === undefined ? {} : { detail: clip(str("waitingReason") ?? "") }),
        ...(str("stepRunId") === undefined ? {} : { stepRunId: str("stepRunId") }),
      };
    case "StepUserResolved":
      return {
        ...base,
        category: "human",
        actor: "user",
        summary:
          str("decision") !== undefined
            ? `Human decided "${str("decision") ?? ""}"`
            : str("outcome") === "success"
              ? "Human approved"
              : str("outcome") === undefined
                ? "Human responded"
                : `Human rejected (${str("outcome") ?? ""})`,
        ...(str("stepRunId") === undefined ? {} : { stepRunId: str("stepRunId") }),
      };
    case "StepRefsCaptured":
      return {
        ...base,
        category: "repo",
        actor: "agent",
        summary: "Repository refs captured",
        detail: `${str("preRef") ?? "?"} → ${str("postRef") ?? "?"}`,
        ...(str("stepRunId") === undefined ? {} : { stepRunId: str("stepRunId") }),
      };
    case "StepRetryScheduled":
      return { ...base, category: "step", actor: "system", summary: "Retry scheduled" };
    case "StepSteered":
      return { ...base, category: "human", actor: "user", summary: "Agent steered mid-run" };
    case "TicketPrOpened":
      return {
        ...base,
        category: "repo",
        actor: "agent",
        summary: "Pull request opened",
        ...(str("url") === undefined ? {} : { detail: str("url") }),
      };
    case "TicketMessagePosted":
      return {
        ...base,
        category: "human",
        actor: str("author") === "agent" ? "agent" : "user",
        summary: "Message posted",
        ...(str("body") === undefined ? {} : { detail: clip(str("body") ?? "") }),
      };
    case "TicketMessageEdited":
      return { ...base, category: "human", actor: "user", summary: "Message edited" };
    case "TicketExternalEventSkipped":
      return {
        ...base,
        category: "external",
        actor: "external",
        summary: "External event skipped",
      };
    case "TicketSlaBreached":
      return { ...base, category: "lifecycle", actor: "system", summary: "SLA breached" };
    case "TicketForkSpawned":
      return { ...base, category: "pipeline", actor: "system", summary: "Forked into children" };
    case "TicketForkResolved":
      return { ...base, category: "pipeline", actor: "system", summary: "Fork resolved" };
    case "ScriptStepStarted":
      return { ...base, category: "step", actor: "system", summary: "Script started" };
    case "ScriptStepExited": {
      const outcome = str("outcome");
      const exitCode = typeof payload["exitCode"] === "number" ? payload["exitCode"] : undefined;
      return {
        ...base,
        category: "step",
        actor: "system",
        // The outcome is the point of this event: "exited" alone hides a timeout
        // or a non-zero status, which is exactly what a reader is looking for.
        summary: `Script ${outcome ?? "exited"}${
          exitCode === undefined ? "" : ` (exit ${String(exitCode)})`
        }`,
        ...(str("stepRunId") === undefined ? {} : { stepRunId: str("stepRunId") }),
      };
    }
    case "StepOutputInvalid":
      return {
        ...base,
        category: "step",
        actor: "agent",
        summary: "Step output failed its contract",
        ...(str("stepRunId") === undefined ? {} : { stepRunId: str("stepRunId") }),
      };
    case "TicketDependenciesSet":
      return { ...base, category: "human", actor: "user", summary: "Dependencies changed" };
    case "TicketForkChildSettled":
      return { ...base, category: "pipeline", actor: "system", summary: "Fork child settled" };
    case "TicketContextPackCompiled":
      return {
        ...base,
        category: "pipeline",
        actor: "system",
        summary: "Handoff context compiled",
      };
    case "TicketContextPackEdited":
      return { ...base, category: "human", actor: "user", summary: "Handoff context edited" };
    default:
      // Unreachable for the current union — TypeScript narrows `event` to never
      // here, which is the compiler proving the mapper is exhaustive. Kept as a
      // runtime floor for a payload that decodes but is not one of these.
      return {
        ...base,
        category: "unknown",
        actor: "system",
        summary: (event as { readonly type: string }).type,
      };
  }
};
