import { TICKET_NO_WORKTREE_MESSAGE } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { classifyTicketDiffError } from "./TicketDiff";

const serverMessage = `Workflow ticket abc ${TICKET_NO_WORKTREE_MESSAGE}`;

describe("classifyTicketDiffError", () => {
  it("treats no-worktree before any step as the benign pre-run state", () => {
    expect(classifyTicketDiffError(serverMessage, false)).toBe("pre-run");
  });

  it("treats no-worktree after steps ran as worktree loss, not 'no changes yet'", () => {
    expect(classifyTicketDiffError(serverMessage, true)).toBe("worktree-missing");
  });

  it("keeps every other error a real failure regardless of work state", () => {
    expect(classifyTicketDiffError("Failed to resolve workflow ticket worktree refs", false)).toBe(
      "failure",
    );
    expect(classifyTicketDiffError("network timed out", true)).toBe("failure");
  });
});
