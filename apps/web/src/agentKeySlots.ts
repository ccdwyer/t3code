import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AGENT_KEY_SLOT_COUNT,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

// ── Agent-key slot store ─────────────────────────────────────────────
//
// The Codex Micro pad exposes six RGB agent keys. This module owns the ONE
// canonical mapping of `[ScopedThreadRef | null] × AGENT_KEY_SLOT_COUNT` that
// both consumers read (spec §4, the review blocker):
//
//   - the LED sync module (T8) mirrors chat status onto `slots[n]`, and
//   - the agent-key dispatch path (T7) opens `slots[n]` directly.
//
// Because both read THIS store's `slots`, a key press and its LED always
// point at the same thread — closing the "glow one chat, open another" bug
// that `thread.jump.N` (sidebar-derived ordering) would reintroduce.
//
// The store is a self-contained, dependency-free zustand store (mirroring
// `uiStateStore`) plus a fully-pure core (`computeAgentKeySlots`). It does NOT
// subscribe to the thread list itself — later tasks mount a live subscription
// by calling `setAgentKeyRankedThreads` (see the header of that function). No
// LED / color / dispatch logic lives here.

/** A single agent-key slot: a thread reference, or empty. */
export type AgentKeySlot = ScopedThreadRef | null;

/** The full six-slot mapping. Always length `AGENT_KEY_SLOT_COUNT`. */
export type AgentKeySlots = readonly AgentKeySlot[];

/**
 * Hysteresis window. A slot keeps its thread as long as that thread stays
 * within the top `HYSTERESIS_WINDOW` of the recency ranking; only when it
 * drops below (or disappears) is the slot freed. Wider than the six slots on
 * purpose — that gap is the dead-band that stops the LEDs shuffling when the
 * top chats merely trade places.
 */
export const HYSTERESIS_WINDOW = 9;

const EMPTY_SLOTS: AgentKeySlots = Object.freeze(
  Array.from({ length: AGENT_KEY_SLOT_COUNT }, () => null),
);

/** Minimal shape needed to rank a thread for the agent keys. */
export interface AgentKeyRankableThread {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly updatedAt: string;
  /** Archived threads are excluded (mirrors the sidebar's live-thread filter).
      Deleted threads simply never appear in the input list. */
  readonly archivedAt?: string | null;
}

/**
 * NaN-safe `updatedAt` parse. Invalid/malformed timestamps sink to the very
 * bottom of the ranking (NEGATIVE_INFINITY) rather than poisoning the sort —
 * the same defensive intent as `Sidebar.logic.ts` `parseTimestampMs`, but
 * using -Infinity (not 0) so an invalid timestamp is guaranteed to rank LAST
 * even against pre-epoch dates.
 */
function updatedAtRankMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Rank candidate threads for the agent keys: archived threads dropped, then
 * ordered by `updatedAt` recency (most recent first). Ties (including two
 * invalid timestamps) break deterministically by scoped key so the ordering
 * is stable across runs. Returns plain `ScopedThreadRef`s ready to feed
 * `computeAgentKeySlots` / `setAgentKeyRankedThreads`.
 */
export function rankThreadsForAgentKeys(
  threads: readonly AgentKeyRankableThread[],
): ScopedThreadRef[] {
  return threads
    .filter((thread) => thread.archivedAt == null)
    .map((thread) => ({
      ref: { environmentId: thread.environmentId, threadId: thread.threadId },
      rankMs: updatedAtRankMs(thread.updatedAt),
    }))
    .sort((left, right) => {
      if (right.rankMs !== left.rankMs) return right.rankMs - left.rankMs;
      return scopedThreadKey(left.ref).localeCompare(scopedThreadKey(right.ref));
    })
    .map((entry) => entry.ref);
}

/**
 * PURE hysteresis core. Given the previous slot assignment and the freshly
 * ranked thread refs (most-recent first), produce the next assignment:
 *
 *  1. Each occupied slot keeps its thread iff that thread is still within the
 *     top `HYSTERESIS_WINDOW` and not already claimed by an earlier slot
 *     (a thread never occupies two slots).
 *  2. Remaining free slots are filled — lowest free index first — from the
 *     highest-ranked threads not already slotted.
 *
 * Kept refs are re-read from `rankedThreadRefs` so slot identity stays fresh.
 * A slot is freed only when its thread leaves the window or vanishes, so slots
 * stay put under rank churn inside the window (no LED shuffle — the point).
 */
