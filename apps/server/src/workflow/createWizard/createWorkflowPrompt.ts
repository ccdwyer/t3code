/**
 * Pure prompt builder + RAW-JSON transforms for the "agent-assisted" create
 * workflow wizard. A no-tool LLM op drafts a board from the user's free-text
 * description; this module assembles the prompt and post-processes the parsed
 * output BEFORE schema decode so that:
 *   - the user's chosen agent is FORCED into every agent step
 *     (`injectAgentIntoSteps`), and
 *   - executable step types are detected for rejection
 *     (`containsForbiddenStepType`).
 *
 * Pure module — no Effect, no I/O. The transforms operate on the RAW parsed
 * JSON (an `unknown`), are total/defensive (never throw on weird input), and
 * mutate only a value the caller owns.
 */

import type { AgentSelection } from "@t3tools/contracts";

import { redactSensitiveText } from "../redactSensitiveText.ts";

const FORBIDDEN_STEP_TYPES = new Set(["script", "merge", "pullRequest"]);

const OUTPUT_INSTRUCTION = [
  "Output a single fenced",
  '```json block with `{ "proposedDefinition": <string>, "rationale": <string> }`, where',
  "proposedDefinition is the full WorkflowDefinition serialized as a JSON string",
  "(i.e. JSON.stringify of the definition object), not a nested object.",
].join(" ");

// EXACT shape the definition object must follow. The decoder is strict about
// enums and required fields (it ignores unknown fields), so the most common
// failure is an out-of-vocabulary `entry`/`type` or a missing required key.
const SHAPE_SPEC = [
  "## Exact JSON shape (the decoder is strict — follow it precisely)",
  'The definition object is `{ "name": string, "lanes": [ Lane, ... ] }`.',
  "Each Lane is an object with these fields:",
  '- `key` (REQUIRED, non-empty string, unique per lane — e.g. "to-do", "in-progress")',
  '- `name` (REQUIRED, non-empty string — the human label, e.g. "To do")',
  '- `entry` (REQUIRED, EXACTLY one of the two strings "auto" or "manual" — no other value)',
  '- `pipeline` (optional array of Step; ONLY meaningful on an "auto" lane)',
  '- `transitions` (optional array of `{ "when": <json-logic>, "to": "<lane key>" | ParkTarget }`)',
  '- `actions` (optional array of `{ "label": string (≤48 chars), "to": "<lane key>" }` — buttons on a manual lane)',
  '- `on` (optional `{ "success": <lane key>|ParkTarget, "failure": <lane key>|ParkTarget, "blocked": <lane key>|ParkTarget }` — where the pipeline routes by outcome; prefer a ParkTarget over a dedicated issue/review lane for failure/blocked outcomes — see "Park targets" below)',
  "- `terminal` (optional boolean; set `true` on the lane(s) where tickets are done)",
  "Each Step in a `pipeline` is an object with:",
  '- `key` (REQUIRED, non-empty string, unique per pipeline — e.g. "implement", "review")',
  '- `type` (REQUIRED, EXACTLY "agent" or "approval" — script/merge/pullRequest are forbidden)',
  '- for `type:"agent"`: `instruction` (REQUIRED string — what the agent should do; use {{ticket.title}}/{{ticket.description}} placeholders). Do NOT include an `agent` field; the server injects it.',
  '- optional `captureOutput` (boolean) — set `true` on a step whose JSON output a later transition reads via `{ "var": "steps.<stepKey>.output.<field>" }`',
  '- optional `on` (`{ "success": <lane key>|ParkTarget, "failure": <lane key>|ParkTarget, "blocked": <lane key>|ParkTarget }` — a step-level fallback route, checked before the lane\'s own `transitions`/`on`)',
  "Rules: a route target (a bare `to`, or `on.success`/`on.failure`/`on.blocked`, at the step level or the lane level) may be a lane key OR a ParkTarget object; only a park's `actions[].to` and a manual lane's `actions[].to` must be a `key` of a lane you define. At least one lane MUST have `terminal: true` and be reachable.",
  "A bounded review loop (run a step again until a budget is hit) uses this transition (note the `lane.runCount` guard, REQUIRED for a self-loop so it terminates):",
  '`{ "when": { "and": [ { "==": [{ "var": "steps.review.output.verdict" }, "revise"] }, { "<": [{ "var": "lane.runCount" }, 3] } ] }, "to": "<same auto lane>" }`',
].join("\n");

