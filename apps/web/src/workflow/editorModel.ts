import { LaneKey, StepKey, WorkflowDefinition } from "@t3tools/contracts";
import type {
  WorkflowDefinitionEncoded,
  WorkflowLintError,
  WorkflowParkSubstate,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

type WorkflowLaneEncoded = WorkflowDefinitionEncoded["lanes"][number];
type WorkflowStepEncoded = NonNullable<WorkflowLaneEncoded["pipeline"]>[number];
type WorkflowStepType = WorkflowStepEncoded["type"];
type LaneRoutingKind = "success" | "failure" | "blocked";
type WorkflowEditorPendingSaveSource = "revert";
type Mutable<T> =
  T extends ReadonlyArray<infer U>
    ? Array<Mutable<U>>
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;
type MutableWorkflowDefinition = Mutable<WorkflowDefinitionEncoded>;
type MutableWorkflowLane = Mutable<WorkflowLaneEncoded>;
type MutableWorkflowStep = Mutable<WorkflowStepEncoded>;
// Route target as it appears on a mutable, encoded lane — a bare lane-key
// string, or a park target object (park objects pass through untouched; no
// stored definition can contain one yet, see plan Task 1b).
type MutableWorkflowRouteTarget = NonNullable<MutableWorkflowLane["transitions"]>[number]["to"];
// The park-object arm of the route-target union (encoded, mutable): everything
// that is not a bare lane-key string. Its `actions` decode as a non-empty array.
type MutableWorkflowParkTarget = Exclude<MutableWorkflowRouteTarget, string>;
type MutableWorkflowLaneTransition = NonNullable<MutableWorkflowLane["transitions"]>[number];
type MutableWorkflowLaneEvent = NonNullable<MutableWorkflowLane["onEvent"]>[number];
// Same route-target shape as it reads on the real (readonly, tuple-preserving)
// Encoded lane — what RoutingEditor/StepFields pass in from `lane.on`/`step.on`.
export type WorkflowRouteTargetEncoded = NonNullable<
  WorkflowLaneEncoded["transitions"]
>[number]["to"];
// The park arm as it reads on the readonly Encoded lane — the sub-editor's prop.
export type WorkflowParkTargetEncoded = Exclude<WorkflowRouteTargetEncoded, string>;

export const PARK_SELECT_VALUES = { issue: "__park_issue", waiting: "__park_waiting" } as const;

// True when a route target parks in place (a park object) rather than moving
// the ticket to a bare lane key.
export const isParkRouteTarget = (
  target: WorkflowRouteTargetEncoded | MutableWorkflowRouteTarget | undefined,
): target is WorkflowParkTargetEncoded => typeof target === "object" && target !== null;

// Value a route <select> shows for a target: the lane key for a bare move, or
// a namespaced park sentinel for a park target (distinct from any lane key so
// selecting one is unambiguous). Undefined ("No route") when unset.
export const routeTargetSelectValue = (
  target: WorkflowRouteTargetEncoded | MutableWorkflowRouteTarget | undefined,
): string | undefined => {
  if (target === undefined) {
    return undefined;
  }
  if (typeof target === "string") {
    return target;
  }
  return target.park === "issue" ? PARK_SELECT_VALUES.issue : PARK_SELECT_VALUES.waiting;
};

// A route <select> can resolve to: clearing the route, a bare lane move, or a
// park target of a given substate.
export type RouteSelectChoice =
  | { readonly kind: "clear" }
  | { readonly kind: "lane"; readonly laneKey: string }
  | { readonly kind: "park"; readonly substate: WorkflowParkSubstate };

export const parseRouteSelectValue = (value: string): RouteSelectChoice => {
  if (value === "") {
    return { kind: "clear" };
  }
  if (value === PARK_SELECT_VALUES.issue) {
    return { kind: "park", substate: "issue" };
  }
  if (value === PARK_SELECT_VALUES.waiting) {
    return { kind: "park", substate: "waiting" };
  }
  return { kind: "lane", laneKey: value };
};

// The four routing positions a target lives at. The park mutators and the
// shared editor field address any of them uniformly.
export type RouteTargetPath =
  | { readonly site: "laneOn"; readonly laneKey: string; readonly kind: LaneRoutingKind }
  | { readonly site: "transition"; readonly laneKey: string; readonly index: number }
  | { readonly site: "laneEvent"; readonly laneKey: string; readonly index: number }
  | {
      readonly site: "stepOn";
      readonly laneKey: string;
      readonly stepKey: string;
      readonly kind: LaneRoutingKind;
    };

export type RouteTargetKind = "lane" | "park-issue" | "park-waiting";

export interface WorkflowEditorModel {
  readonly definition: WorkflowDefinitionEncoded;
  readonly baselineDefinition: WorkflowDefinitionEncoded;
  readonly dirty: boolean;
  readonly lintErrors: ReadonlyArray<WorkflowLintError>;
  readonly pendingSaveSource?: WorkflowEditorPendingSaveSource | undefined;
}

export type WorkflowEditorSelection =
  | { readonly kind: "lane"; readonly laneKey: string }
  | { readonly kind: "step"; readonly laneKey: string; readonly stepKey: string }
  | { readonly kind: "transition"; readonly laneKey: string; readonly index: number };

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const decodeWorkflowDefinition = Schema.decodeUnknownExit(WorkflowDefinition);
const encodeWorkflowDefinition = Schema.encodeSync(WorkflowDefinition);

const uniqueKey = (existing: ReadonlySet<string>, base: string): string => {
  if (!existing.has(base)) {
    return base;
  }

  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
};

const allStepKeys = (definition: MutableWorkflowDefinition): ReadonlySet<string> =>
  new Set(
    definition.lanes.flatMap((lane) => (lane.pipeline ?? []).map((step) => step.key as string)),
  );

const compactOn = (on: MutableWorkflowLane["on"] | MutableWorkflowStep["on"] | undefined) => {
  if (!on) {
    return undefined;
  }
  const next = { ...on };
  if (next.success === undefined) {
    delete next.success;
  }
  if (next.failure === undefined) {
    delete next.failure;
  }
  if (next.blocked === undefined) {
    delete next.blocked;
  }
  return Object.keys(next).length === 0 ? undefined : next;
};

const mutateDefinition = (
  model: WorkflowEditorModel,
  mutate: (definition: MutableWorkflowDefinition) => void,
): WorkflowEditorModel => {
  const definition = cloneJson(model.definition) as MutableWorkflowDefinition;
  mutate(definition);
  return {
    ...model,
    definition: definition as WorkflowDefinitionEncoded,
    dirty: true,
    lintErrors: [],
  };
};

const updateLane = (
  model: WorkflowEditorModel,
  laneKey: string,
  update: (lane: MutableWorkflowLane, definition: MutableWorkflowDefinition) => void,
): WorkflowEditorModel =>
  mutateDefinition(model, (definition) => {
    const lane = definition.lanes.find((candidate) => candidate.key === laneKey);
    if (lane) {
      update(lane, definition);
    }
  });

export const createWorkflowEditorModel = (
  definition: WorkflowDefinitionEncoded,
): WorkflowEditorModel => ({
  definition: cloneJson(definition),
  baselineDefinition: cloneJson(definition),
  dirty: false,
  lintErrors: [],
});

export const normalizeSelection = (
  model: WorkflowEditorModel,
  selection: WorkflowEditorSelection | null,
): WorkflowEditorSelection | null => {
  if (!selection) {
    return null;
  }

  const lane = model.definition.lanes.find(
    (candidate) => String(candidate.key) === selection.laneKey,
  );
  if (!lane) {
    return null;
  }

  if (selection.kind === "lane") {
    return selection;
  }

  if (selection.kind === "step") {
    return (lane.pipeline ?? []).some((step) => String(step.key) === selection.stepKey)
      ? selection
      : { kind: "lane", laneKey: selection.laneKey };
  }

  const transitions = lane.transitions ?? [];
  const transition = selection.index >= 0 ? transitions[selection.index] : undefined;
  return transition ? selection : { kind: "lane", laneKey: selection.laneKey };
};

export const adjustSelectionAfterTransitionRemoval = (
  selection: WorkflowEditorSelection | null,
  laneKey: string,
  removedIndex: number,
): WorkflowEditorSelection | null => {
  if (selection?.kind !== "transition" || selection.laneKey !== laneKey) {
    return selection;
  }
  if (removedIndex < selection.index) {
    return { ...selection, index: selection.index - 1 };
  }
  if (removedIndex === selection.index) {
    return { kind: "lane", laneKey: selection.laneKey };
  }
  return selection;
};

export const setWorkflowLintErrors = (
  model: WorkflowEditorModel,
  lintErrors: ReadonlyArray<WorkflowLintError>,
): WorkflowEditorModel => ({ ...model, lintErrors: [...lintErrors] });

export const lintErrorKey = (lintError: WorkflowLintError): string =>
  [
    lintError.code,
    lintError.message,
    lintError.laneKey,
    lintError.stepKey,
    lintError.transitionIndex,
  ]
    .filter((part) => part !== undefined)
    .join(":");

export const formatVersionTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

export const markWorkflowSaved = (
  model: WorkflowEditorModel,
  definition: WorkflowDefinitionEncoded,
): WorkflowEditorModel => ({
  ...model,
  definition: cloneJson(definition),
  baselineDefinition: cloneJson(definition),
  dirty: false,
  lintErrors: [],
  pendingSaveSource: undefined,
});

export const markWorkflowSavedIfUnchanged = (
  model: WorkflowEditorModel,
  submittedDefinition: WorkflowDefinitionEncoded,
  savedDefinition: WorkflowDefinitionEncoded,
): WorkflowEditorModel => {
  if (JSON.stringify(model.definition) === JSON.stringify(submittedDefinition)) {
    return markWorkflowSaved(model, savedDefinition);
  }

  return {
    ...model,
    baselineDefinition: cloneJson(savedDefinition),
    dirty: true,
    lintErrors: [],
    pendingSaveSource: undefined,
  };
};

export const discardWorkflowChanges = (model: WorkflowEditorModel): WorkflowEditorModel => ({
  ...model,
  definition: cloneJson(model.baselineDefinition),
  dirty: false,
  lintErrors: [],
  pendingSaveSource: undefined,
});

export const loadRevertedDefinition = (
  model: WorkflowEditorModel,
  versionDefinition: WorkflowDefinitionEncoded,
): WorkflowEditorModel => ({
  ...model,
  definition: cloneJson(versionDefinition),
  dirty: true,
  lintErrors: [],
  pendingSaveSource: "revert",
});

const sortJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, child]) => [key, sortJsonValue(child)]),
    );
  }
  return value;
};

