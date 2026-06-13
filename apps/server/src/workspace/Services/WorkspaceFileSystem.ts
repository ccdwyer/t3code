/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectWriteFileInput, ProjectWriteFileResult } from "@t3tools/contracts";
import { WorkspacePathOutsideRootError } from "./WorkspacePaths.ts";

export class WorkspaceFileSystemError extends Schema.TaggedErrorClass<WorkspaceFileSystemError>()(
  "WorkspaceFileSystemError",
  {
    cwd: Schema.String,
    relativePath: Schema.optional(Schema.String),
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * WorkspaceFileSystemShape - Service API for workspace-relative file operations.
 */
export interface WorkspaceFileSystemShape {
  /**
   * Read a file relative to the workspace root.
   *
   * Rejects paths that escape the workspace root.
   */
  readonly readFileString: (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) => Effect.Effect<string, WorkspaceFileSystemError | WorkspacePathOutsideRootError>;

  /**
   * List the regular files directly inside a directory relative to the
   * workspace root (sorted by name). A missing directory lists as empty.
   */
  readonly listFiles: (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) => Effect.Effect<
    ReadonlyArray<string>,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  /**
   * Write a file relative to the workspace root.
   *
   * Creates parent directories as needed and rejects paths that escape the
   * workspace root.
   */
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  /**
   * Create a file relative to the workspace root, failing if it already exists.
   *
   * Creates parent directories as needed and rejects paths that escape the
   * workspace root.
   */
  readonly createFileExclusive: (input: {
    readonly projectRoot: string;
    readonly relativePath: string;
    readonly contents: string;
  }) => Effect.Effect<
    ProjectWriteFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  /**
   * Delete a file relative to the workspace root.
   *
   * Rejects paths that escape the workspace root. Missing files are treated as
   * already deleted so callers can retry safely.
   */
  readonly deleteFile: (input: {
    readonly cwd: string;
    readonly relativePath: string;
  }) => Effect.Effect<void, WorkspaceFileSystemError | WorkspacePathOutsideRootError>;
}

/**
 * WorkspaceFileSystem - Service tag for workspace file operations.
 */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  WorkspaceFileSystemShape
>()("t3/workspace/Services/WorkspaceFileSystem") {}