// Teaches the park-target route shape and states the preference explicitly —
// otherwise the model keeps regenerating a dedicated "needs-attention"/"issues"
// lane, which is the exact pattern this prompt is meant to steer away from.
const PARK_TARGET_PROSE = [
  "A `to`/`on.success`/`on.failure`/`on.blocked` value can be a bare lane key string OR a ParkTarget",
  'object: `{ "park": "issue" | "waiting", "label"?: string (≤80 chars), "actions": [{ "label": string',
  '(≤48 chars), "to": "<lane key>", "hint"?: string }, ...] }` (`actions` is REQUIRED and non-empty; a',
  'park cannot route into another park — `actions[].to` is always a lane key). Use `"issue"` for a',
  'failure/error/blocked outcome and `"waiting"` for an intentional human checkpoint (e.g. a review-loop',
  "budget running out). Prefer park targets over dedicated issue/review/parking lanes — a ticket that",
  "hits a problem or needs a human should park in place in its current lane rather than move to one.",
  "A dedicated manual lane is still valid schema and fine for a real step the user explicitly wants",
  "(e.g. an owner-review gate before Done) — just don't default to one for failure/blocked handling.",
].join(" ");

const PARK_TARGET_SPEC = [
  "## Park targets (prefer these over a dedicated issue/review/parking lane)",
  PARK_TARGET_PROSE,
].join("\n");

// A complete, decode-valid, lint-clean worked example the model can pattern-match.
const WORKED_EXAMPLE = `## Worked example of a valid definition object
\`\`\`json
{
  "name": "Example board",
  "lanes": [
    {
      "key": "backlog",
      "name": "Backlog",
      "entry": "manual",
      "actions": [{ "label": "Start work", "to": "working" }]
    },
    {
      "key": "working",
      "name": "Working",
      "entry": "auto",
      "pipeline": [
        { "key": "implement", "type": "agent", "instruction": "Implement the ticket described in {{ticket.title}}: {{ticket.description}}. Keep the change focused." },
        { "key": "review", "type": "agent", "instruction": "Review the implementation for ticket {{ticket.title}}. Your result object must be {\\"verdict\\": \\"approve\\"} or {\\"verdict\\": \\"revise\\"}.", "captureOutput": true }
      ],
      "transitions": [
        { "when": { "and": [{ "==": [{ "var": "steps.review.output.verdict" }, "revise"] }, { "<": [{ "var": "lane.runCount" }, 3] }] }, "to": "working" },
        { "when": { "==": [{ "var": "steps.review.output.verdict" }, "revise"] }, "to": { "park": "waiting", "label": "Needs manual review", "actions": [{ "label": "Retry", "to": "working" }] } },
        { "when": { "==": [{ "var": "steps.review.output.verdict" }, "approve"] }, "to": "done" }
      ],
      "on": {
        "success": { "park": "issue", "actions": [{ "label": "Retry", "to": "working" }] },
        "failure": { "park": "issue", "actions": [{ "label": "Retry", "to": "working" }] },
        "blocked": { "park": "issue", "actions": [{ "label": "Retry", "to": "working" }] }
      }
    },
    { "key": "done", "name": "Done", "entry": "manual", "terminal": true }
  ]
}
\`\`\``;

/**
 * Assemble a from-scratch board-authoring prompt from the board name + the
 * user's description of how they work, then redact any credential-shaped
 * strings that leaked into the free text (defence-in-depth).
 */
