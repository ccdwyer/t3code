import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
}

describe("GitWorkflowService", () => {
  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("creates a worktree from the latest fetched primary-remote default branch", () => {
    const calls: Array<string> = [];
    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () =>
            Effect.succeed({
              kind: "git",
            } as never),
        }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolvePrimaryRemoteName: () =>
            Effect.sync(() => {
              calls.push("resolve-primary-remote");
              return "upstream";
            }),
          fetchRemote: () =>
            Effect.sync(() => {
              calls.push("fetch-remote");
            }),
          resolveRemoteDefaultBranch: () =>
            Effect.sync(() => {
              calls.push("resolve-default-branch");
              return "develop";
            }),
          resolveRemoteTrackingCommit: () =>
            Effect.sync(() => {
              calls.push("resolve-remote-commit");
              return {
                commitSha: "abc123",
                remoteRefName: "upstream/develop",
              };
            }),
          pruneWorktrees: () =>
            Effect.sync(() => {
              calls.push("prune-worktrees");
            }),
          listRefs: () =>
            Effect.sync(() => {
              calls.push("list-local-refs");
              return {
                refs: [],
                isRepo: true,
                hasPrimaryRemote: true,
                nextCursor: null,
                totalCount: 0,
              };
            }),
          createWorktree: (input) =>
            Effect.sync(() => {
              calls.push("create-worktree");
              assert.deepStrictEqual(input, {
                cwd: "/repo",
                refName: "abc123",
                newRefName: "t3code/1234abcd",
                baseRefName: "upstream/develop",
                path: null,
              });
              return {
                worktree: {
                  path: "/repo-worktrees/1234abcd",
                  refName: "t3code/1234abcd",
                },
              };
            }),
        }),
      ),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const result = yield* workflow.createWorktreeFromLatestDefaultBranch({
        cwd: "/repo",
        newRefName: "t3code/1234abcd",
      });

      assert.deepStrictEqual(result, {
        worktree: {
          path: "/repo-worktrees/1234abcd",
          refName: "t3code/1234abcd",
        },
        remoteName: "upstream",
        baseBranch: "develop",
        baseCommit: "abc123",
        baseRefName: "upstream/develop",
      });
      assert.deepStrictEqual(calls, [
        "resolve-primary-remote",
        "fetch-remote",
        "resolve-default-branch",
        "resolve-remote-commit",
        "prune-worktrees",
        "list-local-refs",
        "create-worktree",
      ]);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("serializes latest-default worktree preparation per repository", () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () => Effect.succeed({ kind: "git" } as never),
        }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolvePrimaryRemoteName: () => Effect.succeed("origin"),
          fetchRemote: () =>
            Effect.gen(function* () {
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              yield* Effect.yieldNow;
              inFlight -= 1;
            }),
          resolveRemoteDefaultBranch: () => Effect.succeed("main"),
          resolveRemoteTrackingCommit: () =>
            Effect.succeed({ commitSha: "abc123", remoteRefName: "origin/main" }),
          pruneWorktrees: () => Effect.void,
          listRefs: () =>
            Effect.succeed({
              refs: [],
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 0,
            }),
          createWorktree: (input) =>
            Effect.succeed({
              worktree: {
                path: `/repo-worktrees/${input.newRefName}`,
                refName: input.newRefName ?? input.refName,
              },
            }),
        }),
      ),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* Effect.all(
        [
          workflow.createWorktreeFromLatestDefaultBranch({
            cwd: "/repo",
            newRefName: "t3code/11111111",
          }),
          workflow.createWorktreeFromLatestDefaultBranch({
            cwd: "/repo",
            newRefName: "t3code/22222222",
          }),
        ],
        { concurrency: 2 },
      );

      assert.equal(maxInFlight, 1);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("adopts an already-registered worktree after promotion crashes before metadata", () => {
    const calls: Array<string> = [];
    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () => Effect.succeed({ kind: "git" } as never),
        }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolvePrimaryRemoteName: () => Effect.succeed("origin"),
          fetchRemote: () => Effect.void,
          resolveRemoteDefaultBranch: () => Effect.succeed("main"),
          resolveRemoteTrackingCommit: () =>
            Effect.succeed({ commitSha: "abc123", remoteRefName: "origin/main" }),
          pruneWorktrees: () =>
            Effect.sync(() => {
              calls.push("prune-worktrees");
            }),
          listRefs: () =>
            Effect.sync(() => {
              calls.push("list-local-refs");
              return {
                refs: [
                  {
                    name: "t3code/crash-recovery",
                    current: false,
                    isDefault: false,
                    worktreePath: "/repo-worktrees/crash-recovery",
                  },
                ],
                isRepo: true,
                hasPrimaryRemote: true,
                nextCursor: null,
                totalCount: 1,
              };
            }),
          createWorktree: () => Effect.die("existing worktree should be adopted"),
        }),
      ),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const result = yield* workflow.createWorktreeFromLatestDefaultBranch({
        cwd: "/repo",
        newRefName: "t3code/crash-recovery",
      });

      assert.deepStrictEqual(result.worktree, {
        path: "/repo-worktrees/crash-recovery",
        refName: "t3code/crash-recovery",
      });
      assert.deepStrictEqual(calls, ["prune-worktrees", "list-local-refs"]);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("rehydrates an existing branch through the repository mutation lock", () => {
    const calls: Array<unknown> = [];
    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () => Effect.succeed({ kind: "git" } as never),
        }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          pruneWorktrees: ({ cwd }) =>
            Effect.sync(() => {
              calls.push({ operation: "prune", cwd });
            }),
          listRefs: (input) =>
            Effect.sync(() => {
              calls.push({ operation: "list", input });
              return {
                refs: [],
                isRepo: true,
                hasPrimaryRemote: true,
                nextCursor: null,
                totalCount: 0,
              };
            }),
          createWorktree: (input) =>
            Effect.sync(() => {
              calls.push({ operation: "create", input });
              return {
                worktree: {
                  path: "/repo-worktrees/slack-thread",
                  refName: "t3code/slack-thread",
                },
              };
            }),
        }),
      ),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const result = yield* workflow.createWorktreeFromExistingBranch({
        cwd: "/repo",
        refName: "t3code/slack-thread",
      });

      assert.deepStrictEqual(result, {
        worktree: {
          path: "/repo-worktrees/slack-thread",
          refName: "t3code/slack-thread",
        },
      });
      assert.deepStrictEqual(calls, [
        {
          operation: "prune",
          cwd: "/repo",
        },
        {
          operation: "list",
          input: {
            cwd: "/repo",
            query: "t3code/slack-thread",
            refKind: "local",
            refresh: true,
            limit: 100,
          },
        },
        {
          operation: "create",
          input: {
            cwd: "/repo",
            refName: "t3code/slack-thread",
            path: null,
          },
        },
      ]);
    }).pipe(Effect.provide(testLayer));
  });
});
