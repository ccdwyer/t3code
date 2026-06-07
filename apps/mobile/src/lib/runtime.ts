import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/unstable/socket/Socket";

import { remoteHttpClientLayer } from "@t3tools/client-runtime";

import { mobileCryptoLayer } from "../features/cloud/dpop";
import { mobileManagedRelayClientLayer } from "../features/cloud/managedRelayLayer";
import { resolveCloudPublicConfig } from "../features/cloud/publicConfig";
import { mobileTracingLayer } from "../features/observability/mobileTracing";

function configuredRelayUrl(): string {
  return resolveCloudPublicConfig().relay.url ?? "http://relay.invalid";
}

const mobileHttpClientLayer = remoteHttpClientLayer(fetch);

export const mobileRuntimeLayer = Layer.merge(
  mobileManagedRelayClientLayer(configuredRelayUrl()),
  Socket.layerWebSocketConstructorGlobal,
).pipe(
  Layer.provideMerge(mobileCryptoLayer),
  Layer.provideMerge(mobileHttpClientLayer),
  Layer.provideMerge(mobileTracingLayer.pipe(Layer.provide(mobileHttpClientLayer))),
);

export const mobileRuntime = ManagedRuntime.make(mobileRuntimeLayer);

export const mobileRuntimeContextLayer = Layer.effectContext(mobileRuntime.contextEffect);
