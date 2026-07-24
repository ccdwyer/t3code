import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentApi } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const {
  executeAtomQuery,
  runAtomCommand,
  listWorkSourceConnectionsAtom,
  getTicketDetailAtom,
  getBoardDefinitionAtom,
  listWorkSourceConnections,
  getTicketDetail,
  getBoardDefinition,
  saveBoardDefinition,
  createWorkSourceConnection,
  boardRaw,
} = vi.hoisted(() => {
  const listWorkSourceConnectionsAtom = { label: "listWorkSourceConnections" };
  const getTicketDetailAtom = { label: "getTicketDetail" };
  const getBoardDefinitionAtom = { label: "getBoardDefinition" };
  const command = { label: "command" };
  return {
    executeAtomQuery: vi.fn(),
    runAtomCommand: vi.fn(),
    listWorkSourceConnectionsAtom,
    getTicketDetailAtom,
    getBoardDefinitionAtom,
    listWorkSourceConnections: vi.fn(() => listWorkSourceConnectionsAtom),
    getTicketDetail: vi.fn(() => getTicketDetailAtom),
    getBoardDefinition: vi.fn(() => getBoardDefinitionAtom),
    saveBoardDefinition: command,
    createWorkSourceConnection: command,
    boardRaw: vi.fn(() => ({ label: "boardRaw" })),
  };
});

vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: (...args: unknown[]) => executeAtomQuery(...args),
  runAtomCommand: (...args: unknown[]) => runAtomCommand(...args),
  squashAtomCommandFailure: (result: { cause?: unknown }) =>
    result.cause instanceof Error ? result.cause : new Error("command failed"),
}));

vi.mock("../state/workflow", () => {
  const command = { label: "command" };
  const query = (label: string) => vi.fn(() => ({ label }));
  return {
    workflowEnvironment: {
      listWorkSourceConnections,
      getTicketDetail,
      getBoardDefinition,
      getBoard: query("getBoard"),
      listBoardVersions: query("listBoardVersions"),
      listBoards: query("listBoards"),
      listBoardTemplates: query("listBoardTemplates"),
      getBoardVersion: query("getBoardVersion"),
      getTicketDiff: query("getTicketDiff"),
      listTicketArtifacts: query("listTicketArtifacts"),
      getWebhookConfig: query("getWebhookConfig"),
      getBoardDigest: query("getBoardDigest"),
      getBoardMetrics: query("getBoardMetrics"),
      listOutboundConnections: query("listOutboundConnections"),
      listBoardProposals: query("listBoardProposals"),
      getBoardProposal: query("getBoardProposal"),
      listImportableWorkItems: query("listImportableWorkItems"),
      listNeedsAttentionTickets: query("listNeedsAttentionTickets"),
      board: query("board"),
      boardRaw,
      createBoard: command,
      importBoard: command,
      createWorkflowBoard: command,
      generateWorkflowDraft: command,
      deleteBoard: command,
      renameBoard: command,
      saveBoardDefinition,
      createTicket: command,
      editTicket: command,
      deleteTicket: command,
      moveTicket: command,
      invokeParkAction: command,
      runLane: command,
      resolveApproval: command,
      answerTicketStep: command,
      postTicketMessage: command,
      editTicketMessage: command,
      setProjectScriptTrust: command,
      cancelStep: command,
      intakeTickets: command,
      dryRunBoard: command,
      proposeBoardImprovement: command,
      resolveBoardProposal: command,
      revertBoardProposal: command,
      createWorkSourceConnection,
      deleteWorkSourceConnection: command,
      createOutboundConnection: command,
      deleteOutboundConnection: command,
      importWorkItems: command,
    },
  };
});

import { useWorkflowApi } from "./useWorkflowApi";

function makeFakeRegistry(input?: { readonly emitOnMount?: unknown }) {
  const refresh = vi.fn();
  let listener: ((result: unknown) => void) | undefined;
  const registry = {
    refresh,
    mount: vi.fn(() => {
      if (input?.emitOnMount !== undefined) {
        listener?.(input.emitOnMount);
      }
      return vi.fn();
    }),
    subscribe: vi.fn((_atom: unknown, next: (result: unknown) => void) => {
      listener = next;
      return vi.fn();
    }),
  } as unknown as AtomRegistry.AtomRegistry;
  return { registry, refresh };
}

