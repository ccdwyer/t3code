import { describe, expect, it } from "vite-plus/test";
import type {
  KeybindingCommand,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
  ServerUpsertKeybindingInput,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";

import {
  CODEX_MICRO_SEED_LAYOUT,
  computeCodexMicroSeedPlan,
  runCodexMicroSeed,
  type CodexMicroSeedRunnerDeps,
} from "./codexMicroSeeding";

function resolvedRule(key: string, command: KeybindingCommand): ResolvedKeybindingRule {
  const shortcut = parseKeybindingShortcut(key);
  if (!shortcut) throw new Error(`invalid test key: ${key}`);
  return { command, shortcut };
}

const EMPTY_CONFIG: ResolvedKeybindingsConfig = [];

describe("computeCodexMicroSeedPlan", () => {
  it("seeds all 8 layout rules on a fresh environment", () => {
    const plan = computeCodexMicroSeedPlan({
      layout: CODEX_MICRO_SEED_LAYOUT,
      existingRules: EMPTY_CONFIG,
      seededEnvironments: [],
      environmentId: "env-a",
    });

    expect(plan.shouldSeed).toBe(true);
    expect(plan.rulesToUpsert).toEqual([
      { key: "f13", command: "agentKey.open.1" },
      { key: "f14", command: "agentKey.open.2" },
      { key: "f15", command: "agentKey.open.3" },
      { key: "f16", command: "agentKey.open.4" },
      { key: "f17", command: "agentKey.open.5" },
      { key: "f18", command: "agentKey.open.6" },
      { key: "f19", command: "approval.accept" },
      { key: "shift+f19", command: "approval.decline" },
    ]);
    // No rule ever carries `replace` — each upsert is a pure append.
    for (const rule of plan.rulesToUpsert) {
      expect("replace" in rule).toBe(false);
    }
  });

  it("skips entirely when the environment is already seeded", () => {
    const plan = computeCodexMicroSeedPlan({
      layout: CODEX_MICRO_SEED_LAYOUT,
      existingRules: EMPTY_CONFIG,
      seededEnvironments: ["env-a", "env-b"],
      environmentId: "env-a",
    });

    expect(plan.shouldSeed).toBe(false);
    expect(plan.rulesToUpsert).toEqual([]);
  });

  it("skips a rule whose key is already bound to another command", () => {
    const plan = computeCodexMicroSeedPlan({
      layout: CODEX_MICRO_SEED_LAYOUT,
      existingRules: [resolvedRule("f13", "sidebar.toggle")],
      seededEnvironments: [],
      environmentId: "env-a",
    });

    expect(plan.shouldSeed).toBe(true);
    // f13 is taken → agentKey.open.1 is skipped; the other 7 seed.
    expect(plan.rulesToUpsert).toHaveLength(7);
    expect(plan.rulesToUpsert.some((rule) => rule.key === "f13")).toBe(false);
    expect(plan.rulesToUpsert.some((rule) => rule.command === "agentKey.open.1")).toBe(false);
  });

  it("skips a rule whose command is already bound to another key", () => {
    const plan = computeCodexMicroSeedPlan({
      layout: CODEX_MICRO_SEED_LAYOUT,
      existingRules: [resolvedRule("ctrl+a", "approval.accept")],
      seededEnvironments: [],
      environmentId: "env-a",
    });

    expect(plan.shouldSeed).toBe(true);
    // approval.accept already bound → f19 rule skipped; 7 remain.
    expect(plan.rulesToUpsert).toHaveLength(7);
    expect(plan.rulesToUpsert.some((rule) => rule.command === "approval.accept")).toBe(false);
    expect(plan.rulesToUpsert.some((rule) => rule.key === "f19")).toBe(false);
    // shift+f19 (approval.decline) is unaffected.
    expect(plan.rulesToUpsert.some((rule) => rule.key === "shift+f19")).toBe(true);
  });

  it("treats shift+f19 and f19 as distinct keys", () => {
    const plan = computeCodexMicroSeedPlan({
      layout: CODEX_MICRO_SEED_LAYOUT,
      existingRules: [resolvedRule("f19", "approval.accept")],
      seededEnvironments: [],
      environmentId: "env-a",
    });

    // f19 + approval.accept both taken → that rule skips, but shift+f19 remains.
    expect(plan.rulesToUpsert.some((rule) => rule.key === "shift+f19")).toBe(true);
    expect(plan.rulesToUpsert.some((rule) => rule.key === "f19")).toBe(false);
  });

  it("returns an empty (but shouldSeed) plan when every key/command is taken", () => {
    const existingRules: ResolvedKeybindingsConfig = CODEX_MICRO_SEED_LAYOUT.map((binding) =>
      resolvedRule(binding.key, binding.command),
    );
    const plan = computeCodexMicroSeedPlan({
      layout: CODEX_MICRO_SEED_LAYOUT,
      existingRules,
      seededEnvironments: [],
      environmentId: "env-a",
    });

    expect(plan.shouldSeed).toBe(true);
    expect(plan.rulesToUpsert).toEqual([]);
  });
});

// ── Runner ───────────────────────────────────────────────────────────

interface FakeRunner {
  readonly deps: CodexMicroSeedRunnerDeps;
  readonly upserts: Array<{ environmentId: string; input: ServerUpsertKeybindingInput }>;
  readonly appended: string[];
  seededEnvironments: string[];
  existingRules: ResolvedKeybindingsConfig;
  serverConfigLoaded: boolean;
  settingsHydrated: boolean;
  /** When true, EVERY upsert rejects (simulates an AsyncResult Failure). */
  failAllUpserts: boolean;
  /** When set, an upsert whose key matches rejects (partial-failure coverage). */
  failUpsertOnKey: string | null;
  /** How many times `getExistingRules` has been called (TOCTOU sequencing). */
  getRulesCallCount: number;
  /** True once the in-progress guard was released (endRun) at least once. */
  runEnded: boolean;
  session: Set<string>;
  inProgress: Set<string>;
}

function makeFakeRunner(options: {
  environmentId: string | null;
  existingRules?: ResolvedKeybindingsConfig;
  seededEnvironments?: string[];
  serverConfigLoaded?: boolean;
  settingsHydrated?: boolean;
  maxKeybindings?: number;
  failAllUpserts?: boolean;
  failUpsertOnKey?: string;
  /** After the plan is computed, subsequent `getExistingRules` calls include
   * this extra bound rule — simulating a key/command being taken mid-loop. */
  takeAfterPlan?: { key: string; command: KeybindingCommand };
}): FakeRunner {
  const upserts: Array<{ environmentId: string; input: ServerUpsertKeybindingInput }> = [];
  const appended: string[] = [];
  const state: FakeRunner = {
    upserts,
    appended,
    seededEnvironments: options.seededEnvironments ? [...options.seededEnvironments] : [],
    existingRules: options.existingRules ?? EMPTY_CONFIG,
    serverConfigLoaded: options.serverConfigLoaded ?? true,
    settingsHydrated: options.settingsHydrated ?? true,
    failAllUpserts: options.failAllUpserts ?? false,
    failUpsertOnKey: options.failUpsertOnKey ?? null,
    getRulesCallCount: 0,
    runEnded: false,
    session: new Set<string>(),
    inProgress: new Set<string>(),
    deps: {
      getEnvironmentId: () => options.environmentId,
      getExistingRules: () => {
        state.getRulesCallCount += 1;
        // The FIRST call feeds the planner; later calls (capacity + per-upsert
        // TOCTOU re-check) see the mutated view when `takeAfterPlan` is set.
        if (options.takeAfterPlan && state.getRulesCallCount > 1) {
          return [
            ...state.existingRules,
            resolvedRule(options.takeAfterPlan.key, options.takeAfterPlan.command),
          ];
        }
        return state.existingRules;
      },
      getSeededEnvironments: () => state.seededEnvironments,
      isServerConfigLoaded: () => state.serverConfigLoaded,
      isSettingsHydrated: () => state.settingsHydrated,
      maxKeybindings: options.maxKeybindings ?? 256,
      upsertKeybinding: async (environmentId, input) => {
        upserts.push({ environmentId, input });
        if (state.failAllUpserts || state.failUpsertOnKey === input.key) {
          throw new Error(`simulated upsert failure for ${input.key}`);
        }
      },
      appendSeededEnvironment: (environmentId) => {
        appended.push(environmentId);
        if (!state.seededEnvironments.includes(environmentId)) {
          state.seededEnvironments = [...state.seededEnvironments, environmentId];
        }
      },
      hasSeededThisSession: (environmentId) => state.session.has(environmentId),
      markSeededThisSession: (environmentId) => {
        state.session.add(environmentId);
      },
      beginRun: (environmentId) => {
        if (state.inProgress.has(environmentId)) return false;
        state.inProgress.add(environmentId);
        return true;
      },
      endRun: (environmentId) => {
        state.runEnded = true;
        state.inProgress.delete(environmentId);
      },
    },
  };
  return state;
}

describe("runCodexMicroSeed", () => {
  it("upserts all 8 rules then marks the environment seeded", async () => {
    const fake = makeFakeRunner({ environmentId: "env-a" });

    await runCodexMicroSeed(fake.deps);

    expect(fake.upserts).toHaveLength(8);
    expect(fake.upserts.every((entry) => entry.environmentId === "env-a")).toBe(true);
    expect(fake.appended).toEqual(["env-a"]);
    // In-progress guard released after a successful run.
    expect(fake.inProgress.size).toBe(0);
  });

  it("does nothing when no environment is active", async () => {
    const fake = makeFakeRunner({ environmentId: null });

    await runCodexMicroSeed(fake.deps);

    expect(fake.upserts).toEqual([]);
    expect(fake.appended).toEqual([]);
  });

  it("does nothing when the environment is already seeded (persisted list)", async () => {
    const fake = makeFakeRunner({
      environmentId: "env-a",
      seededEnvironments: ["env-a"],
    });

    await runCodexMicroSeed(fake.deps);

    expect(fake.upserts).toEqual([]);
    expect(fake.appended).toEqual([]);
  });

  it("marks the environment seeded even when the plan is empty", async () => {
    const existingRules: ResolvedKeybindingsConfig = CODEX_MICRO_SEED_LAYOUT.map((binding) =>
      resolvedRule(binding.key, binding.command),
    );
    const fake = makeFakeRunner({ environmentId: "env-a", existingRules });

    await runCodexMicroSeed(fake.deps);

    expect(fake.upserts).toEqual([]);
    expect(fake.appended).toEqual(["env-a"]);
  });

  it("no-ops on a second run in the same session (session flag)", async () => {
    const fake = makeFakeRunner({ environmentId: "env-a" });

    await runCodexMicroSeed(fake.deps);
    // Simulate a reconnect firing `connected` again — but the persisted list is
    // also now updated, so clear it to prove the SESSION flag is what guards.
    fake.seededEnvironments = [];
    await runCodexMicroSeed(fake.deps);

    expect(fake.upserts).toHaveLength(8);
    expect(fake.appended).toEqual(["env-a"]);
  });

  it("seeds a different, not-yet-seen environment id", async () => {
    const fake = makeFakeRunner({
      environmentId: "env-b",
      seededEnvironments: ["env-a"],
    });

    await runCodexMicroSeed(fake.deps);

    expect(fake.upserts).toHaveLength(8);
    expect(fake.upserts.every((entry) => entry.environmentId === "env-b")).toBe(true);
    expect(fake.appended).toEqual(["env-b"]);
  });

  // ── A1 readiness gates ──────────────────────────────────────────────

  it("does not seed or mark while the server config is unloaded", async () => {
    const fake = makeFakeRunner({ environmentId: "env-a", serverConfigLoaded: false });

    await runCodexMicroSeed(fake.deps);

    expect(fake.upserts).toEqual([]);
    expect(fake.appended).toEqual([]);
    expect(fake.session.has("env-a")).toBe(false);
    // No run lock acquired → a later readiness flip can still seed.
    expect(fake.inProgress.size).toBe(0);
  });

  it("does not seed or mark while client settings are unhydrated", async () => {
    const fake = makeFakeRunner({ environmentId: "env-a", settingsHydrated: false });

    await runCodexMicroSeed(fake.deps);

    expect(fake.upserts).toEqual([]);
    expect(fake.appended).toEqual([]);
    expect(fake.session.has("env-a")).toBe(false);
  });

  it("seeds once readiness flips from unloaded to loaded", async () => {
    const fake = makeFakeRunner({ environmentId: "env-a", serverConfigLoaded: false });

    await runCodexMicroSeed(fake.deps);
    expect(fake.upserts).toEqual([]);

    fake.serverConfigLoaded = true;
    await runCodexMicroSeed(fake.deps);
    expect(fake.upserts).toHaveLength(8);
    expect(fake.appended).toEqual(["env-a"]);
  });

  // ── A2 / A3 failure handling ────────────────────────────────────────

  it("does NOT mark seeded when an upsert fails, and releases the guard", async () => {
    const fake = makeFakeRunner({ environmentId: "env-a", failAllUpserts: true });

    await runCodexMicroSeed(fake.deps);

    // First upsert attempted, then rejected → aborts before appending/marking.
    expect(fake.upserts.length).toBeGreaterThanOrEqual(1);
    expect(fake.appended).toEqual([]);
    expect(fake.session.has("env-a")).toBe(false);
    // In-progress guard released so a retry is possible.
    expect(fake.inProgress.size).toBe(0);
    expect(fake.runEnded).toBe(true);
  });

  it("aborts on a partial mid-loop failure without appending, then retries clean", async () => {
    // Fail specifically on f17 → the first few upserts are attempted, then it
    // rejects; nothing is marked so a later `connected` event can retry.
    const fake = makeFakeRunner({ environmentId: "env-a", failUpsertOnKey: "f17" });

    await runCodexMicroSeed(fake.deps);
    expect(fake.appended).toEqual([]);
    expect(fake.session.has("env-a")).toBe(false);
    const attemptedBeforeRetry = fake.upserts.length;
    expect(attemptedBeforeRetry).toBeGreaterThanOrEqual(1);

    // Clear the fault and retry (the session guard must NOT block this).
    fake.failUpsertOnKey = null;
    fake.upserts.length = 0;
    await runCodexMicroSeed(fake.deps);
    expect(fake.upserts).toHaveLength(8);
    expect(fake.appended).toEqual(["env-a"]);
  });

  // ── A5 capacity ─────────────────────────────────────────────────────

  it("seeds nothing but marks the environment when capacity would overflow", async () => {
    // 250 existing rules + 8 seed rules = 258 > cap → seed nothing, mark done.
    const existingRules: ResolvedKeybindingsConfig = Array.from({ length: 250 }, () =>
      resolvedRule("ctrl+alt+p", "sidebar.toggle"),
    );
    const fake = makeFakeRunner({
      environmentId: "env-a",
      existingRules,
      maxKeybindings: 256,
    });

    await runCodexMicroSeed(fake.deps);

    expect(fake.upserts).toEqual([]);
    expect(fake.appended).toEqual(["env-a"]);
    expect(fake.session.has("env-a")).toBe(true);
  });

  // ── A4 TOCTOU ───────────────────────────────────────────────────────

  it("skips a rule whose key was taken between planning and upsert", async () => {
    // The plan is computed against an empty config (all 8 free), but f13 is
    // taken immediately after — the per-upsert re-check must skip it.
    const fake = makeFakeRunner({
      environmentId: "env-a",
      takeAfterPlan: { key: "f13", command: "sidebar.toggle" },
    });

    await runCodexMicroSeed(fake.deps);

    // f13 skipped → 7 upserts, but still marked seeded (a successful run).
    expect(fake.upserts).toHaveLength(7);
    expect(fake.upserts.some((entry) => entry.input.key === "f13")).toBe(false);
    expect(fake.appended).toEqual(["env-a"]);
  });
});
