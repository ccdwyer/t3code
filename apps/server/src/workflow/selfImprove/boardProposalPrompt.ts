/**
 * Pure prompt builder + structured-output parser for board-improvement
 * proposals.
 *
 * `buildProposalPrompt` assembles a single prompt from the current board
 * definition plus a NUMERIC metrics summary, then runs the whole thing through
 * `redactSensitiveText` as a defence-in-depth pass. Ticket TITLES from the
 * attention list are deliberately NOT included — only ids/ages/lanes — so no
 * free-text ticket content leaks into the meta-agent prompt.
 *
 * `parseBoardProposal` validates the structured output returned by the no-tool
 * `generateBoardProposal` op (E3). E3 already returns a typed shape, so this is
 * a thin validation seam kept for testability and to fail loudly on a provider
 * that returns a malformed payload.
 */

import type { WorkflowBoardMetrics, WorkflowDefinition } from "@t3tools/contracts";

import { redactSensitiveText } from "../redactSensitiveText.ts";

const FOCUS_INSTRUCTION = [
  "Identify dead/never-matched routes, retry-heavy or failing steps, lanes with high manual",
  "correction, and stalled tickets. Propose a revised definition that addresses them; keep",
  "changes targeted; do NOT change sources, outbound, or the board name. Output a single fenced",
  '```json block with `{ "proposedDefinition": <string>, "rationale": <string> }`, where',
  "proposedDefinition is the full WorkflowDefinition serialized as a JSON string (JSON.stringify of the definition object).",
].join(" ");

// A route target (`transitions[].to`, `lane.on.*`, `step.on.*`) can be a bare
// lane key string OR a park target object. Prefer park targets over adding a
// dedicated issue/review/parking lane — a ticket that hits a problem or needs
// a human should park in place in its current lane instead of moving.
const PARK_TARGET_PROSE = [
  "A route target (`transitions[].to`, `lane.on.success/failure/blocked`, or",
  "`step.on.success/failure/blocked`) can be a bare lane key",
  'string OR a park target object: `{ "park": "issue" | "waiting", "label"?: string, "actions":',
  '[{ "label": string, "to": "<lane key>", "hint"?: string }, ...] }` (`actions` is REQUIRED and',
  "non-empty; a park cannot route into another park — `actions[].to` is always a lane key).",
  "Prefer park targets over dedicated issue/review/parking lanes — a ticket that hits a problem",
  'or needs a human should park in place in its current lane rather than move to one. Use `"issue"`',
  'for a failure/error/blocked outcome and `"waiting"` for an intentional human checkpoint. If the',
  "board already has a dedicated needs-attention-style lane, prefer converting its incoming routes",
  "to park targets over adding more routes into it. Example — a pipeline lane's `on.failure`",
  "parking a failure as an issue instead of moving to an issues lane:",
].join(" ");

const PARK_TARGET_GUIDANCE = [
  "## Routing guidance",
  PARK_TARGET_PROSE,
  "```json",
  '{ "on": { "failure": { "park": "issue", "actions": [',
  '  { "label": "Retry planning", "to": "planning", "hint": "Run planning and specification again." },',
  '  { "label": "Back to backlog", "to": "backlog", "hint": "Park the ticket; nothing runs until you start it again." }',
  "] } } }",
  "```",
].join("\n");

/**
 * Build a numeric, title-free metrics summary. Every value here is a number or
 * a lane/step key — never a ticket title or other free text.
 */
const summarizeMetrics = (metrics: WorkflowBoardMetrics): string => {
  const lines: Array<string> = [];
  lines.push(`Window: ${metrics.windowDays} day(s)`);
  lines.push(
    `Throughput: created=${metrics.throughput.created}, shipped=${metrics.throughput.shipped}`,
  );
  lines.push(
    `Cycle time (ms): count=${metrics.cycleTime.count}, p50=${metrics.cycleTime.p50Ms}, p90=${metrics.cycleTime.p90Ms}, avg=${metrics.cycleTime.avgMs}`,
  );
  lines.push(`Manual moves: ${metrics.manualMoveCount}`);
  lines.push(
    `Attention: blocked=${metrics.attention.blocked}, waitingOnUser=${metrics.attention.waitingOnUser}`,
  );

  // Oldest stalled tickets — NUMERIC only. Titles are intentionally stripped.
  if (metrics.attention.oldest.length > 0) {
    lines.push("Oldest stalled tickets (lane, ageMs — titles omitted):");
    for (const t of metrics.attention.oldest) {
      lines.push(`  - lane=${t.laneKey ?? "none"} ageMs=${t.ageMs}`);
    }
  }

  if (metrics.routeOutcomes.length > 0) {
    lines.push("Route outcomes (from → to, source, result, count):");
    for (const r of metrics.routeOutcomes) {
      lines.push(
        `  - ${r.fromLane ?? "none"} -> ${r.toLane ?? "none"} [${r.source}/${r.result}] x${r.count}`,
      );
    }
  }

  if (metrics.stepStats.length > 0) {
    lines.push("Step stats (lane.step, type, succeeded/failed/retries, tokens, avgMs):");
    for (const s of metrics.stepStats) {
      lines.push(
        `  - ${s.laneKey}.${s.stepKey} [${s.stepType}] ok=${s.succeeded} fail=${s.failed} retries=${s.retries} tokens=${s.totalTokens} avgMs=${s.avgDurationMs}`,
      );
    }
  }

  if (metrics.wipByLane.length > 0) {
    lines.push("WIP by lane (admitted/queued):");
    for (const w of metrics.wipByLane) {
      lines.push(`  - ${w.laneKey} admitted=${w.admitted} queued=${w.queued}`);
    }
  }

  return lines.join("\n");
};

export const buildProposalPrompt = ({
  definition,
  metrics,
}: {
  readonly definition: WorkflowDefinition;
  readonly metrics: WorkflowBoardMetrics;
}): string => {
  const definitionJson = JSON.stringify(definition, null, 2);

  const assembled = [
    "You are reviewing a t3 workflow board definition for possible improvements.",
    "",
    "## Current board metrics",
    summarizeMetrics(metrics),
    "",
    "## Current board definition (WorkflowDefinition JSON)",
    "```json",
    definitionJson,
    "```",
    "",
    PARK_TARGET_GUIDANCE,
    "",
    "## Task",
    FOCUS_INSTRUCTION,
  ].join("\n");

  // Defence-in-depth: strip any high-entropy / credential-shaped strings that
  // may have leaked into the definition (e.g. a token pasted into an
  // instruction). Numeric metrics are unaffected.
  return redactSensitiveText(assembled);
};

export interface ParsedBoardProposal {
  readonly proposedDefinition: unknown;
  readonly rationale: string;
}

/**
 * Validate the structured output from E3. Throws a plain Error on a malformed
 * payload; the caller maps that to an `invalid` proposal / RPC error.
 */
export const parseBoardProposal = (output: {
  readonly proposedDefinition: unknown;
  readonly rationale: string;
}): ParsedBoardProposal => {
  if (output === null || typeof output !== "object") {
    throw new Error("Board proposal output was not an object.");
  }
  if (typeof output.rationale !== "string") {
    throw new Error("Board proposal output is missing a string `rationale`.");
  }
  if (output.proposedDefinition === undefined || output.proposedDefinition === null) {
    throw new Error("Board proposal output is missing `proposedDefinition`.");
  }
  return { proposedDefinition: output.proposedDefinition, rationale: output.rationale };
};
