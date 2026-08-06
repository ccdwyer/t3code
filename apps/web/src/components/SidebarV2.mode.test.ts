import { describe, expect, it } from "vite-plus/test";

import { resolveNextSidebarV2Mode, shouldClearThreadSelectionOnModeChange } from "./SidebarV2.mode";

describe("SidebarV2 mode switch", () => {
  it("ignores empty and invalid payloads", () => {
    expect(
      resolveNextSidebarV2Mode({
        current: "threads",
        payload: [],
        hydrated: true,
      }),
    ).toBeNull();
    expect(
      resolveNextSidebarV2Mode({
        current: "threads",
        payload: ["boards"],
        hydrated: true,
      }),
    ).toBeNull();
  });

  it("accepts a valid mode change only after hydration", () => {
    expect(
      resolveNextSidebarV2Mode({
        current: "threads",
        payload: ["workflows"],
        hydrated: false,
      }),
    ).toBeNull();
    expect(
      resolveNextSidebarV2Mode({
        current: "threads",
        payload: ["workflows"],
        hydrated: true,
      }),
    ).toBe("workflows");
  });

  it("is a no-op when the mode is unchanged", () => {
    expect(
      resolveNextSidebarV2Mode({
        current: "workflows",
        payload: ["workflows"],
        hydrated: true,
      }),
    ).toBeNull();
  });

  it("clears thread selection only on Threads → Workflows", () => {
    expect(
      shouldClearThreadSelectionOnModeChange({
        from: "threads",
        to: "workflows",
      }),
    ).toBe(true);
    expect(
      shouldClearThreadSelectionOnModeChange({
        from: "workflows",
        to: "threads",
      }),
    ).toBe(false);
    expect(
      shouldClearThreadSelectionOnModeChange({
        from: "threads",
        to: "threads",
      }),
    ).toBe(false);
  });
});
