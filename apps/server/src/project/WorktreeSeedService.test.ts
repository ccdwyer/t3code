// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ProcessRunner, type ProcessRunInput } from "../processRunner.ts";
import { T3ProjectFileLoader } from "./T3ProjectFileLoader.ts";
import { WorktreeSeedService } from "./WorktreeSeedService.ts";
import { WorktreeSeedServiceLive } from "./WorktreeSeedServiceLive.ts";

const withTempRoots = <A, E, R>(
  use: (input: {
    readonly projectCwd: string;
    readonly worktreePath: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-worktree-seed-"));
      const projectCwd = NodePath.join(root, "project");
      const worktreePath = NodePath.join(root, "worktree");
      NodeFS.mkdirSync(NodePath.join(projectCwd, "node_modules"), { recursive: true });
      NodeFS.mkdirSync(worktreePath, { recursive: true });
      return { root, projectCwd, worktreePath };
    }),
    use,
    ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

const makeLayer = (input: {
  readonly platform: NodeJS.Platform;
  readonly calls: ProcessRunInput[];
  readonly exitCode?: number;
}) =>
  WorktreeSeedServiceLive.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostProcessPlatform, input.platform)),
    Layer.provideMerge(
      Layer.mock(T3ProjectFileLoader)({
        load: () => Effect.succeed(Option.some({ worktreeSeedPaths: ["node_modules"] })),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProcessRunner)({
        run: (command) =>
          Effect.sync(() => {
            input.calls.push(command);
            return {
              stdout: "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(input.exitCode ?? 0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      }),
    ),
  );

describe("WorktreeSeedServiceLive", () => {
  it.effect("uses cp -cR on macOS", () =>
    withTempRoots(({ projectCwd, worktreePath }) =>
      Effect.gen(function* () {
        const calls: ProcessRunInput[] = [];
        const result = yield* Effect.flatMap(WorktreeSeedService, (service) =>
          service.seed({ projectCwd, worktreePath }),
        ).pipe(Effect.provide(makeLayer({ platform: "darwin", calls })));

        assert.equal(result.strategy, "macos-clone");
        assert.deepStrictEqual(result.seededPaths, ["node_modules"]);
        assert.deepStrictEqual(calls, [
          {
            command: "cp",
            args: [
              "-cR",
              NodePath.join(projectCwd, "node_modules"),
              NodePath.join(worktreePath, "node_modules"),
            ],
            cwd: projectCwd,
            timeout: "5 minutes",
            maxOutputBytes: 64 * 1024,
            outputMode: "truncate",
          },
        ]);
      }),
    ),
  );

  it.effect("uses reflink-always on Linux and WSL without a full-copy fallback", () =>
    withTempRoots(({ projectCwd, worktreePath }) =>
      Effect.gen(function* () {
        const calls: ProcessRunInput[] = [];
        const result = yield* Effect.flatMap(WorktreeSeedService, (service) =>
          service.seed({ projectCwd, worktreePath }),
        ).pipe(Effect.provide(makeLayer({ platform: "linux", calls, exitCode: 1 })));

        assert.equal(result.strategy, "linux-reflink");
        assert.deepStrictEqual(result.seededPaths, []);
        assert.deepStrictEqual(result.skippedPaths, [
          { path: "node_modules", reason: "copy-on-write-unavailable" },
        ]);
        assert.deepStrictEqual(calls[0]?.args.slice(0, 2), ["--reflink=always", "-a"]);
        assert.equal(calls.length, 1);
      }),
    ),
  );

  it.effect("skips seeding on native Windows while leaving normal setup available", () =>
    withTempRoots(({ projectCwd, worktreePath }) =>
      Effect.gen(function* () {
        const calls: ProcessRunInput[] = [];
        const result = yield* Effect.flatMap(WorktreeSeedService, (service) =>
          service.seed({ projectCwd, worktreePath }),
        ).pipe(Effect.provide(makeLayer({ platform: "win32", calls })));

        assert.deepStrictEqual(result, {
          strategy: "unsupported",
          seededPaths: [],
          skippedPaths: [{ path: "node_modules", reason: "unsupported-platform" }],
        });
        assert.equal(calls.length, 0);
      }),
    ),
  );
});
