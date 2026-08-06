import { assert, describe, it } from "@effect/vitest";

import {
  activeContentFor,
  ARTIFACT_ALLOWED_EXTENSIONS,
  ARTIFACT_CAPTION_MAX_CHARS,
  ARTIFACT_FILE_CAPS,
  ARTIFACT_INLINE_FILE_CAP_BYTES,
  MIB,
  collisionWinner,
  compareRawNames,
  decodeUtf8Replacing,
  decodedByteLength,
  detectArtifactKind,
  isCanonicalUuid,
  isSidecarName,
  isTextLikeKind,
  isValidTicketDirKey,
  normalizeCaption,
  sidecarBaseName,
  sidecarNameFor,
  toSourceMtimeMs,
  truncateDecodedToBytes,
  validateArtifactName,
} from "./artifactRules.ts";

describe("artifactRules", () => {
  describe("kind/mime table", () => {
    it("maps the pinned extensions case-insensitively", () => {
      assert.deepEqual(detectArtifactKind("PLAN.md"), {
        kind: "markdown",
        mime: "text/markdown; charset=utf-8",
      });
      assert.deepEqual(detectArtifactKind("shots/after.PNG"), {
        kind: "image",
        mime: "image/png",
      });
      assert.deepEqual(detectArtifactKind("run.LOG"), {
        kind: "text",
        mime: "text/plain; charset=utf-8",
      });
      assert.deepEqual(detectArtifactKind("data.json"), {
        kind: "text",
        mime: "application/json",
      });
      assert.deepEqual(detectArtifactKind("flow.webm"), {
        kind: "video",
        mime: "video/webm",
      });
    });

    it("recognizes SVG as an image kind", () => {
      assert.deepEqual(detectArtifactKind("design/diagram.SVG"), {
        kind: "image",
        mime: "image/svg+xml",
      });
      assert.include(ARTIFACT_ALLOWED_EXTENSIONS, ".svg");
    });

    it("returns null for unknown extensions (skip-with-reason path)", () => {
      assert.isNull(detectArtifactKind("report.pdf"));
      assert.isNull(detectArtifactKind("noextension"));
      assert.isNull(detectArtifactKind(".gitignore"));
      assert.include(ARTIFACT_ALLOWED_EXTENSIONS, ".md");
      assert.include(ARTIFACT_ALLOWED_EXTENSIONS, ".webm");
    });

    it("classifies active content from MIME, never from kind", () => {
      assert.equal(activeContentFor("text/html; charset=utf-8"), "html");
      // The whole point: an SVG is kind "image", so a kind-keyed test would
      // leave it unsandboxed.
      assert.equal(activeContentFor("image/svg+xml"), "svg");
      assert.isNull(activeContentFor("image/png"));
      assert.isNull(activeContentFor("text/markdown; charset=utf-8"));
      assert.isNull(activeContentFor("video/mp4"));
    });

    it("pins caps in binary units and text-like kinds", () => {
      assert.equal(ARTIFACT_FILE_CAPS.markdown, 1 * MIB);
      assert.equal(ARTIFACT_FILE_CAPS.video, 100 * MIB);
      assert.equal(ARTIFACT_INLINE_FILE_CAP_BYTES, 65_536);
      assert.isTrue(isTextLikeKind("markdown"));
      assert.isTrue(isTextLikeKind("text"));
      assert.isFalse(isTextLikeKind("html"));
      assert.isFalse(isTextLikeKind("image"));
    });
  });

  describe("name validation", () => {
    it("accepts nested names and normalizes to NFC", () => {
      const nfd = "before/café.png"; // é as NFD
      const result = validateArtifactName(nfd);
      assert.isTrue(result.ok);
      if (result.ok) {
        assert.equal(result.normalized, "before/café.png");
      }
    });

    it("rejects the pinned invalid shapes", () => {
      for (const [raw, fragment] of [
        ["", "empty name"],
        ["/abs.md", "absolute"],
        ["a//b.md", "empty path segment"],
        ["a/../b.md", "dot path"],
        ["./b.md", "dot path"],
        ["a\\b.md", "backslash"],
        ["a\u0000b.md", "NUL"],
        [Array.from({ length: 17 }, (_, i) => `s${String(i)}`).join("/") + "/f.md", "segments"],
        ["x".repeat(513) + ".md", "longer than"],
      ] as const) {
        const result = validateArtifactName(raw);
        assert.isFalse(result.ok, `expected reject: ${raw.slice(0, 40)}`);
        if (!result.ok) assert.include(result.reason, fragment);
      }
    });

    it("collision winner is the smallest raw name in UTF-8 byte order", () => {
      const nfc = "café.png";
      const nfd = "café.png";
      // NFC é (0xC3 0xA9) vs NFD e+combining (0x65 0xCC 0x81): 'e' (0x65) < 0xC3.
      assert.equal(collisionWinner([nfc, nfd]), nfd);
      assert.isBelow(compareRawNames(nfd, nfc), 0);
      assert.equal(collisionWinner(["b.md", "a.md"]), "a.md");
    });
  });

  describe("sidecars", () => {
    it("matches the literal grammar with case-insensitive suffix", () => {
      assert.isTrue(isSidecarName("after.png.caption.md"));
      assert.isTrue(isSidecarName("report.md.caption.MD"));
      assert.equal(sidecarBaseName("report.md.caption.md"), "report.md");
      assert.equal(sidecarNameFor("after.png"), "after.png.caption.md");
      // The stem convention is NOT a sidecar for report.md — no base match.
      assert.equal(sidecarBaseName("report.caption.md"), "report");
      // A bare ".caption.md" has no base; it is not a sidecar name.
      assert.isFalse(isSidecarName(".caption.md"));
    });

    it("caption truncation includes the ellipsis in the 2000-char budget", () => {
      assert.equal(normalizeCaption("  hello  "), "hello");
      assert.isUndefined(normalizeCaption("   "));
      const long = "x".repeat(ARTIFACT_CAPTION_MAX_CHARS + 500);
      const capped = normalizeCaption(long);
      assert.isDefined(capped);
      if (capped !== undefined) {
        assert.lengthOf([...capped], ARTIFACT_CAPTION_MAX_CHARS);
        assert.isTrue(capped.endsWith("…"));
      }
      const exact = "y".repeat(ARTIFACT_CAPTION_MAX_CHARS);
      assert.equal(normalizeCaption(exact), exact);
    });
  });

  describe("identifier gates", () => {
    it("ticket dir key refuses anything path-capable", () => {
      assert.isTrue(isValidTicketDirKey("2d567e19-aaaa-bbbb-cccc-1234567890ab"));
      assert.isTrue(isValidTicketDirKey("ticket_1"));
      assert.isFalse(isValidTicketDirKey("../attachments"));
      assert.isFalse(isValidTicketDirKey("a/b"));
      assert.isFalse(isValidTicketDirKey("a.b"));
      assert.isFalse(isValidTicketDirKey(""));
    });

    it("canonical uuid gate", () => {
      assert.isTrue(isCanonicalUuid("0f2c7b1e-9d4a-4c1b-8e6f-1a2b3c4d5e6f"));
      assert.isFalse(isCanonicalUuid("0F2C7B1E-9D4A-4C1B-8E6F-1A2B3C4D5E6F"));
      assert.isFalse(isCanonicalUuid("not-a-uuid"));
      assert.isFalse(isCanonicalUuid(""));
    });
  });

  describe("pinned conversions", () => {
    it("mtime conversion floors", () => {
      assert.equal(toSourceMtimeMs(1722900000123.789), 1722900000123);
    });

    it("decodes invalid UTF-8 with replacement and counts returned bytes", () => {
      const invalid = new Uint8Array([0x68, 0x69, 0xff, 0xfe]);
      const decoded = decodeUtf8Replacing(invalid);
      assert.equal(decoded, "hi��");
      // Each U+FFFD is 3 UTF-8 bytes: budgets count RETURNED bytes (2 + 6).
      assert.equal(decodedByteLength(decoded), 8);
    });

    it("truncates decoded strings on code-point boundaries by byte budget", () => {
      const text = "aé漢🎥"; // 1 + 2 + 3 + 4 bytes
      assert.deepEqual(truncateDecodedToBytes(text, 10), {
        slice: text,
        truncated: false,
      });
      const cut = truncateDecodedToBytes(text, 9);
      assert.deepEqual(cut, { slice: "aé漢", truncated: true });
      const tight = truncateDecodedToBytes(text, 3);
      assert.deepEqual(tight, { slice: "aé", truncated: true });
      const zero = truncateDecodedToBytes(text, 0);
      assert.deepEqual(zero, { slice: "", truncated: true });
    });
  });
});
