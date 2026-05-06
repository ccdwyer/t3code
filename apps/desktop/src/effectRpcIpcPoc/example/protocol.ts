import { DesktopIpcPocRpcGroup } from "@t3tools/contracts/effectElectronIpcPoc";
import { Effect } from "effect";
import { RpcClient } from "effect/unstable/rpc";

export * from "@t3tools/contracts/effectElectronIpcPoc";

export const makeDesktopIpcPocClient = RpcClient.make(DesktopIpcPocRpcGroup);
type DesktopIpcPocClientFactory = typeof makeDesktopIpcPocClient;
export type DesktopIpcPocClient =
  DesktopIpcPocClientFactory extends Effect.Effect<infer Client, infer _Error, infer _Services>
    ? Client
    : never;
