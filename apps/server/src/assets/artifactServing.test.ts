import { assert, describe, it } from "@effect/vitest";

import { artifactHeaders, contentDispositionInline, decideRange } from "./artifactServing.ts";

describe("decideRange — the pinned decision table", () => {
  const SIZE = 1000;

  it("no header → full", () => {
    assert.deepEqual(decideRange(undefined, SIZE), { kind: "full" });
  });

  it("ignore-class → full 200: malformed, unknown units, multi-range", () => {
    assert.deepEqual(decideRange("bites=0-10", SIZE), { kind: "full" });
    assert.deepEqual(decideRange("bytes=abc", SIZE), { kind: "full" });
    assert.deepEqual(decideRange("bytes=0-10,20-30", SIZE), { kind: "full" });
    // Ignore-class against a ZERO-LENGTH file still → 200 (caller sends
    // Content-Length: 0).
    assert.deepEqual(decideRange("bytes=0-10,20-30", 0), { kind: "full" });
    assert.deepEqual(decideRange("bites=0-10", 0), { kind: "full" });
  });

  it("bounded ranges clamp end to size-1", () => {
    assert.deepEqual(decideRange("bytes=100-200", SIZE), {
      kind: "partial",
      start: 100,
      end: 200,
      openEnded: false,
    });
    assert.deepEqual(decideRange("bytes=900-5000", SIZE), {
      kind: "partial",
      start: 900,
      end: 999,
      openEnded: false,
    });
  });

  it("open-ended bytes=0- (the first thing browsers send) → whole file 206", () => {
    assert.deepEqual(decideRange("bytes=0-", SIZE), {
      kind: "partial",
      start: 0,
      end: 999,
      openEnded: true,
    });
    assert.deepEqual(decideRange("bytes=500-", SIZE), {
      kind: "partial",
      start: 500,
      end: 999,
      openEnded: true,
    });
  });

  it("suffix ranges; suffix > size covers the whole file", () => {
    assert.deepEqual(decideRange("bytes=-100", SIZE), {
      kind: "partial",
      start: 900,
      end: 999,
      openEnded: true,
    });
    assert.deepEqual(decideRange("bytes=-5000", SIZE), {
      kind: "partial",
      start: 0,
      end: 999,
      openEnded: true,
    });
  });

  it("unsatisfiable → 416: start ≥ size, -0, end < start, valid range on empty file", () => {
    assert.deepEqual(decideRange("bytes=1000-", SIZE), { kind: "unsatisfiable" });
    assert.deepEqual(decideRange("bytes=1500-1600", SIZE), { kind: "unsatisfiable" });
    assert.deepEqual(decideRange("bytes=-0", SIZE), { kind: "unsatisfiable" });
    assert.deepEqual(decideRange("bytes=200-100", SIZE), { kind: "unsatisfiable" });
    assert.deepEqual(decideRange("bytes=0-", 0), { kind: "unsatisfiable" });
    assert.deepEqual(decideRange("bytes=-100", 0), { kind: "unsatisfiable" });
  });
});

describe("contentDispositionInline", () => {
  it("derives both parameters from the basename only", () => {
    const header = contentDispositionInline("after/board shot.png");
    assert.include(header, 'filename="board shot.png"');
    assert.include(header, "filename*=UTF-8''board%20shot.png");
    assert.notInclude(header, "after/");
  });

  it("replaces non-ASCII with _ and strips quotes/controls in the fallback", () => {
    const header = contentDispositionInline('报告 "final".html');
    assert.include(header, 'filename="__ final.html"');
    assert.include(header, "filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%22final%22.html");
  });

  it("falls back to 'artifact' when the sanitized basename is empty", () => {
    assert.include(contentDispositionInline("评估"), 'filename="__"');
    assert.include(contentDispositionInline('""'), 'filename="artifact"');
  });
});

describe("artifactHeaders", () => {
  it("pins the base set and gates CSP on html", () => {
    const base = artifactHeaders({
      mime: "image/png",
      displayName: "a.png",
      activeContent: null,
    });
    assert.equal(base["X-Content-Type-Options"], "nosniff");
    assert.equal(base["Cache-Control"], "private, no-store");
    assert.equal(base["Referrer-Policy"], "no-referrer");
    assert.equal(base["Accept-Ranges"], "bytes");
    assert.isUndefined(base["Content-Security-Policy"]);

    const html = artifactHeaders({
      mime: "text/html; charset=utf-8",
      displayName: "report.html",
      activeContent: "html",
    });
    // Token-set equality: exactly sandbox + allow-scripts; allow-same-origin
    // is forbidden forever.
    const tokens = (html["Content-Security-Policy"] ?? "").split(/\s+/).sort();
    assert.deepEqual(tokens, ["allow-scripts", "sandbox"]);
  });

  it("sandboxes SVG WITHOUT allow-scripts", () => {
    const svg = artifactHeaders({
      mime: "image/svg+xml",
      displayName: "diagram.svg",
      activeContent: "svg",
    });
    // An <img>-loaded SVG never runs scripts, but a top-level open would —
    // bare `sandbox` gives it an opaque origin AND blocks script execution.
    assert.deepEqual((svg["Content-Security-Policy"] ?? "").split(/\s+/).sort(), ["sandbox"]);
    assert.equal(svg["X-Content-Type-Options"], "nosniff");
  });
});
