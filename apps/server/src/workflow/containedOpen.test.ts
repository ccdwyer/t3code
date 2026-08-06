// @effect-diagnostics nodeBuiltinImport:off
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import * as Fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  isInsideRealDirectory,
  openContained,
  resolveSubdirectoryRealpath,
  resolveTicketScratchRoot,
} from "./containedOpen.ts";

/**
 * The containment primitive is the security boundary for BOTH the durable
 * artifact store and the ticket-scratch read/serve paths (spec
 * 2026-08-06-scratch-artifact-viewer §G). These cases pin the refusals the
 * scratch paths depend on: a symlinked entry must never be followed, nothing
 * outside the contain-root may open, and the artifacts subtree must be
 * detectable on canonical paths rather than on a spelling.
 */

const makeTree = () => {
  const base = mkdtempSync(NodePath.join(tmpdir(), "contained-"));
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
    mkdirSync(NodePath.join(elsewhere, "ticket-2"), { recursive: true });
    const victim = mkdtempSync(NodePath.join(tmpdir(), "victim-"));
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
