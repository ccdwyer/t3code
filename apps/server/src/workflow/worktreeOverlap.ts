/**
 * Pure overlap math for worktree-aware parallelism (Phase A / conflict policy).
 *
 * Callers should pass git-style repo-relative paths (`git diff --name-only`).
 * Paths are normalized before intersection: strip leading `./`, collapse
 * duplicate `/`, drop trailing `/`, and compare case-insensitively so
 * case-insensitive filesystems (default macOS APFS, Windows) do not miss
 * collisions. Display forms keep the first-seen casing from the left set.
 */
export type ConflictPolicy = "off" | "warn" | "serialize";

/** Stable reason prefixes for serialize-hold step outcomes (engine routing bypass). */
export const PARALLELISM_HOLD_REASON_ACTIVE = "ticket is held for worktree serialization";
export const PARALLELISM_HOLD_REASON_PREFIX = "serialize hold:";

/** True when a blocked step outcome is a worktree serialize hold (must not on.blocked-route). */
export const isParallelismHoldReason = (reason: string | undefined): boolean =>
  reason === PARALLELISM_HOLD_REASON_ACTIVE ||
  (reason !== undefined && reason.startsWith(PARALLELISM_HOLD_REASON_PREFIX));

export const serializeHoldReason = (blockedByTicketId: string): string =>
  `${PARALLELISM_HOLD_REASON_PREFIX} overlaps with ${blockedByTicketId}`;

/** Normalize a repo-relative path for stable comparison. */
export const normalizeRepoPath = (path: string): string => {
  let p = path.replaceAll("\\", "/").trim();
  while (p.startsWith("./")) {
    p = p.slice(2);
  }
  // Collapse duplicate separators.
  p = p.replace(/\/{2,}/g, "/");
  // Drop trailing slash (except keep empty as empty).
  if (p.length > 1 && p.endsWith("/")) {
    p = p.slice(0, -1);
  }
  return p;
};

const pathKey = (path: string): string => normalizeRepoPath(path).toLowerCase();

export const computePathOverlap = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const left = new Map<string, string>();
  for (const raw of a) {
    const n = normalizeRepoPath(raw);
    if (n.length === 0) continue;
    const k = n.toLowerCase();
    if (!left.has(k)) left.set(k, n);
  }
  const right = new Set<string>();
  for (const raw of b) {
    const n = normalizeRepoPath(raw);
    if (n.length === 0) continue;
    right.add(n.toLowerCase());
  }
  return [...left.entries()]
    .filter(([k]) => right.has(k))
    .map(([, display]) => display)
    .sort();
};

/**
 * Simple ignore matcher used by `overlapIgnorePaths`.
 *
 * Supported forms (not full gitignore):
 * - exact path or prefix: `src/a.ts`, `src` (matches `src` and `src/...`)
 * - directory prefix: `dist/`
 * - one-level children: `src/*` (matches `src/a.ts`, not `src/x/y.ts`)
 * - recursive under dir: `src/**` (matches under `src/`, not `src` itself)
 * - basename globs with `*`: `*.log`, `*lock*` (no `/` in pattern → basename only)
 * - bare `*`: matches every path
 *
 * Patterns with unsupported complex globs (e.g. `**` mid-path) fall through
 * to exact/prefix match and typically match nothing.
 */
export const pathIgnored = (path: string, ignore: ReadonlyArray<string>): boolean => {
  const normalized = normalizeRepoPath(path);
  if (normalized.length === 0) return false;
  const basename = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;

  for (const rawPattern of ignore) {
    // Preserve trailing-slash directory intent before path normalization.
    const trimmed = rawPattern.replaceAll("\\", "/").trim();
    const isDirPrefix =
      trimmed.endsWith("/") && !trimmed.endsWith("/*") && !trimmed.endsWith("/**");
    const pattern = normalizeRepoPath(trimmed);
    if (pattern.length === 0 && trimmed !== "*") continue;

    if (trimmed === "*" || pattern === "*") {
      return true;
    }

    if (trimmed.endsWith("/**") || pattern.endsWith("/**")) {
      const prefix = (
        trimmed.endsWith("/**") ? trimmed.slice(0, -3) : pattern.slice(0, -3)
      ).replace(/\/+$/, "");
      const prefixNorm = normalizeRepoPath(prefix);
      // `a/**` matches under `a/`, not `a` itself (gitignore-ish).
      if (prefixNorm.length > 0 && normalized.startsWith(`${prefixNorm}/`)) return true;
    } else if (trimmed.endsWith("/*") || pattern.endsWith("/*")) {
      const prefix = (trimmed.endsWith("/*") ? trimmed.slice(0, -2) : pattern.slice(0, -2)).replace(
        /\/+$/,
        "",
      );
      const prefixNorm = normalizeRepoPath(prefix);
      if (
        prefixNorm.length > 0 &&
        normalized.startsWith(`${prefixNorm}/`) &&
        !normalized.slice(prefixNorm.length + 1).includes("/")
      ) {
        return true;
      }
    } else if (isDirPrefix) {
      if (normalized === pattern || normalized.startsWith(`${pattern}/`)) return true;
    } else if (!pattern.includes("/") && pattern.includes("*")) {
      // Basename-only glob: `*.log`, `foo*`, `*bar*`.
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
      if (new RegExp(`^${escaped}$`, "i").test(basename)) return true;
    } else if (normalized === pattern || normalized.startsWith(`${pattern}/`)) {
      return true;
    } else if (pathKey(normalized) === pathKey(pattern)) {
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
  | {
      readonly action: "warned" | "serialized";
      /** Cap ≤50, lexicographic. */
      readonly paths: ReadonlyArray<string>;
      /** Full intersection size before the 50-path cap. */
      readonly totalPathCount: number;
      readonly truncated: boolean;
    };

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
  const capped = overlap.slice(0, 50);
  return {
    action: effective === "serialize" ? "serialized" : "warned",
    paths: capped,
    totalPathCount: overlap.length,
    truncated: overlap.length > 50,
  };
};
