import { MOCK_SLACK_WORKSPACE_ID } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMockInvocation,
  buildMockMentionInput,
  buildMockSlackAgentCreateInput,
  getRunnableMockSlackAgentInstances,
} from "./SlackMockThreadLab";
import type { SlackAgentInstanceView } from "~/workflow/useWorkflowApi";

describe("buildMockMentionInput", () => {
  it("builds a mock identity create payload scoped to a project", () => {
    expect(
      buildMockSlackAgentCreateInput({
        ownerLabel: " Chris ",
        handleSuffix: "@t3_Chris-Dev",
        projectId: "project-1",
        acknowledged: true,
      }),
    ).toEqual({
      input: {
        ownerLabel: "Chris",
        handleSuffix: "chrisdev",
        target: { projectId: "project-1" },
        acknowledged: true,
      },
      error: null,
    });
  });

  it("requires explicit acknowledgement before creating a mock identity", () => {
    expect(
      buildMockSlackAgentCreateInput({
        ownerLabel: "Chris",
        handleSuffix: "chris",
        projectId: "project-1",
        acknowledged: false,
      }),
    ).toEqual({
      input: null,
      error: "Confirm that this mock identity can start T3 turns.",
    });
  });

  it("only exposes enabled valid mock instances to the lab runner", () => {
    const base = {
      instanceId: "instance-1",
      handle: "t3_chris",
      ownerLabel: "Chris",
      botUserId: "U123",
      target: { projectId: "project-1" },
      workspace: { workspaceId: MOCK_SLACK_WORKSPACE_ID },
      credentialsConfigured: true,
      connection: { state: "connected" },
      activeRunCount: 0,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    } as unknown as Omit<SlackAgentInstanceView, "kind" | "enabled" | "state" | "validation">;

    expect(
      getRunnableMockSlackAgentInstances([
        {
          ...base,
          kind: "mock",
          enabled: true,
          state: "enabled",
          validation: { valid: true },
        },
        {
          ...base,
          instanceId: "instance-2" as never,
          kind: "slack",
          enabled: true,
          state: "enabled",
          validation: { valid: true },
        },
        {
          ...base,
          instanceId: "instance-3" as never,
          kind: "mock",
          enabled: true,
          state: "needs_setup",
          validation: { valid: false },
        },
      ]),
    ).toHaveLength(1);
  });

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
    expect(built.input).not.toHaveProperty("invocation");
    expect(built.input?.messages).toHaveLength(2);
  });

  it("allows an explicit chat invocation without changing the default payload", () => {
    const built = buildMockMentionInput({
      instanceId: "instance-1",
      messages: [{ messageId: "m1", authorLabel: "Chris", text: "@t3_chris status" }],
      triggerMessageIndex: 0,
      invocation: { mode: "chat" },
    });

    expect(built.error).toBeNull();
    expect(built.input).not.toHaveProperty("invocation");
  });

  it("builds explicit workflow invocation only for a valid initial lane", () => {
    const invocation = buildMockInvocation({
      mode: "workflow",
      boardId: "board-1",
      initialLane: "implement",
      laneTargets: [
        {
          laneKey: "implement",
          laneName: "Implement",
          path: ["implement", "open-pr"],
          pathLabel: "Implement / Open PR",
        },
      ],
    });
    const built = buildMockMentionInput({
      instanceId: "instance-1",
      messages: [{ messageId: "m1", authorLabel: "Chris", text: "@t3_chris ship this" }],
      triggerMessageIndex: 0,
      ...(invocation.input === undefined ? {} : { invocation: invocation.input }),
    });

    expect(invocation.error).toBeNull();
    expect(built.error).toBeNull();
    expect(built.input).toMatchObject({
      invocation: {
        mode: "workflow",
        target: {
          boardId: "board-1",
          initialLane: "implement",
        },
      },
    });
  });

  it("rejects workflow invocation when the selected lane is not valid for Slack", () => {
    expect(
      buildMockInvocation({
        mode: "workflow",
        boardId: "board-1",
        initialLane: "manual",
        laneTargets: [],
      }),
    ).toEqual({
      input: undefined,
      error: "Choose a valid workflow initial lane.",
    });
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
