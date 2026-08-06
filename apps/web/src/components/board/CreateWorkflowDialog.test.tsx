import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { StepRoutingView } from "./CreateWorkflowDialog";

// Gate-3 finding 5: the human-review summary's per-step routing must render a
// park target through the shared formatter, not `String(park)` → "[object
// Object]", so a reviewer can inspect a generated step's park substate + label.
describe("StepRoutingView park targets", () => {
  it("renders a step park route as 'park (issue): label', never [object Object]", () => {
    const markup = renderToStaticMarkup(
      <StepRoutingView
        routing={
          {
            success: "review",
            failure: {
              park: "issue",
              label: "Build broke",
              actions: [{ label: "Retry", to: "run" }],
            },
          } as never
        }
      />,
    );
    expect(markup).toContain("success → review");
    expect(markup).toContain("park (issue): Build broke");
    expect(markup).not.toContain("[object Object]");
  });

  it("renders a bare-lane step route unchanged", () => {
    const markup = renderToStaticMarkup(<StepRoutingView routing={{ success: "done" } as never} />);
    expect(markup).toContain("success → done");
  });

  it("renders nothing when there is no routing", () => {
    expect(renderToStaticMarkup(<StepRoutingView routing={undefined} />)).toBe("");
  });
});
