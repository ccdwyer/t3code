import { assert, describe, it } from "@effect/vitest";

import {
  classifySlackEventBody,
  classifySlackEventPayload,
  decodeSlackSocketEventBody,
  deriveSlackThreadIdentity,
  normalizeSlackMessage,
  parseSlackWorkflowDirective,
  type SlackSocketEventsApiBody,
} from "./slackEvent.ts";

const appMentionBody = (overrides: Partial<SlackSocketEventsApiBody["event"]> = {}) =>
  ({
    team_id: "T123",
    api_app_id: "A123",
    event_id: "Ev123",
    event: {
      type: "app_mention",
      channel: "C123",
      ts: "1700000001.000001",
      user: "U123",
      text: "<@U999> hello",
      ...overrides,
    },
  }) satisfies SlackSocketEventsApiBody;

const messageBody = (overrides: Partial<SlackSocketEventsApiBody["event"]> = {}) =>
  ({
    team_id: "T123",
    api_app_id: "A123",
    event_id: "Ev124",
    event: {
      type: "message",
      channel: "C123",
      ts: "1700000002.000001",
      user: "U123",
      text: "follow up",
      ...overrides,
    },
  }) satisfies SlackSocketEventsApiBody;

describe("slackEvent", () => {
  it("rejects bot, self, system, edit, delete, and hidden events", () => {
    assert.deepStrictEqual(
      classifySlackEventBody({
        body: messageBody({ user: "U999" }),
        botUserId: "U999",
        linkedThread: true,
      }),
      { type: "ignored", reason: "bot_or_self" },
    );
    assert.deepStrictEqual(
      classifySlackEventBody({
        body: messageBody({ bot_id: "B999", user: undefined }),
        botUserId: "U999",
        linkedThread: true,
      }),
      { type: "ignored", reason: "bot_or_self" },
    );
    assert.deepStrictEqual(
      classifySlackEventBody({
        body: messageBody({ subtype: "message_changed" }),
        botUserId: "U999",
        linkedThread: true,
      }),
      { type: "ignored", reason: "system_or_unsupported_subtype" },
    );
    assert.deepStrictEqual(
      classifySlackEventBody({
        body: messageBody({ subtype: "message_deleted" }),
        botUserId: "U999",
        linkedThread: true,
      }),
      { type: "ignored", reason: "system_or_unsupported_subtype" },
    );
    assert.deepStrictEqual(
      classifySlackEventBody({
        body: messageBody({ subtype: "channel_join" }),
        botUserId: "U999",
        linkedThread: true,
      }),
      { type: "ignored", reason: "system_or_unsupported_subtype" },
    );
    assert.deepStrictEqual(
      classifySlackEventBody({
        body: messageBody({ hidden: true }),
        botUserId: "U999",
        linkedThread: true,
      }),
      { type: "ignored", reason: "hidden" },
    );
  });

  it("classifies an app mention as an initial chat event", () => {
    const result = classifySlackEventBody({
      body: appMentionBody(),
      botUserId: "U999",
      linkedThread: false,
    });

    assert.equal(result.type, "accepted");
    if (result.type === "accepted") {
      assert.equal(result.reason, "initial_app_mention");
      assert.deepStrictEqual(result.invocation, { mode: "chat" });
      assert.equal(result.identity.threadKey, "slack:T123:C123:1700000001.000001");
    }
  });

  it("parses a project selector from an initial chat app mention", () => {
    const result = classifySlackEventBody({
      body: appMentionBody({ text: "<@U999> project:beta please inspect this" }),
      botUserId: "U999",
      linkedThread: false,
    });

    assert.equal(result.type, "accepted");
    if (result.type === "accepted") {
      assert.equal(result.reason, "initial_app_mention");
      assert.deepStrictEqual(result.invocation, { mode: "chat", projectSelector: "beta" });
    }
  });

  it("classifies an untagged linked thread message as a follow-up", () => {
    const result = classifySlackEventBody({
      body: messageBody({ thread_ts: "1700000001.000001", text: "no mention needed" }),
      botUserId: "U999",
      linkedThread: true,
    });

    assert.equal(result.type, "accepted");
    if (result.type === "accepted") {
      assert.equal(result.reason, "linked_thread_follow_up");
      assert.deepStrictEqual(result.invocation, { mode: "chat" });
      assert.equal(result.identity.rootThreadTs, "1700000001.000001");
    }
  });

  it("ignores an unrelated public message without a linked thread", () => {
    assert.deepStrictEqual(
      classifySlackEventBody({
        body: messageBody({ channel_type: "channel" }),
        botUserId: "U999",
        linkedThread: false,
      }),
      { type: "ignored", reason: "unrelated_message" },
    );
  });

  it("classifies a human DM message as an initial chat event", () => {
    const result = classifySlackEventBody({
      body: messageBody({ channel: "D123", channel_type: "im" }),
      botUserId: "U999",
      linkedThread: false,
    });

    assert.equal(result.type, "accepted");
    if (result.type === "accepted") {
      assert.equal(result.reason, "initial_dm");
      assert.equal(result.identity.channelId, "D123");
      assert.deepStrictEqual(result.invocation, { mode: "chat" });
    }
  });

  it("parses a project selector from an initial DM message", () => {
    const result = classifySlackEventBody({
      body: messageBody({ channel: "D123", channel_type: "im", text: "project:mobile help" }),
      botUserId: "U999",
      linkedThread: false,
    });

    assert.equal(result.type, "accepted");
    if (result.type === "accepted") {
      assert.equal(result.reason, "initial_dm");
      assert.deepStrictEqual(result.invocation, { mode: "chat", projectSelector: "mobile" });
    }
  });

  it("derives deterministic Slack thread and trigger identities", () => {
    assert.deepStrictEqual(
      deriveSlackThreadIdentity(
        messageBody({ channel: "C999", thread_ts: "1700000001.000001", ts: "1700000003.000003" }),
      ),
      {
        workspaceId: "T123",
        channelId: "C999",
        rootThreadTs: "1700000001.000001",
        triggerTs: "1700000003.000003",
        threadKey: "slack:T123:C999:1700000001.000001",
        triggerMessageId: "slack:T123:C999:1700000003.000003",
      },
    );
  });

  it("parses explicit workflow directives only from mention text", () => {
    const result = classifySlackEventBody({
      body: appMentionBody({ text: "<@U999> workflow board:board-1 lane:triage please" }),
      botUserId: "U999",
      linkedThread: false,
    });

    assert.equal(result.type, "accepted");
    if (result.type === "accepted") {
      assert.deepStrictEqual(result.invocation, {
        mode: "workflow",
        target: { boardId: "board-1", initialLane: "triage" },
      });
    }
    assert.deepStrictEqual(
      parseSlackWorkflowDirective("workflow board:board-1 lane:triage project:beta"),
      {
        mode: "workflow",
        projectSelector: "beta",
        target: { boardId: "board-1", initialLane: "triage" },
      },
    );
    assert.deepStrictEqual(parseSlackWorkflowDirective("project:beta please help"), {
      mode: "chat",
      projectSelector: "beta",
    });
    assert.deepStrictEqual(parseSlackWorkflowDirective("project:Mobile please help"), {
      mode: "chat",
      projectSelector: "mobile",
    });
    assert.deepStrictEqual(parseSlackWorkflowDirective("workflow lane:triage board:board-1"), {
      mode: "chat",
    });
    assert.deepStrictEqual(
      classifySlackEventBody({
        body: messageBody({ text: "workflow board:board-1 lane:triage" }),
        botUserId: "U999",
        linkedThread: true,
      }),
      {
        type: "accepted",
        reason: "linked_thread_follow_up",
        event: messageBody({ text: "workflow board:board-1 lane:triage" }).event,
        identity: deriveSlackThreadIdentity(
          messageBody({ text: "workflow board:board-1 lane:triage" }),
        ),
        invocation: { mode: "chat" },
      },
    );
  });

  it("rejects malformed Socket Mode event payloads", () => {
    assert.throws(() => decodeSlackSocketEventBody({ event: { type: "message" } }));
    assert.throws(() =>
      classifySlackEventPayload({
        payload: {
          team_id: "T123",
          api_app_id: "A123",
          event_id: "Ev1",
          event: { type: "reaction_added" },
        },
        botUserId: "U999",
        linkedThread: false,
      }),
    );
  });

  it("normalizes Slack messages and file metadata without stripping text", () => {
    assert.deepStrictEqual(
      normalizeSlackMessage({
        workspaceId: "T123",
        authorLabel: "Chris",
        message: messageBody({
          subtype: "file_share",
          text: "keep <@U999> mentions and code ```raw```",
          edited: { ts: "1700000004.000004" },
          files: [
            {
              id: "F123",
              name: "error.log",
              mimetype: "text/plain",
              size: 42,
              permalink: "https://slack.test/files/F123",
            },
            {
              id: "F124",
              title: "screenshot",
              filetype: "png",
              url_private: "https://slack.test/files/F124",
            },
          ],
        }).event,
      }),
      {
        messageId: "slack:T123:C123:1700000002.000001",
        ts: "1700000002.000001",
        authorUserId: "U123",
        authorLabel: "Chris",
        text: "keep <@U999> mentions and code ```raw```",
        editedTs: "1700000004.000004",
        attachments: [
          {
            id: "F123",
            filename: "error.log",
            mediaType: "text/plain",
            sizeBytes: 42,
            permalink: "https://slack.test/files/F123",
          },
          {
            id: "F124",
            filename: "screenshot",
            mediaType: "png",
            sizeBytes: 0,
            permalink: "https://slack.test/files/F124",
          },
        ],
      },
    );
  });
});
