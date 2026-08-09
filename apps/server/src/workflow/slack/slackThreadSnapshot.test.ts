import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildSlackThreadSnapshot,
  renderSlackThreadSnapshotMarkdown,
  SLACK_THREAD_SNAPSHOT_MAX_BYTES,
  SLACK_THREAD_SNAPSHOT_MAX_MESSAGES,
} from "./slackThreadSnapshot.ts";

const baseInput = {
  workspaceId: "T123",
  channelId: "C123",
  channelName: "eng",
  threadTs: "1000.000000",
  triggerEventId: "evt-trigger",
  triggerTs: "1000.000003",
};

const msg = (
  messageId: string,
  ts: string,
  text: string,
  extra: Partial<Parameters<typeof buildSlackThreadSnapshot>[0]["messages"][number]> = {},
) => ({
  messageId,
  ts,
  authorUserId: "U123",
  authorLabel: "Chris",
  text,
  ...extra,
});

it.effect(
  "captures root and replies through the triggering message in stable timestamp order",
  () =>
    Effect.gen(function* () {
      const snapshot = yield* buildSlackThreadSnapshot({
        ...baseInput,
        messages: [
          msg("after", "1000.000004", "too late"),
          msg("trigger", "1000.000003", "@t3_chris do this"),
          msg("root", "1000.000000", "root"),
          msg("same-a", "1000.000002", "same A"),
          msg("same-b", "1000.000002", "same B"),
        ],
      });

      assert.deepEqual(
        snapshot.messages.map((message) => message.messageId),
        ["root", "same-a", "same-b", "trigger"],
      );
      assert.equal(snapshot.triggerMessageId, "trigger");
      assert.equal(
        snapshot.messages.some((message) => message.messageId === "after"),
        false,
      );
    }),
);

it.effect("uses the explicit trigger message id when Slack timestamps are equal", () =>
  Effect.gen(function* () {
    const snapshot = yield* buildSlackThreadSnapshot({
      ...baseInput,
      triggerMessageId: "trigger-b",
      messages: [
        msg("root", "1000.000000", "root"),
        msg("trigger-a", "1000.000003", "first at timestamp"),
        msg("trigger-b", "1000.000003", "actual mention"),
      ],
    });

    assert.equal(snapshot.triggerMessageId, "trigger-b");
  }),
);

it.effect("renders edited-message and attachment metadata with the trigger marker", () =>
  Effect.gen(function* () {
    const snapshot = yield* buildSlackThreadSnapshot({
      ...baseInput,
      messages: [
        msg("root", "1000.000000", "root\r\ntext"),
        msg("trigger", "1000.000003", "@t3_chris ship it", {
          editedTs: "1000.000005",
          attachments: [
            {
              id: "F1",
              filename: "trace.txt",
              mediaType: "text/plain",
              sizeBytes: 42,
              permalink: "https://mock.slack/files/F1",
            },
          ],
        }),
      ],
    });

    const markdown = renderSlackThreadSnapshotMarkdown(snapshot);
    assert.include(markdown, "Workspace: T123");
    assert.include(markdown, "## Chris at 1000.000003 [trigger]");
    assert.include(markdown, "Edited: 1000.000005");
    assert.include(markdown, "- trace.txt (text/plain, 42 bytes): https://mock.slack/files/F1");
    assert.notInclude(markdown, "\r");
  }),
);

it.effect("accepts exact message and byte boundaries", () =>
  Effect.gen(function* () {
    const messages = Array.from({ length: SLACK_THREAD_SNAPSHOT_MAX_MESSAGES }, (_, index) =>
      msg(`m-${index}`, `1000.${String(index).padStart(6, "0")}`, index === 499 ? "trigger" : "ok"),
    );

    const snapshot = yield* buildSlackThreadSnapshot({
      ...baseInput,
      triggerTs: "1000.000499",
      messages,
    });

    assert.equal(snapshot.messages.length, SLACK_THREAD_SNAPSHOT_MAX_MESSAGES);

    const exactBytesSnapshot = yield* buildSlackThreadSnapshot({
      ...baseInput,
      maxBytes: SLACK_THREAD_SNAPSHOT_MAX_BYTES,
      byteLengthOverride: SLACK_THREAD_SNAPSHOT_MAX_BYTES,
      messages: [msg("trigger", "1000.000003", "trigger")],
    });
    assert.equal(exactBytesSnapshot.byteLength, SLACK_THREAD_SNAPSHOT_MAX_BYTES);
  }),
);

it.effect("rejects oversize snapshots instead of truncating", () =>
  Effect.gen(function* () {
    const tooMany = yield* Effect.exit(
      buildSlackThreadSnapshot({
        ...baseInput,
        triggerTs: "1000.000501",
        messages: Array.from({ length: SLACK_THREAD_SNAPSHOT_MAX_MESSAGES + 1 }, (_, index) =>
          msg(`m-${index}`, `1000.${String(index).padStart(6, "0")}`, "ok"),
        ),
      }),
    );
    assert.equal(tooMany._tag, "Failure");

    const tooLarge = yield* Effect.exit(
      buildSlackThreadSnapshot({
        ...baseInput,
        byteLengthOverride: SLACK_THREAD_SNAPSHOT_MAX_BYTES + 1,
        messages: [msg("trigger", "1000.000003", "trigger")],
      }),
    );
    assert.equal(tooLarge._tag, "Failure");
  }),
);

it.effect("trims oldest context until a real Slack snapshot fits the byte budget", () =>
  Effect.gen(function* () {
    const triggerOnly = yield* buildSlackThreadSnapshot({
      ...baseInput,
      messages: [msg("trigger", "1000.000003", "trigger")],
    });
    const snapshot = yield* buildSlackThreadSnapshot({
      ...baseInput,
      trimToFit: true,
      maxBytes: triggerOnly.byteLength,
      messages: [
        msg("root", "1000.000000", "x".repeat(4_000)),
        msg("reply", "1000.000002", "y".repeat(4_000)),
        msg("trigger", "1000.000003", "trigger"),
      ],
    });

    assert.deepEqual(
      snapshot.messages.map((message) => message.messageId),
      ["trigger"],
    );
    assert.equal(snapshot.byteLength, triggerOnly.byteLength);
  }),
);

it.effect("keeps the first duplicate message id in the winning snapshot", () =>
  Effect.gen(function* () {
    const snapshot = yield* buildSlackThreadSnapshot({
      ...baseInput,
      messages: [
        msg("root", "1000.000000", "root"),
        msg("trigger", "1000.000003", "first trigger"),
        msg("trigger", "1000.000003", "duplicate trigger"),
      ],
    });

    assert.deepEqual(
      snapshot.messages.map((message) => message.text),
      ["root", "first trigger"],
    );
  }),
);
