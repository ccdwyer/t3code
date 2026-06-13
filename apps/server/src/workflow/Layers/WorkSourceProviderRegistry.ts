import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  AsanaProvider,
  GithubIssuesProvider,
  WorkSourceProviderRegistry,
  type WorkSourceProviderRegistryShape,
} from "../Services/WorkSourceProvider.ts";

const make = Effect.gen(function* () {
  const github = yield* GithubIssuesProvider;
  const asana = yield* AsanaProvider;

  return {
    get: (provider: "github" | "asana") => {
      if (provider === "github") return github;
      return asana;
    },
  } satisfies WorkSourceProviderRegistryShape;
});

export const WorkSourceProviderRegistryLive = Layer.effect(WorkSourceProviderRegistry, make);
