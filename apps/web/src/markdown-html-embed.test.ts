import { describe, expect, it } from "vite-plus/test";

import {
  HTML_EMBED_MESSAGE_TYPE,
  buildHtmlEmbedSrcDoc,
  extractHtmlEmbedFileRef,
  isFenceClosedAt,
  isHtmlEmbedHeightMessage,
  isMessageFromEmbed,
} from "./markdown-html-embed";

function fenceOffsets(source: string, fenceStart: string): [number, number] {
  const start = source.indexOf(fenceStart);
  expect(start).toBeGreaterThanOrEqual(0);
  return [start, source.length];
}

describe("isFenceClosedAt", () => {
  it("treats every fence as closed once streaming ends", () => {
    expect(isFenceClosedAt("```html\n<p>hi</p>\n", 0, 18, false)).toBe(true);
    expect(isFenceClosedAt("anything", undefined, undefined, false)).toBe(true);
  });

  it("is conservative when offsets are missing while streaming", () => {
    expect(isFenceClosedAt("```html\n<p>hi</p>\n```", undefined, 21, true)).toBe(false);
    expect(isFenceClosedAt("```html\n<p>hi</p>\n```", 0, undefined, true)).toBe(false);
  });

  it("detects a closed fence mid-message while streaming", () => {
    const source = "before\n\n```html\n<p>hi</p>\n```\n\nmore prose";
    const start = source.indexOf("```html");
    const end = source.indexOf("\n\nmore prose");
    expect(isFenceClosedAt(source, start, end, true)).toBe(true);
  });

  it("reports a trailing unclosed fence as open while streaming", () => {
    const source = "before\n\n```html\n<p>partial";
    const [start, end] = fenceOffsets(source, "```html");
    expect(isFenceClosedAt(source, start, end, true)).toBe(false);
  });

  it("reports a fence with only the opening line as open", () => {
    const source = "```html\n";
    expect(isFenceClosedAt(source, 0, source.length, true)).toBe(false);
  });

  it("supports tilde fences", () => {
    const source = "~~~html\n<p>hi</p>\n~~~";
    expect(isFenceClosedAt(source, 0, source.length, true)).toBe(true);
  });

  it("accepts a closing fence longer than the opening", () => {
    const source = "```html\n<p>hi</p>\n`````";
    expect(isFenceClosedAt(source, 0, source.length, true)).toBe(true);
  });

  it("rejects a closing fence shorter than the opening", () => {
    const source = "````html\n<p>hi</p>\n```";
    expect(isFenceClosedAt(source, 0, source.length, true)).toBe(false);
  });

  it("supports indented fences", () => {
    const source = "   ```html\n   <p>hi</p>\n   ```";
    expect(isFenceClosedAt(source, 0, source.length, true)).toBe(true);
  });

  it("rejects a marker-mismatched closing line", () => {
    const source = "```html\n<p>hi</p>\n~~~";
    expect(isFenceClosedAt(source, 0, source.length, true)).toBe(false);
  });

  it("ignores trailing blank lines when finding the closer", () => {
    const source = "```html\n<p>hi</p>\n```\n\n";
    expect(isFenceClosedAt(source, 0, source.length, true)).toBe(true);
  });
});

describe("buildHtmlEmbedSrcDoc", () => {
  it("keeps the original html unchanged at the start", () => {
    const html = "<!doctype html><html><body><p>hi</p></body></html>";
    expect(buildHtmlEmbedSrcDoc(html).startsWith(html)).toBe(true);
  });

  it("appends exactly one resize-reporter script after the document", () => {
    const html = "<p>hi</p>";
    const srcDoc = buildHtmlEmbedSrcDoc(html);
    const occurrences = srcDoc.split(HTML_EMBED_MESSAGE_TYPE).length - 1;
    expect(occurrences).toBe(1);
    expect(srcDoc.indexOf("<script>")).toBeGreaterThan(srcDoc.indexOf("<p>hi</p>"));
    expect(srcDoc).toContain("ResizeObserver");
  });
});

describe("extractHtmlEmbedFileRef", () => {
  it("parses file= and src= attributes in all quote styles", () => {
    expect(extractHtmlEmbedFileRef("file=docs/plan.html")).toBe("docs/plan.html");
    expect(extractHtmlEmbedFileRef('file="docs/my plan.html"')).toBe("docs/my plan.html");
    expect(extractHtmlEmbedFileRef("file='plan.html'")).toBe("plan.html");
    expect(extractHtmlEmbedFileRef("src=reports/out.html")).toBe("reports/out.html");
  });

  it("accepts a bare *.html token but not other bare tokens", () => {
    expect(extractHtmlEmbedFileRef("docs/plan.html")).toBe("docs/plan.html");
    expect(extractHtmlEmbedFileRef("page.htm")).toBe("page.htm");
    expect(extractHtmlEmbedFileRef("docs/notes.md")).toBe(null);
    expect(extractHtmlEmbedFileRef("interactive demo")).toBe(null);
  });

  it("strips a leading ./ and handles empty meta", () => {
    expect(extractHtmlEmbedFileRef("file=./docs/plan.html")).toBe("docs/plan.html");
    expect(extractHtmlEmbedFileRef(undefined)).toBe(null);
    expect(extractHtmlEmbedFileRef("")).toBe(null);
  });

  it("allows explicit file= attributes with non-html extensions", () => {
    expect(extractHtmlEmbedFileRef("file=fragment.htmlpart")).toBe("fragment.htmlpart");
  });
});

describe("isHtmlEmbedHeightMessage", () => {
  it("accepts a well-formed height message", () => {
    expect(isHtmlEmbedHeightMessage({ type: HTML_EMBED_MESSAGE_TYPE, height: 300 })).toBe(true);
  });

  it("rejects malformed data", () => {
    expect(isHtmlEmbedHeightMessage(null)).toBe(false);
    expect(isHtmlEmbedHeightMessage(300)).toBe(false);
    expect(isHtmlEmbedHeightMessage({ type: "other", height: 300 })).toBe(false);
    expect(isHtmlEmbedHeightMessage({ type: HTML_EMBED_MESSAGE_TYPE, height: "300" })).toBe(false);
    expect(isHtmlEmbedHeightMessage({ type: HTML_EMBED_MESSAGE_TYPE, height: Number.NaN })).toBe(
      false,
    );
    expect(
      isHtmlEmbedHeightMessage({ type: HTML_EMBED_MESSAGE_TYPE, height: Number.POSITIVE_INFINITY }),
    ).toBe(false);
    expect(isHtmlEmbedHeightMessage({ type: HTML_EMBED_MESSAGE_TYPE, height: -1 })).toBe(false);
    expect(isHtmlEmbedHeightMessage({ type: HTML_EMBED_MESSAGE_TYPE, height: 0 })).toBe(false);
  });
});

describe("isMessageFromEmbed", () => {
  it("accepts only the embed's own content window by identity", () => {
    const contentWindow = {} as Window;
    expect(isMessageFromEmbed(contentWindow as MessageEventSource, contentWindow)).toBe(true);
    expect(isMessageFromEmbed({} as MessageEventSource, contentWindow)).toBe(false);
    expect(isMessageFromEmbed(null, contentWindow)).toBe(false);
    expect(isMessageFromEmbed(contentWindow as MessageEventSource, null)).toBe(false);
    expect(isMessageFromEmbed(null, null)).toBe(false);
  });
});
