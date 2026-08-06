import type { WorkflowTicketArtifactView } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ArtifactImageViewer,
  ArtifactOpenInBrowser,
  ArtifactRowHeader,
  ArtifactUnavailableNotice,
  ArtifactVideoViewer,
  ScratchFileList,
  TicketArtifacts,
} from "./TicketArtifacts";

const NOW = Date.parse("2026-08-05T12:00:00.000Z");

const artifact = (
  overrides: Partial<WorkflowTicketArtifactView> = {},
): WorkflowTicketArtifactView =>
  ({
    artifactId: "art_1",
    name: "PLAN.md",
    kind: "markdown",
    mime: "text/markdown",
    byteSize: 4 * 1024,
    createdAt: "2026-08-05T11:00:00.000Z",
    updatedAt: "2026-08-05T11:55:00.000Z",
    url: "/assets/ticket-artifacts/art_1?sig=abc",
    ...overrides,
  }) as WorkflowTicketArtifactView;

describe("ArtifactRowHeader", () => {
  it("renders name, description, updated age, and formatted size", () => {
    const markup = renderToStaticMarkup(
      <ArtifactRowHeader artifact={artifact({ description: "Implementation plan" })} now={NOW} />,
    );
    expect(markup).toContain("PLAN.md");
    expect(markup).toContain("Implementation plan");
    expect(markup).toContain("updated 5m ago");
    expect(markup).toContain("4 KiB");
    // Kind icon rendered as an svg.
    expect(markup).toContain("<svg");
  });

  it("omits the description line when absent", () => {
    const markup = renderToStaticMarkup(<ArtifactRowHeader artifact={artifact()} now={NOW} />);
    expect(markup).toContain("PLAN.md");
    expect(markup).not.toContain("Implementation plan");
  });
});

describe("ArtifactUnavailableNotice", () => {
  it("shows the muted unavailable state", () => {
    const markup = renderToStaticMarkup(<ArtifactUnavailableNotice />);
    expect(markup).toContain("content unavailable");
    expect(markup).toContain("text-muted-foreground");
  });
});

