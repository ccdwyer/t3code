import {
  MessageId,
  PARK_ACTION_DRIFT_MESSAGES,
  StepRunId,
  type EnvironmentApi,
  type TicketAttachment,
  TicketId,
  WorkflowEventId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { stackedThreadToast, toastManager } from "../components/ui/toast";

import {
  filterBoardStateByQuery,
  getBoardRouteEmptyState,
  isParkActionDriftError,
  notifyTicketStatusChange,
  requestFreshTicketDetail,
  submitParkActionFromBoardRoute,
  submitTicketAnswerFromBoardRoute,
  submitTicketEditFromBoardRoute,
  submitTicketMessageEditFromBoardRoute,
} from "./_chat.$environmentId.board";

vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: vi.fn((options: Record<string, unknown>) => options),
  toastManager: { add: vi.fn() },
}));

describe("getBoardRouteEmptyState", () => {
  it("distinguishes no selection from a missing requested board", () => {
    expect(getBoardRouteEmptyState({ boardId: null, boardLoadError: null })).toEqual({
      title: "No board selected.",
      description: null,
    });

    expect(
      getBoardRouteEmptyState({
        boardId: "project-1__missing" as never,
        boardLoadError: "Workflow board project-1__missing was not found",
      }),
    ).toEqual({
      title: "Board not found.",
      description: "Workflow board project-1__missing was not found",
    });
  });
});

