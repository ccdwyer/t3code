import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type WorktreeSeedStrategy =
  | "macos-clone"
  | "linux-reflink"
  | "unsupported"
  | "not-configured";

export type WorktreeSeedSkipReason =
  | "unsupported-platform"
  | "source-missing"
  | "destination-exists"
  | "copy-on-write-unavailable";

export interface WorktreeSeedResult {
  readonly strategy: WorktreeSeedStrategy;
  readonly seededPaths: ReadonlyArray<string>;
  readonly skippedPaths: ReadonlyArray<{
    readonly path: string;
    readonly reason: WorktreeSeedSkipReason;
  }>;
}

export interface WorktreeSeedServiceShape {
  readonly seed: (input: {
    readonly projectCwd: string;
    readonly worktreePath: string;
  }) => Effect.Effect<WorktreeSeedResult>;
}

export class WorktreeSeedService extends Context.Service<
  WorktreeSeedService,
  WorktreeSeedServiceShape
>()("t3/project/WorktreeSeedService") {}
