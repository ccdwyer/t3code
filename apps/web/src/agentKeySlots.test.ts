import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AGENT_KEY_SLOT_COUNT,
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  agentKeySlotsEqual,
  computeAgentKeySlots,
  getAgentKeySlot,
  getAgentKeySlots,
  HYSTERESIS_WINDOW,
  rankThreadsForAgentKeys,
  resetAgentKeySlots,
  selectAgentKeySlots,
  setAgentKeyRankedThreads,
  useAgentKeySlotsStore,
  type AgentKeyRankableThread,
  type AgentKeySlots,
} from "./agentKeySlots";

const ENV = EnvironmentId.make("env-a");
const OTHER_ENV = EnvironmentId.make("env-b");

function ref(id: string, env: EnvironmentId = ENV): ScopedThreadRef {
  return scopeThreadRef(env, ThreadId.make(id));
}

/** Build `count` ranked refs t0..t(count-1) where t0 is most recent. */
function rankedRefs(count: number): ScopedThreadRef[] {
  return Array.from({ length: count }, (_, index) => ref(`t${index}`));
}

const EMPTY: AgentKeySlots = Array.from({ length: AGENT_KEY_SLOT_COUNT }, () => null);

function keys(slots: AgentKeySlots): Array<string | null> {
  return slots.map((slot) => (slot === null ? null : scopedThreadKey(slot)));
}

describe("computeAgentKeySlots — initial fill", () => {
  it("fills the six most-recent threads into slots 0-5, most recent first", () => {
    const result = computeAgentKeySlots(EMPTY, rankedRefs(10));
    expect(keys(result)).toEqual([
      "env-a:t0",
      "env-a:t1",
      "env-a:t2",
      "env-a:t3",
      "env-a:t4",
      "env-a:t5",
    ]);
  });

  it("leaves trailing nulls when fewer than six threads exist", () => {
    const result = computeAgentKeySlots(EMPTY, rankedRefs(3));
    expect(keys(result)).toEqual(["env-a:t0", "env-a:t1", "env-a:t2", null, null, null]);
  });

  it("returns an all-null mapping when there are no threads", () => {
    const result = computeAgentKeySlots(EMPTY, []);
    expect(keys(result)).toEqual([null, null, null, null, null, null]);
    expect(result).toHaveLength(AGENT_KEY_SLOT_COUNT);
  });
});

describe("computeAgentKeySlots — hysteresis stability", () => {
  it("keeps a slot's thread while it stays within the top-9 window (rank 7)", () => {
    const initial = computeAgentKeySlots(EMPTY, rankedRefs(6));
    // t2 (slot 2) sinks to rank 7 — two fresh chats jump ahead of it, still
    // in-window. It must NOT be evicted, and its slot must not move.
    const churned: ScopedThreadRef[] = [
      ref("n0"),
      ref("n1"),
      ref("t0"),
      ref("t1"),
      ref("t3"),
      ref("t4"),
      ref("t5"),
      ref("t2"), // rank 7
      ref("n2"),
    ];
    const next = computeAgentKeySlots(initial, churned);
    expect(next[2] && scopedThreadKey(next[2])).toBe("env-a:t2");
  });

  it("does not shuffle slots when top chats merely trade places inside the window", () => {
    const initial = computeAgentKeySlots(EMPTY, rankedRefs(6));
    // Reverse the top-6 order entirely; all remain in-window so every slot
    // holds its original thread — zero shuffle.
    const reversed = [...rankedRefs(6)].reverse();
    const next = computeAgentKeySlots(initial, reversed);
    expect(keys(next)).toEqual(keys(initial));
  });

  it("treats rank exactly at the window boundary (8, 0-based) as still retained", () => {
    const initial = computeAgentKeySlots(EMPTY, rankedRefs(6));
    // t0 (slot 0) drops to rank 8 (< HYSTERESIS_WINDOW === 9) → retained.
    const churned = [
      ...Array.from({ length: 8 }, (_, i) => ref(`n${i}`)),
      ref("t0"), // rank 8
    ];
    const next = computeAgentKeySlots(initial, churned);
    expect(next[0] && scopedThreadKey(next[0])).toBe("env-a:t0");
    expect(HYSTERESIS_WINDOW).toBe(9);
  });
});

