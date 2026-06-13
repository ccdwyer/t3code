import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const containsRealPath = (realRoot: string, realTarget: string) => {
    const relative = path.relative(realRoot, realTarget);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const containmentError = (
    input: { readonly cwd: string; readonly relativePath: string },
    operation: string,
    detail: string,
  ) =>
    new WorkspaceFileSystemError({
      cwd: input.cwd,
      relativePath: input.relativePath,
      operation,
      detail,
    });

  const mapFileSystemError =
    (input: { readonly cwd: string; readonly relativePath: string }, operation: string) =>
    (cause: unknown) =>
      new WorkspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

  const isNotFoundError = (cause: unknown): boolean => {
    if (typeof cause !== "object" || cause === null || !("reason" in cause)) {
      return false;
    }
    const reason = (cause as { readonly reason?: unknown }).reason;
    return (
      typeof reason === "object" &&
      reason !== null &&
      "_tag" in reason &&
      (reason as { readonly _tag?: unknown })._tag === "NotFound"
    );
  };

  const realWorkspaceRoot = (
    input: { readonly cwd: string; readonly relativePath: string },
    operation: string,
  ) => fileSystem.realPath(input.cwd).pipe(Effect.mapError(mapFileSystemError(input, operation)));

  const existingRealTargetWithinWorkspace = (
    input: { readonly cwd: string; readonly relativePath: string },
    absolutePath: string,
    operation: string,
  ) =>
    Effect.gen(function* () {
      const realRoot = yield* realWorkspaceRoot(input, operation);
      const realTarget = yield* fileSystem
        .realPath(absolutePath)
        .pipe(Effect.mapError(mapFileSystemError(input, operation)));
      if (!containsRealPath(realRoot, realTarget)) {
        return yield* containmentError(
          input,
          operation,
          "Workspace file target resolves outside the workspace root.",
        );
      }
      return realTarget;
    });

  const writableRealTargetWithinWorkspace = (
    input: { readonly cwd: string; readonly relativePath: string },
    absolutePath: string,
    operation: string,
  ) =>
    Effect.gen(function* () {
      const realRoot = yield* realWorkspaceRoot(input, operation);
      const targetDirectory = path.dirname(absolutePath);
      const realParent = yield* fileSystem
        .realPath(targetDirectory)
        .pipe(Effect.mapError(mapFileSystemError(input, operation)));
      if (!containsRealPath(realRoot, realParent)) {
        return yield* containmentError(
          input,
          operation,
          "Workspace file parent resolves outside the workspace root.",
        );
      }

      const realTarget = yield* fileSystem
        .realPath(absolutePath)
        .pipe(Effect.orElseSucceed(() => path.resolve(realParent, path.basename(absolutePath))));
      if (!containsRealPath(realRoot, realTarget)) {
        return yield* containmentError(
          input,
          operation,
          "Workspace file target resolves outside the workspace root.",
        );
      }
      return realTarget;
    });

  const deletableTargetWithinWorkspace = (
    input: { readonly cwd: string; readonly relativePath: string },
    absolutePath: string,
    operation: string,
  ) =>
    Effect.gen(function* () {
      const realRoot = yield* realWorkspaceRoot(input, operation);
      const symlinkTarget = yield* fileSystem
        .readLink(absolutePath)
        .pipe(Effect.orElseSucceed(() => null));

      if (symlinkTarget !== null) {
        const targetDirectory = path.dirname(absolutePath);
        const realParent = yield* fileSystem
          .realPath(targetDirectory)
          .pipe(Effect.mapError(mapFileSystemError(input, operation)));
        if (!containsRealPath(realRoot, realParent)) {
          return yield* containmentError(
            input,
            operation,
            "Workspace file parent resolves outside the workspace root.",
          );
        }

        const absoluteLinkTarget = path.isAbsolute(symlinkTarget)
          ? symlinkTarget
          : path.resolve(targetDirectory, symlinkTarget);
        const logicalRoot = path.resolve(input.cwd);
        const logicalTarget = path.resolve(absoluteLinkTarget);
        if (
          !containsRealPath(logicalRoot, logicalTarget) &&
          !containsRealPath(realRoot, logicalTarget)
        ) {
          return yield* containmentError(
            input,
            operation,
            "Workspace file target resolves outside the workspace root.",
          );
        }

        const realTarget = yield* fileSystem
          .realPath(absoluteLinkTarget)
          .pipe(Effect.orElseSucceed(() => null));
        if (realTarget !== null && !containsRealPath(realRoot, realTarget)) {
          return yield* containmentError(
            input,
            operation,
            "Workspace file target resolves outside the workspace root.",
          );
        }
        return true;
      }

      const targetExists = yield* fileSystem.stat(absolutePath).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          isNotFoundError(cause)
            ? Effect.succeed(false)
            : Effect.fail(mapFileSystemError(input, operation)(cause)),
        ),
      );
      if (!targetExists) {
        return false;
      }

      const realTarget = yield* fileSystem
        .realPath(absolutePath)
        .pipe(Effect.mapError(mapFileSystemError(input, operation)));
      if (!containsRealPath(realRoot, realTarget)) {
        return yield* containmentError(
          input,
          operation,
          "Workspace file target resolves outside the workspace root.",
        );
      }
      return true;
    });

  const readFileString: WorkspaceFileSystemShape["readFileString"] = Effect.fn(
    "WorkspaceFileSystem.readFileString",
  )(function* (input) {
    const operation = "workspaceFileSystem.readFileString";
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const realTarget = yield* existingRealTargetWithinWorkspace(
      input,
      target.absolutePath,
      operation,
    );

    return yield* fileSystem
      .readFileString(realTarget)
      .pipe(Effect.mapError(mapFileSystemError(input, operation)));
  });

  const listFiles: WorkspaceFileSystemShape["listFiles"] = Effect.fn(
    "WorkspaceFileSystem.listFiles",
  )(function* (input) {
    const operation = "workspaceFileSystem.listFiles";
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const exists = yield* fileSystem
      .exists(target.absolutePath)
      .pipe(Effect.mapError(mapFileSystemError(input, operation)));
    if (!exists) {
      return [];
    }
    const realTarget = yield* existingRealTargetWithinWorkspace(
      input,
      target.absolutePath,
      operation,
    );
    const entries = yield* fileSystem
      .readDirectory(realTarget)
      .pipe(Effect.mapError(mapFileSystemError(input, operation)));
    const files: string[] = [];
    for (const entry of entries) {
      const info = yield* fileSystem
        .stat(path.join(realTarget, entry))
        .pipe(Effect.orElseSucceed(() => null));
      if (info?.type === "File") {
        files.push(entry);
      }
    }
    return files.sort((left, right) => left.localeCompare(right));
  });

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const operation = "workspaceFileSystem.writeFile";
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* writableRealTargetWithinWorkspace(input, target.absolutePath, operation);
    yield* fileSystem
      .writeFileString(target.absolutePath, input.contents)
      .pipe(Effect.mapError(mapFileSystemError(input, operation)));
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });

  const createFileExclusive: WorkspaceFileSystemShape["createFileExclusive"] = Effect.fn(
    "WorkspaceFileSystem.createFileExclusive",
  )(function* (input) {
    const operation = "workspaceFileSystem.createFileExclusive";
    const fileInput = { cwd: input.projectRoot, relativePath: input.relativePath };
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.projectRoot,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.projectRoot,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* writableRealTargetWithinWorkspace(fileInput, target.absolutePath, operation);
    yield* fileSystem.writeFileString(target.absolutePath, input.contents, { flag: "wx" }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.projectRoot,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.createFileExclusive",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.projectRoot);
    return { relativePath: target.relativePath };
  });

  const deleteFile: WorkspaceFileSystemShape["deleteFile"] = Effect.fn(
    "WorkspaceFileSystem.deleteFile",
  )(function* (input) {
    const operation = "workspaceFileSystem.deleteFile";
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const exists = yield* deletableTargetWithinWorkspace(input, target.absolutePath, operation);
    if (!exists) {
      return;
    }

    yield* fileSystem
      .remove(target.absolutePath, { force: true })
      .pipe(Effect.mapError(mapFileSystemError(input, operation)));
    yield* workspaceEntries.invalidate(input.cwd);
  });

  return {
    readFileString,
    listFiles,
    writeFile,
    createFileExclusive,
    deleteFile,
  } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
