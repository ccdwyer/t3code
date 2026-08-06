import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentApi } from "@t3tools/contracts";
import { StepRunId, TicketId } from "@t3tools/contracts";

import { steerTicketStep } from "../../workflow/boardRpc";
import { runSteerSubmit, SteerComposer } from "./SteerComposer";
import {
  isSteerComposerInteractive,
  isSteerComposerVisible,
  steerBlockedTooltip,
} from "./steerVisibility";

describe("steerVisibility (composer policy)", () => {
  it("hides when canSteer is false and no blocked reason", () => {
    expect(isSteerComposerVisible({ canSteer: false })).toBe(false);
    expect(isSteerComposerInteractive({ canSteer: false })).toBe(false);
  });

  it("shows interactive when canSteer is true", () => {
    expect(isSteerComposerVisible({ canSteer: true })).toBe(true);
    expect(isSteerComposerInteractive({ canSteer: true })).toBe(true);
  });

  it("shows disabled with tooltip when delivering", () => {
    expect(
      isSteerComposerVisible({
        canSteer: false,
        steerBlockedReason: "delivering",
      }),
    ).toBe(true);
    expect(
      isSteerComposerInteractive({
        canSteer: false,
        steerBlockedReason: "delivering",
      }),
    ).toBe(false);
    expect(steerBlockedTooltip("delivering")).toMatch(/on its way/i);
  });

  it("shows disabled with answer tooltip when awaiting_user", () => {
    expect(
      isSteerComposerVisible({
        canSteer: false,
        steerBlockedReason: "awaiting_user",
      }),
    ).toBe(true);
    expect(steerBlockedTooltip("awaiting_user")).toMatch(/answer/i);
  });
});

describe("runSteerSubmit (composer submit path)", () => {
  it("clears text on success", async () => {
    const outcome = await runSteerSubmit({
      text: "also update the tests",
      submit: async () => ({ accepted: true }),
    });
    expect(outcome).toEqual({ text: "", error: null });
  });

  it("retains text and surfaces frozen error on failure", async () => {
    const outcome = await runSteerSubmit({
      text: "keep me",
      submit: async () => {
        throw new Error("a previous steering message is still being delivered");
      },
    });
    expect(outcome.text).toBe("keep me");
    expect(outcome.error).toMatch(/delivered/i);
  });
});

describe("SteerComposer (real component markup)", () => {
  const api = {
    workflow: {
      steerTicketStep: vi.fn(async () => ({ accepted: true as const })),
    },
  } as unknown as EnvironmentApi;

  it("renders interactive composer when canSteer is true", () => {
    const markup = renderToStaticMarkup(
      <SteerComposer
        api={api}
        ticketId="ticket-1"
        step={{ stepRunId: "step-1", canSteer: true, steerCount: 2 }}
      />,
    );
    expect(markup).toContain('data-testid="steer-composer"');
    expect(markup).toContain('data-testid="steer-composer-input"');
    expect(markup).toContain('data-testid="steer-composer-send"');
    expect(markup).toContain("steered 2×");
    expect(markup).not.toContain("steer-composer-blocked");
  });

  it("renders disabled blocked tooltip when delivering", () => {
    const markup = renderToStaticMarkup(
      <SteerComposer
        api={api}
        ticketId="ticket-1"
        step={{
          stepRunId: "step-1",
          canSteer: false,
          steerBlockedReason: "delivering",
        }}
      />,
    );
    expect(markup).toContain('data-testid="steer-composer"');
    expect(markup).toContain("Previous steering message is on its way");
    expect(markup).toContain("disabled");
  });

  it("renders nothing when not steerable", () => {
    const markup = renderToStaticMarkup(
      <SteerComposer
        api={api}
        ticketId="ticket-1"
        step={{ stepRunId: "step-1", canSteer: false }}
      />,
    );
    expect(markup).toBe("");
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