export const canonicalizeDefinitionJson = (definition: WorkflowDefinitionEncoded): string => {
  const decoded = decodeWorkflowDefinition(definition);
  const canonicalValue = Exit.isSuccess(decoded)
    ? encodeWorkflowDefinition(decoded.value)
    : definition;
  return `${JSON.stringify(sortJsonValue(canonicalValue), null, 2)}\n`;
};

export const addLane = (model: WorkflowEditorModel): WorkflowEditorModel =>
  mutateDefinition(model, (definition) => {
    const key = uniqueKey(new Set(definition.lanes.map((lane) => lane.key as string)), "new-lane");
    definition.lanes.push({ key: LaneKey.make(key), name: "New lane", entry: "manual" });
  });

// Rewrite a route target after `removedLaneKey` is deleted. A bare target
// pointing at the removed lane, or a park whose actions all pointed at it,
// collapses to `undefined` — the caller then drops that routing position
// (clears `on.*`, removes the transition/event) exactly as it does for a bare
// dangling target. A park that keeps at least one action survives with the
// dangling actions pruned.
const resolveTargetAfterLaneRemoval = (
  target: MutableWorkflowRouteTarget | undefined,
  removedLaneKey: string,
): MutableWorkflowRouteTarget | undefined => {
  if (target === undefined) {
    return undefined;
  }
  if (typeof target === "string") {
    return target === removedLaneKey ? undefined : target;
  }
  const actions = target.actions.filter((action) => action.to !== removedLaneKey);
  return actions.length === 0 ? undefined : { ...target, actions };
};

