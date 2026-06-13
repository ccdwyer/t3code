import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  AsanaProvider,
  GithubIssuesProvider,
  WorkSourceProviderRegistry,
  type WorkSourceProvider,
} from "../Services/WorkSourceProvider.ts";
import { WorkSourceProviderRegistryLive } from "./WorkSourceProviderRegistry.ts";

const makeStub = (name: "github" | "asana"): WorkSourceProvider => ({
  provider: name,
  selectorSchema: Schema.Unknown,
  listPage: () => Effect.succeed({ items: [] }),
  getItem: () => Effect.succeed(null),
});

const githubStubLayer = Layer.succeed(GithubIssuesProvider, makeStub("github"));
const asanaStubLayer = Layer.succeed(AsanaProvider, makeStub("asana"));

const testLayer = WorkSourceProviderRegistryLive.pipe(
  Layer.provide(Layer.merge(githubStubLayer, asanaStubLayer)),
);

const layer = it.layer(testLayer);

layer("WorkSourceProviderRegistry", (it) => {
  it.effect("get('github') returns the github provider", () =>
    Effect.gen(function* () {
      const registry = yield* WorkSourceProviderRegistry;
      const provider = registry.get("github");
      assert.equal(provider.provider, "github");
    }),
  );

  it.effect("get('asana') returns the asana provider", () =>
    Effect.gen(function* () {
      const registry = yield* WorkSourceProviderRegistry;
      const provider = registry.get("asana");
      assert.equal(provider.provider, "asana");
    }),
  );
});
