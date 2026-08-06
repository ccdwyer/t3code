import { describe, expect, it } from "vite-plus/test";

import { pickAgentConversationStep } from "./pickAgentConversationStep";

describe("pickAgentConversationStep", () => {
  it("returns null when no agent step has a provider thread", () => {
    expect(
      pickAgentConversationStep([
        {
          stepKey: "ship",
          stepType: "approval",
          status: "awaiting_user",
        },
        {
          stepKey: "agent-review",
          stepType: "agent",
          status: "running",
        },
      ]),
    ).toBeNull();
  });

  it("prefers the latest active agent step over an older completed one", () => {
    expect(
      pickAgentConversationStep([
        {
          stepKey: "implement",
          stepType: "agent",
          status: "succeeded",
          providerThreadId: "thread-old",
        },
        {
          stepKey: "review",
          stepType: "agent",
          status: "awaiting_user",
          providerThreadId: "thread-active",
        },
      ]),
    ).toEqual({ stepKey: "review", threadId: "thread-active" });
  });

  it("falls back to the latest agent step with a thread when none are active", () => {
    expect(
      pickAgentConversationStep([
        {
          stepKey: "implement",
          stepType: "agent",
          status: "succeeded",
          providerThreadId: "thread-1",
        },
        {
          stepKey: "review",
          stepType: "agent",
          status: "succeeded",
          providerThreadId: "thread-2",
        },
        {
          stepKey: "ship",
          stepType: "approval",
          status: "succeeded",
        },
      ]),
    ).toEqual({ stepKey: "review", threadId: "thread-2" });
  });

  it("ignores empty providerThreadId strings", () => {
    expect(
      pickAgentConversationStep([
        {
          stepKey: "implement",
          stepType: "agent",
          status: "running",
          providerThreadId: "",
        },
      ]),
    ).toBeNull();
  });
});
