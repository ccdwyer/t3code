import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  DESKTOP_IPC_POC_METHODS,
  DesktopIpcPocRpcGroup,
  type DesktopIpcPocEchoResult,
  type DesktopIpcPocRuntimeInfo,
  type DesktopIpcPocTick,
} from "@t3tools/contracts/effectElectronIpcPoc";
import { Cause, Effect, Option, Scope, Stream } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { RpcClient } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import {
  getEffectElectronIpcRendererBridge,
  makeEffectElectronIpcRendererPort,
  makeEffectElectronIpcRendererProtocol,
  type EffectElectronIpcBrowserGlobal,
} from "effect-electron-ipc/client";
import type { EffectElectronIpcRendererBridge } from "effect-electron-ipc/ipc";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";

import { AppAtomRegistryProvider } from "../rpc/atomRegistry";

// -----------------------------------------------------------------------------
// example/preload.ts
// -----------------------------------------------------------------------------
// import { contextBridge, ipcRenderer } from "electron";
// import { exposeEffectElectronIpcPreloadBridge } from "effect-electron-ipc/preload";
//
// exposeEffectElectronIpcPreloadBridge({ contextBridge, ipcRenderer });

// -----------------------------------------------------------------------------
// packages/contracts/src/effectElectronIpcPoc.ts
// -----------------------------------------------------------------------------
// The shared contract owns only app-level RPC method names and schemas:
//
//   DESKTOP_IPC_POC_METHODS
//   DesktopIpcPocRuntimeInfo
//   DesktopIpcPocEchoInput
//   DesktopIpcPocEchoResult
//   DesktopIpcPocSubscribeTicksInput
//   DesktopIpcPocTick
//   DesktopIpcPocRpcGroup
//
// The generic Electron transport package does not import these contracts.

// -----------------------------------------------------------------------------
// example/browser-client.ts
// -----------------------------------------------------------------------------
// preload bridge -> Effect Electron IPC renderer port
//                -> Effect RPC RpcClient.Protocol
//                -> generated typed DesktopIpcPoc client

const makeDesktopIpcPocClient = RpcClient.make(DesktopIpcPocRpcGroup);
type DesktopIpcPocClient =
  typeof makeDesktopIpcPocClient extends Effect.Effect<infer Client, infer _Error, infer _Services>
    ? Client
    : never;

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

// -----------------------------------------------------------------------------
// example/browser-atoms.ts
// -----------------------------------------------------------------------------

const DESKTOP_IPC_POC_SNAPSHOT_STALE_TIME_MS = 5_000;
const DESKTOP_IPC_POC_SNAPSHOT_IDLE_TTL_MS = 60_000;

export const desktopIpcPocClientAtom = Atom.make(makeDesktopIpcPocBrowserClient()).pipe(
  Atom.keepAlive,
  Atom.withLabel("desktop-ipc-poc:effect-rpc-client"),
);

export const desktopIpcPocSnapshotAtom = Atom.make(
  loadDesktopIpcPocSnapshot({
    echoText: "hello from an Effect Atom",
    ticks: 5,
  }),
).pipe(
  Atom.swr({
    staleTime: DESKTOP_IPC_POC_SNAPSHOT_STALE_TIME_MS,
    revalidateOnMount: true,
  }),
  Atom.setIdleTTL(DESKTOP_IPC_POC_SNAPSHOT_IDLE_TTL_MS),
  Atom.withLabel("desktop-ipc-poc:snapshot"),
);

export const desktopIpcPocManualEchoAtom = Atom.make(
  Effect.gen(function* () {
    const client = yield* makeDesktopIpcPocBrowserClient();
    return yield* client[DESKTOP_IPC_POC_METHODS.echo]({
      text: "manual echo from an Atom-backed action",
    });
  }),
).pipe(Atom.withLabel("desktop-ipc-poc:manual-echo"));

// -----------------------------------------------------------------------------
// example/components/DesktopIpcPocPanel.tsx
// -----------------------------------------------------------------------------

function formatAsyncResultError(result: AsyncResult.AsyncResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") {
    return null;
  }
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : String(error);
}

function DesktopIpcPocClientStatus(): ReactElement {
  const clientResult = useAtomValue(desktopIpcPocClientAtom);
  const isReady = clientResult._tag === "Success";
  const label = isReady
    ? "Effect RPC client ready"
    : clientResult.waiting
      ? "Connecting RPC client"
      : "RPC client failed";

  return <span data-state={isReady ? "ready" : clientResult._tag.toLowerCase()}>{label}</span>;
}

function RuntimeInfoView(props: { readonly runtimeInfo: DesktopIpcPocRuntimeInfo }): ReactElement {
  return (
    <dl aria-label="Runtime info">
      <dt>App version</dt>
      <dd>{props.runtimeInfo.appVersion}</dd>
      <dt>Platform</dt>
      <dd>{props.runtimeInfo.platform}</dd>
      <dt>Transport</dt>
      <dd>{props.runtimeInfo.ipcTransport}</dd>
    </dl>
  );
}

function EchoView(props: { readonly echo: DesktopIpcPocEchoResult }): ReactElement {
  return (
    <p>
      Echoed &quot;{props.echo.text}&quot; at {props.echo.echoedAt}
    </p>
  );
}

function TickList(props: { readonly ticks: ReadonlyArray<DesktopIpcPocTick> }): ReactElement {
  return (
    <ol aria-label="Streamed ticks">
      {props.ticks.map((tick) => (
        <li key={tick.sequence}>
          {tick.sequence}: {tick.label}
        </li>
      ))}
    </ol>
  );
}

function ManualEchoButton(): ReactElement {
  const echoResult = useAtomValue(desktopIpcPocManualEchoAtom);
  const runEcho = useAtomRefresh(desktopIpcPocManualEchoAtom);
  const echo = Option.getOrNull(AsyncResult.value(echoResult));
  const error = formatAsyncResultError(echoResult);

  return (
    <div>
      <button disabled={echoResult.waiting} type="button" onClick={() => runEcho()}>
        {echoResult.waiting ? "Sending" : "Send manual echo"}
      </button>
      {echo ? <EchoView echo={echo} /> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

export function DesktopIpcPocPanel(): ReactElement {
  const snapshotResult = useAtomValue(desktopIpcPocSnapshotAtom);
  const refreshSnapshot = useAtomRefresh(desktopIpcPocSnapshotAtom);
  const snapshot = Option.getOrNull(AsyncResult.value(snapshotResult));
  const error = formatAsyncResultError(snapshotResult);

  return (
    <section aria-label="Effect Electron IPC proof of concept">
      <header>
        <DesktopIpcPocClientStatus />
      </header>
      <button disabled={snapshotResult.waiting} type="button" onClick={() => refreshSnapshot()}>
        {snapshotResult.waiting ? "Refreshing" : "Refresh"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {snapshot ? (
        <div>
          <RuntimeInfoView runtimeInfo={snapshot.runtimeInfo} />
          <EchoView echo={snapshot.echo} />
          <TickList ticks={snapshot.ticks} />
          <ManualEchoButton />
        </div>
      ) : (
        <p>Loading desktop RPC data</p>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------
// example/renderer.tsx
// -----------------------------------------------------------------------------

export function mountDesktopIpcPocReactExample(container: Element): void {
  createRoot(container).render(
    <AppAtomRegistryProvider>
      <DesktopIpcPocPanel />
    </AppAtomRegistryProvider>,
  );
}
