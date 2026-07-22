import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { HTML_EMBED_SANDBOX } from "../../markdown-html-embed";
import { HtmlEmbedCard } from "./HtmlEmbedCard";

const HTML = "<p>hello embed</p>";

function renderCard(): string {
  return renderToStaticMarkup(
    <HtmlEmbedCard html={HTML} codeBlock={<div data-testid="code-block">CODE</div>} />,
  );
}

describe("HtmlEmbedCard", () => {
  it("renders a sandboxed iframe without allow-same-origin", () => {
    const markup = renderCard();
    expect(markup).toContain(`sandbox="${HTML_EMBED_SANDBOX}"`);
    expect(HTML_EMBED_SANDBOX).not.toContain("allow-same-origin");
    expect(markup).toMatch(/referrerpolicy="no-referrer"/i);
  });

  it("embeds the fence html plus the resize script in srcdoc", () => {
    const markup = renderCard();
    expect(markup).toContain("hello embed");
    expect(markup).toContain("t3code:html-embed-height");
  });

  it("defaults to the preview view with the code block unmounted", () => {
    const markup = renderCard();
    expect(markup).toContain('data-html-embed-view="preview"');
    expect(markup).not.toContain("code-block");
  });

  it("exposes accessible view-toggle buttons with pressed state", () => {
    const markup = renderCard();
    expect(markup).toContain('aria-label="Show preview"');
    expect(markup).toContain('aria-label="Show code"');
    const previewButton = markup.match(/<button[^>]*aria-label="Show preview"[^>]*>/)?.[0];
    const codeButton = markup.match(/<button[^>]*aria-label="Show code"[^>]*>/)?.[0];
    expect(previewButton).toContain('aria-pressed="true"');
    expect(codeButton).toContain('aria-pressed="false"');
  });
});