describe("board route ticket actions", () => {
  it("returns the answer RPC promise and reloads only after it resolves", async () => {
    let resolveAnswer: (() => void) | undefined;
    const rpcPromise = new Promise<void>((resolve) => {
      resolveAnswer = resolve;
    });
    const api = {
      workflow: {
        answerTicketStep: vi.fn(() => rpcPromise),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetail = vi.fn();
    const attachments = [] satisfies ReadonlyArray<TicketAttachment>;

    const result = submitTicketAnswerFromBoardRoute(
      api,
      {
        stepRunId: "step-awaiting",
        text: "Use the compatibility guard.",
        attachments,
      },
      reloadTicketDetail,
    );

    expect(api.workflow.answerTicketStep).toHaveBeenCalledWith({
      stepRunId: StepRunId.make("step-awaiting"),
      text: "Use the compatibility guard.",
      attachments,
    });
    expect(reloadTicketDetail).not.toHaveBeenCalled();

    resolveAnswer?.();
    await expect(result).resolves.toBeUndefined();
    expect(reloadTicketDetail).toHaveBeenCalledOnce();
  });

  it("propagates answer RPC failures without reloading", async () => {
    const api = {
      workflow: {
        answerTicketStep: vi.fn(async () => {
          throw new Error("answer failed");
        }),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetail = vi.fn();

    await expect(
      submitTicketAnswerFromBoardRoute(
        api,
        { stepRunId: "step-awaiting", text: "Try again." },
        reloadTicketDetail,
      ),
    ).rejects.toThrow("answer failed");
    expect(reloadTicketDetail).not.toHaveBeenCalled();
  });

  it("rejects ticket actions when the environment API is unavailable", async () => {
    await expect(
      submitTicketAnswerFromBoardRoute(
        null,
        { stepRunId: "step-awaiting", text: "Try again." },
        vi.fn(),
      ),
    ).rejects.toThrow("Environment API unavailable.");

    await expect(
      submitTicketEditFromBoardRoute(
        undefined,
        { ticketId: "ticket-1", title: "Updated" },
        vi.fn(),
      ),
    ).rejects.toThrow("Environment API unavailable.");
  });

  it("returns the edit RPC promise and reloads only after it resolves", async () => {
    const api = {
      workflow: {
        editTicket: vi.fn(async () => undefined),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetail = vi.fn();

    await expect(
      submitTicketEditFromBoardRoute(
        api,
        {
          ticketId: "ticket-1",
          title: "Retitle",
          description: "",
        },
        reloadTicketDetail,
      ),
    ).resolves.toBeUndefined();

    expect(api.workflow.editTicket).toHaveBeenCalledWith({
      ticketId: TicketId.make("ticket-1"),
      title: "Retitle",
      description: "",
    });
    expect(reloadTicketDetail).toHaveBeenCalledOnce();
  });

  it("edits a ticket message and reloads only after the RPC resolves", async () => {
    let resolveEdit: (() => void) | undefined;
    const rpcPromise = new Promise<void>((resolve) => {
      resolveEdit = resolve;
    });
    const api = {
      workflow: {
        editTicketMessage: vi.fn(() => rpcPromise),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetail = vi.fn();

    const result = submitTicketMessageEditFromBoardRoute(
      api,
      { ticketId: "ticket-1", messageId: "message-1", body: "Updated body." },
      reloadTicketDetail,
    );

    expect(api.workflow.editTicketMessage).toHaveBeenCalledWith({
      ticketId: TicketId.make("ticket-1"),
      messageId: MessageId.make("message-1"),
      body: "Updated body.",
    });
    expect(reloadTicketDetail).not.toHaveBeenCalled();

    resolveEdit?.();
    await expect(result).resolves.toBeUndefined();
    expect(reloadTicketDetail).toHaveBeenCalledOnce();
  });

  it("rejects ticket message edits when the environment API is unavailable", async () => {
    await expect(
      submitTicketMessageEditFromBoardRoute(
        null,
        { ticketId: "ticket-1", messageId: "message-1", body: "Updated body." },
        vi.fn(),
      ),
    ).rejects.toThrow("Environment API unavailable.");
  });
});

describe("submitParkActionFromBoardRoute", () => {
  const baseInput = {
    ticketId: "ticket-parked",
    actionIndex: 0,
    parkedEventId: "event-1",
  };

  it("reloads the open ticket's detail on a 'moved' result, without a toast", async () => {
    const api = {
      workflow: {
        invokeParkAction: vi.fn(async () => "moved" as const),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetailIfOpen = vi.fn();
    const pendingTicketIds = new Set<string>();

    await submitParkActionFromBoardRoute(api, baseInput, {
      reloadTicketDetailIfOpen,
      pendingTicketIds,
    });

    expect(api.workflow.invokeParkAction).toHaveBeenCalledWith({
      ticketId: TicketId.make("ticket-parked"),
      actionIndex: 0,
      parkedEventId: WorkflowEventId.make("event-1"),
    });
    expect(reloadTicketDetailIfOpen).toHaveBeenCalledOnce();
    expect(toastManager.add).not.toHaveBeenCalled();
    // The guard releases the ticket once the RPC settles.
    expect(pendingTicketIds.has("ticket-parked")).toBe(false);
  });

  it("reloads without a toast on a 'queued' result (re-admitted behind a WIP slot)", async () => {
    const api = {
      workflow: {
        invokeParkAction: vi.fn(async () => "queued" as const),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetailIfOpen = vi.fn();
    const pendingTicketIds = new Set<string>();

    await submitParkActionFromBoardRoute(api, baseInput, {
      reloadTicketDetailIfOpen,
      pendingTicketIds,
    });

    expect(reloadTicketDetailIfOpen).toHaveBeenCalledOnce();
    expect(toastManager.add).not.toHaveBeenCalled();
    expect(pendingTicketIds.has("ticket-parked")).toBe(false);
  });

  it("surfaces an informational toast and still reloads on a 'stale' result", async () => {
    const api = {
      workflow: {
        invokeParkAction: vi.fn(async () => "stale" as const),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetailIfOpen = vi.fn();

    await submitParkActionFromBoardRoute(api, baseInput, {
      reloadTicketDetailIfOpen,
      pendingTicketIds: new Set<string>(),
    });

    expect(stackedThreadToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Already handled — the board moved on.",
      }),
    );
    expect(toastManager.add).toHaveBeenCalledOnce();
    expect(reloadTicketDetailIfOpen).toHaveBeenCalledOnce();
  });

  it("surfaces an error toast (and does not reload) when the RPC rejects with a non-drift error", async () => {
    // A generic (non-drift) rejection must NOT reload the drawer detail — only
    // definition-drift errors repair the board/drawer (covered separately).
    const api = {
      workflow: {
        invokeParkAction: vi.fn(async () => {
          throw new Error("network unavailable");
        }),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetailIfOpen = vi.fn();
    const pendingTicketIds = new Set<string>();

    await expect(
      submitParkActionFromBoardRoute(api, baseInput, {
        reloadTicketDetailIfOpen,
        pendingTicketIds,
      }),
    ).resolves.toBeUndefined();

    expect(stackedThreadToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Couldn't update ticket",
        description: "network unavailable",
      }),
    );
    expect(reloadTicketDetailIfOpen).not.toHaveBeenCalled();
    expect(pendingTicketIds.has("ticket-parked")).toBe(false);
  });

  it("rejects when the environment API is unavailable, without touching the guard", async () => {
    const pendingTicketIds = new Set<string>();

    await expect(
      submitParkActionFromBoardRoute(null, baseInput, {
        reloadTicketDetailIfOpen: vi.fn(),
        pendingTicketIds,
      }),
    ).rejects.toThrow("Environment API unavailable.");

    expect(pendingTicketIds.size).toBe(0);
  });

  it("treats a second invocation for the same ticket as a no-op while the first is in flight", async () => {
    let resolveRpc: ((result: "moved") => void) | undefined;
    const rpcPromise = new Promise<"moved">((resolve) => {
      resolveRpc = resolve;
    });
    const api = {
      workflow: {
        invokeParkAction: vi.fn(() => rpcPromise),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetailIfOpen = vi.fn();
    const pendingTicketIds = new Set<string>();

    const first = submitParkActionFromBoardRoute(api, baseInput, {
      reloadTicketDetailIfOpen,
      pendingTicketIds,
    });
    // The ticket is now marked in-flight — a second invoke (e.g. a doubled
    // click) must not fire a second RPC.
    const second = submitParkActionFromBoardRoute(api, baseInput, {
      reloadTicketDetailIfOpen,
      pendingTicketIds,
    });

    expect(api.workflow.invokeParkAction).toHaveBeenCalledOnce();
    await expect(second).resolves.toBeUndefined();
    expect(reloadTicketDetailIfOpen).not.toHaveBeenCalled();

    resolveRpc?.("moved");
    await expect(first).resolves.toBeUndefined();
    expect(reloadTicketDetailIfOpen).toHaveBeenCalledOnce();
    expect(pendingTicketIds.has("ticket-parked")).toBe(false);

    // Once released, a subsequent invoke is no longer suppressed.
    await submitParkActionFromBoardRoute(api, baseInput, {
      reloadTicketDetailIfOpen,
      pendingTicketIds,
    });
    expect(api.workflow.invokeParkAction).toHaveBeenCalledTimes(2);
  });

  it("mirrors the guard into a shared set as it adds then releases the ticket", async () => {
    // The route backs the guard with a reactive mirror; prove the add/delete
    // lifecycle a plain Set (or the route's adapter) sees during one action.
    const seenDuring: boolean[] = [];
    let resolveRpc: ((r: "moved") => void) | undefined;
    const rpc = new Promise<"moved">((resolve) => {
      resolveRpc = resolve;
    });
    const pendingTicketIds = new Set<string>();
    const api = {
      workflow: { invokeParkAction: vi.fn(() => rpc) },
    } as unknown as EnvironmentApi;

    const settled = submitParkActionFromBoardRoute(api, baseInput, {
      reloadTicketDetailIfOpen: () => {},
      pendingTicketIds,
    });
    seenDuring.push(pendingTicketIds.has("ticket-parked")); // true while in flight
    resolveRpc?.("moved");
    await settled;
    seenDuring.push(pendingTicketIds.has("ticket-parked")); // false after settle
    expect(seenDuring).toEqual([true, false]);
  });

  it("triggers a board refresh (repair) on a definition-drift rejection, not a generic one", async () => {
    const driftApi = {
      workflow: {
        invokeParkAction: vi.fn(async () => {
          throw new Error("park actions unavailable — board definition changed");
        }),
      },
    } as unknown as EnvironmentApi;
    const onDefinitionDrift = vi.fn();
    await submitParkActionFromBoardRoute(driftApi, baseInput, {
      reloadTicketDetailIfOpen: vi.fn(),
      pendingTicketIds: new Set<string>(),
      onDefinitionDrift,
    });
    expect(onDefinitionDrift).toHaveBeenCalledOnce();

    const genericApi = {
      workflow: {
        invokeParkAction: vi.fn(async () => {
          throw new Error("network unavailable");
        }),
      },
    } as unknown as EnvironmentApi;
    const onDefinitionDriftGeneric = vi.fn();
    await submitParkActionFromBoardRoute(genericApi, baseInput, {
      reloadTicketDetailIfOpen: vi.fn(),
      pendingTicketIds: new Set<string>(),
      onDefinitionDrift: onDefinitionDriftGeneric,
    });
    expect(onDefinitionDriftGeneric).not.toHaveBeenCalled();
  });

  it("on drift refreshes BOTH the board and the open drawer detail for the failing ticket", async () => {
    const driftApi = {
      workflow: {
        invokeParkAction: vi.fn(async () => {
          throw new Error(
            `Failed to invoke workflow park action: ${PARK_ACTION_DRIFT_MESSAGES.definitionChanged}`,
          );
        }),
      },
    } as unknown as EnvironmentApi;
    const onDefinitionDrift = vi.fn();
    const reloadTicketDetailIfOpen = vi.fn();
    await submitParkActionFromBoardRoute(driftApi, baseInput, {
      reloadTicketDetailIfOpen,
      pendingTicketIds: new Set<string>(),
      onDefinitionDrift,
    });
    // Board repair (card/strip) AND drawer repair both fire — the drawer holds a
    // cached detail payload the board subscription cannot repair on its own.
    expect(onDefinitionDrift).toHaveBeenCalledOnce();
    expect(reloadTicketDetailIfOpen).toHaveBeenCalledOnce();
  });

  it("does not refresh the drawer detail on a generic (non-drift) rejection", async () => {
    const genericApi = {
      workflow: {
        invokeParkAction: vi.fn(async () => {
          throw new Error("network unavailable");
        }),
      },
    } as unknown as EnvironmentApi;
    const reloadTicketDetailIfOpen = vi.fn();
    await submitParkActionFromBoardRoute(genericApi, baseInput, {
      reloadTicketDetailIfOpen,
      pendingTicketIds: new Set<string>(),
      onDefinitionDrift: vi.fn(),
    });
    expect(reloadTicketDetailIfOpen).not.toHaveBeenCalled();
  });
});

describe("isParkActionDriftError", () => {
  it("matches the server's typed drift messages and nothing else", () => {
    expect(isParkActionDriftError("park actions unavailable — board definition changed")).toBe(
      true,
    );
    expect(isParkActionDriftError("park action index out of range")).toBe(true);
    expect(
      isParkActionDriftError(
        "park action targets lane 'gone' which no longer exists in the board definition",
      ),
    ).toBe(true);
    expect(isParkActionDriftError("network unavailable")).toBe(false);
    expect(isParkActionDriftError("Something went wrong. Please try again.")).toBe(false);
  });

  it("matches every shared PARK_ACTION_DRIFT_MESSAGES fragment (no hand-copied strings)", () => {
    expect(isParkActionDriftError(PARK_ACTION_DRIFT_MESSAGES.definitionChanged)).toBe(true);
    expect(isParkActionDriftError(PARK_ACTION_DRIFT_MESSAGES.indexOutOfRange)).toBe(true);
    // The lane-missing fragment is a suffix of the full server message.
    expect(
      isParkActionDriftError(
        `park action targets lane 'gone' which ${PARK_ACTION_DRIFT_MESSAGES.targetLaneMissing}`,
      ),
    ).toBe(true);
  });

  it("still matches after the RPC handler wraps the engine message for the wire", () => {
    // The invokeParkAction handler surfaces the engine cause as
    // `Failed to invoke workflow park action: <engine message>`; the matcher
    // must fire on that wire form for the board/drawer to repair.
    const prefix = "Failed to invoke workflow park action";
    expect(
      isParkActionDriftError(`${prefix}: ${PARK_ACTION_DRIFT_MESSAGES.definitionChanged}`),
    ).toBe(true);
    expect(isParkActionDriftError(`${prefix}: ${PARK_ACTION_DRIFT_MESSAGES.indexOutOfRange}`)).toBe(
      true,
    );
    expect(
      isParkActionDriftError(
        `${prefix}: park action targets lane 'gone' which ${PARK_ACTION_DRIFT_MESSAGES.targetLaneMissing}`,
      ),
    ).toBe(true);
    // The generic wrapper alone (no engine cause) must NOT be treated as drift.
    expect(isParkActionDriftError(prefix)).toBe(false);
  });
});

describe("requestFreshTicketDetail", () => {
  it("invalidates the open ticket's detail atom before bumping the reload key", () => {
    // Proves the reload FORCES a refetch (registry.refresh) rather than serving
    // the SWR-cached pre-action detail — the order matters so the subsequent
    // read sees a fresh value.
    const calls: string[] = [];
    const refreshTicketDetail = vi.fn(() => calls.push("refresh"));
    const bumpReloadKey = vi.fn(() => calls.push("bump"));

    requestFreshTicketDetail(TicketId.make("ticket-1"), {
      refreshTicketDetail,
      bumpReloadKey,
    });
    expect(refreshTicketDetail).toHaveBeenCalledWith(TicketId.make("ticket-1"));
    expect(bumpReloadKey).toHaveBeenCalledOnce();
    expect(calls).toEqual(["refresh", "bump"]);
  });

  it("only bumps (no atom to invalidate) when no ticket is open", () => {
    const refreshTicketDetail = vi.fn();
    const bumpReloadKey = vi.fn();
    requestFreshTicketDetail(null, { refreshTicketDetail, bumpReloadKey });
    expect(refreshTicketDetail).not.toHaveBeenCalled();
    expect(bumpReloadKey).toHaveBeenCalledOnce();
  });
});

describe("notifyTicketStatusChange", () => {
  beforeEach(() => {
    vi.mocked(toastManager.add).mockClear();
    vi.mocked(stackedThreadToast).mockClear();
  });

  const baseTicket = { ticketId: "ticket-1", title: "Fix the widget" };

  it("does nothing on first sighting (no previous state)", () => {
    notifyTicketStatusChange(
      { ...baseTicket, status: "parked", attentionKind: "parked_issue" },
      undefined,
      null,
    );
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("does nothing when the drawer is already open on this ticket", () => {
    notifyTicketStatusChange(
      { ...baseTicket, status: "parked", attentionKind: "parked_issue" },
      { status: "queued" },
      TicketId.make("ticket-1"),
    );
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("does nothing when status/attentionKind/parkedEventId are all unchanged", () => {
    notifyTicketStatusChange(
      {
        ...baseTicket,
        status: "parked",
        attentionKind: "parked_issue",
        parked: { parkedEventId: "event-1" },
      },
      {
        status: "parked",
        attentionKind: "parked_issue",
        parkedEventId: "event-1",
      },
      null,
    );
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("toasts a warning when a ticket starts waiting on the user", () => {
    notifyTicketStatusChange(
      { ...baseTicket, status: "waiting_on_user" },
      { status: "queued" },
      null,
    );
    expect(stackedThreadToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: `"${baseTicket.title}" is waiting on you`,
        description: "Open the ticket to answer or approve.",
      }),
    );
    expect(toastManager.add).toHaveBeenCalledOnce();
  });

  it("toasts an error when a ticket parks on an issue", () => {
    notifyTicketStatusChange(
      {
        ...baseTicket,
        status: "parked",
        attentionKind: "parked_issue",
        parked: { parkedEventId: "event-1" },
      },
      { status: "running" },
      null,
    );
    expect(stackedThreadToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: `"${baseTicket.title}" hit an issue`,
        description: "Open the ticket to see what went wrong.",
      }),
    );
    expect(toastManager.add).toHaveBeenCalledOnce();
  });

  it("toasts a warning when a ticket parks waiting on the user", () => {
    notifyTicketStatusChange(
      {
        ...baseTicket,
        status: "parked",
        attentionKind: "parked_waiting",
        parked: { parkedEventId: "event-1" },
      },
      { status: "running" },
      null,
    );
    expect(stackedThreadToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: `"${baseTicket.title}" is waiting on you`,
        description: "Open the ticket to review and choose an action.",
      }),
    );
    expect(toastManager.add).toHaveBeenCalledOnce();
  });

  it("re-toasts a re-park into the same substate once the parkedEventId changes", () => {
    // A ticket that hit an issue, was retried, and immediately parked on the
    // same issue substate again: status and attentionKind are unchanged, but
    // the park is a fresh one — the parkedEventId is how the guard tells.
    notifyTicketStatusChange(
      {
        ...baseTicket,
        status: "parked",
        attentionKind: "parked_issue",
        parked: { parkedEventId: "event-2" },
      },
      {
        status: "parked",
        attentionKind: "parked_issue",
        parkedEventId: "event-1",
      },
      null,
    );
    expect(toastManager.add).toHaveBeenCalledOnce();
    expect(stackedThreadToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: `"${baseTicket.title}" hit an issue` }),
    );
  });

  it("does not re-toast a duplicate broadcast of the same park (identical parkedEventId)", () => {
    notifyTicketStatusChange(
      {
        ...baseTicket,
        status: "parked",
        attentionKind: "parked_issue",
        parked: { parkedEventId: "event-1" },
      },
      {
        status: "parked",
        attentionKind: "parked_issue",
        parkedEventId: "event-1",
      },
      null,
    );
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("still toasts 'needs attention' for failed/blocked statuses", () => {
    notifyTicketStatusChange({ ...baseTicket, status: "failed" }, { status: "running" }, null);
    expect(stackedThreadToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: `"${baseTicket.title}" needs attention`,
        description: "Open the ticket to see what went wrong.",
      }),
    );
    expect(toastManager.add).toHaveBeenCalledOnce();
  });
});

describe("filterBoardStateByQuery", () => {
  const state = {
    projectId: "p1",
    boardId: "b1",
    boardName: "Board",
    lanes: [
      {
        key: "work",
        name: "Work",
        entry: "auto",
        pipelineStepCount: 1,
        admittedTicketIds: ["t1", "t2"],
        queuedTicketIds: ["t3"],
        parkedTicketIds: [],
      },
    ],
    ticketIds: ["t1", "t2", "t3"],
    ticketById: {
      t1: {
        ticketId: "t1",
        title: "Fix login flow",
        currentLaneKey: "work",
        status: "running",
      },
      t2: {
        ticketId: "t2",
        title: "Polish dashboard",
        description: "Charts misalign on login",
        currentLaneKey: "work",
        status: "idle",
      },
      t3: {
        ticketId: "t3",
        title: "Unrelated chore",
        currentLaneKey: "work",
        status: "queued",
        queuedAt: "2026-06-09T00:00:00.000Z",
      },
    },
  };

  it("returns the same state for an empty query", () => {
    expect(filterBoardStateByQuery(state, "   ")).toBe(state);
  });

  it("matches titles and descriptions case-insensitively", () => {
    const filtered = filterBoardStateByQuery(state, "LOGIN");
    expect(filtered.ticketIds).toEqual(["t1", "t2"]);
    expect(filtered.lanes[0]?.admittedTicketIds).toEqual(["t1", "t2"]);
    expect(filtered.lanes[0]?.queuedTicketIds).toEqual([]);
  });

  it("filters queued tickets too", () => {
    const filtered = filterBoardStateByQuery(state, "chore");
    expect(filtered.ticketIds).toEqual(["t3"]);
    expect(filtered.lanes[0]?.admittedTicketIds).toEqual([]);
    expect(filtered.lanes[0]?.queuedTicketIds).toEqual(["t3"]);
  });
});