function renderWorkflowApi(registry: AtomRegistry.AtomRegistry): EnvironmentApi["workflow"] {
  let captured: EnvironmentApi["workflow"] | undefined;
  function Probe() {
    captured = useWorkflowApi(EnvironmentId.make("environment-1"));
    return null;
  }
  renderToStaticMarkup(
    <RegistryContext.Provider value={registry}>
      <Probe />
    </RegistryContext.Provider>,
  );
  if (captured === undefined) {
    throw new Error("useWorkflowApi did not produce a value");
  }
  return captured;
}

describe("useWorkflowApi freshness", () => {
  beforeEach(() => {
    executeAtomQuery.mockReset();
    runAtomCommand.mockReset();
    listWorkSourceConnections.mockClear();
    getTicketDetail.mockClear();
    getBoardDefinition.mockClear();
    boardRaw.mockClear();
  });

  it("refreshes the query atom before listWorkSourceConnections so SWR cannot serve a pre-mutation list", async () => {
    const { registry, refresh } = makeFakeRegistry();
    const connections = [{ connectionRef: "conn-1", provider: "github", displayName: "GH" }];
    executeAtomQuery.mockResolvedValue(AsyncResult.success(connections));

    const api = renderWorkflowApi(registry);
    const result = await api.listWorkSourceConnections({});

    expect(refresh).toHaveBeenCalledWith(listWorkSourceConnectionsAtom);
    expect(executeAtomQuery).toHaveBeenCalledWith(
      registry,
      listWorkSourceConnectionsAtom,
      expect.objectContaining({ reportFailure: false }),
    );
    // refresh must precede the query mount/read.
    const refreshOrder = refresh.mock.invocationCallOrder[0] ?? -1;
    const queryOrder = executeAtomQuery.mock.invocationCallOrder[0] ?? -1;
    expect(refreshOrder).toBeLessThan(queryOrder);
    expect(result).toEqual(connections);
  });

  it("refreshes getTicketDetail before read so agent session threads are not stuck on a cached empty step", async () => {
    const { registry, refresh } = makeFakeRegistry();
    const detail = {
      ticket: { ticketId: "ticket-1" },
      steps: [{ stepType: "agent", providerThreadId: "thread-1" }],
    };
    executeAtomQuery.mockResolvedValue(AsyncResult.success(detail));

    const api = renderWorkflowApi(registry);
    const result = await api.getTicketDetail({ ticketId: "ticket-1" as never });

    expect(refresh).toHaveBeenCalledWith(getTicketDetailAtom);
    expect(result).toEqual(detail);
  });

  it("invalidates listWorkSourceConnections after createWorkSourceConnection", async () => {
    const { registry, refresh } = makeFakeRegistry();
    const created = { connectionRef: "conn-new", provider: "github", displayName: "New" };
    runAtomCommand.mockResolvedValue(AsyncResult.success(created));

    const api = renderWorkflowApi(registry);
    const result = await api.createWorkSourceConnection({
      provider: "github",
      displayName: "New",
      token: "secret",
    });

    expect(result).toEqual(created);
    expect(refresh).toHaveBeenCalledWith(listWorkSourceConnectionsAtom);
  });

  it("invalidates getBoardDefinition after saveBoardDefinition so a just-added source is not missing", async () => {
    const { registry, refresh } = makeFakeRegistry();
    const saveResult = { ok: true as const, versionHash: "v2", snapshot: {} };
    runAtomCommand.mockResolvedValue(AsyncResult.success(saveResult));

    const api = renderWorkflowApi(registry);
    await api.saveBoardDefinition({
      boardId: "board-1" as never,
      definition: { name: "Board", lanes: [] } as never,
      expectedVersionHash: "v1",
    });

    expect(refresh).toHaveBeenCalledWith(getBoardDefinitionAtom);
  });

  it("subscribeBoard observes the initial snapshot emitted synchronously while the stream mounts", () => {
    const snapshotItem = { kind: "snapshot", snapshot: { tickets: [] } };
    const { registry } = makeFakeRegistry({
      emitOnMount: AsyncResult.success(snapshotItem),
    });
    const api = renderWorkflowApi(registry);
    const callback = vi.fn();

    api.subscribeBoard({ boardId: "board-1" as never }, callback);

    expect(callback).toHaveBeenCalledWith(snapshotItem);
  });
});
