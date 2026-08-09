import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ProcessRunner } from "../processRunner.ts";
import { T3ProjectFileLoader } from "./T3ProjectFileLoader.ts";
import {
  WorktreeSeedService,
  type WorktreeSeedResult,
  type WorktreeSeedSkipReason,
  type WorktreeSeedStrategy,
} from "./WorktreeSeedService.ts";

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcessPlatform;
  const loader = yield* T3ProjectFileLoader;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner;

  const strategy: WorktreeSeedStrategy =
    hostPlatform === "darwin"
      ? "macos-clone"
      : hostPlatform === "linux"
        ? "linux-reflink"
        : "unsupported";

  const copyArguments = (source: string, destination: string): ReadonlyArray<string> =>
    hostPlatform === "darwin"
      ? ["-cR", source, destination]
      : ["--reflink=always", "-a", source, destination];

  const seed: WorktreeSeedService["Service"]["seed"] = Effect.fn("WorktreeSeedService.seed")(
    function* (input) {
      const projectFile = yield* loader.load(input.projectCwd);
      const configuredPaths = Option.isSome(projectFile)
        ? [...new Set(projectFile.value.worktreeSeedPaths ?? [])]
        : [];
      if (configuredPaths.length === 0) {
        return {
          strategy: "not-configured",
          seededPaths: [],
          skippedPaths: [],
        } satisfies WorktreeSeedResult;
      }

      if (strategy === "unsupported") {
        return {
          strategy,
          seededPaths: [],
          skippedPaths: configuredPaths.map((seedPath) => ({
            path: seedPath,
            reason: "unsupported-platform" as const,
          })),
        } satisfies WorktreeSeedResult;
      }

      const seededPaths: string[] = [];
      const skippedPaths: Array<{ path: string; reason: WorktreeSeedSkipReason }> = [];
      for (const seedPath of configuredPaths) {
        const source = path.join(input.projectCwd, seedPath);
        const destination = path.join(input.worktreePath, seedPath);
        const sourceExists = yield* fileSystem
          .exists(source)
          .pipe(Effect.orElseSucceed(() => false));
        if (!sourceExists) {
          skippedPaths.push({ path: seedPath, reason: "source-missing" });
          continue;
        }
        const destinationExists = yield* fileSystem
          .exists(destination)
          .pipe(Effect.orElseSucceed(() => false));
        if (destinationExists) {
          skippedPaths.push({ path: seedPath, reason: "destination-exists" });
          continue;
        }

        const copied = yield* fileSystem
          .makeDirectory(path.dirname(destination), { recursive: true })
          .pipe(
            Effect.andThen(
              processRunner.run({
                command: "cp",
                args: copyArguments(source, destination),
                cwd: input.projectCwd,
                timeout: "5 minutes",
                maxOutputBytes: 64 * 1024,
                outputMode: "truncate",
              }),
            ),
            Effect.map((result) => result.code !== null && Number(result.code) === 0),
            Effect.orElseSucceed(() => false),
          );
        if (copied) {
          seededPaths.push(seedPath);
          continue;
        }

        yield* fileSystem
          .remove(destination, { recursive: true, force: true })
          .pipe(Effect.ignoreCause);
        skippedPaths.push({ path: seedPath, reason: "copy-on-write-unavailable" });
      }

      const result = { strategy, seededPaths, skippedPaths } satisfies WorktreeSeedResult;
      if (skippedPaths.length > 0) {
        yield* Effect.logInfo("worktree copy-on-write seeding skipped one or more paths", {
          projectCwd: input.projectCwd,
          worktreePath: input.worktreePath,
          strategy,
          skippedPaths,
        });
      }
      return result;
    },
  );

  return WorktreeSeedService.of({ seed });
});

export const WorktreeSeedServiceLive = Layer.effect(WorktreeSeedService, make);
