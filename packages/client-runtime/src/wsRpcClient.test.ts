import type {
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import {
  BoardId,
  ORCHESTRATION_WS_METHODS,
  StepRunId,
  TicketId,
  ThreadId,
  WORKFLOW_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./wsTransport.ts", () => ({
  WsTransport: class WsTransport {
    dispose = vi.fn(async () => undefined);
    reconnect = vi.fn(async () => undefined);
    request = vi.fn();
    requestStream = vi.fn();
    subscribe = vi.fn(() => () => undefined);
  },
}));

import { createWsRpcClient } from "./wsRpcClient.ts";
import type { WsTransport } from "./wsTransport.ts";

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/demo",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

describe("createWsRpcClient", () => {
  it("runs beforeReconnect before awaiting transport.reconnect", async () => {
    const order: string[] = [];
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => {
        order.push("reconnect");
      }),
      isHeartbeatFresh: vi.fn(() => true),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport, {
      beforeReconnect: () => {
        order.push("beforeReconnect");
      },
    });

    await client.reconnect();
    expect(order).toEqual(["beforeReconnect", "reconnect"]);
  });

  it("delegates heartbeat freshness to the transport", () => {
    const isHeartbeatFresh = vi.fn(() => true);
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh,
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);

    expect(client.isHeartbeatFresh()).toBe(true);
    expect(isHeartbeatFresh).toHaveBeenCalledOnce();
  });

  it("reduces vcs status stream events into flat status snapshots", () => {
    const subscribe = vi.fn(<TValue>(_connect: unknown, listener: (value: TValue) => void) => {
      for (const event of [
        {
          _tag: "snapshot",
          local: baseLocalStatus,
          remote: null,
        },
        {
          _tag: "remoteUpdated",
          remote: baseRemoteStatus,
        },
        {
          _tag: "localUpdated",
          local: {
            ...baseLocalStatus,
            hasWorkingTreeChanges: true,
          },
        },
      ] satisfies VcsStatusStreamEvent[]) {
        listener(event as TValue);
      }
      return () => undefined;
    });

    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe,
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    client.vcs.onStatus({ cwd: "/repo" }, listener);

    expect(listener.mock.calls).toEqual([
      [
        {
          ...baseLocalStatus,
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          aheadOfDefaultCount: 0,
          pr: null,
        },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
        },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
          hasWorkingTreeChanges: true,
        },
      ],
    ]);
  });

  it("tags stream subscriptions for targeted resubscribe handling", () => {
    const subscribe = vi.fn(() => () => undefined);
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe,
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    const terminalAttachHistory = (
      client.terminal as unknown as {
        readonly attachHistory: (
          input: { readonly threadId: string; readonly terminalId: string },
          listener: (event: unknown) => void,
        ) => () => void;
      }
    ).attachHistory;
    expect(typeof terminalAttachHistory).toBe("function");

    terminalAttachHistory(
      { threadId: "script-thread-1", terminalId: "script-terminal-1" },
      listener,
    );
    client.terminal.onMetadata(listener);
    client.vcs.onStatus({ cwd: "/repo" }, listener);
    client.server.subscribeConfig(listener);
    client.orchestration.subscribeThread({ threadId: ThreadId.make("thread-1") }, listener);

    const subscribeCalls = subscribe.mock.calls as unknown as Array<
      readonly [unknown, unknown, { readonly tag?: string }?]
    >;
    expect(subscribeCalls.map((call) => call[2]?.tag)).toEqual([
      "terminal.attachHistory",
      WS_METHODS.subscribeTerminalMetadata,
      WS_METHODS.subscribeVcsStatus,
      WS_METHODS.subscribeServerConfig,
      ORCHESTRATION_WS_METHODS.subscribeThread,
    ]);
  });

  it("maps workflow board version methods to websocket RPC names", async () => {
    const boardId = BoardId.make("board-versions");
    const rpcInvocations: Array<readonly [string, unknown]> = [];
    const rpcClient = {
      [WORKFLOW_WS_METHODS.listBoardVersions]: (input: unknown) => {
        rpcInvocations.push([WORKFLOW_WS_METHODS.listBoardVersions, input]);
        return [];
      },
      [WORKFLOW_WS_METHODS.deleteBoard]: (input: unknown) => {
        rpcInvocations.push([WORKFLOW_WS_METHODS.deleteBoard, input]);
      },
      [WORKFLOW_WS_METHODS.renameBoard]: (input: unknown) => {
        rpcInvocations.push([WORKFLOW_WS_METHODS.renameBoard, input]);
      },
      [WORKFLOW_WS_METHODS.getBoardVersion]: (input: unknown) => {
        rpcInvocations.push([WORKFLOW_WS_METHODS.getBoardVersion, input]);
        return {
          versionId: 7,
          definition: { name: "Delivery", lanes: [] },
          versionHash: "hash-7",
          source: "save",
          createdAt: "2026-06-08T12:00:00.000Z",
        };
      },
      [WORKFLOW_WS_METHODS.editTicket]: (input: unknown) => {
        rpcInvocations.push([WORKFLOW_WS_METHODS.editTicket, input]);
      },
      [WORKFLOW_WS_METHODS.answerTicketStep]: (input: unknown) => {
        rpcInvocations.push([WORKFLOW_WS_METHODS.answerTicketStep, input]);
      },
    };
    const request = vi.fn(async (connect: (client: typeof rpcClient) => unknown) =>
      connect(rpcClient),
    ) as unknown as WsTransport["request"];
    const transport = {
      dispose: vi.fn(async () => undefined),
      reconnect: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      request,
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);

    await client.workflow.listBoardVersions({ boardId });
    await client.workflow.deleteBoard({ boardId });
    await client.workflow.renameBoard({ boardId, name: "Renamed delivery" });
    await client.workflow.getBoardVersion({ boardId, versionId: 7 });
    await client.workflow.editTicket({
      ticketId: TicketId.make("ticket-1"),
      title: "Updated",
      description: "Notes",
    });
    await client.workflow.answerTicketStep({
      stepRunId: StepRunId.make("step-1"),
      text: "Use the compatibility guard.",
      attachments: [],
    });

    expect(rpcInvocations).toEqual([
      [WORKFLOW_WS_METHODS.listBoardVersions, { boardId }],
      [WORKFLOW_WS_METHODS.deleteBoard, { boardId }],
      [WORKFLOW_WS_METHODS.renameBoard, { boardId, name: "Renamed delivery" }],
      [WORKFLOW_WS_METHODS.getBoardVersion, { boardId, versionId: 7 }],
      [
        WORKFLOW_WS_METHODS.editTicket,
        { ticketId: TicketId.make("ticket-1"), title: "Updated", description: "Notes" },
      ],
      [
        WORKFLOW_WS_METHODS.answerTicketStep,
        {
          stepRunId: StepRunId.make("step-1"),
          text: "Use the compatibility guard.",
          attachments: [],
        },
      ],
    ]);
  });
});
