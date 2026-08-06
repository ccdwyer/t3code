import { describe, expect, it } from "@effect/vitest";

import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";
import { T3_CODE_HTML_PREVIEW_INSTRUCTIONS } from "./UiCapabilityInstructions.ts";

describe("T3_CODE_HTML_PREVIEW_INSTRUCTIONS", () => {
  it("documents the inline and file forms of the html fence", () => {
    expect(T3_CODE_HTML_PREVIEW_INSTRUCTIONS).toContain("```html");
    expect(T3_CODE_HTML_PREVIEW_INSTRUCTIONS).toContain("file=docs/plan.html");
    expect(T3_CODE_HTML_PREVIEW_INSTRUCTIONS).toContain("sandbox");
  });

  it("is included in Codex developer instructions for both modes", () => {
    const runtime = { model: "gpt-5.5", reasoningEffort: "medium" };
    expect(buildCodexDeveloperInstructions("default", runtime)).toContain(
      "T3 Code inline HTML previews",
    );
    expect(buildCodexDeveloperInstructions("plan", runtime)).toContain(
      "T3 Code inline HTML previews",
    );
  });
});
