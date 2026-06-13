import "../../../../index.css";

import type { WorkflowDefinitionEncoded } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { DiffView } from "./DiffView";

const versionDefinition = {
  name: "Delivery",
  lanes: [
    { key: "queue", name: "Queue", entry: "manual" },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
} satisfies WorkflowDefinitionEncoded;

const invalidCurrentDefinition = {
  ...versionDefinition,
  lanes: [{ key: "queue", name: "", entry: "manual" }],
} satisfies WorkflowDefinitionEncoded;

describe("DiffView", () => {
  it("renders a diff for an invalid current draft without throwing", async () => {
    render(
      <DiffView
        currentDefinition={invalidCurrentDefinition}
        versionDefinition={versionDefinition}
      />,
    );

    await expect.element(page.getByLabelText("Version diff")).toBeInTheDocument();
    await expect.element(page.getByText(/"name": ""/)).toBeInTheDocument();
  });
});
