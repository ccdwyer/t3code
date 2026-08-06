import { describe, expect, it } from "vite-plus/test";

import {
  exceedsForkDepth,
  MAX_FORK_DEPTH,
  nextForkDepth,
  renderForkChildTitle,
} from "./forkSpawnHelpers.ts";

describe("forkSpawnHelpers", () => {
  it("renders titles and never returns empty after trim/slice", () => {
    expect(
      renderForkChildTitle("Child {{child.key}} for {{ticket.title}}", {
        ticketTitle: "Main",
        ticketId: "t1",
        childKey: "a",
      }),
    ).toBe("Child a for Main");
    expect(
      renderForkChildTitle("   ", {
        ticketTitle: "x",
        ticketId: "t",
        childKey: "k",
      }),
    ).toBe("fork:k");
  });

  it("caps nested fork depth", () => {
    expect(nextForkDepth(undefined)).toBe(1);
    expect(nextForkDepth(1)).toBe(2);
    expect(nextForkDepth(MAX_FORK_DEPTH)).toBe(MAX_FORK_DEPTH + 1);
    expect(exceedsForkDepth(MAX_FORK_DEPTH)).toBe(false);
    expect(exceedsForkDepth(MAX_FORK_DEPTH + 1)).toBe(true);
  });
});
