// @effect-diagnostics nodeBuiltinImport:off
import { constants as FsConstants } from "node:fs";
import * as Fs from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * The pinned safe-open sequence (spec §Ingest pipeline step 1 / §Serve-time
 * open): lstat regular → open O_NOFOLLOW → fstat regular → realpath
 * component-boundary containment → re-lstat dev/ino === fstat dev/ino.
 * Returns null on ANY violation. POSIX-only by contract.
 *
 * Lifted out of `Layers/TicketArtifactStore.ts` (spec
 * 2026-08-06-scratch-artifact-viewer-design §G) so the durable store and the
 * ticket-scratch read/serve paths share ONE containment implementation.
 *
 * The checks are byte-for-byte the original; the ONLY change is that the
 * success value additionally carries `realPath`. It is already computed for
 * the containment test, and the scratch caller needs it to decide the
 * artifacts-subtree exclusion on canonical paths. Durable callers ignore the
 * extra field, so their behavior is unchanged.
 *
 * `containRootRealpath` must already be a realpath. The target must be a
 * STRICT descendant of it, so passing a different root is the only knob a
 * caller has — scratch passes the canonical `.t3/ticket/<id>` directory,
 * the durable store passes its artifact root.
 */
export const openContained = async (
  absolutePath: string,
  containRootRealpath: string,
  options?: {
    /**
     * Refuse a file with more than one directory entry (`nlink !== 1`).
     *
     * Path containment cannot see hard links: `ln ../../.env notes.md` inside
     * the contained directory satisfies lstat-regular, O_NOFOLLOW, realpath
     * containment, AND the dev/ino recheck, because the link IS a real
     * directory entry there. Scratch content is agent-written and therefore
     * untrusted, so the scratch paths opt in. The durable store does not:
     * it writes its own blobs, and changing its behavior is out of scope.
     */
    readonly rejectMultiplyLinked?: boolean;
  },
): Promise<{
  readonly handle: Fs.FileHandle;
  readonly size: number;
  readonly mtimeMs: number;
  /** Canonical path of the opened file (component-boundary contained). */
  readonly realPath: string;
} | null> => {
  let handle: Fs.FileHandle | null = null;
  try {
    const pre = await Fs.lstat(absolutePath);
    if (!pre.isFile()) return null;
    handle = await Fs.open(absolutePath, FsConstants.O_RDONLY | FsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return null;
    }
    if (options?.rejectMultiplyLinked === true && stat.nlink !== 1) {
      await handle.close();
      return null;
    }
    const real = await Fs.realpath(absolutePath);
    if (real !== containRootRealpath && !real.startsWith(containRootRealpath + NodePath.sep)) {
      await handle.close();
      return null;
    }
    if (real === containRootRealpath) {
      // The target must be a CHILD of the root, never the root itself.
      await handle.close();
      return null;
    }
    const post = await Fs.lstat(absolutePath);
    if (post.dev !== stat.dev || post.ino !== stat.ino) {
      await handle.close();
      return null;
    }
    return { handle, size: stat.size, mtimeMs: stat.mtimeMs, realPath: real };
  } catch {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // already closed
      }
    }
    return null;
  }
};

/**
 * The open options EVERY ticket-scratch path must use — list and serve alike.
 *
 * A shared constant rather than two literals: when only the list path rejected
 * hard links, an attacker could list a normal file to mint a signed URL, then
 * replace the path with a hard link to a secret before the GET. The serve open
 * would happily return it. One constant makes that divergence impossible.
 */
export const SCRATCH_OPEN_OPTIONS = { rejectMultiplyLinked: true } as const;

/**
 * Whether an opened scratch file may be SERVED, given what the open revealed.
 *
 * Pulled out of the route so the decision sequence is testable without HTTP
 * plumbing: every branch here answers 404, and a regression in any of them is
 * otherwise silent. The route keeps the IO; this keeps the rules.
 */
