// @effect-diagnostics nodeBuiltinImport:off
import path from "node:path";

export const unsafeWorkflowInstructionPathMessage = (repoRelativePath: string): string =>
  `Instruction file path must be relative and stay within the project root: "${repoRelativePath}"`;

export const isSafeWorkflowInstructionPath = (repoRelativePath: string): boolean => {
  if (path.isAbsolute(repoRelativePath) || path.win32.isAbsolute(repoRelativePath)) {
    return false;
  }

  return !repoRelativePath.split(/[\\/]+/).some((segment) => segment === "..");
};

export const resolveWorkflowInstructionPath = (
  repoRoot: string,
  repoRelativePath: string,
): string | null =>
  isSafeWorkflowInstructionPath(repoRelativePath) ? path.resolve(repoRoot, repoRelativePath) : null;

export const containsRealPath = (realRoot: string, realTarget: string): boolean => {
  const relative = path.relative(realRoot, realTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