export const removeLane = (model: WorkflowEditorModel, laneKey: string): WorkflowEditorModel =>
  mutateDefinition(model, (definition) => {
    definition.lanes = definition.lanes.filter((lane) => lane.key !== laneKey);
    for (const lane of definition.lanes) {
      lane.on = compactOn({
        success: resolveTargetAfterLaneRemoval(lane.on?.success, laneKey),
        failure: resolveTargetAfterLaneRemoval(lane.on?.failure, laneKey),
        blocked: resolveTargetAfterLaneRemoval(lane.on?.blocked, laneKey),
      });
      lane.transitions = lane.transitions
        ?.map((transition): MutableWorkflowLaneTransition | undefined => {
          const to = resolveTargetAfterLaneRemoval(transition.to, laneKey);
          return to === undefined ? undefined : { ...transition, to };
        })
        .filter(
          (transition): transition is MutableWorkflowLaneTransition => transition !== undefined,
        );
      if (lane.transitions?.length === 0) {
        delete lane.transitions;
      }
      lane.actions = lane.actions?.filter((action) => action.to !== laneKey);
      if (lane.actions?.length === 0) {
        delete lane.actions;
      }
      lane.onEvent = lane.onEvent
        ?.map((event): MutableWorkflowLaneEvent | undefined => {
          const to = resolveTargetAfterLaneRemoval(event.to, laneKey);
          return to === undefined ? undefined : { ...event, to };
        })
        .filter((event): event is MutableWorkflowLaneEvent => event !== undefined);
      if (lane.onEvent?.length === 0) {
        delete lane.onEvent;
      }
      for (const step of lane.pipeline ?? []) {
        step.on = compactOn({
          success: resolveTargetAfterLaneRemoval(step.on?.success, laneKey),
          failure: resolveTargetAfterLaneRemoval(step.on?.failure, laneKey),
          blocked: resolveTargetAfterLaneRemoval(step.on?.blocked, laneKey),
        });
      }
      // Drop dangling SLA escalateTo; leave budget-only SLA for the editor to
      // re-target (Phase A requires a target; lint flags until fixed).
      if (lane.sla?.escalateTo === laneKey) {
        const { escalateTo: _removed, ...rest } = lane.sla;
        lane.sla = rest as WorkflowLaneEncoded["sla"];
      }
    }
  });