export type ScratchServeDecision =
  | "serve"
  | "in-artifacts"
  | "unknown-kind"
  | "text-like"
  | "over-cap";

export const decideScratchServe = (input: {
  /** Canonical path of the OPENED file. */
  readonly realPath: string;
  /** Canonical ticket-root artifacts dir, or null when absent. */
  readonly artifactsRealPath: string | null;
  /** Kind re-derived from the claim's scan-relative tail, null if unknown. */
  readonly kind: "markdown" | "html" | "image" | "video" | "text" | null;
  readonly size: number;
  readonly capForKind: number | null;
}): ScratchServeDecision => {
  // The durable list owns artifacts/**, and a symlink or case alias can still
  // land there even though the claim's spelling did not.
  if (isInsideRealDirectory(input.realPath, input.artifactsRealPath)) return "in-artifacts";
  if (input.kind === null || input.capForKind === null) return "unknown-kind";
  // Text-like rows are inlined by the RPC and never get a URL, so a text-like
  // claim should not exist. Refuse rather than serve one.
  if (input.kind === "markdown" || input.kind === "text") return "text-like";
  // Re-checked against the CURRENT size: the claim carries no size baseline, so
  // a file small at signing time could otherwise grow and force a full read.
  if (input.size > input.capForKind) return "over-cap";
  return "serve";
};

/**
 * Canonical path of `<containRootRealpath>/<subdirectory>`, or null when it
 * does not exist. Resolved through `realpath` rather than string-joined: on a
 * case-insensitive volume the directory may be spelled `ARTIFACTS` on disk, and
 * `join(root, "artifacts")` would then never prefix-match the canonical path of
 * a file inside it.
 */
export const resolveSubdirectoryRealpath = async (
  containRootRealpath: string,
  subdirectory: string,
): Promise<string | null> => {
  try {
    return await Fs.realpath(NodePath.join(containRootRealpath, subdirectory));
  } catch {
    return null;
  }
};

/**
 * Canonical path of a ticket's scratch directory, ANCHORED to the workspace.
 *
 * `openContained`'s `O_NOFOLLOW` protects only the final component, so the
 * contain-root itself must be proven — otherwise a symlinked `.t3`, `ticket`,
 * or `<ticketId>` directory (or a swapped ancestor) pivots the root somewhere
 * else entirely, and every later containment check faithfully enforces
 * containment within the ATTACKER's directory. Both realpaths are resolved and
 * the ticket directory must be a strict descendant of the canonical workspace
 * root. Returns null on any violation.
 */
export const resolveTicketScratchRoot = async (
  workspaceRoot: string,
  ticketId: string,
): Promise<string | null> => {
  try {
    const workspaceReal = await Fs.realpath(workspaceRoot);
    const expected = NodePath.join(workspaceReal, ".t3", "ticket", ticketId);
    const ticketDirReal = await Fs.realpath(expected);
    // STRICT identity, not merely "somewhere under the workspace". A
    // `.t3/ticket/<id> -> <workspace>/.secrets` symlink stays inside the
    // workspace and would otherwise be accepted, letting the scratch list
    // enumerate and inline an unrelated directory. Any symlinked component
    // makes the realpath differ from the expected path, so equality rejects
    // the whole class.
    if (ticketDirReal !== expected) return null;
    return ticketDirReal;
  } catch {
    return null;
  }
};

/**
 * True when `realPath` is `subdirectoryRealpath` or a strict descendant of it,
 * using the same component-boundary rule as containment. Both inputs must
 * already be canonical. Used to keep the ticket-scratch paths out of the
 * durable `artifacts/` subtree — a raw `startsWith("artifacts/")` on the
 * scan-relative name is defeated by a case alias and by a symlink
 * (spec §C issuance gate 3).
 */
export const isInsideRealDirectory = (
  realPath: string,
  subdirectoryRealpath: string | null,
): boolean =>
  subdirectoryRealpath !== null &&
  (realPath === subdirectoryRealpath || realPath.startsWith(subdirectoryRealpath + NodePath.sep));
