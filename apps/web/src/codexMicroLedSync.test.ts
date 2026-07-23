import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AGENT_KEY_SLOT_COUNT,
  type CodexMicroLedFrame,
  EnvironmentId,
  ProviderInstanceId,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_RUNTIME_MODE } from "./types";

import type { AgentKeySlots } from "./agentKeySlots";
import {
  createLedFramePusher,
  LED_COLOR_AMBER,
  LED_COLOR_BLACK,
  LED_COLOR_EMERALD,
  LED_COLOR_INDIGO,
  LED_COLOR_SKY,
  LED_COLOR_VIOLET,
  LED_FRAME_ALL_OFF,
  LED_SLOT_OFF,
  ledFrameForSlots,
  ledFramesEqual,
  type CodexMicroLedStatusInput,
} from "./codexMicroLedSync";

const ENV = EnvironmentId.make("env-a");

function ref(id: string): ScopedThreadRef {
  return scopeThreadRef(ENV, ThreadId.make(id));
}

/** Pad a list of refs to a full six-slot mapping with trailing nulls. */
function slotsOf(...refs: Array<ScopedThreadRef | null>): AgentKeySlots {
  const slots: Array<ScopedThreadRef | null> = [...refs];
  while (slots.length < AGENT_KEY_SLOT_COUNT) slots.push(null);
  return slots.slice(0, AGENT_KEY_SLOT_COUNT);
}

const BASE_SESSION = {
  threadId: ThreadId.make("thread-1"),
  status: "ready" as const,
  providerName: "Codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: DEFAULT_RUNTIME_MODE,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-09T10:00:00.000Z",
};

const SETTLED_TURN = {
  turnId: "turn-1" as never,
  state: "completed" as const,
  assistantMessageId: null,
  requestedAt: "2026-03-09T10:00:00.000Z",
  startedAt: "2026-03-09T10:00:00.000Z",
  completedAt: "2026-03-09T10:05:00.000Z",
};

/** Idle by default (session ready, no turn/plan/visit) → resolves to no pill. */
function statusInput(overrides: Partial<CodexMicroLedStatusInput> = {}): CodexMicroLedStatusInput {
  return {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default",
    latestTurn: null,
    session: BASE_SESSION,
    ...overrides,
  } as CodexMicroLedStatusInput;
}

/** Build the single-slot frame produced for one thread with the given status. */
function frameForOne(input: CodexMicroLedStatusInput): CodexMicroLedFrame {
  const slot = ref("t0");
  const map = new Map<string, CodexMicroLedStatusInput>([[scopedThreadKey(slot), input]]);
  return ledFrameForSlots(slotsOf(slot), map);
}

describe("ledFrameForSlots — status → color/effect mapping", () => {
  it("maps pending approval to amber solid", () => {
    expect(frameForOne(statusInput({ hasPendingApprovals: true }))[0]).toEqual({
      effect: "solid",
      color: LED_COLOR_AMBER,
    });
  });

  it("maps awaiting input to indigo solid", () => {
    expect(frameForOne(statusInput({ hasPendingUserInput: true }))[0]).toEqual({
      effect: "solid",
      color: LED_COLOR_INDIGO,
    });
  });

  it("maps working (running session) to sky pulse", () => {
    const input = statusInput({
      session: { ...BASE_SESSION, status: "running", activeTurnId: "turn-1" as never },
    });
    expect(frameForOne(input)[0]).toEqual({ effect: "pulse", color: LED_COLOR_SKY });
  });

  it("maps connecting (starting session) to sky pulse — identical to working", () => {
    const working = frameForOne(
      statusInput({
        session: { ...BASE_SESSION, status: "running", activeTurnId: "turn-1" as never },
      }),
    );
    const connecting = frameForOne(
      statusInput({
        session: { ...BASE_SESSION, status: "starting", activeTurnId: "turn-1" as never },
      }),
    );
    expect(connecting[0]).toEqual({ effect: "pulse", color: LED_COLOR_SKY });
    // Both blocked-in-motion states collapse to the SAME single LED state.
    expect(connecting[0]).toEqual(working[0]);
  });

  it("maps plan ready to violet solid", () => {
    const input = statusInput({
      interactionMode: "plan",
      hasActionableProposedPlan: true,
      latestTurn: SETTLED_TURN,
      session: { ...BASE_SESSION, status: "ready", activeTurnId: null },
    });
    expect(frameForOne(input)[0]).toEqual({ effect: "solid", color: LED_COLOR_VIOLET });
  });

  it("maps unseen completion to emerald solid", () => {
    const input = statusInput({
      latestTurn: SETTLED_TURN,
      // completedAt (10:05) is newer than the last visit (10:04) → unseen.
      lastVisitedAt: "2026-03-09T10:04:00.000Z",
    });
    expect(frameForOne(input)[0]).toEqual({ effect: "solid", color: LED_COLOR_EMERALD });
  });

  it("maps idle / no-status to off (black)", () => {
    expect(frameForOne(statusInput())[0]).toEqual(LED_SLOT_OFF);
    expect(frameForOne(statusInput())[0]).toEqual({ effect: "off", color: LED_COLOR_BLACK });
  });

  it("maps a null slot to off", () => {
    const frame = ledFrameForSlots(slotsOf(null), new Map());
    expect(frame[0]).toEqual(LED_SLOT_OFF);
  });

  it("maps a slotted thread with no status input to off", () => {
    // Slot references t0 but the map is empty → cannot resolve → off.
    const frame = ledFrameForSlots(slotsOf(ref("t0")), new Map());
    expect(frame[0]).toEqual(LED_SLOT_OFF);
  });

  it("always returns exactly six slots and fills empties with off", () => {
    const slot = ref("t0");
    const map = new Map<string, CodexMicroLedStatusInput>([
      [scopedThreadKey(slot), statusInput({ hasPendingApprovals: true })],
    ]);
    const frame = ledFrameForSlots(slotsOf(slot), map);
    expect(frame).toHaveLength(AGENT_KEY_SLOT_COUNT);
    expect(frame[0]).toEqual({ effect: "solid", color: LED_COLOR_AMBER });
    for (let index = 1; index < AGENT_KEY_SLOT_COUNT; index++) {
      expect(frame[index]).toEqual(LED_SLOT_OFF);
    }
  });
});