export const buildCreatePrompt = ({
  name,
  description,
  agent: _agent,
}: {
  readonly name: string;
  readonly description: string;
  readonly agent: AgentSelection;
}): string => {
  const assembled = [
    "You are designing a brand-new t3 workflow board from scratch.",
    "",
    "A t3 workflow board is a state machine: tickets flow between lanes. Each lane",
    'either accepts tickets manually (`entry: "manual"`) or runs an automated',
    'pipeline of steps when a ticket enters it (`entry: "auto"`). Routing on a',
    "step's outcome (success/failure/blocked) routes the ticket — either to",
    "another lane, or by parking it in place in its current lane.",
    "",
    "## Board name",
    name,
    "",
    "## How the user works with their agent (their words)",
    description,
    "",
    "## Task",
    "Design the lanes and an agent pipeline that matches how this user works.",
    'Agent steps (`type: "agent"`) run a SPECIFIC configured agent that the user',
    "has already chosen — you do NOT need to specify the agent's instance or model;",
    "the server injects them. Just describe each agent step's instruction and",
    "routing.",
    "",
    "ALLOWED step types: only `agent` and `approval`. Manual lanes and manual",
    "actions are also allowed.",
    "FORBIDDEN step types: do NOT emit any `script`, `merge`, or `pullRequest`",
    "steps — the board will be rejected if it contains them.",
    "",
    "The board MUST have at least one reachable terminal lane (a lane marked",
    "`terminal: true`) so tickets can complete.",
    "",
    SHAPE_SPEC,
    "",
    PARK_TARGET_SPEC,
    "",
    WORKED_EXAMPLE,
    "",
    OUTPUT_INSTRUCTION,
  ].join("\n");

  // Defence-in-depth: the description is free text and may contain a pasted
  // token / secret. Strip credential-shaped strings before sending to the LLM.
  return redactSensitiveText(assembled);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Force the user's chosen agent into every agent step of a RAW parsed
 * definition (BEFORE schema decode), overwriting whatever the model emitted.
 * Total/defensive: returns the input unchanged on any non-object/non-array
 * shape (decode will reject it later). Mutates the passed object in place and
 * returns it.
 *
 * `retry.escalate`: rather than re-normalize an LLM-invented escalation target,
 * we simply DELETE the `escalate` key — simpler and safe. The retry policy's
 * `maxAttempts` (and any other fields) are preserved.
 */
export const injectAgentIntoSteps = (rawDef: unknown, agent: AgentSelection): unknown => {
  if (!isRecord(rawDef)) return rawDef;
  const lanes = rawDef.lanes;
  if (!Array.isArray(lanes)) return rawDef;

  const injectedAgent: Record<string, unknown> = {
    instance: agent.instance,
    model: agent.model,
    ...(agent.options === undefined ? {} : { options: agent.options }),
  };

  for (const lane of lanes) {
    if (!isRecord(lane)) continue;
    const pipeline = lane.pipeline;
    if (!Array.isArray(pipeline)) continue;
    for (const step of pipeline) {
      if (!isRecord(step)) continue;
      if (step.type !== "agent") continue;
      // Overwrite (or set) the agent with a fresh object the caller owns.
      step.agent = { ...injectedAgent };
      if (isRecord(step.retry) && "escalate" in step.retry) {
        delete step.retry.escalate;
      }
    }
  }

  return rawDef;
};

/**
 * True if any step in any lane pipeline has a forbidden executable type
 * (`script` / `merge` / `pullRequest`). Defensive on non-object/non-array
 * shapes (returns false). Operates on the RAW object.
 */
export const containsForbiddenStepType = (rawDef: unknown): boolean => {
  if (!isRecord(rawDef)) return false;
  const lanes = rawDef.lanes;
  if (!Array.isArray(lanes)) return false;
  for (const lane of lanes) {
    if (!isRecord(lane)) continue;
    const pipeline = lane.pipeline;
    if (!Array.isArray(pipeline)) continue;
    for (const step of pipeline) {
      if (!isRecord(step)) continue;
      if (typeof step.type === "string" && FORBIDDEN_STEP_TYPES.has(step.type)) {
        return true;
      }
    }
  }
  return false;
};