export function computeAgentKeySlots(
  previousSlots: AgentKeySlots,
  rankedThreadRefs: readonly ScopedThreadRef[],
): AgentKeySlots {
  // Dedupe BEFORE assigning ranks: a duplicate entry must not inflate the
  // indices of the unique threads behind it, or an in-window thread could be
  // pushed past the hysteresis boundary and falsely evicted.
  const uniqueRefs: ScopedThreadRef[] = [];
  const rankByKey = new Map<string, number>();
  for (const candidate of rankedThreadRefs) {
    const key = scopedThreadKey(candidate);
    if (rankByKey.has(key)) continue;
    rankByKey.set(key, uniqueRefs.length);
    uniqueRefs.push(candidate);
  }

  const claimedKeys = new Set<string>();
  const nextSlots: AgentKeySlot[] = Array.from({ length: AGENT_KEY_SLOT_COUNT }, () => null);

  // 1. Retain in-window threads in their existing slot.
  for (let slot = 0; slot < AGENT_KEY_SLOT_COUNT; slot++) {
    const previous = previousSlots[slot] ?? null;
    if (previous === null) continue;
    const key = scopedThreadKey(previous);
    const rank = rankByKey.get(key);
    if (rank !== undefined && rank < HYSTERESIS_WINDOW && !claimedKeys.has(key)) {
      nextSlots[slot] = uniqueRefs[rank] ?? previous;
      claimedKeys.add(key);
    }
  }

  // 2. Fill free slots (lowest index first) with the highest-ranked unslotted
  //    threads.
  let cursor = 0;
  for (let slot = 0; slot < AGENT_KEY_SLOT_COUNT; slot++) {
    if (nextSlots[slot] !== null) continue;
    while (cursor < uniqueRefs.length && claimedKeys.has(scopedThreadKey(uniqueRefs[cursor]!))) {
      cursor++;
    }
    if (cursor >= uniqueRefs.length) break;
    const ref = uniqueRefs[cursor]!;
    nextSlots[slot] = ref;
    claimedKeys.add(scopedThreadKey(ref));
    cursor++;
  }

  return nextSlots;
}

/** Structural equality for two slot mappings (by scoped key / null). */
export function agentKeySlotsEqual(left: AgentKeySlots, right: AgentKeySlots): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index] ?? null;
    const b = right[index] ?? null;
    if (a === null || b === null) {
      if (a !== b) return false;
      continue;
    }
    if (scopedThreadKey(a) !== scopedThreadKey(b)) return false;
  }
  return true;
}

// ── Store ────────────────────────────────────────────────────────────

interface AgentKeySlotsStore {
  readonly slots: AgentKeySlots;
  /** Recompute slots from a fresh ranking; keeps the previous array reference
      when nothing changed so subscribers don't re-render needlessly. */
  setRankedThreads: (rankedThreadRefs: readonly ScopedThreadRef[]) => void;
  /** Clear all slots (e.g. on sign-out / environment teardown). */
  reset: () => void;
}

export const useAgentKeySlotsStore = create<AgentKeySlotsStore>((set, get) => ({
  slots: EMPTY_SLOTS,
  setRankedThreads: (rankedThreadRefs) => {
    const previous = get().slots;
    const next = computeAgentKeySlots(previous, rankedThreadRefs);
    if (agentKeySlotsEqual(previous, next)) return;
    set({ slots: next });
  },
  reset: () => {
    if (agentKeySlotsEqual(get().slots, EMPTY_SLOTS)) return;
    set({ slots: EMPTY_SLOTS });
  },
}));

/** Selector: the six-slot mapping. Both the hook and the imperative accessors
    below read through this one field, so press and LED share a source. */
export function selectAgentKeySlots(state: AgentKeySlotsStore): AgentKeySlots {
  return state.slots;
}

/**
 * React hook returning the six agent-key slots. Consumers (the LED sync view
 * in T8) subscribe here; it reads the SAME `slots` field the dispatch-path
 * accessors below read.
 */
export function useAgentKeySlots(): AgentKeySlots {
  return useAgentKeySlotsStore(selectAgentKeySlots);
}

/** Hook for a single slot by index (0-based). */
export function useAgentKeySlot(index: number): AgentKeySlot {
  return useAgentKeySlotsStore((state) => state.slots[index] ?? null);
}

/**
 * Imperative read of all slots — for the non-React key-dispatch path (T7).
 * Returns the exact same array `useAgentKeySlots()` observes.
 */
export function getAgentKeySlots(): AgentKeySlots {
  return useAgentKeySlotsStore.getState().slots;
}

/**
 * Imperative accessor for the thread behind agent key `index` (0-based). This
 * is the source of truth the key-press handler opens — never `thread.jump.N`.
 * Out-of-range indices return null.
 */
export function getAgentKeySlot(index: number): AgentKeySlot {
  return useAgentKeySlotsStore.getState().slots[index] ?? null;
}

/**
 * Imperative updater the live subscription mounts onto (T7/T8). Given the
 * ranked thread refs (from `rankThreadsForAgentKeys`), recompute and publish
 * the slots. Safe to call on every thread-list change; a no-op when the
 * mapping is unchanged.
 */
export function setAgentKeyRankedThreads(rankedThreadRefs: readonly ScopedThreadRef[]): void {
  useAgentKeySlotsStore.getState().setRankedThreads(rankedThreadRefs);
}

/** Reset the mapping (imperative form of the store action). */
export function resetAgentKeySlots(): void {
  useAgentKeySlotsStore.getState().reset();
}
