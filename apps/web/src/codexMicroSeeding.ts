/**
 * Codex Micro — seeded default keybindings on first device connect.
 *
 * The Codex Micro macro pad ships VIA-mapped to F13–F19. The first time a real
 * pad reaches the `connected` state while the primary local environment is
 * active, we upsert a default keybinding layout into that environment's server
 * keybindings config so the keys do something useful out of the box. The layout
 * is fully user-editable afterwards (it is upserted, never re-applied).
 *
 * This module is split into:
 *  - a PURE planner (`computeCodexMicroSeedPlan`) that decides which rules to
 *    upsert given the current resolved config and the per-environment guard,
 *  - a dependency-injected async runner (`runCodexMicroSeed`) that performs the
 *    upserts + persists the per-environment "seeded" marker, and
 *  - a thin React hook (`useCodexMicroKeybindingSeeding`) that wires the runner
 *    to the desktop bridge, the primary environment, the resolved keybindings
 *    atom, and client settings.
 *
 * Guards enforced (in order):
 *  1. Bridge / device absent  → never runs (hook-level).
 *  2. Environment already in the seeded list → skip (planner-level).
 *  3. Never override an existing user rule: skip any layout entry whose key is
 *     already bound (to anything) or whose command already has a binding
 *     (planner-level).
 *  4. Idempotent within a session: a per-session flag prevents a second
 *     `connected` emission (e.g. a reconnect) from re-running (runner-level).
 *
 * After a seed is ATTEMPTED — even when every rule was skipped as already-bound
 * (an empty plan) — the environment id is appended to
 * `codexMicroKeybindingsSeededEnvironments` so it never re-runs for that
 * environment. A different (unseen) environment id seeds on its own first
 * connect.
 *
 * @module codexMicroSeeding
 */
import { useEffect, useRef } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type KeybindingCommand,
  type KeybindingShortcut,
  MAX_KEYBINDINGS_COUNT,
  type ResolvedKeybindingsConfig,
  type ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";

import {
  useClientSettings,
  useClientSettingsHydrated,
  useUpdateClientSettings,
} from "./hooks/useSettings";
import {
  primaryServerConfigAtom,
  primaryServerKeybindingsAtom,
  serverEnvironment,
} from "./state/server";
import { usePrimaryEnvironment } from "./state/environments";
import { useAtomCommand } from "./state/use-atom-command";

// ── Seed layout ──────────────────────────────────────────────────────

export interface CodexMicroSeedBinding {
  readonly key: string;
  readonly command: KeybindingCommand;
}

/**
 * The default Codex Micro layout. Six agent keys (F13–F18) open the six
 * agent-key slots; F19 accepts the focused approval, Shift+F19 declines it.
 *
 * Exported as a typed constant so the devices settings page can render it
 * read-only alongside the "remap via VIA" escape hatch.
 */
export const CODEX_MICRO_SEED_LAYOUT: readonly CodexMicroSeedBinding[] = [
  { key: "f13", command: "agentKey.open.1" },
  { key: "f14", command: "agentKey.open.2" },
  { key: "f15", command: "agentKey.open.3" },
  { key: "f16", command: "agentKey.open.4" },
  { key: "f17", command: "agentKey.open.5" },
  { key: "f18", command: "agentKey.open.6" },
  { key: "f19", command: "approval.accept" },
  { key: "shift+f19", command: "approval.decline" },
];

// ── Pure planner ─────────────────────────────────────────────────────

export interface CodexMicroSeedPlanInput {
  readonly layout: readonly CodexMicroSeedBinding[];
  /** Current RESOLVED keybindings config for the target environment. */
  readonly existingRules: ResolvedKeybindingsConfig;
  /** Environment ids that have already been seeded (persisted client setting). */
  readonly seededEnvironments: readonly string[];
  /** The environment whose server owns the keybindings being seeded. */
  readonly environmentId: string;
}

export interface CodexMicroSeedPlan {
  /**
   * True when the environment has not been seeded yet. When true the caller
   * should perform `rulesToUpsert` (possibly empty) and then mark the
   * environment seeded. When false the caller must do nothing.
   */
  readonly shouldSeed: boolean;
  readonly rulesToUpsert: readonly ServerUpsertKeybindingInput[];
}

/**
 * Canonical, platform-agnostic signature of a shortcut so two shortcuts that
 * mean the same chord compare equal regardless of how they were authored.
 * Both the resolved-config shortcuts and the layout keys are normalized through
 * `parseKeybindingShortcut` before signing, so comparison is apples-to-apples.
 */
