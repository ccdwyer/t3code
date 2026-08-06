import {
  CHECKPOINT_OTHER_SENTINEL,
  CheckpointFieldKey,
  type CheckpointForm,
  type CheckpointFormField,
} from "@t3tools/contracts";

/**
 * Turning an agent's `__questions` block into a CheckpointForm.
 *
 * The agent declares questions in a small shape of its own; the server maps
 * them onto the checkpoint form the rest of the system already knows how to
 * persist, render, validate and answer. Nothing here trusts the agent: every
 * bound is re-checked against what CheckpointForm accepts, and anything that
 * does not fit means NO question is raised (see `mapAgentQuestions`), because
 * failing to ask is safe while a half-formed question is not.
 */

/** Reserved key on a captured-output object; see SPEC §2.2. */
export const AGENT_QUESTIONS_KEY = "__questions";

/** Upper bound on how many questions one turn may ask. */
export const MAX_AGENT_QUESTIONS = 10;

/** The decision field appended to every raised form. */
export const QUESTION_DECISION_KEY = "__continue";

/**
 * Keys that resolve to something inherited rather than an answer.
 *
 * Every name on `Object.prototype`, not a hand-picked few: `toString` and
 * `valueOf` are just as dangerous as `__proto__` here, because validation reads
 * the inherited function and an unanswered field looks answered — which makes
 * Cancel, whose whole point is to allow incomplete answers, fail.
 */
