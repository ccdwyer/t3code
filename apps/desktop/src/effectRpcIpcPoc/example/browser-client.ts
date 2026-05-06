import { Effect, Scope, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

import {
  getEffectElectronIpcRendererBridge,
  makeEffectElectronIpcRendererPort,
  makeEffectElectronIpcRendererProtocol,
  type EffectElectronIpcBrowserGlobal,
} from "effect-electron-ipc/client";
import type { EffectElectronIpcRendererBridge } from "effect-electron-ipc/ipc";
import {
  DESKTOP_IPC_POC_METHODS,
  makeDesktopIpcPocClient,
  type DesktopIpcPocClient,
  type DesktopIpcPocEchoResult,
  type DesktopIpcPocRuntimeInfo,
  type DesktopIpcPocTick,
} from "./protocol.ts";

export interface DesktopIpcPocSnapshot {
  readonly runtimeInfo: DesktopIpcPocRuntimeInfo;
  readonly echo: DesktopIpcPocEchoResult;
  readonly ticks: ReadonlyArray<DesktopIpcPocTick>;
}

export interface DesktopIpcPocBrowserClientOptions {
  readonly bridge?: EffectElectronIpcRendererBridge;
  readonly globalObject?: EffectElectronIpcBrowserGlobal;
}

export interface DesktopIpcPocSnapshotOptions extends DesktopIpcPocBrowserClientOptions {
  readonly echoText?: string;
  readonly ticks?: number;
}

export const makeDesktopIpcPocBrowserClient = (
  options: DesktopIpcPocBrowserClientOptions = {},
): Effect.Effect<DesktopIpcPocClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const bridge = options.bridge ?? getEffectElectronIpcRendererBridge(options.globalObject);
    const rendererPort = makeEffectElectronIpcRendererPort(bridge);
    const rendererProtocol = yield* makeEffectElectronIpcRendererProtocol(rendererPort);

    return yield* makeDesktopIpcPocClient.pipe(
      Effect.provideService(RpcClient.Protocol, rendererProtocol),
    );
  });

export const loadDesktopIpcPocSnapshot = (
  options: DesktopIpcPocSnapshotOptions = {},
): Effect.Effect<DesktopIpcPocSnapshot, RpcClientError, Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* makeDesktopIpcPocBrowserClient(options);
    const runtimeInfo = yield* client[DESKTOP_IPC_POC_METHODS.getRuntimeInfo]({});
    const echo = yield* client[DESKTOP_IPC_POC_METHODS.echo]({
      text: options.echoText ?? "hello from the renderer",
    });
    const ticks = yield* client[DESKTOP_IPC_POC_METHODS.subscribeTicks]({
      take: options.ticks ?? 3,
    }).pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );

    return {
      runtimeInfo,
      echo,
      ticks,
    };
  });

export const loadDesktopIpcPocSnapshotFromBrowser = (
  options: Omit<DesktopIpcPocSnapshotOptions, "bridge" | "globalObject"> = {},
) => Effect.runPromise(Effect.scoped(loadDesktopIpcPocSnapshot(options)));