function shortcutSignature(shortcut: KeybindingShortcut): string {
  return [
    shortcut.modKey ? "mod" : "",
    shortcut.metaKey ? "meta" : "",
    shortcut.ctrlKey ? "ctrl" : "",
    shortcut.altKey ? "alt" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.key.toLowerCase(),
  ].join("|");
}

/**
 * Precompute the set of bound shortcut signatures + commands for a resolved
 * config so free-ness checks are O(1) per binding.
 */
function boundSignatures(existingRules: ResolvedKeybindingsConfig): {
  readonly shortcuts: ReadonlySet<string>;
  readonly commands: ReadonlySet<string>;
} {
  const shortcuts = new Set<string>();
  const commands = new Set<string>();
  for (const rule of existingRules) {
    shortcuts.add(shortcutSignature(rule.shortcut));
    commands.add(rule.command);
  }
  return { shortcuts, commands };
}

/**
 * Shared free-ness predicate (guard 3), reused by BOTH the planner and the
 * runner's per-upsert TOCTOU re-check (A4) so the two can never diverge. A
 * binding is free when its normalized shortcut is unbound AND its command is
 * unbound in `existingRules`. A malformed layout key is treated as NOT free
 * (it can never seed) so it is skipped rather than emitted as an unparseable
 * upsert.
 */
export function isBindingFree(
  existingRules: ResolvedKeybindingsConfig,
  binding: CodexMicroSeedBinding,
): boolean {
  const shortcut = parseKeybindingShortcut(binding.key);
  if (!shortcut) return false;
  const { shortcuts, commands } = boundSignatures(existingRules);
  return !shortcuts.has(shortcutSignature(shortcut)) && !commands.has(binding.command);
}

/**
 * Decide the seed plan for one environment. Pure — no I/O, no React.
 *
 * Guard 2: an already-seeded environment yields `{ shouldSeed: false }`.
 * Guard 3: a layout entry is skipped when its key is already bound (to any
 * command) OR its command is already bound (to any key) — we never override or
 * shadow a user's existing rule (via the shared `isBindingFree` predicate).
 */
export function computeCodexMicroSeedPlan(input: CodexMicroSeedPlanInput): CodexMicroSeedPlan {
  if (input.seededEnvironments.includes(input.environmentId)) {
    return { shouldSeed: false, rulesToUpsert: [] };
  }

  const rulesToUpsert: ServerUpsertKeybindingInput[] = [];
  for (const binding of input.layout) {
    if (!isBindingFree(input.existingRules, binding)) continue;
    rulesToUpsert.push({ key: binding.key, command: binding.command });
  }

  return { shouldSeed: true, rulesToUpsert };
}

// ── Async runner (dependency-injected, testable without React) ───────

export interface CodexMicroSeedRunnerDeps {
  /** The primary local environment id, or null when not yet active. */
  readonly getEnvironmentId: () => string | null;
  /** Current resolved keybindings for the primary environment. */
  readonly getExistingRules: () => ResolvedKeybindingsConfig;
  /** Persisted seeded-environment list. */
  readonly getSeededEnvironments: () => readonly string[];
  /**
   * A1a readiness: the primary server config has ACTUALLY loaded. Until it has,
   * `getExistingRules` silently returns the DEFAULT resolved keybindings (the
   * atom's null-config fallback), which makes an existing user rule look free —
   * so seeding must not run against it.
   */
  readonly isServerConfigLoaded: () => boolean;
  /**
   * A1b readiness: client settings have hydrated from persistence. Until they
   * have, `getSeededEnvironments` returns the pre-hydration default (empty), so
   * a relaunch would re-seed bindings the user deleted. Seeding must wait for
   * the real stored guard value.
   */
  readonly isSettingsHydrated: () => boolean;
  /**
   * A5 capacity: the server truncates each environment's keybindings to this
   * limit by evicting OLDEST rules. If seeding would overflow it we seed
   * nothing (never evict a user rule) and just mark the environment seeded.
   */
  readonly maxKeybindings: number;
  /**
   * Perform a single upsert against the environment's server. Never sets
   * `replace` — combined with guard 3 (planner skips already-bound keys /
   * commands) this makes each upsert a pure append that cannot shadow a user
   * rule. MUST reject (throw) when the upsert fails (A2) so the runner does not
   * mark a failed seed as done.
   */
  readonly upsertKeybinding: (
    environmentId: string,
    input: ServerUpsertKeybindingInput,
  ) => Promise<void>;
  /** Append the environment id to the persisted seeded list (idempotent). */
  readonly appendSeededEnvironment: (environmentId: string) => void;
  /** Has this environment been SUCCESSFULLY seeded this session? */
  readonly hasSeededThisSession: (environmentId: string) => boolean;
  /** Mark this environment successfully seeded for the rest of this session. */
  readonly markSeededThisSession: (environmentId: string) => void;
  /**
   * A3 in-progress guard: atomically acquire the run lock for this environment,
   * returning `false` if a run is already in flight (so concurrent
   * `connected`/activation events cannot both proceed). Set synchronously,
   * before any await.
   */
  readonly beginRun: (environmentId: string) => boolean;
  /**
   * A3: release the in-progress guard. On failure this lets a later `connected`
   * event retry; on success the session marker already blocks re-runs.
   */
  readonly endRun: (environmentId: string) => void;
}