export const renameLane = (
  model: WorkflowEditorModel,
  laneKey: string,
  name: string,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.name = name;
  });

export const setLaneEntry = (
  model: WorkflowEditorModel,
  laneKey: string,
  entry: WorkflowLaneEncoded["entry"],
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.entry = entry;
  });

export const setLaneWipLimit = (
  model: WorkflowEditorModel,
  laneKey: string,
  wipLimit: number | undefined,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    if (wipLimit === undefined) {
      delete lane.wipLimit;
    } else {
      lane.wipLimit = wipLimit;
    }
  });

/** Set or replace a lane's SLA policy. Pass `escalateTo` undefined for budget-only (Phase B). */
export const setLaneSla = (
  model: WorkflowEditorModel,
  laneKey: string,
  sla: { readonly budget: string; readonly escalateTo?: string | undefined },
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.sla = {
      budget: sla.budget,
      ...(sla.escalateTo === undefined ? {} : { escalateTo: sla.escalateTo as never }),
    } as WorkflowLaneEncoded["sla"];
  });

export const clearLaneSla = (model: WorkflowEditorModel, laneKey: string): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    delete lane.sla;
  });

export const setLaneTerminal = (
  model: WorkflowEditorModel,
  laneKey: string,
  terminal: boolean | undefined,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    if (terminal === undefined) {
      delete lane.terminal;
    } else {
      lane.terminal = terminal;
    }
  });

