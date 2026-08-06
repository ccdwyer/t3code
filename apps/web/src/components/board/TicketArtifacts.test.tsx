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
      <ArtifactRowHeader
        artifact={artifact({ description: "Implementation plan" })}
        now={NOW}
      />,
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
        artifact={artifact({
          kind: "image",
          mime: "image/png",
          name: "after.png",
          description: "After the fix",
          url: "/assets/ticket-artifacts/img?sig=1",
        })}
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
      <ArtifactImageViewer artifact={artifact({ kind: "image", name: "shot.png" })} />,
    );
    expect(markup).toContain('alt="shot.png"');
  });
});

describe("ArtifactVideoViewer", () => {
  it("renders a bounded video with controls, metadata preload, and caption", () => {
    const markup = renderToStaticMarkup(
      <ArtifactVideoViewer
        artifact={artifact({
          kind: "video",
          mime: "video/mp4",
          name: "demo.mp4",
          description: "Flow recording",
          url: "/assets/ticket-artifacts/vid?sig=2",
        })}
      />,
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
  it("renders legacy scratch files with the old <pre> viewer", () => {
    const markup = renderToStaticMarkup(
      <ScratchFileList
        files={[
          { name: "PLAN.md", content: "# scratch plan" },
          { name: "REVIEW.md", content: "review body", truncated: true },
        ]}
      />,
    );
    expect(markup).toContain("PLAN.md");
    expect(markup).toContain("# scratch plan");
    expect(markup).toContain("<pre");
    expect(markup).toContain("(truncated)");
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
    expect(markup).not.toContain("role=\"alert\"");
  });
});
