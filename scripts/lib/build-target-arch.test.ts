import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  getDefaultBuildArch,
  HostProcessArchitecture,
  HostProcessPlatform,
  resolveHostProcessArch,
} from "./build-target-arch.ts";

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

const withHostRuntime = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  env: Readonly<Record<string, string | undefined>> = {},
) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(HostProcessPlatform, platform),
      Layer.succeed(HostProcessArchitecture, arch),
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) })),
    ),
  );

describe("build-target-arch", () => {
  it.effect("prefers arm64 for Windows-on-Arm hosts running x64 emulation", () =>
    Effect.gen(function* () {
      // Windows-on-Arm can run an x64 Node process under emulation while still
      // exposing the real host CPU via PROCESSOR_ARCHITEW6432.
      const hostArch = yield* resolveHostProcessArch().pipe(
        withHostRuntime("win32", "x64", {
          PROCESSOR_ARCHITECTURE: "AMD64", // The currently running Node process is x64.
          PROCESSOR_ARCHITEW6432: "ARM64", // Windows exposes the real host CPU here when x64 runs under ARM emulation.
        }),
      );

      assert.equal(hostArch, "arm64");
    }),
  );

  it.effect("falls back to x64 for native x64 Windows hosts", () =>
    Effect.gen(function* () {
      const hostArch = yield* resolveHostProcessArch().pipe(
        withHostRuntime("win32", "x64", {
          PROCESSOR_ARCHITECTURE: "AMD64", // Both the process and the Windows host are native x64.
        }),
      );

      assert.equal(hostArch, "x64");
    }),
  );

  it.effect("keeps arm64 when the current process is already native arm64", () =>
    Effect.gen(function* () {
      const hostArch = yield* resolveHostProcessArch().pipe(withHostRuntime("win32", "arm64"));

      assert.equal(hostArch, "arm64");
    }),
  );

  it.effect("uses the resolved host arch when selecting the default Windows build arch", () =>
    Effect.gen(function* () {
      // This mirrors the packaging script's default-path behavior: the current
      // process is x64, but the machine itself is ARM64, so the default build
      // target should be win-arm64 rather than win-x64.
      const arch = yield* getDefaultBuildArch("win", { archChoices: ["x64", "arm64"] }).pipe(
        withHostRuntime("win32", "x64", {
          PROCESSOR_ARCHITECTURE: "AMD64", // The currently running Node process is x64.
          PROCESSOR_ARCHITEW6432: "ARM64", // The process is x64, but the actual Windows host is ARM64.
        }),
      );

      assert.equal(arch, "arm64");
    }),
  );

  it.effect("does not apply Windows host env heuristics for non-Windows targets", () =>
    Effect.gen(function* () {
      const arch = yield* getDefaultBuildArch("linux", { archChoices: ["x64", "arm64"] }).pipe(
        withHostRuntime("linux", "x64", {
          PROCESSOR_ARCHITECTURE: "AMD64",
          PROCESSOR_ARCHITEW6432: "ARM64",
        }),
      );

      assert.equal(arch, "x64");
    }),
  );
});