describe("computeAgentKeySlots — eviction and refill", () => {
  it("frees a slot when its thread falls below the window and refills from the top unslotted", () => {
    const initial = computeAgentKeySlots(EMPTY, rankedRefs(6));
    // t3 (slot 3) drops to rank 10 (>= 9) and a new chat n-fresh leads.
    const churned: ScopedThreadRef[] = [
      ref("t0"),
      ref("t1"),
      ref("t2"),
      ref("t4"),
      ref("t5"),
      ref("h6"),
      ref("h7"),
      ref("h8"),
      ref("h9"),
      ref("t3"), // rank 10 → evicted
    ];
    const next = computeAgentKeySlots(initial, churned);
    // slot 3 no longer holds t3; it is refilled by the highest-ranked
    // unslotted thread (h6 at rank 5 — ranks 0-4 are held in slots 0,1,2,4,5).
    expect(next[3] && scopedThreadKey(next[3])).toBe("env-a:h6");
    expect(keys(next)).not.toContain("env-a:t3");
  });

  it("frees a slot when its thread disappears entirely", () => {
    const initial = computeAgentKeySlots(EMPTY, rankedRefs(6));
    // t5 gone from the ranking; a fresh chat takes the freed slot 5.
    const churned = [ref("t0"), ref("t1"), ref("t2"), ref("t3"), ref("t4"), ref("fresh")];
    const next = computeAgentKeySlots(initial, churned);
    expect(next[5] && scopedThreadKey(next[5])).toBe("env-a:fresh");
  });

  it("fills a newly-free slot with a brand-new thread deterministically (lowest index first)", () => {
    // Start with slot 2 empty (only 5 threads previously, packed 0,1,3? no —
    // packing is lowest-index-first, so build a real hole via eviction).
    const initial = computeAgentKeySlots(EMPTY, [ref("a"), ref("b")]);
    expect(keys(initial)).toEqual(["env-a:a", "env-a:b", null, null, null, null]);
    // Two new threads arrive; they fill the lowest free indices (2, then 3).
    const next = computeAgentKeySlots(initial, [ref("a"), ref("b"), ref("c"), ref("d")]);
    expect(keys(next)).toEqual(["env-a:a", "env-a:b", "env-a:c", "env-a:d", null, null]);
  });
});

describe("computeAgentKeySlots — invariants", () => {
  it("never places one thread in two slots", () => {
    // Malicious previous state: same thread duplicated across slots 0 and 1.
    const dup = ref("dup");
    const previous: AgentKeySlots = [dup, dup, null, null, null, null];
    const next = computeAgentKeySlots(previous, [ref("dup"), ref("x"), ref("y")]);
    const nonNull = keys(next).filter((k): k is string => k !== null);
    expect(new Set(nonNull).size).toBe(nonNull.length);
    expect(nonNull).toContain("env-a:dup");
  });

  it("dedupes by (environmentId, threadId) — same threadId across environments are distinct", () => {
    const sameIdOtherEnv = ref("same", OTHER_ENV);
    const next = computeAgentKeySlots(EMPTY, [ref("same"), sameIdOtherEnv]);
    expect(keys(next).slice(0, 2)).toEqual(["env-a:same", "env-b:same"]);
  });

  it("always returns exactly AGENT_KEY_SLOT_COUNT slots", () => {
    expect(computeAgentKeySlots(EMPTY, rankedRefs(100))).toHaveLength(AGENT_KEY_SLOT_COUNT);
    expect(computeAgentKeySlots(EMPTY, [])).toHaveLength(AGENT_KEY_SLOT_COUNT);
  });
});

describe("rankThreadsForAgentKeys", () => {
  function thread(
    id: string,
    updatedAt: string,
    extra?: Partial<AgentKeyRankableThread>,
  ): AgentKeyRankableThread {
    return { environmentId: ENV, threadId: ThreadId.make(id), updatedAt, ...extra };
  }

  it("orders by updatedAt recency, most recent first", () => {
    const ranked = rankThreadsForAgentKeys([
      thread("old", "2026-01-01T00:00:00.000Z"),
      thread("new", "2026-07-01T00:00:00.000Z"),
      thread("mid", "2026-04-01T00:00:00.000Z"),
    ]);
    expect(ranked.map((r) => r.threadId)).toEqual(["new", "mid", "old"]);
  });

  it("excludes archived threads (mirrors the sidebar live-thread filter)", () => {
    const ranked = rankThreadsForAgentKeys([
      thread("live", "2026-07-01T00:00:00.000Z"),
      thread("archived", "2026-07-02T00:00:00.000Z", { archivedAt: "2026-07-03T00:00:00.000Z" }),
    ]);
    expect(ranked.map((r) => r.threadId)).toEqual(["live"]);
  });

  it("sinks invalid/NaN timestamps to the bottom without crashing", () => {
    const ranked = rankThreadsForAgentKeys([
      thread("bad", "not-a-date"),
      thread("good", "2026-07-01T00:00:00.000Z"),
      thread("empty", ""),
    ]);
    expect(ranked[0]!.threadId).toBe("good");
    // Both invalid entries rank last, tie-broken deterministically by key.
    expect(
      ranked
        .slice(1)
        .map((r) => r.threadId)
        .sort(),
    ).toEqual(["bad", "empty"]);
  });

  it("breaks ties deterministically by scoped key", () => {
    const ts = "2026-07-01T00:00:00.000Z";
    const a = rankThreadsForAgentKeys([thread("b", ts), thread("a", ts), thread("c", ts)]);
    const b = rankThreadsForAgentKeys([thread("c", ts), thread("b", ts), thread("a", ts)]);
    expect(a.map((r) => r.threadId)).toEqual(["a", "b", "c"]);
    expect(a.map((r) => r.threadId)).toEqual(b.map((r) => r.threadId));
  });

  it("feeds cleanly into computeAgentKeySlots", () => {
    const ranked = rankThreadsForAgentKeys(
      Array.from({ length: 8 }, (_, i) =>
        thread(`t${i}`, new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()),
      ),
    );
    // t7 is newest (largest timestamp) → slot 0.
    const slots = computeAgentKeySlots(EMPTY, ranked);
    expect(slots[0]!.threadId).toBe("t7");
    expect(slots).toHaveLength(AGENT_KEY_SLOT_COUNT);
  });
});

