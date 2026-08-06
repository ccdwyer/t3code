export interface RouteDecisionStepView {
  readonly status: string;
  readonly exitCode?: number | undefined;
  readonly verdict?: string | undefined;
}

export interface RouteDecisionView {
  readonly occurredAt: string;
  readonly fromLane?: string | undefined;
  // Invariant (producer-enforced): exactly one of toLane/park is present.
  // Absent for a park entry (the ticket parked in place rather than moving —
  // see `park` below).
  readonly toLane?: string | undefined;
  readonly source:
    | "step_on"
    | "lane_transition"
    | "lane_on"
    | "manual"
    | "external_event"
    | "work_source"
    | "sla";
  readonly matchedTransitionIndex?: number | undefined;
  readonly eventName?: string | undefined;
  readonly pipelineResult?: "success" | "failure" | "blocked" | undefined;
  readonly laneRunCount?: number | undefined;
  readonly steps?: Readonly<Record<string, RouteDecisionStepView>> | undefined;
  // Invariant (producer-enforced): exactly one of toLane/park is present.
  // Present when this entry renders a `TicketParked` event rather than a
  // `TicketRouteDecided` one — the ticket parked in place instead of moving.
  readonly park?:
    | {
        readonly substate: "issue" | "waiting";
        readonly label: string;
        readonly reason: string;
      }
    | undefined;
  // Present when this entry renders a `TicketSlaBreached` event.
  readonly sla?:
    | {
        readonly budgetMs: number;
        readonly escalatedTo?: string | undefined;
      }
    | undefined;
}

export interface DescribedRouteDecision {
  readonly title: string;
  readonly details: ReadonlyArray<string>;
}

const formatSlaBudgetMs = (budgetMs: number | undefined): string => {
  if (budgetMs === undefined || !Number.isFinite(budgetMs) || budgetMs <= 0) {
    return "budget";
  }
  if (budgetMs % 3_600_000 === 0) {
    const hours = budgetMs / 3_600_000;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  if (budgetMs % 60_000 === 0) {
    const minutes = budgetMs / 60_000;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return `${budgetMs} ms`;
};

/** A captured review output's verdict field, when it has the common shape. */
export const extractVerdict = (output: unknown): string | null => {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return null;
  }
  const verdict = (output as Record<string, unknown>)["verdict"];
  return typeof verdict === "string" ? verdict : null;
};

/** Agent-produced labels can be arbitrarily long — bound them for badges. */
export const truncateLabel = (value: string, maxLength = 48): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;

const PIPELINE_RESULT_LABELS: Record<string, string> = {
  success: "Pipeline succeeded",
  failure: "Pipeline failed",
  blocked: "Pipeline blocked",
};

const PARK_SUBSTATE_WORDS: Record<"issue" | "waiting", string> = {
  issue: "issue",
  waiting: "waiting",
};

// Supplementary origin phrase for a park row — shown only when the source is
// a real, known origin. "manual" is deliberately absent: it is the
// malformed-origin fallback recorded when a park's real origin could not be
// determined, and a park row must NEVER be described as "moved manually" (a
// park never moves the ticket at all).
const PARK_ORIGIN_LABELS: Partial<Record<RouteDecisionView["source"], string>> = {
  step_on: "From a step outcome",
  lane_transition: "From a lane transition",
  lane_on: "From the lane's default route",
  external_event: "From an external event",
};

/**
 * Describes a park row (`row.park` present). Renders exclusively from the
 * park fields — never from `source` — so a malformed-origin park row (whose
 * `source` falls back to `"manual"`) never renders as "Moved manually".
 */
const describeParkDecision = (
  park: NonNullable<RouteDecisionView["park"]>,
  source: RouteDecisionView["source"],
): DescribedRouteDecision => {
  const title = `Parked (${PARK_SUBSTATE_WORDS[park.substate]}) — ${park.label}`;
  const details: string[] = [park.reason];
  const originLabel = PARK_ORIGIN_LABELS[source];
  if (originLabel !== undefined) {
    details.push(originLabel);
  }
  return { title, details };
};

/**
 * Human-readable explanation of one routing decision for the ticket drawer.
 * `laneName` resolves lane keys to display names (falls back to the key).
 */
export const describeRouteDecision = (
  decision: RouteDecisionView,
  laneName: (key: string) => string,
): DescribedRouteDecision => {
  // Acceptance criterion: branch on `park` FIRST, before ever looking at
  // `source` — a park row's `source` may be the malformed-origin fallback
  // ("manual") and must never be mistaken for a manual lane move.
  if (decision.park !== undefined) {
    return describeParkDecision(decision.park, decision.source);
  }

  if (decision.source === "sla" || decision.sla !== undefined) {
    const budgetLabel = formatSlaBudgetMs(decision.sla?.budgetMs);
    const from = decision.fromLane === undefined ? "lane" : laneName(decision.fromLane);
    const title =
      decision.sla?.escalatedTo !== undefined || decision.toLane !== undefined
        ? `SLA breached (over ${budgetLabel} in ${from})`
        : `SLA breached (over ${budgetLabel} in ${from})`;
    const details: string[] = [];
    const target = decision.sla?.escalatedTo ?? decision.toLane;
    if (target !== undefined) {
      details.push(`Escalated to ${laneName(target)}`);
    } else {
      details.push("Needs attention (notify only)");
    }
    return { title, details };
  }

  const to = decision.toLane === undefined ? "—" : laneName(decision.toLane);
  const title =
    decision.fromLane === undefined ? `Moved to ${to}` : `${laneName(decision.fromLane)} → ${to}`;

  if (decision.source === "manual") {
    return { title, details: ["Moved manually"] };
  }

  const details: string[] = [];
  if (decision.source === "lane_transition" && decision.matchedTransitionIndex !== undefined) {
    details.push(`Matched transition #${decision.matchedTransitionIndex + 1}`);
  } else if (decision.source === "lane_transition") {
    details.push("Matched a lane transition");
  } else if (decision.source === "lane_on") {
    details.push("Default route");
  } else if (decision.source === "external_event") {
    details.push(
      decision.eventName === undefined
        ? "External event"
        : // Truncate the name only, then wrap in quotes, so a long name never
          // drops the closing quote (which would be the truncated character).
          `External event "${truncateLabel(decision.eventName, 30)}"`,
    );
  } else if (decision.source === "work_source") {
    details.push("Synced from a work source");
  } else {
    details.push("Routed by a step outcome");
  }
  const resultLabel =
    decision.pipelineResult === undefined
      ? undefined
      : PIPELINE_RESULT_LABELS[decision.pipelineResult];
  if (resultLabel !== undefined) {
    details.push(resultLabel);
  }
  if (decision.laneRunCount !== undefined) {
    details.push(`Run ${decision.laneRunCount} in this lane`);
  }
  for (const [stepKey, step] of Object.entries(decision.steps ?? {})) {
    if (step.verdict !== undefined) {
      details.push(truncateLabel(`${stepKey}: ${step.verdict}`));
    } else if (step.exitCode !== undefined) {
      details.push(`${stepKey}: exit ${step.exitCode}`);
    }
  }
  return { title, details };
};
