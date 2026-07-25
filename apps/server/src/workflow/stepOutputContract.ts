/**
 * Pure step-output contract validation + prompt rendering.
 * Used by RealStepExecutor, recovery, and lint (render size).
 */
import type { StepOutputContract } from "@t3tools/contracts";

export type OutputDiagnostic = {
  readonly output?: object;
  readonly rawBlock?: string;
  readonly failure?: "no_block" | "parse_error" | "not_object";
};

export const CONTRACT_INSTRUCTION_MAX_CHARS = 4_000;
export const MAX_VALIDATION_ERRORS = 20;
export const MAX_ERROR_CHARS = 500;
export const MAX_CONTRACT_FIELDS = 24;
export const MAX_ENUM_VALUES = 24;

const BANNED_FIELD_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const truncate = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

const typeLabel = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

export const validateStepOutput = (
  contract: StepOutputContract,
  diagnostic: OutputDiagnostic,
): ReadonlyArray<string> => {
  const errors: string[] = [];
  const push = (msg: string) => {
    if (errors.length < MAX_VALIDATION_ERRORS) {
      errors.push(truncate(msg, MAX_ERROR_CHARS));
    }
  };

  const fieldEntries = Object.entries(contract.fields);
  if (fieldEntries.length === 0) {
    push("contract declares no fields");
    return errors;
  }

  if (diagnostic.failure === "no_block" || diagnostic.output === undefined) {
    if (diagnostic.failure === "parse_error") {
      push("fenced json block failed to parse");
    } else if (diagnostic.failure === "not_object") {
      push("fenced json block is not a plain object");
    } else if (diagnostic.failure === "no_block" || diagnostic.output === undefined) {
      push("no fenced json block found");
    }
    return errors;
  }

  const output = diagnostic.output as Record<string | symbol, unknown>;
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    push("fenced json block is not a plain object");
    return errors;
  }

  for (const [name, field] of fieldEntries) {
    if (BANNED_FIELD_NAMES.has(name)) {
      push(`field "${name}": banned field name`);
      continue;
    }
    const required = field.required !== false;
    const has = Object.hasOwn(output, name);
    if (!has) {
      if (required) {
        push(`field "${name}": required but missing`);
      }
      continue;
    }
    const value = output[name];
    if (value === null) {
      push(`field "${name}": expected ${field.type}, got null`);
      continue;
    }
    switch (field.type) {
      case "string":
        if (typeof value !== "string") {
          push(`field "${name}": expected string, got ${typeLabel(value)}`);
        }
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          push(
            `field "${name}": expected finite number, got ${
              typeof value === "number" ? String(value) : typeLabel(value)
            }`,
          );
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          push(`field "${name}": expected boolean, got ${typeLabel(value)}`);
        }
        break;
      case "enum": {
        const values = field.values ?? [];
        if (values.length === 0) {
          push(`field "${name}": enum has no allowed values`);
        } else if (typeof value !== "string" || !values.includes(value as never)) {
          push(
            `field "${name}": expected one of ${JSON.stringify([...values])}, got ${JSON.stringify(value)}`,
          );
        }
        break;
      }
      case "string[]":
        if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
          push(`field "${name}": expected string[], got ${typeLabel(value)}`);
        }
        break;
      default:
        push(`field "${name}": unknown type`);
    }
  }

  if (contract.allowUnknown === false) {
    for (const key of Object.keys(output)) {
      if (!Object.hasOwn(contract.fields, key)) {
        push(`unexpected field "${key}"`);
      }
    }
  }

  return errors;
};