const PROTOTYPE_KEYS = new Set<string>([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);

/** Its two option values. Continue is the ONLY value that resumes the agent. */
export const QUESTION_CONTINUE_VALUE = "continue";
export const QUESTION_CANCEL_VALUE = "cancel";

/**
 * Bounds mirrored from the CheckpointForm schema (workflow.ts).
 *
 * Checked here so a violation becomes "the step failed to raise a question"
 * with a readable reason, rather than a schema decode error thrown from inside
 * the commit path.
 */
const MAX_LABEL = 80;
const MAX_OPTION_VALUE = 40;
const MAX_OPTION_LABEL = 48;

export interface AgentQuestionsMapping {
  readonly ok: true;
  readonly form: CheckpointForm;
}

export interface AgentQuestionsRejection {
  readonly ok: false;
  readonly message: string;
}

export type AgentQuestionsResult = AgentQuestionsMapping | AgentQuestionsRejection;

const reject = (message: string): AgentQuestionsRejection => ({
  ok: false,
  message,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asOptions = (
  raw: unknown,
  where: string,
): ReadonlyArray<{ value: string; label: string }> | string => {
  if (!Array.isArray(raw)) return `${where} options must be an array`;
  const options: Array<{ value: string; label: string }> = [];
  for (const entry of raw) {
    // Accept a bare string as shorthand — value and label are the same thing
    // when an agent just lists choices.
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      if (trimmed.length === 0) return `${where} has an empty option`;
      if (trimmed.length > MAX_OPTION_VALUE) return `${where} option "${trimmed}" is too long`;
      if (trimmed === CHECKPOINT_OTHER_SENTINEL)
        return `${where} may not use "${CHECKPOINT_OTHER_SENTINEL}" as an option`;
      options.push({ value: trimmed, label: trimmed });
      continue;
    }
    if (!isRecord(entry)) return `${where} options must be strings or {value,label}`;
    const value = typeof entry.value === "string" ? entry.value.trim() : "";
    // An explicit empty label is NOT the same as an absent one: absent means
    // "use the value", empty violates CheckpointOption's non-empty schema and
    // would reach the event commit as a runtime-invalid form instead of a clear
    // error here.
    const label =
      typeof entry.label === "string" ? entry.label.trim() : entry.label === undefined ? value : "";
    if (value.length === 0) return `${where} has an option with no value`;
    if (label.length === 0) return `${where} has an option with an empty label`;
    if (value.length > MAX_OPTION_VALUE) return `${where} option "${value}" is too long`;
    if (value === CHECKPOINT_OTHER_SENTINEL)
      return `${where} may not use "${CHECKPOINT_OTHER_SENTINEL}" as an option`;
    if (label.length > MAX_OPTION_LABEL) return `${where} option label for "${value}" is too long`;
    options.push({ value, label });
  }
  if (options.length === 0) return `${where} has no options`;
  const seen = new Set<string>();
  for (const option of options) {
    if (seen.has(option.value)) return `${where} repeats option "${option.value}"`;
    seen.add(option.value);
  }
  return options;
};

/**
 * Map a raw `__questions` value onto a CheckpointForm.
 *
 * Returns a rejection rather than throwing: the caller turns it into a step
 * failure with the message attached, so an agent that emits a malformed block
 * gets told why instead of silently having its question dropped.
 */
export const mapAgentQuestions = (raw: unknown): AgentQuestionsResult => {
  if (!Array.isArray(raw)) return reject(`${AGENT_QUESTIONS_KEY} must be an array`);
  if (raw.length === 0) return reject(`${AGENT_QUESTIONS_KEY} is empty`);
  if (raw.length > MAX_AGENT_QUESTIONS) {
    return reject(
      `${AGENT_QUESTIONS_KEY} has ${String(raw.length)} questions (max ${String(MAX_AGENT_QUESTIONS)})`,
    );
  }

  const fields: Array<CheckpointFormField> = [];
  const usedKeys = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const where = `question ${String(index + 1)}`;
    if (!isRecord(entry)) return reject(`${where} must be an object`);

    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    // Mirrors the CheckpointFieldKey pattern (workflow.ts) — checked here so a
    // bad key is a readable rejection rather than a decode failure at commit.
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(key)) {
      return reject(`${where} key "${key}" must match [A-Za-z0-9_-]{1,40}`);
    }
    if (key === QUESTION_DECISION_KEY) {
      return reject(`${where} may not use the reserved key "${QUESTION_DECISION_KEY}"`);
    }
    // `__proto__` matches the key pattern but is not a normal property: writing
    // it on a plain object hits the prototype setter instead of creating an own
    // property, so a validated answer would vanish and the agent would be handed
    // the inherited value. `constructor` and `prototype` are refused with it —
    // none of them are worth the sharp edge.
    if (PROTOTYPE_KEYS.has(key)) {
      return reject(`${where} may not use "${key}" as a key`);
    }
    // CheckpointAnswers is a Record keyed by this, so a duplicate key would let
    // one answer silently serve two questions.
    if (usedKeys.has(key)) return reject(`${where} repeats key "${key}"`);
    usedKeys.add(key);

    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (label.length === 0) return reject(`${where} has no label`);
    if (label.length > MAX_LABEL) return reject(`${where} label is too long`);

    const brandedKey = key as CheckpointFieldKey;

    // `multi` is only ever absent or a boolean. Left unchecked, `"true"`
    // silently produced a single-select and the operator could not give the
    // several answers the agent asked for — a malformed block quietly changing
    // the question's TYPE, which is exactly what this mapper exists to refuse.
    if (entry.multi !== undefined && typeof entry.multi !== "boolean") {
      return reject(`${where} multi must be true or false`);
    }
    if (entry.multi === true && entry.options === undefined) {
      return reject(`${where} asks for several answers but lists no options`);
    }

    if (entry.options === undefined) {
      // No options declared = freeform.
      fields.push({ kind: "text", key: brandedKey, label, required: true });
      continue;
    }

    const options = asOptions(entry.options, where);
    if (typeof options === "string") return reject(options);

    // asOptions guarantees non-empty, which is what NonEmptyArray needs.
    const nonEmpty = options as unknown as readonly [
      { value: string; label: string },
      ...{ value: string; label: string }[],
    ];

    if (entry.multi === true) {
      fields.push({
        kind: "checklist",
        key: brandedKey,
        label,
        items: nonEmpty,
        required: true,
      });
      continue;
    }

    fields.push({
      kind: "select",
      key: brandedKey,
      label,
      options: nonEmpty,
      required: true,
      // A choice question always accepts "none of these" — the user asked for
      // freeform entry whenever no proposed answer fits.
      allowOther: true,
    });
  }

  // The decision field is what the drawer renders as submit buttons, and its
  // outcome is deliberately limited to continuing or cancelling THIS step —
  // an agent-raised question must never choose a route (SPEC §6).
  fields.push({
    kind: "decision",
    key: QUESTION_DECISION_KEY as CheckpointFieldKey,
    label: "Answer",
    options: [
      { value: QUESTION_CONTINUE_VALUE, label: "Continue", outcome: "success" },
      { value: QUESTION_CANCEL_VALUE, label: "Cancel", outcome: "failure" },
    ],
  });

  // The decision field above is unconditional, so `fields` is always non-empty;
  // TS cannot narrow a pushed-to array to NonEmptyArray on its own.
  const nonEmptyFields = fields as unknown as CheckpointForm["fields"];
  return { ok: true, form: { fields: nonEmptyFields } };
};

/**
 * The prompt the operator sees while the step is parked.
 *
 * Built from the questions themselves so the board says what is being asked
 * without having to open the form.
 */
export const questionsWaitingReason = (form: CheckpointForm): string => {
  const asked = form.fields
    .filter((field) => field.kind !== "decision")
    .map((field) => ("label" in field ? field.label : ""))
    .filter((label) => label.length > 0);
  if (asked.length === 0) return "Agent asked a question";
  if (asked.length === 1) return `Agent asked: ${asked[0] ?? ""}`;
  return `Agent asked ${String(asked.length)} questions: ${asked.join(" · ")}`;
};