describe("store + press↔LED identity", () => {
  beforeEach(() => {
    resetAgentKeySlots();
  });

  it("publishes computed slots through the store and hook selector", () => {
    setAgentKeyRankedThreads(rankedRefs(6));
    const stateSlots = selectAgentKeySlots(useAgentKeySlotsStore.getState());
    expect(keys(stateSlots)).toEqual([
      "env-a:t0",
      "env-a:t1",
      "env-a:t2",
      "env-a:t3",
      "env-a:t4",
      "env-a:t5",
    ]);
  });

  it("feeds BOTH consumers from ONE source of truth (getAgentKeySlot === useAgentKeySlots source)", () => {
    setAgentKeyRankedThreads(rankedRefs(6));

    // The LED-sync consumer reads via the hook selector; the key-press
    // consumer reads via getAgentKeySlot. Both resolve to the identical
    // underlying array — same object reference, so they can never disagree.
    const ledSourceSlots = selectAgentKeySlots(useAgentKeySlotsStore.getState());
    const pressSourceSlots = getAgentKeySlots();
    expect(pressSourceSlots).toBe(ledSourceSlots);

    for (let index = 0; index < AGENT_KEY_SLOT_COUNT; index++) {
      // Per-index identity: the ref a key press opens IS the ref the LED lit.
      expect(getAgentKeySlot(index)).toBe(ledSourceSlots[index] ?? null);
    }
  });

  it("preserves hysteresis across successive store updates (uses previous slots)", () => {
    setAgentKeyRankedThreads(rankedRefs(6));
    const before = getAgentKeySlots();
    // t2 sinks to rank 7 (in-window): its slot must be retained across the update.
    setAgentKeyRankedThreads([
      ref("n0"),
      ref("n1"),
      ref("t0"),
      ref("t1"),
      ref("t3"),
      ref("t4"),
      ref("t5"),
      ref("t2"),
      ref("n2"),
    ]);
    const after = getAgentKeySlots();
    expect(after[2] && scopedThreadKey(after[2])).toBe("env-a:t2");
    expect(before[2] && scopedThreadKey(before[2])).toBe("env-a:t2");
  });

  it("keeps the previous array reference when the mapping is unchanged (no needless re-render)", () => {
    setAgentKeyRankedThreads(rankedRefs(6));
    const first = getAgentKeySlots();
    // Reorder within the window — same six threads, same slots → identical ref.
    setAgentKeyRankedThreads([...rankedRefs(6)].reverse());
    expect(getAgentKeySlots()).toBe(first);
  });

  it("reset clears all slots", () => {
    setAgentKeyRankedThreads(rankedRefs(6));
    resetAgentKeySlots();
    expect(keys(getAgentKeySlots())).toEqual([null, null, null, null, null, null]);
  });

  it("getAgentKeySlot returns null for out-of-range indices", () => {
    setAgentKeyRankedThreads(rankedRefs(6));
    expect(getAgentKeySlot(-1)).toBeNull();
    expect(getAgentKeySlot(AGENT_KEY_SLOT_COUNT)).toBeNull();
  });
});

describe("agentKeySlotsEqual", () => {
  it("is reference- and structure-aware", () => {
    const a: AgentKeySlots = [ref("x"), null, null, null, null, null];
    const b: AgentKeySlots = [ref("x"), null, null, null, null, null];
    expect(agentKeySlotsEqual(a, a)).toBe(true);
    expect(agentKeySlotsEqual(a, b)).toBe(true);
    expect(agentKeySlotsEqual(a, [ref("y"), null, null, null, null, null])).toBe(false);
    expect(agentKeySlotsEqual(a, [null, ref("x"), null, null, null, null])).toBe(false);
  });
});