describe("ArtifactOpenInBrowser", () => {
  it("renders a plain external anchor, PR-link pattern", () => {
    const markup = renderToStaticMarkup(
      <ArtifactOpenInBrowser url="/assets/ticket-artifacts/art_2?sig=xyz" />,
    );
    expect(markup).toContain('href="/assets/ticket-artifacts/art_2?sig=xyz"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("Open in browser");
  });
});

describe("ArtifactImageViewer", () => {
  it("renders a lazy bounded thumbnail wrapped in a new-tab link with caption", () => {
    const markup = renderToStaticMarkup(
      <ArtifactImageViewer
        url="/assets/ticket-artifacts/img?sig=1"
        name="after.png"
        description="After the fix"
      />,
    );
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain("max-h-64");
    expect(markup).toContain('src="/assets/ticket-artifacts/img?sig=1"');
    expect(markup).toContain('href="/assets/ticket-artifacts/img?sig=1"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("After the fix");
    // Description doubles as alt text.
    expect(markup).toContain('alt="After the fix"');
  });

  it("falls back to the file name for alt text", () => {
    const markup = renderToStaticMarkup(
      <ArtifactImageViewer url="/a/img" name="shot.png" description={undefined} />,
    );
    expect(markup).toContain('alt="shot.png"');
  });
});

describe("ArtifactVideoViewer", () => {
  it("renders a bounded video with controls, metadata preload, and caption", () => {
    const markup = renderToStaticMarkup(
      <ArtifactVideoViewer url="/assets/ticket-artifacts/vid?sig=2" description="Flow recording" />,
    );
    expect(markup).toContain("<video");
    expect(markup).toContain("controls");
    expect(markup).toContain('preload="metadata"');
    expect(markup).toContain("max-h-64");
    expect(markup).toContain('src="/assets/ticket-artifacts/vid?sig=2"');
    expect(markup).toContain("Flow recording");
  });
});

describe("ScratchFileList", () => {
  it("renders markdown scratch files rendered, with a Raw toggle and size", () => {
    const markup = renderToStaticMarkup(
      <ScratchFileList
        files={[
          { name: "PLAN.md", kind: "markdown", byteSize: 4096, content: "# scratch plan" },
          {
            name: "REVIEW.md",
            kind: "markdown",
            byteSize: 2048,
            content: "review body",
            truncated: true,
          },
        ]}
      />,
    );
    expect(markup).toContain("PLAN.md");
    expect(markup).toContain("(truncated)");
    expect(markup).toContain("4 KiB");
    // Rendered by default (an <h1>, not the literal "# scratch plan"), with the
    // toggle available.
    expect(markup).toContain("Raw");
    expect(markup).toContain("scratch plan");
  });

  it("renders plain text scratch files in a <pre>", () => {
    const markup = renderToStaticMarkup(
      <ScratchFileList
        files={[{ name: "run.log", kind: "text", byteSize: 12, content: "hello log" }]}
      />,
    );
    expect(markup).toContain("<pre");
    expect(markup).toContain("hello log");
    expect(markup).not.toContain("Raw");
  });

  it("renders images and videos instead of dumping their bytes", () => {
    const markup = renderToStaticMarkup(
      <ScratchFileList
        files={[
          { name: "screenshot.png", kind: "image", byteSize: 51_200, url: "/assets/s/png?sig=1" },
          { name: "demo.mp4", kind: "video", byteSize: 1_048_576, url: "/assets/s/mp4?sig=2" },
        ]}
      />,
    );
    expect(markup).toContain('<img src="/assets/s/png?sig=1"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain("<video");
    expect(markup).toContain('preload="metadata"');
    expect(markup).toContain("50 KiB");
    expect(markup).toContain("1 MiB");
  });

  it("renders a binary row with a size, no content, and no link", () => {
    const markup = renderToStaticMarkup(
      <ScratchFileList files={[{ name: "notes.zip", kind: "binary", byteSize: 2048 }]} />,
    );
    expect(markup).toContain("notes.zip");
    expect(markup).toContain("2 KiB");
    expect(markup).toContain("binary file");
    expect(markup).not.toContain("<pre");
    expect(markup).not.toContain("<a ");
  });

  it("links html out instead of inlining it", () => {
    const markup = renderToStaticMarkup(
      <ScratchFileList
        files={[{ name: "report.html", kind: "html", byteSize: 900, url: "/assets/s/html?sig=3" }]}
      />,
    );
    expect(markup).toContain("Open in browser");
    expect(markup).toContain('href="/assets/s/html?sig=3"');
  });

  it("shows the unavailable notice when a media row has no signed url", () => {
    const markup = renderToStaticMarkup(
      <ScratchFileList files={[{ name: "big.mp4", kind: "video", byteSize: 999 }]} />,
    );
    expect(markup).toContain("content unavailable");
    expect(markup).not.toContain("<video");
  });

  it("renders a 0-byte markdown file as an empty document, NOT as unavailable", () => {
    // Regression: `if (!file.content)` would call an empty-but-valid plan
    // "unavailable". The guard must test `=== undefined`.
    const markup = renderToStaticMarkup(
      <ScratchFileList files={[{ name: "PLAN.md", kind: "markdown", byteSize: 0, content: "" }]} />,
    );
    expect(markup).not.toContain("content unavailable");
    expect(markup).toContain("0 B");
    expect(markup).toContain("Raw");
  });

  it("renders an empty state when there are no files", () => {
    const markup = renderToStaticMarkup(<ScratchFileList files={[]} />);
    expect(markup).toContain("No working files.");
  });
});

describe("TicketArtifacts (collapsed shell)", () => {
  it("renders the collapsed Artifacts section without loading anything", () => {
    const markup = renderToStaticMarkup(<TicketArtifacts api={null} ticketId="ticket-1" />);
    expect(markup).toContain("Artifacts");
    expect(markup).toContain('data-testid="ticket-artifacts"');
    // Nothing loaded yet: no count badge, no rows, no error.
    expect(markup).not.toContain("Loading");
    expect(markup).not.toContain('role="alert"');
  });
});