describe("visit-state-driven Completed", () => {
  it("lights emerald while completion is unseen, then goes off after visiting", () => {
    const unseen = frameForOne(
      statusInput({ latestTurn: SETTLED_TURN, lastVisitedAt: "2026-03-09T10:04:00.000Z" }),
    );
    expect(unseen[0]).toEqual({ effect: "solid", color: LED_COLOR_EMERALD });

    // "Visit" the thread: lastVisitedAt now newer than completedAt → seen → off.
    const seen = frameForOne(
      statusInput({ latestTurn: SETTLED_TURN, lastVisitedAt: "2026-03-09T10:06:00.000Z" }),
    );
    expect(seen[0]).toEqual(LED_SLOT_OFF);
  });
});

// ── Coalescing scheduler ────────────────────────────────────────────────

/** Single-slot manual timer (the pusher only ever has one outstanding). */
function fakeTimer() {
  let pending: (() => void) | null = null;
  return {
    setTimer: (callback: () => void) => {
      pending = callback;
      return 1;
    },
    clearTimer: () => {
      pending = null;
    },
    /** Fire the outstanding trailing-window callback, if any. */
    fire: () => {
      const callback = pending;
      pending = null;
      callback?.();
    },
    hasPending: () => pending !== null,
  };
}

function amberFrame(): CodexMicroLedFrame {
  return ledFrameForSlots(
    slotsOf(ref("t0")),
    new Map([[scopedThreadKey(ref("t0")), statusInput({ hasPendingApprovals: true })]]),
  );
}

function indigoFrame(): CodexMicroLedFrame {
  return ledFrameForSlots(
    slotsOf(ref("t0")),
    new Map([[scopedThreadKey(ref("t0")), statusInput({ hasPendingUserInput: true })]]),
  );
}

describe("createLedFramePusher — coalescing", () => {
  it("collapses three rapid frames in one window into a single push with the LAST frame", () => {
    const pushed: CodexMicroLedFrame[] = [];
    const timer = fakeTimer();
    const pusher = createLedFramePusher({
      push: (frame) => pushed.push(frame),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    pusher.submit(amberFrame());
    pusher.submit(indigoFrame());
    const last = amberFrame();
    pusher.submit(last);
    // Nothing sent until the window closes.
    expect(pushed).toHaveLength(0);

    timer.fire();
    expect(pushed).toHaveLength(1);
    expect(ledFramesEqual(pushed[0]!, last)).toBe(true);
  });

  it("does not re-push a frame identical to the last one pushed", () => {
    const pushed: CodexMicroLedFrame[] = [];
    const timer = fakeTimer();
    const pusher = createLedFramePusher({
      push: (frame) => pushed.push(frame),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    pusher.submit(amberFrame());
    timer.fire();
    expect(pushed).toHaveLength(1);

    // A structurally identical frame in a new window must be suppressed.
    pusher.submit(amberFrame());
    timer.fire();
    expect(pushed).toHaveLength(1);
  });

  it("pushes a distinct frame in a subsequent window", () => {
    const pushed: CodexMicroLedFrame[] = [];
    const timer = fakeTimer();
    const pusher = createLedFramePusher({
      push: (frame) => pushed.push(frame),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    pusher.submit(amberFrame());
    timer.fire();
    pusher.submit(indigoFrame());
    timer.fire();

    expect(pushed).toHaveLength(2);
    expect(ledFramesEqual(pushed[1]!, indigoFrame())).toBe(true);
  });

  it("forceOff pushes a single all-off frame then nothing more", () => {
    const pushed: CodexMicroLedFrame[] = [];
    const timer = fakeTimer();
    const pusher = createLedFramePusher({
      push: (frame) => pushed.push(frame),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    // Establish a lit state first.
    pusher.submit(amberFrame());
    timer.fire();
    expect(pushed).toHaveLength(1);

    pusher.forceOff();
    expect(pushed).toHaveLength(2);
    expect(ledFramesEqual(pushed[1]!, LED_FRAME_ALL_OFF)).toBe(true);
    // Any pending window was cancelled; nothing lingers to fire.
    expect(timer.hasPending()).toBe(false);

    // A second gate-off is a no-op (already off — deduped).
    pusher.forceOff();
    expect(pushed).toHaveLength(2);
  });

  it("forceOff cancels a pending window instead of pushing the trailing frame", () => {
    const pushed: CodexMicroLedFrame[] = [];
    const timer = fakeTimer();
    const pusher = createLedFramePusher({
      push: (frame) => pushed.push(frame),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    pusher.submit(amberFrame());
    // Window still open; gate off before it closes.
    pusher.forceOff();
    expect(pushed).toHaveLength(1);
    expect(ledFramesEqual(pushed[0]!, LED_FRAME_ALL_OFF)).toBe(true);
    // Firing a stale timer must do nothing (it was cleared).
    timer.fire();
    expect(pushed).toHaveLength(1);
  });
});
