import type { SidebarV2Mode } from "@t3tools/contracts/settings";

/**
 * Pure helpers for the Sidebar v2 mode switch (controlled ToggleGroup rules).
 */

export function resolveNextSidebarV2Mode(input: {
  readonly current: SidebarV2Mode;
  readonly payload: ReadonlyArray<string>;
  readonly hydrated: boolean;
}): SidebarV2Mode | null {
  const next = input.payload[0];
  if (next !== "threads" && next !== "workflows") {
    return null;
  }
  if (next === input.current) {
    return null;
  }
  if (!input.hydrated) {
    return null;
  }
  return next;
}

export function shouldClearThreadSelectionOnModeChange(input: {
  readonly from: SidebarV2Mode;
  readonly to: SidebarV2Mode;
}): boolean {
  return input.from === "threads" && input.to === "workflows";
}
