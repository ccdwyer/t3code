import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentApi } from "@t3tools/contracts";
import { StepRunId, TicketId } from "@t3tools/contracts";

import { steerTicketStep } from "../../workflow/boardRpc";
import {
  isSteerComposerInteractive,
  isSteerComposerVisible,
  steerBlockedTooltip,
} from "./steerVisibility";

describe("steer composer visibility rules", () => {
  it("hides when canSteer is false and no blocked reason", () => {
    expect(isSteerComposerVisible({ canSteer: false })).toBe(false);
    expect(isSteerComposerInteractive({ canSteer: false })).toBe(false);
  });

  it("shows interactive when canSteer is true", () => {
    expect(isSteerComposerVisible({ canSteer: true })).toBe(true);
    expect(isSteerComposerInteractive({ canSteer: true })).toBe(true);
  });

  it("shows disabled with tooltip when delivering", () => {
    expect(isSteerComposerVisible({ canSteer: false, steerBlockedReason: "delivering" })).toBe(
      true,
    );
    expect(isSteerComposerInteractive({ canSteer: false, steerBlockedReason: "delivering" })).toBe(
      false,
    );
    expect(steerBlockedTooltip("delivering")).toMatch(/on its way/i);
  });

  it("shows disabled with answer tooltip when awaiting_user", () => {
    expect(isSteerComposerVisible({ canSteer: false, steerBlockedReason: "awaiting_user" })).toBe(
      true,
    );
    expect(steerBlockedTooltip("awaiting_user")).toMatch(/answer/i);
  });
});

describe("steerTicketStep boardRpc wiring", () => {
  it("delegates to EnvironmentApi.workflow.steerTicketStep", async () => {
    const api = {
      workflow: {
        steerTicketStep: vi.fn(async () => ({ accepted: true as const })),
      },
    } as unknown as EnvironmentApi;

    await expect(
      steerTicketStep(api, {
        ticketId: TicketId.make("t-1"),
        stepRunId: StepRunId.make("s-1"),
        messageId: "m-1" as never,
        text: "nudge",
      }),
    ).resolves.toEqual({ accepted: true });

    expect(api.workflow.steerTicketStep).toHaveBeenCalledWith({
      ticketId: TicketId.make("t-1"),
      stepRunId: StepRunId.make("s-1"),
      messageId: "m-1",
      text: "nudge",
    });
  });
});