export type LaneActionEncoded = NonNullable<WorkflowLaneEncoded["actions"]>[number];

export const addLaneAction = (model: WorkflowEditorModel, laneKey: string): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane, definition) => {
    const to = definition.lanes.find((candidate) => candidate.key !== laneKey)?.key ?? lane.key;
    lane.actions = [...(lane.actions ?? []), { label: "New action", to } as LaneActionEncoded];
  });

export const updateLaneAction = (
  model: WorkflowEditorModel,
  laneKey: string,
  index: number,
  patch: Partial<LaneActionEncoded>,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    if (index < 0 || index >= (lane.actions?.length ?? 0)) {
      return;
    }
    lane.actions = (lane.actions ?? []).map((action, candidateIndex) => {
      if (candidateIndex !== index) {
        return action;
      }
      const next = { ...action, ...patch };
      if (next.hint !== undefined && next.hint.length === 0) {
        delete next.hint;
      }
      return next;
    });
  });

export const removeLaneAction = (
  model: WorkflowEditorModel,
  laneKey: string,
  index: number,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    const next = (lane.actions ?? []).filter((_, candidateIndex) => candidateIndex !== index);
    if (next.length === 0) {
      delete lane.actions;
    } else {
      lane.actions = next;
    }
  });

export const setLaneColor = (
  model: WorkflowEditorModel,
  laneKey: string,
  color: string | undefined,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    if (color === undefined) {
      delete lane.color;
    } else {
      lane.color = color;
    }
  });

type MutableAgentSelection = Extract<MutableWorkflowStep, { type: "agent" }>["agent"];

const defaultAgent = (definition: MutableWorkflowDefinition): MutableAgentSelection => {
  for (const lane of definition.lanes) {
    for (const step of lane.pipeline ?? []) {
      if (step.type === "agent") {
        return cloneJson(step.agent) as MutableAgentSelection;
      }
    }
  }
  return { instance: "missing-provider", model: "missing-model" };
};

const newStep = (
  definition: MutableWorkflowDefinition,
  type: WorkflowStepType,
): MutableWorkflowStep => {
  const key = uniqueKey(allStepKeys(definition), type);
  if (type === "agent") {
    return {
      key: StepKey.make(key),
      type,
      agent: defaultAgent(definition),
      instruction: "",
    };
  }
  if (type === "script") {
    return { key: StepKey.make(key), type, run: "true" };
  }
  if (type === "pullRequest") {
    return { key: StepKey.make(key), type, action: "open" };
  }
  return { key: StepKey.make(key), type };
};

export const addStep = (
  model: WorkflowEditorModel,
  laneKey: string,
  type: WorkflowStepType,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane, definition) => {
    lane.pipeline = [...(lane.pipeline ?? []), newStep(definition, type)];
  });

export const removeStep = (
  model: WorkflowEditorModel,
  laneKey: string,
  stepKey: string,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.pipeline = lane.pipeline?.filter((step) => step.key !== stepKey);
    if (lane.pipeline?.length === 0) {
      delete lane.pipeline;
    }
  });

export const reorderStep = (
  model: WorkflowEditorModel,
  laneKey: string,
  from: number,
  to: number,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    const pipeline = [...(lane.pipeline ?? [])];
    if (from < 0 || from >= pipeline.length || to < 0 || to >= pipeline.length) {
      return;
    }
    const [step] = pipeline.splice(from, 1);
    if (!step) {
      return;
    }
    pipeline.splice(to, 0, step);
    lane.pipeline = pipeline;
  });

