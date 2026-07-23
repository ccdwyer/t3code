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
}

function makeFakeRunner(options: {
  environmentId: string | null;
  existingRules?: ResolvedKeybindingsConfig;
  seededEnvironments?: string[];
}): FakeRunner {
  const upserts: Array<{ environmentId: string; input: ServerUpsertKeybindingInput }> = [];
  const appended: string[] = [];
  const session = new Set<string>();
  const state: FakeRunner = {
    upserts,
    appended,
    seededEnvironments: options.seededEnvironments ? [...options.seededEnvironments] : [],
    deps: {
      getEnvironmentId: () => options.environmentId,
      getExistingRules: () => options.existingRules ?? EMPTY_CONFIG,
      getSeededEnvironments: () => state.seededEnvironments,
      upsertKeybinding: async (environmentId, input) => {
        upserts.push({ environmentId, input });
      },
      appendSeededEnvironment: (environmentId) => {
        appended.push(environmentId);
        if (!state.seededEnvironments.includes(environmentId)) {
          state.seededEnvironments = [...state.seededEnvironments, environmentId];
        }
      },
      hasSeededThisSession: (environmentId) => session.has(environmentId),
      markSeededThisSession: (environmentId) => {
        session.add(environmentId);
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
});
