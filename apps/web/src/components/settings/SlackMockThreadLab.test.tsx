import { MOCK_SLACK_WORKSPACE_ID } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMockMentionInput } from "./SlackMockThreadLab";

describe("buildMockMentionInput", () => {
  it("accepts a bounded chronological thread and preserves the trigger index", () => {
    const built = buildMockMentionInput({
      instanceId: "instance-1",
      messages: [
        { messageId: "m1", authorLabel: "Chris", text: "Context", attachments: [] },
        {
          messageId: "m2",
          authorLabel: "Julius",
          text: "@t3_chris please ship this",
          attachments: [],
        },
      ],
      triggerMessageIndex: 1,
      externalEventId: "event-1",
    });

    expect(built.error).toBeNull();
    expect(built.input).toMatchObject({
      instanceId: "instance-1",
      externalEventId: "event-1",
      triggerMessageId: "m2",
      thread: { workspaceId: MOCK_SLACK_WORKSPACE_ID },
    });
    expect(built.input?.messages).toHaveLength(2);
  });

  it("rejects more than 500 mock messages before sending to the server", () => {
    const built = buildMockMentionInput({
      instanceId: "instance-1",
      messages: Array.from({ length: 501 }, (_value, index) => ({
        messageId: `m${index}`,
        authorLabel: "Chris",
        text: "message",
        attachments: [],
      })),
      triggerMessageIndex: 500,
    });

    expect(built.input).toBeNull();
    expect(built.error).toContain("500 messages");
  });

  it("rejects snapshots over 1 MiB before sending to the server", () => {
    const built = buildMockMentionInput({
      instanceId: "instance-1",
      messages: [
        {
          messageId: "m1",
          authorLabel: "Chris",
          text: "x".repeat(1024 * 1024),
          attachments: [],
        },
      ],
      triggerMessageIndex: 0,
    });

    expect(built.input).toBeNull();
    expect(built.error).toContain("1 MiB");
  });

  it("rejects duplicate source message ids instead of silently dropping context", () => {
    const built = buildMockMentionInput({
      instanceId: "instance-1",
      messages: [
        { messageId: "m1", authorLabel: "Chris", text: "Root", attachments: [] },
        { messageId: "m1", authorLabel: "Theo", text: "Trigger", attachments: [] },
      ],
      triggerMessageIndex: 1,
    });

    expect(built.input).toBeNull();
    expect(built.error).toContain("unique message id");
  });

  it("keeps distinct explicit thread keys distinct even when their 32-bit hashes collide", () => {
    const build = (threadKey: string) =>
      buildMockMentionInput({
        instanceId: "instance-1",
        messages: [{ messageId: "m1", authorLabel: "Chris", text: "Ship it" }],
        triggerMessageIndex: 0,
        threadKey,
      });

    const first = build("Aa");
    const second = build("BB");

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(first.input?.thread.channelId).not.toBe(second.input?.thread.channelId);
  });
});
