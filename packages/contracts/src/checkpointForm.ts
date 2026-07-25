import type {
  CheckpointAnswers,
  CheckpointForm,
  CheckpointFormField,
  CheckpointOutcome,
} from "./workflow.ts";

/** Stable message fragments clients match on, like PARK_ACTION_DRIFT_MESSAGES. */
export const CHECKPOINT_MESSAGES = {
  noOpenWait: "no open checkpoint for this step",
  upgradeRequired: "this checkpoint requires a newer client",
  invalidFormSnapshot: "checkpoint form snapshot is invalid",
} as const;

export interface CheckpointSubmission {
  readonly decision?: string | undefined;
  readonly answers?: CheckpointAnswers | undefined;
}

export interface CheckpointValidationOk {
  readonly ok: true;
  readonly outcome: CheckpointOutcome;
  readonly decision?: string | undefined;
  readonly answers: CheckpointAnswers;
}

export interface CheckpointValidationError {
  readonly ok: false;
  readonly message: string;
}

export type CheckpointValidation = CheckpointValidationOk | CheckpointValidationError;

const decisionField = (form: CheckpointForm) =>
  form.fields.find(
    (field): field is Extract<CheckpointFormField, { kind: "decision" }> =>
      field.kind === "decision",
  );

const asStringArray = (value: unknown): ReadonlyArray<string> | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as ReadonlyArray<string>)
    : null;

/**
 * Validate a reviewer's submission against the form SNAPSHOT taken when the wait
 * was created — never the current board definition, which may have been edited
 * while the ticket sat waiting.
 *
 * Returns the routing outcome the chosen decision maps to, so the caller does
 * not re-derive it and cannot disagree with what the reviewer was shown.
 *
 * `requiredness is only enforced for a SUCCESS outcome`: a reviewer rejecting
 * something must not be blocked by an unfilled checklist that only matters when
 * approving. That asymmetry is deliberate — the alternative traps a reviewer who
 * is trying to say "no".
 */
export const validateCheckpointSubmission = (
  form: CheckpointForm | undefined,
  submission: CheckpointSubmission,
  /** Used when the form has no decision field (a formless approval). */
  fallbackOutcome: CheckpointOutcome,
): CheckpointValidation => {
  if (form === undefined) {
    return { ok: true, outcome: fallbackOutcome, answers: {} };
  }

  const answers: Record<string, string | ReadonlyArray<string>> = {};
  const submitted = submission.answers ?? {};

  const decision = decisionField(form);
  let outcome: CheckpointOutcome = fallbackOutcome;
  if (decision !== undefined) {
    if (submission.decision === undefined) {
      return { ok: false, message: "a decision is required for this checkpoint" };
    }
    const chosen = decision.options.find((option) => option.value === submission.decision);
    if (chosen === undefined) {
      return {
        ok: false,
        message: `decision "${submission.decision}" is not an option on this checkpoint`,
      };
    }
    outcome = chosen.outcome;
    answers[decision.key] = chosen.value;
  }

  for (const field of form.fields) {
    if (field.kind === "decision") {
      continue;
    }
    const raw = submitted[field.key];
    const mustBeFilled = field.required === true && outcome === "success";

    if (field.kind === "text") {
      if (raw !== undefined && typeof raw !== "string") {
        return { ok: false, message: `answer for "${field.key}" must be text` };
      }
      const text = (raw ?? "").trim();
      if (text.length === 0) {
        if (mustBeFilled) {
          return { ok: false, message: `"${field.label}" is required` };
        }
        continue;
      }
      const max = field.maxLength ?? 2000;
      if (text.length > max) {
        return {
          ok: false,
          message: `"${field.label}" is longer than the ${String(max)} characters this field allows`,
        };
      }
      answers[field.key] = text;
      continue;
    }

    if (field.kind === "select") {
      if (raw === undefined || raw === "") {
        if (mustBeFilled) {
          return { ok: false, message: `"${field.label}" is required` };
        }
        continue;
      }
      if (typeof raw !== "string") {
        return { ok: false, message: `answer for "${field.key}" must be a single option` };
      }
      if (!field.options.some((option) => option.value === raw)) {
        return { ok: false, message: `"${raw}" is not an option for "${field.label}"` };
      }
      answers[field.key] = raw;
      continue;
    }

    // checklist
    const checked = raw === undefined ? [] : asStringArray(raw);
    if (checked === null) {
      return { ok: false, message: `answer for "${field.key}" must be a list of checked items` };
    }
    const unknown = checked.find((value) => !field.items.some((item) => item.value === value));
    if (unknown !== undefined) {
      return { ok: false, message: `"${unknown}" is not an item of "${field.label}"` };
    }
    // De-duplicate: a client that sends the same box twice must not make
    // requireAll pass on a partially checked list.
    const unique = [...new Set(checked)];
    if (outcome === "success") {
      if (field.requireAll === true && unique.length !== field.items.length) {
        return { ok: false, message: `every item of "${field.label}" must be checked` };
      }
      if (field.required === true && unique.length === 0) {
        return { ok: false, message: `at least one item of "${field.label}" must be checked` };
      }
    }
    if (unique.length > 0) {
      answers[field.key] = unique;
    }
  }

  // Answers for fields the snapshot does not declare are dropped rather than
  // rejected: a client one version ahead should not be able to smuggle unbounded
  // keys into the event log or into routing.
  return {
    ok: true,
    outcome,
    // Echo the decision ONLY when the form actually has a decision field. A form
    // without one has no membership check to validate against, so echoing a
    // caller-supplied string would be an unbounded side channel straight into
    // the event log.
    ...(decision === undefined || submission.decision === undefined
      ? {}
      : { decision: submission.decision }),
    answers: answers as CheckpointAnswers,
  };
};
