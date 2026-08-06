// @effect-diagnostics nodeBuiltinImport:off
import { linkSync, rmSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as Fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { afterAll, assert, describe, it } from "@effect/vitest";

import {
  isInsideRealDirectory,
  openContained,
  resolveSubdirectoryRealpath,
  resolveTicketScratchRoot,
  SCRATCH_OPEN_OPTIONS,
  decideScratchServe,
} from "./containedOpen.ts";

/**
 * The containment primitive is the security boundary for BOTH the durable
 * artifact store and the ticket-scratch read/serve paths (spec
 * 2026-08-06-scratch-artifact-viewer §G). These cases pin the refusals the
 * scratch paths depend on: a symlinked entry must never be followed, nothing
 * outside the contain-root may open, and the artifacts subtree must be
 * detectable on canonical paths rather than on a spelling.
 */

const TEMP_DIRS: Array<string> = [];
afterAll(() => {
  // Each case makes a temp worktree; without this they accumulate under the
  // system temp dir across watch and CI runs.
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

const makeTree = () => {
  const base = mkdtempSync(NodePath.join(tmpdir(), "contained-"));
  TEMP_DIRS.push(base);
  TEMP_DIRS.push(base);
  const ticketDir = NodePath.join(base, ".t3", "ticket", "ticket-1");
  mkdirSync(ticketDir, { recursive: true });
  mkdirSync(NodePath.join(ticketDir, "artifacts"), { recursive: true });
  writeFileSync(NodePath.join(ticketDir, "PLAN.md"), "# plan");
  writeFileSync(NodePath.join(ticketDir, "artifacts", "kept.md"), "durable");
  writeFileSync(NodePath.join(base, "secret.env"), "TOKEN=1");
  return { base, ticketDir };
};

const close = async (opened: { readonly handle: Fs.FileHandle } | null) => {
  if (opened !== null) await opened.handle.close();
};

describe("openContained", () => {
  it("opens a regular file inside the contain root and reports its size and realpath", async () => {
    const { ticketDir } = makeTree();
    const root = await Fs.realpath(ticketDir);
    const opened = await openContained(NodePath.join(ticketDir, "PLAN.md"), root);
    assert.isNotNull(opened);
    assert.equal(opened?.size, 6);
    assert.equal(opened?.realPath, NodePath.join(root, "PLAN.md"));
    await close(opened);
  });

  it("refuses a symlinked final component pointing OUTSIDE the workspace", async () => {
    const { base, ticketDir } = makeTree();
    symlinkSync("/etc/hosts", NodePath.join(ticketDir, "hosts.md"));
    const root = await Fs.realpath(ticketDir);
    assert.isNull(await openContained(NodePath.join(ticketDir, "hosts.md"), root));
    assert.isTrue(base.length > 0);
  });

  it("refuses a symlink to another file INSIDE the workspace but outside the ticket dir", async () => {
    // The pre-existing leak this closes: `notes.md -> ../../../secret.env`
    // would otherwise have its contents inlined into the RPC response.
    const { base, ticketDir } = makeTree();
    symlinkSync(NodePath.join(base, "secret.env"), NodePath.join(ticketDir, "notes.md"));
    const root = await Fs.realpath(ticketDir);
    assert.isNull(await openContained(NodePath.join(ticketDir, "notes.md"), root));
  });

  it("refuses a symlink INTO the durable artifacts subtree", async () => {
    const { ticketDir } = makeTree();
    symlinkSync(
      NodePath.join(ticketDir, "artifacts", "kept.md"),
      NodePath.join(ticketDir, "sneaky.md"),
    );
    const root = await Fs.realpath(ticketDir);
    // O_NOFOLLOW refuses the symlinked final component outright — the
    // artifacts check below is the second line for non-symlink routes.
    assert.isNull(await openContained(NodePath.join(ticketDir, "sneaky.md"), root));
  });

  it("refuses a directory and a missing path", async () => {
    const { ticketDir } = makeTree();
    const root = await Fs.realpath(ticketDir);
    assert.isNull(await openContained(NodePath.join(ticketDir, "artifacts"), root));
    assert.isNull(await openContained(NodePath.join(ticketDir, "nope.md"), root));
  });

  it("refuses the contain root itself", async () => {
    const { ticketDir } = makeTree();
    const root = await Fs.realpath(ticketDir);
    assert.isNull(await openContained(root, root));
  });

  it("refuses a traversal path that escapes the contain root", async () => {
    const { ticketDir } = makeTree();
    const root = await Fs.realpath(ticketDir);
    assert.isNull(
      await openContained(NodePath.join(ticketDir, "..", "..", "..", "secret.env"), root),
    );
  });
});

describe("artifacts subtree exclusion", () => {
  it("detects a file inside the ticket's canonical artifacts directory", async () => {
    const { ticketDir } = makeTree();
    const root = await Fs.realpath(ticketDir);
    const artifactsReal = await resolveSubdirectoryRealpath(root, "artifacts");
    const opened = await openContained(NodePath.join(ticketDir, "artifacts", "kept.md"), root);
    assert.isNotNull(opened);
    assert.isTrue(isInsideRealDirectory(opened?.realPath ?? "", artifactsReal));
    await close(opened);
  });

  it("does NOT exclude a nested directory that merely happens to be named artifacts", async () => {
    const { ticketDir } = makeTree();
    mkdirSync(NodePath.join(ticketDir, "design", "artifacts"), { recursive: true });
    writeFileSync(NodePath.join(ticketDir, "design", "artifacts", "x.md"), "nested");
    const root = await Fs.realpath(ticketDir);
    const artifactsReal = await resolveSubdirectoryRealpath(root, "artifacts");
    const opened = await openContained(
      NodePath.join(ticketDir, "design", "artifacts", "x.md"),
      root,
    );
    assert.isNotNull(opened);
    // Only the TICKET-ROOT artifacts subtree belongs to the durable list.
    assert.isFalse(isInsideRealDirectory(opened?.realPath ?? "", artifactsReal));
    await close(opened);
  });

  it("returns null for a missing artifacts directory and then excludes nothing", async () => {
    const base = mkdtempSync(NodePath.join(tmpdir(), "contained-bare-"));
    TEMP_DIRS.push(base);
    assert.isNull(await resolveSubdirectoryRealpath(base, "artifacts"));
    assert.isFalse(isInsideRealDirectory(NodePath.join(base, "a.md"), null));
  });

  it("matches on component boundaries, not string prefixes", () => {
    // `/root/artifacts-old/x` must NOT count as inside `/root/artifacts`.
    assert.isFalse(isInsideRealDirectory("/root/artifacts-old/x.md", "/root/artifacts"));
    assert.isTrue(isInsideRealDirectory("/root/artifacts/x.md", "/root/artifacts"));
    assert.isTrue(isInsideRealDirectory("/root/artifacts", "/root/artifacts"));
  });
});

describe("resolveTicketScratchRoot", () => {
  it("resolves the ticket directory inside the canonical workspace root", async () => {
    const { base } = makeTree();
    const root = await resolveTicketScratchRoot(base, "ticket-1");
    assert.isNotNull(root);
    assert.equal(root, NodePath.join(await Fs.realpath(base), ".t3", "ticket", "ticket-1"));
  });

  it("refuses a ticket directory that an ANCESTOR symlink pivots out of the workspace", async () => {
    // O_NOFOLLOW only guards the final component. Without anchoring the
    // contain-root, every later containment check would faithfully enforce
    // containment inside the attacker's directory.
    const { base } = makeTree();
    const elsewhere = mkdtempSync(NodePath.join(tmpdir(), "elsewhere-"));
    TEMP_DIRS.push(elsewhere);
    mkdirSync(NodePath.join(elsewhere, "ticket-2"), { recursive: true });
    const victim = mkdtempSync(NodePath.join(tmpdir(), "victim-"));
    TEMP_DIRS.push(victim);
    mkdirSync(NodePath.join(victim, ".t3"), { recursive: true });
    // .t3/ticket -> /elsewhere
    symlinkSync(elsewhere, NodePath.join(victim, ".t3", "ticket"));
    assert.isNull(await resolveTicketScratchRoot(victim, "ticket-2"));
    assert.isTrue(base.length > 0);
  });

  it("refuses a missing ticket directory", async () => {
    const { base } = makeTree();
    assert.isNull(await resolveTicketScratchRoot(base, "no-such-ticket"));
  });
});

describe("hard links (path containment cannot see them)", () => {
  it("serves a hard link by default, and REFUSES it with rejectMultiplyLinked", async () => {
    const { base, ticketDir } = makeTree();
    // `ln <workspace>/secret.env <ticket>/notes.md` — the link IS a real
    // directory entry inside the ticket dir, so lstat-regular, O_NOFOLLOW,
    // realpath containment and the dev/ino recheck all pass.
    linkSync(NodePath.join(base, "secret.env"), NodePath.join(ticketDir, "notes.md"));
    const root = await Fs.realpath(ticketDir);
    const target = NodePath.join(ticketDir, "notes.md");

    const permissive = await openContained(target, root);
    assert.isNotNull(permissive, "path containment alone does not stop a hard link");
    await close(permissive);

    // Scratch content is agent-written, so the scratch paths opt in.
    assert.isNull(await openContained(target, root, { rejectMultiplyLinked: true }));
  });

  it("still opens an ordinary single-linked file under rejectMultiplyLinked", async () => {
    const { ticketDir } = makeTree();
    const root = await Fs.realpath(ticketDir);
    const opened = await openContained(NodePath.join(ticketDir, "PLAN.md"), root, {
      rejectMultiplyLinked: true,
    });
    assert.isNotNull(opened);
    await close(opened);
  });
});

describe("resolveTicketScratchRoot — inside-workspace pivots", () => {
  it("refuses a ticket directory symlinked to ANOTHER directory in the same workspace", async () => {
    // The subtler pivot: it never leaves the workspace, so a "descendant of the
    // workspace root" test accepts it and the scratch list would enumerate and
    // inline an unrelated directory.
    const victim = mkdtempSync(NodePath.join(tmpdir(), "pivot-inside-"));
    TEMP_DIRS.push(victim);
    mkdirSync(NodePath.join(victim, ".t3", "ticket"), { recursive: true });
    mkdirSync(NodePath.join(victim, ".secrets"), { recursive: true });
    writeFileSync(NodePath.join(victim, ".secrets", "creds.md"), "TOKEN=1");
    symlinkSync(
      NodePath.join(victim, ".secrets"),
      NodePath.join(victim, ".t3", "ticket", "ticket-9"),
    );
    assert.isNull(await resolveTicketScratchRoot(victim, "ticket-9"));
  });
});

describe("SCRATCH_OPEN_OPTIONS", () => {
  it("rejects hard links, so list and serve cannot drift apart", async () => {
    // The drift this guards: when only the LIST path rejected hard links, a
    // normal file could be listed to mint a signed URL and then replaced with a
    // hard link to a secret before the GET — the serve open would return it.
    // Both scratch paths must use this constant.
    assert.isTrue(SCRATCH_OPEN_OPTIONS.rejectMultiplyLinked);

    const { base, ticketDir } = makeTree();
    linkSync(NodePath.join(base, "secret.env"), NodePath.join(ticketDir, "swapped.md"));
    const root = await Fs.realpath(ticketDir);
    assert.isNull(
      await openContained(NodePath.join(ticketDir, "swapped.md"), root, SCRATCH_OPEN_OPTIONS),
    );
  });
});

describe("decideScratchServe", () => {
  const base = {
    realPath: "/wt/.t3/ticket/t1/shot.png",
    artifactsRealPath: "/wt/.t3/ticket/t1/artifacts",
    kind: "image" as const,
    size: 1024,
    capForKind: 10 * 1024 * 1024,
  };

  it("serves a recognized, in-bounds media file", () => {
    assert.equal(decideScratchServe(base), "serve");
  });

  it("refuses anything resolving into the durable artifacts subtree", () => {
    // A symlink or case alias can land here even when the claim's spelling did
    // not — which is why this is decided on the CANONICAL path.
    assert.equal(
      decideScratchServe({ ...base, realPath: "/wt/.t3/ticket/t1/artifacts/kept.png" }),
      "in-artifacts",
    );
  });

  it("refuses an unknown kind", () => {
    assert.equal(decideScratchServe({ ...base, kind: null, capForKind: null }), "unknown-kind");
  });

  it("refuses text-like kinds, which are inlined and never get a URL", () => {
    assert.equal(decideScratchServe({ ...base, kind: "markdown" }), "text-like");
    assert.equal(decideScratchServe({ ...base, kind: "text" }), "text-like");
  });

  it("refuses a file that grew past its cap after signing", () => {
    // The claim carries no size baseline, so this is the only thing standing
    // between a signed URL and a full-body read of an arbitrarily large file.
    assert.equal(decideScratchServe({ ...base, size: base.capForKind + 1 }), "over-cap");
    assert.equal(decideScratchServe({ ...base, size: base.capForKind }), "serve");
  });

  it("still serves when the ticket has no artifacts directory at all", () => {
    assert.equal(decideScratchServe({ ...base, artifactsRealPath: null }), "serve");
  });
});
