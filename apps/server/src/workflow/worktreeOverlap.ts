/**
 * Pure overlap math for worktree-aware parallelism (Phase A / conflict policy).
 */
export type ConflictPolicy = "off" | "warn" | "serialize";

export const computePathOverlap = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const setB = new Set(b);
  return [...new Set(a.filter((p) => setB.has(p)))].sort();
};

/** Simple gitignore-style ignore: exact match or prefix `dir/` / `*` suffix. */
export const pathIgnored = (path: string, ignore: ReadonlyArray<string>): boolean => {
  for (const pattern of ignore) {
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3);
      if (path === prefix || path.startsWith(`${prefix}/`)) return true;
    } else if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      if (path.startsWith(`${prefix}/`) && !path.slice(prefix.length + 1).includes("/")) {
        return true;
      }
    } else if (pattern.endsWith("/")) {
      if (path.startsWith(pattern) || path === pattern.slice(0, -1)) return true;
    } else if (path === pattern || path.startsWith(`${pattern}/`)) {
      return true;
    }
  }
  return false;
};

export const filterIgnored = (
  paths: ReadonlyArray<string>,
  ignore: ReadonlyArray<string>,
): ReadonlyArray<string> => paths.filter((p) => !pathIgnored(p, ignore));

export type OverlapDecision =
  | { readonly action: "none" }
  | { readonly action: "warned" | "serialized"; readonly paths: ReadonlyArray<string> };

export const decideOverlapAction = (
  policy: ConflictPolicy | undefined,
  leftPaths: ReadonlyArray<string>,
  rightPaths: ReadonlyArray<string>,
  ignore: ReadonlyArray<string> = [],
): OverlapDecision => {
  const effective = policy ?? "off";
  if (effective === "off") {
    return { action: "none" };
  }
  const overlap = computePathOverlap(
    filterIgnored(leftPaths, ignore),
    filterIgnored(rightPaths, ignore),
  );
  if (overlap.length === 0) {
    return { action: "none" };
  }
  return {
    action: effective === "serialize" ? "serialized" : "warned",
    paths: overlap.slice(0, 50),
  };
};