/**
 * Run the seed once for the currently-active environment. Safe to call on every
 * `connected` emission and whenever the environment becomes active — it is
 * idempotent via the per-session success marker + in-progress guard and the
 * persisted seeded list.
 *
 * Marking (`markSeededThisSession` + `appendSeededEnvironment`) happens ONLY
 * after the full plan applied successfully — or against a confirmed-empty plan
 * on loaded config (A3). On any upsert failure the in-progress guard is
 * released and nothing is marked, so a later event retries.
 */
export async function runCodexMicroSeed(deps: CodexMicroSeedRunnerDeps): Promise<void> {
  const environmentId = deps.getEnvironmentId();
  if (!environmentId) return;

  // A1 readiness gates — BOTH must hold or the guards above are unreliable.
  // Return without marking or acquiring the run lock so a later readiness flip
  // (which re-fires the attempt) can seed honestly.
  if (!deps.isServerConfigLoaded()) return;
  if (!deps.isSettingsHydrated()) return;

  // Already seeded this session → nothing to do (checked before the lock so a
  // post-success re-fire is a cheap no-op).
  if (deps.hasSeededThisSession(environmentId)) return;

  // A3 in-progress guard: acquire synchronously, before any await, so two
  // near-simultaneous emissions cannot both proceed.
  if (!deps.beginRun(environmentId)) return;

  try {
    const plan = computeCodexMicroSeedPlan({
      layout: CODEX_MICRO_SEED_LAYOUT,
      existingRules: deps.getExistingRules(),
      seededEnvironments: deps.getSeededEnvironments(),
      environmentId,
    });
    // Already in the persisted seeded list → nothing to do (no marking needed).
    if (!plan.shouldSeed) {
      return;
    }

    // A5 capacity: if applying the plan would exceed the server's keybinding
    // cap (which evicts OLDEST — i.e. user — rules to make room), seed NOTHING
    // and mark the environment seeded. Policy: a user at the cap seeds manually;
    // we never evict their rules.
    const existingCount = deps.getExistingRules().length;
    if (existingCount + plan.rulesToUpsert.length > deps.maxKeybindings) {
      deps.markSeededThisSession(environmentId);
      deps.appendSeededEnvironment(environmentId);
      return;
    }

    for (const rule of plan.rulesToUpsert) {
      // A4 TOCTOU re-check: re-read the LATEST resolved rules and skip this
      // binding if its key or command was taken since the plan was computed
      // (reuses the planner's `isBindingFree` predicate). Residual race: this
      // is a client-side narrowing only — a fully atomic server-side seed op
      // was adjudicated OUT of v1 scope, so a rule bound in the sub-millisecond
      // window between this check and the server applying the upsert can still
      // be shadowed. Accepted for v1.
      if (!isBindingFree(deps.getExistingRules(), rule)) {
        continue;
      }
      // Throws on failure (A2) → caught below: no marking, guard released.
      await deps.upsertKeybinding(environmentId, rule);
    }

    // Success (full plan applied, or a confirmed-empty plan) → mark so it never
    // re-runs for this environment this session or on a future launch.
    deps.markSeededThisSession(environmentId);
    deps.appendSeededEnvironment(environmentId);
  } catch {
    // A2/A3: an upsert failed. Do NOT mark seeded; the in-progress guard is
    // released in `finally` so a later `connected` event retries.
  } finally {
    deps.endRun(environmentId);
  }
}

// ── React hook (thin) ────────────────────────────────────────────────

/**
 * Subscribe to the Codex Micro device state and seed default keybindings the
 * first time the pad reaches `connected` while the primary environment is
 * active. No-op when the desktop bridge (or the `codexMicro` sub-bridge) is
 * absent. Mount once, high in the app tree (see integration note in the task).
 */