/** Compact human-readable contract shape for agent instructions. */
export const renderContractInstruction = (contract: StepOutputContract): string => {
  const parts: string[] = [];
  for (const [name, field] of Object.entries(contract.fields)) {
    const optional = field.required === false ? "?" : "";
    let typeStr: string;
    if (field.type === "enum") {
      const vals = (field.values ?? []).map((v) => JSON.stringify(v)).join(" | ");
      typeStr = vals.length > 0 ? vals : "enum";
    } else if (field.type === "string[]") {
      typeStr = "string[]";
    } else {
      typeStr = field.type;
    }
    parts.push(`${name}${optional}: ${typeStr}`);
  }
  const body = `{ ${parts.join(", ")} }`;
  const prefix = "The json object must match: ";
  const full = `${prefix}${body}`;
  if (full.length <= CONTRACT_INSTRUCTION_MAX_CHARS) {
    return full;
  }
  return `${full.slice(0, CONTRACT_INSTRUCTION_MAX_CHARS - 20)}…[truncated]`;
};

/**
 * Self-contained repair prompt. Returns null when even the minimal fixed
 * parts cannot fit `maxInputChars`.
 */
export const renderRepairPrompt = (
  contract: StepOutputContract,
  diagnostic: OutputDiagnostic,
  errors: ReadonlyArray<string>,
  maxInputChars: number,
): string | null => {
  const capture =
    "End your final message with a single fenced ```json block containing your result object.";
  const header =
    "Your previous output did not match the required contract. Fix the errors and emit only a valid fenced json object.";
  let contractNote = renderContractInstruction(contract);
  let errorList = errors.map((e, i) => `${i + 1}. ${e}`).join("\n");
  let raw =
    diagnostic.rawBlock !== undefined
      ? `Invalid output was:\n\`\`\`json\n${diagnostic.rawBlock}\n\`\`\``
      : "No fenced json block was found.";

  const assemble = () => [header, contractNote, "Errors:", errorList, raw, capture].join("\n\n");

  let prompt = assemble();
  if (prompt.length <= maxInputChars) {
    return prompt;
  }

  // Truncation order: raw block → errors → contract.
  raw = "Invalid output omitted (budget).";
  prompt = assemble();
  if (prompt.length <= maxInputChars) {
    return prompt;
  }

  errorList = errors
    .slice(0, 3)
    .map((e, i) => `${i + 1}. ${truncate(e, 80)}`)
    .join("\n");
  prompt = assemble();
  if (prompt.length <= maxInputChars) {
    return prompt;
  }

  contractNote = "Contract details omitted (budget).";
  prompt = assemble();
  if (prompt.length <= maxInputChars) {
    return prompt;
  }

  const minimal = `${header}\n\n${capture}`;
  if (minimal.length > maxInputChars) {
    return null;
  }
  return minimal;
};

/** Lint helpers — field/enum caps and banned names. */
export const lintContractShape = (contract: StepOutputContract): ReadonlyArray<string> => {
  const errors: string[] = [];
  const entries = Object.entries(contract.fields);
  if (entries.length === 0) {
    errors.push("contract must declare at least one field");
  }
  if (entries.length > MAX_CONTRACT_FIELDS) {
    errors.push(`contract exceeds ${MAX_CONTRACT_FIELDS} fields`);
  }
  for (const [name, field] of entries) {
    if (BANNED_FIELD_NAMES.has(name)) {
      errors.push(`field "${name}" is banned`);
    }
    if (field.type === "enum") {
      const values = field.values ?? [];
      if (values.length === 0) {
        errors.push(`field "${name}": enum requires values`);
      }
      if (values.length > MAX_ENUM_VALUES) {
        errors.push(`field "${name}": exceeds ${MAX_ENUM_VALUES} enum values`);
      }
      const seen = new Set<string>();
      for (const v of values) {
        const t = v.trim();
        if (seen.has(t)) {
          errors.push(`field "${name}": duplicate enum value ${JSON.stringify(t)}`);
        }
        seen.add(t);
      }
    } else if (field.values !== undefined) {
      errors.push(`field "${name}": values only allowed on enum`);
    }
  }
  if (renderContractInstruction(contract).length > CONTRACT_INSTRUCTION_MAX_CHARS) {
    errors.push(`rendered contract instruction exceeds ${CONTRACT_INSTRUCTION_MAX_CHARS} chars`);
  }
  return errors;
};
