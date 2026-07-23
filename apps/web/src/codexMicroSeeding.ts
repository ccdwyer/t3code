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
  type ResolvedKeybindingsConfig,
  type ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";

import { useClientSettings, useUpdateClientSettings } from "./hooks/useSettings";
import { primaryServerKeybindingsAtom, serverEnvironment } from "./state/server";
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
 * Decide the seed plan for one environment. Pure — no I/O, no React.
 *
 * Guard 2: an already-seeded environment yields `{ shouldSeed: false }`.
 * Guard 3: a layout entry is skipped when its key is already bound (to any
 * command) OR its command is already bound (to any key) — we never override or
 * shadow a user's existing rule.
 */
export function computeCodexMicroSeedPlan(input: CodexMicroSeedPlanInput): CodexMicroSeedPlan {
  if (input.seededEnvironments.includes(input.environmentId)) {
    return { shouldSeed: false, rulesToUpsert: [] };
  }

  const boundShortcutSignatures = new Set<string>();
  const boundCommands = new Set<string>();
  for (const rule of input.existingRules) {
    boundShortcutSignatures.add(shortcutSignature(rule.shortcut));
    boundCommands.add(rule.command);
  }

  const rulesToUpsert: ServerUpsertKeybindingInput[] = [];
  for (const binding of input.layout) {
    const shortcut = parseKeybindingShortcut(binding.key);
    // Defensive: a malformed layout key can never seed. (The shipped layout is
    // all valid.) Skip it rather than emit an unparseable upsert.
    if (!shortcut) continue;
    if (boundShortcutSignatures.has(shortcutSignature(shortcut))) continue;
    if (boundCommands.has(binding.command)) continue;
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
   * Perform a single upsert against the environment's server. Never sets
   * `replace` — combined with guard 3 (planner skips already-bound keys /
   * commands) this makes each upsert a pure append that cannot shadow a user
   * rule.
   */
  readonly upsertKeybinding: (
    environmentId: string,
    input: ServerUpsertKeybindingInput,
  ) => Promise<void>;
  /** Append the environment id to the persisted seeded list (idempotent). */
  readonly appendSeededEnvironment: (environmentId: string) => void;
  /** Guard 4: has this environment already been seeded this session? */
  readonly hasSeededThisSession: (environmentId: string) => boolean;
  /** Guard 4: mark this environment as seeded for the rest of this session. */
  readonly markSeededThisSession: (environmentId: string) => void;
}

/**
 * Run the seed once for the currently-active environment. Safe to call on every
 * `connected` emission and whenever the environment becomes active — it is
 * idempotent via the per-session flag and the persisted seeded list.
 */
export async function runCodexMicroSeed(deps: CodexMicroSeedRunnerDeps): Promise<void> {
  const environmentId = deps.getEnvironmentId();
  if (!environmentId) return;

  // Guard 4: within-session idempotence. Checked (and set, below) BEFORE any
  // await so two near-simultaneous `connected` emissions cannot both proceed.
  if (deps.hasSeededThisSession(environmentId)) return;

  const plan = computeCodexMicroSeedPlan({
    layout: CODEX_MICRO_SEED_LAYOUT,
    existingRules: deps.getExistingRules(),
    seededEnvironments: deps.getSeededEnvironments(),
    environmentId,
  });
  if (!plan.shouldSeed) return;

  deps.markSeededThisSession(environmentId);

  for (const rule of plan.rulesToUpsert) {
    await deps.upsertKeybinding(environmentId, rule);
  }

  // Append AFTER attempting (even for an empty plan) so it never re-runs for
  // this environment on a future launch.
  deps.appendSeededEnvironment(environmentId);
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
    seededEnvironments,
    updateClientSettings,
    upsertKeybinding,
  });
  latestRef.current = {
    environmentId,
    keybindings,
    seededEnvironments,
    updateClientSettings,
    upsertKeybinding,
  };

  const deviceConnectedRef = useRef(false);
  const sessionSeededRef = useRef<Set<string>>(new Set());

  // Stable attempt: gated on the device currently being connected. Idempotent
  // via the runner's per-session flag + the persisted seeded list, so it is
  // safe to fire from both the state subscription and the environment effect.
  const attemptRef = useRef<() => void>(() => {});
  attemptRef.current = () => {
    if (!deviceConnectedRef.current) return;
    void runCodexMicroSeed({
      getEnvironmentId: () => latestRef.current.environmentId,
      getExistingRules: () => latestRef.current.keybindings,
      getSeededEnvironments: () => latestRef.current.seededEnvironments,
      upsertKeybinding: async (envId, input) => {
        // `envId` originates from the branded primary environment id (below), so
        // this cast back to the branded type is sound — the runner keeps a plain
        // `string` seam so it stays framework-agnostic and easily testable.
        await latestRef.current.upsertKeybinding({
          environmentId: envId as EnvironmentId,
          input,
        });
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

  // Covers the ordering where the pad is already connected but the primary
  // environment becomes active only later — re-attempt when the environment id
  // appears/changes (no-op unless the device is currently connected).
  useEffect(() => {
    attemptRef.current();
  }, [environmentId]);
}
