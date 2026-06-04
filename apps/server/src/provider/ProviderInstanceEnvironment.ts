import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { HostProcessEnv } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    next[variable.name] = variable.value;
  }
  return next;
}

export const mergeProviderInstanceEnvironmentEffect = Effect.fn(
  "mergeProviderInstanceEnvironmentEffect",
)(function* (environment: ProviderInstanceEnvironment | undefined) {
  const hostEnv = yield* HostProcessEnv;
  return mergeProviderInstanceEnvironment(environment, hostEnv);
});