export function useCodexMicroKeybindingSeeding(): void {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // A1a: the primary server config is non-null only once it has actually
  // loaded. `primaryServerKeybindingsAtom` falls back to the DEFAULT resolved
  // keybindings while this is null, so the seed must gate on it.
  const serverConfigLoaded = useAtomValue(primaryServerConfigAtom) !== null;
  // A1b: the persisted client settings (incl. the seeded-environments guard)
  // have hydrated from storage — not the pre-hydration default.
  const settingsHydrated = useClientSettingsHydrated();
  const seededEnvironments = useClientSettings(
    (settings) => settings.codexMicroKeybindingsSeededEnvironments,
  );
  const updateClientSettings = useUpdateClientSettings();
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });

  // Keep the latest reactive values in a ref so the once-only bridge
  // subscription (and the environment-activation effect) always read current
  // data without resubscribing on every render.
  const latestRef = useRef({
    environmentId,
    keybindings,
    serverConfigLoaded,
    settingsHydrated,
    seededEnvironments,
    updateClientSettings,
    upsertKeybinding,
  });
  latestRef.current = {
    environmentId,
    keybindings,
    serverConfigLoaded,
    settingsHydrated,
    seededEnvironments,
    updateClientSettings,
    upsertKeybinding,
  };

  const deviceConnectedRef = useRef(false);
  // Environments SUCCESSFULLY seeded this session.
  const sessionSeededRef = useRef<Set<string>>(new Set());
  // A3 in-progress guard: environments with a seed run currently in flight.
  const inProgressRef = useRef<Set<string>>(new Set());

  // Stable attempt: gated on the device currently being connected. Idempotent
  // via the runner's per-session success marker + in-progress guard + the
  // persisted seeded list, so it is safe to fire from both the state
  // subscription and the environment/readiness effect.
  const attemptRef = useRef<() => void>(() => {});
  attemptRef.current = () => {
    if (!deviceConnectedRef.current) return;
    void runCodexMicroSeed({
      getEnvironmentId: () => latestRef.current.environmentId,
      getExistingRules: () => latestRef.current.keybindings,
      getSeededEnvironments: () => latestRef.current.seededEnvironments,
      isServerConfigLoaded: () => latestRef.current.serverConfigLoaded,
      isSettingsHydrated: () => latestRef.current.settingsHydrated,
      maxKeybindings: MAX_KEYBINDINGS_COUNT,
      upsertKeybinding: async (envId, input) => {
        // `envId` originates from the branded primary environment id (below), so
        // this cast back to the branded type is sound — the runner keeps a plain
        // `string` seam so it stays framework-agnostic and easily testable.
        const result = await latestRef.current.upsertKeybinding({
          environmentId: envId as EnvironmentId,
          input,
        });
        // A2: `useAtomCommand` RESOLVES with an AsyncResult; a `Failure` here is
        // a rejected/failed upsert. Surface it as a throw so the runner does not
        // mark a failed seed as done (and can retry on a later `connected`).
        if (result._tag === "Failure") {
          throw new Error("codex-micro keybinding upsert failed");
        }
      },
      appendSeededEnvironment: (envId) => {
        const current = latestRef.current.seededEnvironments;
        if (current.includes(envId)) return;
        latestRef.current.updateClientSettings({
          codexMicroKeybindingsSeededEnvironments: [...current, envId],
        });
      },
      hasSeededThisSession: (envId) => sessionSeededRef.current.has(envId),
      markSeededThisSession: (envId) => {
        sessionSeededRef.current.add(envId);
      },
      beginRun: (envId) => {
        if (inProgressRef.current.has(envId)) return false;
        inProgressRef.current.add(envId);
        return true;
      },
      endRun: (envId) => {
        inProgressRef.current.delete(envId);
      },
    });
  };

  // Guard 1: subscribe only when the bridge + codexMicro sub-bridge exist.
  // Replay-on-subscribe delivers the current state immediately as the first
  // emission, so an already-connected pad is handled without a getState race.
  useEffect(() => {
    const bridge = window.desktopBridge?.codexMicro;
    if (!bridge) return;
    const unsubscribe = bridge.onStateChange((state) => {
      deviceConnectedRef.current = state.state === "connected";
      if (deviceConnectedRef.current) {
        attemptRef.current();
      }
    });
    return unsubscribe;
  }, []);

  // Covers the orderings where the pad is already connected but the primary
  // environment becomes active — or the readiness signals (server config
  // loaded / settings hydrated) flip — only later. Re-attempt whenever any of
  // those change (no-op unless the device is currently connected and ready).
  useEffect(() => {
    attemptRef.current();
  }, [environmentId, serverConfigLoaded, settingsHydrated]);
}