const applyPatch = <T extends Record<string, unknown>>(target: T, patch: Partial<T>): T => {
  const next = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete next[key];
    } else {
      next[key as keyof T] = value as T[keyof T];
    }
  }
  return next;
};

export const updateStep = (
  model: WorkflowEditorModel,
  laneKey: string,
  stepKey: string,
  patch: Partial<WorkflowStepEncoded>,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.pipeline = lane.pipeline?.map((step) =>
      step.key === stepKey
        ? (applyPatch(step as Record<string, unknown>, patch) as MutableWorkflowStep)
        : step,
    );
  });

export const setLaneOn = (
  model: WorkflowEditorModel,
  laneKey: string,
  kind: LaneRoutingKind,
  target: MutableWorkflowRouteTarget | undefined,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.on = compactOn({
      ...lane.on,
      [kind]:
        target === undefined
          ? undefined
          : typeof target === "string"
            ? LaneKey.make(target)
            : target,
    });
  });

export const addTransition = (model: WorkflowEditorModel, laneKey: string): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane, definition) => {
    const to =
      definition.lanes.find((candidate) => candidate.key !== laneKey)?.key ?? LaneKey.make(laneKey);
    lane.transitions = [...(lane.transitions ?? []), { when: { var: "pipeline.result" }, to }];
  });

export const updateTransition = (
  model: WorkflowEditorModel,
  laneKey: string,
  index: number,
  patch: { readonly when?: unknown; readonly to?: MutableWorkflowRouteTarget },
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    if (!lane.transitions?.[index]) {
      return;
    }
    const current = lane.transitions[index];
    // patch.to may be a bare lane key or a park target object — pass either
    // through untouched (no stored definition can contain a park target yet,
    // see plan Task 1b; full park editing lands in Task 18).
    const next: MutableWorkflowLaneTransition = {
      when: patch.when === undefined ? current.when : patch.when,
      to: patch.to === undefined ? current.to : patch.to,
    };
    lane.transitions = lane.transitions.map((transition, transitionIndex) =>
      transitionIndex === index ? next : transition,
    );
  });

export const removeTransition = (
  model: WorkflowEditorModel,
  laneKey: string,
  index: number,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.transitions = lane.transitions?.filter((_, transitionIndex) => transitionIndex !== index);
    if (lane.transitions?.length === 0) {
      delete lane.transitions;
    }
  });

export const addLaneEvent = (model: WorkflowEditorModel, laneKey: string): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane, definition) => {
    const to =
      definition.lanes.find((candidate) => candidate.key !== laneKey)?.key ?? LaneKey.make(laneKey);
    lane.onEvent = [...(lane.onEvent ?? []), { name: "ci.passed", to }];
  });

export const updateLaneEvent = (
  model: WorkflowEditorModel,
  laneKey: string,
  index: number,
  patch: {
    readonly name?: string;
    readonly when?: unknown | null;
    readonly to?: MutableWorkflowRouteTarget;
  },
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    if (!lane.onEvent?.[index]) {
      return;
    }
    const current = lane.onEvent[index];
    // when: null clears the predicate; undefined keeps it.
    const when =
      patch.when === undefined ? current.when : patch.when === null ? undefined : patch.when;
    // patch.to may be a bare lane key or a park target object — pass either
    // through untouched (no stored definition can contain a park target yet,
    // see plan Task 1b; full park editing lands in Task 18).
    const next: MutableWorkflowLaneEvent = {
      name: patch.name === undefined ? current.name : patch.name,
      ...(when === undefined ? {} : { when }),
      to: patch.to === undefined ? current.to : patch.to,
    };
    lane.onEvent = lane.onEvent.map((event, eventIndex) => (eventIndex === index ? next : event));
  });

