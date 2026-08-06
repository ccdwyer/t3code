import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type AtomRegistry } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// Replace the heavy client-runtime-backed state modules with sentinel atom
// families so the bridge can be exercised against a fake registry in isolation.
vi.mock("../state/threads", () => ({
  environmentThreads: {
    streamRaw: vi.fn((target: unknown) => ({ family: "threadRaw", target })),
  },
}));
vi.mock("../state/terminal", () => ({
  terminalEnvironment: {
    attachHistory: vi.fn((target: unknown) => ({
      family: "attachHistory",
      target,
    })),
  },
}));
vi.mock("./useWorkflowApi", () => ({
  useWorkflowApi: vi.fn(() => ({ marker: "workflow" })),
}));

import type { EnvironmentApi } from "@t3tools/contracts";

import { environmentThreads } from "../state/threads";
import { terminalEnvironment } from "../state/terminal";
import { useBoardApi } from "./useBoardApi";

function makeFakeRegistry(input?: {
  readonly emitOnMount?: unknown;
  readonly emitOnRefresh?: unknown;
}) {
  const unmount = vi.fn();
  const unsubscribe = vi.fn();
  let listener: ((result: unknown) => void) | undefined;
  const registry = {
    mount: vi.fn(() => {
      if (input?.emitOnMount !== undefined) {
        listener?.(input.emitOnMount);
      }
      return unmount;
    }),
    subscribe: vi.fn((_atom: unknown, next: (result: unknown) => void) => {
      listener = next;
      return unsubscribe;
    }),
    refresh: vi.fn(() => {
      if (input?.emitOnRefresh !== undefined) {
        listener?.(input.emitOnRefresh);
      }
    }),
  } as unknown as AtomRegistry.AtomRegistry;
  return {
    registry,
    unmount,
    unsubscribe,
    emit: (result: unknown) => listener?.(result),
  };
}

function renderBoardApi(registry: AtomRegistry.AtomRegistry): EnvironmentApi {
  let captured: EnvironmentApi | undefined;
  function Probe() {
    captured = useBoardApi(EnvironmentId.make("environment-1"));
    return null;
  }
  renderToStaticMarkup(
    <RegistryContext.Provider value={registry}>
      <Probe />
    </RegistryContext.Provider>,
  );
  if (captured === undefined) {
    throw new Error("useBoardApi did not produce a value");
  }
  return captured;
}

describe("useBoardApi", () => {
  it("exposes real (non-undefined) orchestration + terminal subscription clients", () => {
    const { registry } = makeFakeRegistry();
    const api = renderBoardApi(registry);

    expect(typeof api.orchestration.subscribeThread).toBe("function");
    expect(typeof api.terminal.attachHistory).toBe("function");
    expect(api.workflow).toEqual({ marker: "workflow" });
  });

  it("subscribeThread mounts the raw atom, forwards snapshot + event items, ignores failures, and tears down", () => {
    const { registry, unmount, unsubscribe, emit } = makeFakeRegistry();
    const api = renderBoardApi(registry);

    const callback = vi.fn();
    const input = { threadId: ThreadId.make("thread-1") };
    const teardown = api.orchestration.subscribeThread(input, callback);

    expect(environmentThreads.streamRaw).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment-1"),
      input,
    });
    expect(registry.mount).toHaveBeenCalledTimes(1);
    expect(registry.subscribe).toHaveBeenCalledTimes(1);

    const snapshotItem = { kind: "snapshot" };
    const eventItem = { kind: "event" };
    emit(AsyncResult.success(snapshotItem));
    emit(AsyncResult.success(eventItem));
    emit(AsyncResult.failure(Cause.die(new Error("ignored")))); // non-success is skipped

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(1, snapshotItem);
    expect(callback).toHaveBeenNthCalledWith(2, eventItem);

    teardown();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unmount).toHaveBeenCalledTimes(1);
  });

  it("subscribeThread observes a snapshot emitted synchronously while the stream mounts", () => {
    const snapshotItem = {
      kind: "snapshot",
      snapshot: { thread: { messages: [] } },
    };
    const { registry } = makeFakeRegistry({
      emitOnMount: AsyncResult.success(snapshotItem),
    });
    const api = renderBoardApi(registry);
    const callback = vi.fn();

    api.orchestration.subscribeThread(
      { threadId: ThreadId.make("thread-mount-snapshot") },
      callback,
    );

    expect(callback).toHaveBeenCalledWith(snapshotItem);
  });

  it("subscribeThread refreshes an already-mounted raw stream to recover its full snapshot", () => {
    const snapshotItem = {
      kind: "snapshot",
      snapshot: { thread: { messages: [] } },
    };
    const { registry } = makeFakeRegistry({
      emitOnRefresh: AsyncResult.success(snapshotItem),
    });
    const api = renderBoardApi(registry);
    const callback = vi.fn();

    api.orchestration.subscribeThread(
      { threadId: ThreadId.make("thread-shared-stream") },
      callback,
    );

    expect(registry.refresh).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(snapshotItem);
  });

  it("attachHistory mounts the raw atom, forwards events, and tears down", () => {
    const { registry, unmount, unsubscribe, emit } = makeFakeRegistry();
    const api = renderBoardApi(registry);

    const callback = vi.fn();
    const input = { threadId: "thread-1", terminalId: "terminal-1" };
    const teardown = api.terminal.attachHistory(input, callback);

    expect(terminalEnvironment.attachHistory).toHaveBeenCalledWith({
      environmentId: EnvironmentId.make("environment-1"),
      input,
    });

    const historyEvent = { type: "history" };
    emit(AsyncResult.success(historyEvent));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenNthCalledWith(1, historyEvent);

    teardown();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unmount).toHaveBeenCalledTimes(1);
  });
});
