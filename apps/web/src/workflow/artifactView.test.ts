import type { WorkflowTicketArtifactView, WorkflowTicketArtifactsResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  artifactsInServerOrder,
  contentStateFor,
  formatBytes,
  needsFetchOnExpand,
  rendererForKind,
  scratchIsExpandable,
  scratchNeedsUrl,
  scratchRendererForKind,
} from "./artifactView";

const view = (overrides: Partial<WorkflowTicketArtifactView> = {}): WorkflowTicketArtifactView =>
  ({
    artifactId: "art_1",
    name: "PLAN.md",
    kind: "markdown",
    mime: "text/markdown",
    byteSize: 1234,
    createdAt: "2026-08-05T10:00:00.000Z",
    updatedAt: "2026-08-05T10:05:00.000Z",
    url: "/assets/ticket-artifacts/art_1?sig=abc",
    ...overrides,
  }) as WorkflowTicketArtifactView;

describe("rendererForKind", () => {
  it("maps every kind to its viewer", () => {
    expect(rendererForKind("markdown")).toBe("markdown");
    expect(rendererForKind("text")).toBe("text");
    expect(rendererForKind("html")).toBe("html-link");
    expect(rendererForKind("image")).toBe("image");
    expect(rendererForKind("video")).toBe("video");
  });
});

describe("contentStateFor", () => {
  it("returns inline when complete content arrived with the list", () => {
    expect(contentStateFor(view({ content: "# Plan" }))).toEqual({
      status: "inline",
      content: "# Plan",
    });
  });

  it("returns needs-fetch with the partial slice as preview when truncated", () => {
    expect(contentStateFor(view({ content: "# Pla", contentTruncated: true }))).toEqual({
      status: "needs-fetch",
      preview: "# Pla",
    });
  });

  it("returns needs-fetch without a preview when omitted by the aggregate budget", () => {
    expect(contentStateFor(view({ contentOmitted: true }))).toEqual({
      status: "needs-fetch",
      preview: undefined,
    });
  });

  it("returns needs-fetch defensively when content is absent with no flags", () => {
    expect(contentStateFor(view({ kind: "text", mime: "text/plain" }))).toEqual({
      status: "needs-fetch",
      preview: undefined,
    });
  });

  it("unavailable wins over everything else", () => {
    expect(
      contentStateFor(
        view({
          content: "stale",
          contentTruncated: true,
          contentUnavailable: true,
        }),
      ),
    ).toEqual({ status: "unavailable" });
    expect(contentStateFor(view({ kind: "image", contentUnavailable: true }))).toEqual({
      status: "unavailable",
    });
  });

  it("non-text kinds carry no textual content state", () => {
    for (const kind of ["html", "image", "video"] as const) {
      expect(contentStateFor(view({ kind }))).toEqual({ status: "none" });
    }
  });
});

describe("needsFetchOnExpand", () => {
  it("is true exactly for omitted/truncated (or content-less) text kinds", () => {
    expect(needsFetchOnExpand(view({ contentOmitted: true }))).toBe(true);
    expect(needsFetchOnExpand(view({ content: "x", contentTruncated: true }))).toBe(true);
    expect(needsFetchOnExpand(view({ content: "full" }))).toBe(false);
    expect(needsFetchOnExpand(view({ kind: "image" }))).toBe(false);
    expect(needsFetchOnExpand(view({ contentUnavailable: true }))).toBe(false);
  });
});

describe("artifactsInServerOrder", () => {
  it("preserves the server's canonical order — never re-sorts", () => {
    const artifacts = [
      view({ artifactId: "b", name: "b.md" }),
      view({ artifactId: "A", name: "A.md" }),
      view({ artifactId: "z", name: "z.md" }),
      view({ artifactId: "0", name: "0.md" }),
    ];
    const result = {
      artifacts,
      scratch: [],
    } as unknown as WorkflowTicketArtifactsResult;
    const ordered = artifactsInServerOrder(result);
    expect(ordered.map((a) => a.artifactId)).toEqual(["b", "A", "z", "0"]);
    // Identity: the exact array the server sent, untouched.
    expect(ordered).toBe(artifacts);
  });
});

describe("formatBytes", () => {
  it("formats using KiB = 1024 B and MiB = 1024 KiB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(10 * 1024)).toBe("10 KiB");
    expect(formatBytes(64 * 1024)).toBe("64 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1 MiB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MiB");
    expect(formatBytes(100 * 1024 * 1024)).toBe("100 MiB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GiB");
  });

  it("is defensive about invalid sizes", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("scratch view model", () => {
  it("maps every scratch kind to a renderer, including the binary fallback", () => {
    expect(scratchRendererForKind("markdown")).toBe("markdown");
    expect(scratchRendererForKind("text")).toBe("text");
    expect(scratchRendererForKind("html")).toBe("html-link");
    expect(scratchRendererForKind("image")).toBe("image");
    expect(scratchRendererForKind("video")).toBe("video");
    expect(scratchRendererForKind("binary")).toBe("binary");
  });

  it("requires a signed url for exactly the kinds that cannot render without one", () => {
    expect(scratchNeedsUrl("html")).toBe(true);
    expect(scratchNeedsUrl("image")).toBe(true);
    expect(scratchNeedsUrl("video")).toBe(true);
    // Text-like rows carry inline content; binary renders no body at all.
    expect(scratchNeedsUrl("markdown")).toBe(false);
    expect(scratchNeedsUrl("text")).toBe(false);
    expect(scratchNeedsUrl("binary")).toBe(false);
  });

  it("expands only the kinds with a body to show", () => {
    expect(scratchIsExpandable("markdown")).toBe(true);
    expect(scratchIsExpandable("text")).toBe(true);
    expect(scratchIsExpandable("image")).toBe(true);
    expect(scratchIsExpandable("video")).toBe(true);
    // html links out (durable pattern); binary has nothing to reveal.
    expect(scratchIsExpandable("html")).toBe(false);
    expect(scratchIsExpandable("binary")).toBe(false);
  });
});