export const removeLaneEvent = (
  model: WorkflowEditorModel,
  laneKey: string,
  index: number,
): WorkflowEditorModel =>
  updateLane(model, laneKey, (lane) => {
    lane.onEvent = lane.onEvent?.filter((_, eventIndex) => eventIndex !== index);
    if (lane.onEvent?.length === 0) {
      delete lane.onEvent;
    }
  });

// ── Park-target editing ────────────────────────────────────────────────────
// One reader/writer over all four routing positions. `update` receives the
// current target and returns the next one; for the required `transition.to` /
// `onEvent.to` positions a returned `undefined` is ignored (they cannot be
// cleared), while `on.*` positions clear on `undefined` via `compactOn`.
const mutateRouteTargetAt = (
  model: WorkflowEditorModel,
  path: RouteTargetPath,
  update: (
    current: MutableWorkflowRouteTarget | undefined,
    lane: MutableWorkflowLane,
    definition: MutableWorkflowDefinition,
  ) => MutableWorkflowRouteTarget | undefined,
): WorkflowEditorModel =>
  updateLane(model, path.laneKey, (lane, definition) => {
    if (path.site === "laneOn") {
      lane.on = compactOn({
        ...lane.on,
        [path.kind]: update(lane.on?.[path.kind], lane, definition),
      });
      return;
    }
    if (path.site === "stepOn") {
      const step = lane.pipeline?.find((candidate) => candidate.key === path.stepKey);
      if (!step) {
        return;
      }
      step.on = compactOn({
        ...step.on,
        [path.kind]: update(step.on?.[path.kind], lane, definition),
      });
      return;
    }
    if (path.site === "transition") {
      const transition = lane.transitions?.[path.index];
      if (!transition) {
        return;
      }
      const next = update(transition.to, lane, definition);
      if (next !== undefined) {
        transition.to = next;
      }
      return;
    }
    const event = lane.onEvent?.[path.index];
    if (!event) {
      return;
    }
    const next = update(event.to, lane, definition);
    if (next !== undefined) {
      event.to = next;
    }
  });

const firstOtherLaneKey = (
  definition: MutableWorkflowDefinition,
  laneKey: string,
): string | undefined => definition.lanes.find((candidate) => candidate.key !== laneKey)?.key;

// Write a concrete target (bare lane move) or clear the position. Park objects
// are set via `setRouteTargetKind`.
export const setRouteTarget = (
  model: WorkflowEditorModel,
  path: RouteTargetPath,
  target: string | undefined,
): WorkflowEditorModel =>
  mutateRouteTargetAt(model, path, () => (target === undefined ? undefined : LaneKey.make(target)));

// Swap the target between a bare lane move and a park substate. lane→park seeds
// a minimal park with a single "Retry" action back to the owning lane;
// park→park preserves the existing label + actions (substate toggle);
// park→lane falls back to the first action's target, else another lane.
export const setRouteTargetKind = (
  model: WorkflowEditorModel,
  path: RouteTargetPath,
  kind: RouteTargetKind,
): WorkflowEditorModel =>
  mutateRouteTargetAt(model, path, (current, lane, definition) => {
    const laneKey = String(lane.key);
    if (kind === "lane") {
      if (current !== undefined && typeof current !== "string") {
        const firstActionTo = current.actions[0]?.to;
        return LaneKey.make(
          (firstActionTo === undefined ? undefined : String(firstActionTo)) ??
            firstOtherLaneKey(definition, laneKey) ??
            laneKey,
        );
      }
      return current ?? LaneKey.make(firstOtherLaneKey(definition, laneKey) ?? laneKey);
    }
    const substate: WorkflowParkSubstate = kind === "park-issue" ? "issue" : "waiting";
    if (current !== undefined && typeof current !== "string") {
      return { ...current, park: substate };
    }
    const seeded: MutableWorkflowParkTarget = {
      park: substate,
      actions: [{ label: "Retry", to: LaneKey.make(laneKey) }],
    };
    return seeded;
  });

