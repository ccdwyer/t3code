import * as NodeCrypto from "node:crypto";

import type { WorkflowParkTarget } from "@t3tools/contracts";

// The `src` of a park origin — which routing site produced the park decision.
// Mirrors the JSON shape documented in
// docs/superpowers/specs/2026-07-22-workflow-substates-design.md:
//   { "src": "lane_on" | "transition" | "step" | "event",
//     "key"?, "stepKey"?, "name"?, "fp" }
export type ParkOriginSource = "lane_on" | "transition" | "step" | "event";

// The parsed, typed form of a `park_origin` JSON string. Index is deliberately
// absent: identity is the fingerprint, never a positional path (a transition
// inserted above would silently rebind an index-based origin).
export interface ParkOrigin {
  readonly src: ParkOriginSource;
  // Routing key ("success" | "failure" | "blocked") for lane_on / step origins.
  readonly key?: string;
  // Step key for step origins.
  readonly stepKey?: string;
  // Event name for event origins.
  readonly name?: string;
  // First 16 hex chars of SHA-256 of the canonical park target.
  readonly fp: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Deterministic JSON with recursively sorted object keys. `undefined` (e.g. an
// absent optional `label`/`hint`) canonicalizes to `null`, so a target with the
// key absent and one with the key explicitly `undefined` hash identically.
const canonicalJson = (value: unknown): string => {
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return JSON.stringify(value) ?? "null";
};

// A stable identity for a park target: the fingerprint changes if and only if
// the park substate, label, or any action changes. Re-resolution at read/invoke
// time compares this against the candidates in the *current* definition — a
// match survives reordering, any edit fails closed.
export const parkTargetFingerprint = (target: WorkflowParkTarget): string => {
  const canonical = canonicalJson({
    park: target.park,
    label: target.label,
    actions: target.actions,
  });
  return NodeCrypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
};

export interface BuildParkOriginInput {
  readonly src: ParkOriginSource;
  readonly target: WorkflowParkTarget;
  readonly key?: string;
  readonly stepKey?: string;
  readonly name?: string;
}

// Serializes a park origin to the spec's JSON string, carrying the fingerprint
// of the target so re-resolution can find it again.
export const buildParkOrigin = (input: BuildParkOriginInput): string => {
  const origin: ParkOrigin = {
    src: input.src,
    ...(input.key === undefined ? {} : { key: input.key }),
    ...(input.stepKey === undefined ? {} : { stepKey: input.stepKey }),
    ...(input.name === undefined ? {} : { name: input.name }),
    fp: parkTargetFingerprint(input.target),
  };
  return JSON.stringify(origin);
};

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

// Parses a stored `park_origin` string back to a typed origin, or null when the
// JSON is malformed or missing the required `src` / `fp` fields.
export const parseParkOrigin = (json: string): ParkOrigin | null => {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const src = value.src;
  if (src !== "lane_on" && src !== "transition" && src !== "step" && src !== "event") {
    return null;
  }
  const fp = value.fp;
  if (typeof fp !== "string") {
    return null;
  }
  const key = optionalString(value.key);
  const stepKey = optionalString(value.stepKey);
  const name = optionalString(value.name);
  return {
    src,
    ...(key === undefined ? {} : { key }),
    ...(stepKey === undefined ? {} : { stepKey }),
    ...(name === undefined ? {} : { name }),
    fp,
  };
};