export const updateParkTarget = (
  model: WorkflowEditorModel,
  path: RouteTargetPath,
  patch: { readonly label?: string | undefined },
): WorkflowEditorModel =>
  mutateRouteTargetAt(model, path, (current) => {
    if (current === undefined || typeof current === "string") {
      return current;
    }
    const next: MutableWorkflowParkTarget = { ...current };
    if ("label" in patch) {
      if (patch.label === undefined || patch.label.length === 0) {
        delete next.label;
      } else {
        next.label = patch.label;
      }
    }
    return next;
  });

export const addParkAction = (
  model: WorkflowEditorModel,
  path: RouteTargetPath,
): WorkflowEditorModel =>
  mutateRouteTargetAt(model, path, (current, lane, definition) => {
    if (current === undefined || typeof current === "string") {
      return current;
    }
    const laneKey = String(lane.key);
    const to = firstOtherLaneKey(definition, laneKey) ?? laneKey;
    return {
      ...current,
      actions: [...current.actions, { label: "New action", to: LaneKey.make(to) }],
    };
  });

export const updateParkAction = (
  model: WorkflowEditorModel,
  path: RouteTargetPath,
  index: number,
  patch: Partial<LaneActionEncoded>,
): WorkflowEditorModel =>
  mutateRouteTargetAt(model, path, (current) => {
    if (
      current === undefined ||
      typeof current === "string" ||
      index < 0 ||
      index >= current.actions.length
    ) {
      return current;
    }
    const actions = current.actions.map((action, candidateIndex) => {
      if (candidateIndex !== index) {
        return action;
      }
      const next = { ...action, ...patch };
      if (next.hint !== undefined && next.hint.length === 0) {
        delete next.hint;
      }
      return next;
    });
    return { ...current, actions };
  });

// Removing the last action would leave an empty (invalid) park, so the minimum
// of one action is enforced here — the sub-editor also disables the control.
export const removeParkAction = (
  model: WorkflowEditorModel,
  path: RouteTargetPath,
  index: number,
): WorkflowEditorModel =>
  mutateRouteTargetAt(model, path, (current) => {
    if (current === undefined || typeof current === "string" || current.actions.length <= 1) {
      return current;
    }
    return {
      ...current,
      actions: current.actions.filter((_, candidateIndex) => candidateIndex !== index),
    };
  });

export interface LaneParkBadge {
  readonly substate: WorkflowParkSubstate;
  readonly label: string | undefined;
  readonly selection: WorkflowEditorSelection;
}

// Every park target hanging off a lane (its on.* fallbacks, transitions,
// external events, and step routes), paired with the selection that opens its
// editor — the canvas renders one badge per entry.
export const collectLaneParkBadges = (lane: WorkflowLaneEncoded): ReadonlyArray<LaneParkBadge> => {
  const laneKey = String(lane.key);
  const badges: LaneParkBadge[] = [];
  const push = (
    target: WorkflowRouteTargetEncoded | undefined,
    selection: WorkflowEditorSelection,
  ) => {
    if (isParkRouteTarget(target)) {
      badges.push({ substate: target.park, label: target.label, selection });
    }
  };
  for (const kind of ["success", "failure", "blocked"] as const) {
    push(lane.on?.[kind], { kind: "lane", laneKey });
  }
  (lane.transitions ?? []).forEach((transition, index) => {
    push(transition.to, { kind: "transition", laneKey, index });
  });
  for (const event of lane.onEvent ?? []) {
    push(event.to, { kind: "lane", laneKey });
  }
  for (const step of lane.pipeline ?? []) {
    for (const kind of ["success", "failure", "blocked"] as const) {
      push(step.on?.[kind], { kind: "step", laneKey, stepKey: String(step.key) });
    }
  }
  return badges;
};
