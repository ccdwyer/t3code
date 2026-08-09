import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const SLACK_THREAD_SNAPSHOT_MAX_MESSAGES = 500;
export const SLACK_THREAD_SNAPSHOT_MAX_BYTES = 1024 * 1024;

export interface SlackAttachmentMetadata {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly permalink: string;
}

export interface SlackThreadMessageInput {
  readonly messageId: string;
  readonly ts: string;
  readonly authorUserId: string;
  readonly authorLabel: string;
  readonly text: string;
  readonly editedTs?: string | undefined;
  readonly attachments?: ReadonlyArray<SlackAttachmentMetadata> | undefined;
}

export interface SlackThreadSnapshotInput {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly threadTs: string;
  readonly triggerEventId: string;
  readonly triggerTs: string;
  readonly triggerMessageId?: string | undefined;
  readonly messages: ReadonlyArray<SlackThreadMessageInput>;
  readonly maxMessages?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly byteLengthOverride?: number | undefined;
  /** Real Slack intake may discard oldest context until the durable snapshot fits. */
  readonly trimToFit?: boolean | undefined;
}

export interface SlackThreadSnapshotMessage {
  readonly messageId: string;
  readonly ts: string;
  readonly authorUserId: string;
  readonly authorLabel: string;
  readonly text: string;
  readonly editedTs?: string | undefined;
  readonly attachments: ReadonlyArray<SlackAttachmentMetadata>;
}

export interface SlackThreadSnapshot {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly threadTs: string;
  readonly triggerEventId: string;
  readonly triggerTs: string;
  readonly triggerMessageId: string;
  readonly messages: ReadonlyArray<SlackThreadSnapshotMessage>;
  readonly canonicalJson: string;
  readonly byteLength: number;
}

export class SlackThreadSnapshotError extends Schema.TaggedErrorClass<SlackThreadSnapshotError>()(
  "SlackThreadSnapshotError",
  {
    reason: Schema.Literals([
      "trigger_not_found",
      "too_many_messages",
      "snapshot_too_large",
      "invalid_timestamp",
    ]),
    message: Schema.String,
    messageCount: Schema.optional(Schema.Number),
    canonicalJsonBytes: Schema.optional(Schema.Number),
  },
) {}

const JsonString = Schema.fromJsonString(Schema.Unknown);
const encodeJsonString = Schema.encodeSync(JsonString);

const parseSlackTimestamp = (ts: string): bigint | null => {
  const match = /^(\d+)\.(\d{1,6})$/.exec(ts);
  if (match === null) return null;
  const seconds = BigInt(match[1] ?? "0");
  const micros = BigInt((match[2] ?? "").padEnd(6, "0"));
  return seconds * 1_000_000n + micros;
};

const normalizeText = (text: string) => text.replace(/\r\n?/g, "\n");

interface SortableSlackThreadMessage {
  readonly message: SlackThreadMessageInput;
  readonly index: number;
  readonly value: bigint;
}

const canonicalizeMessage = (message: SlackThreadMessageInput): SlackThreadSnapshotMessage => ({
  messageId: message.messageId,
  ts: message.ts,
  authorUserId: message.authorUserId,
  authorLabel: message.authorLabel,
  text: normalizeText(message.text),
  ...(message.editedTs === undefined ? {} : { editedTs: message.editedTs }),
  attachments: [...(message.attachments ?? [])].map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    permalink: attachment.permalink,
  })),
});

export const buildSlackThreadSnapshot = Effect.fn("buildSlackThreadSnapshot")(function* (
  input: SlackThreadSnapshotInput,
) {
  const triggerValue = parseSlackTimestamp(input.triggerTs);
  if (triggerValue === null) {
    return yield* new SlackThreadSnapshotError({
      reason: "invalid_timestamp",
      message: `Invalid trigger Slack timestamp "${input.triggerTs}".`,
    });
  }

  const sortable: Array<SortableSlackThreadMessage> = [];
  for (const [index, message] of input.messages.entries()) {
    const value = parseSlackTimestamp(message.ts);
    if (value === null) {
      return yield* new SlackThreadSnapshotError({
        reason: "invalid_timestamp",
        message: `Invalid Slack timestamp "${message.ts}".`,
      });
    }
    sortable.push({ message, index, value });
  }

  const seenMessageIds = new Set<string>();
  const messages = sortable
    .filter((entry) => {
      if (entry.value > triggerValue) return false;
      if (seenMessageIds.has(entry.message.messageId)) return false;
      seenMessageIds.add(entry.message.messageId);
      return true;
    })
    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : a.index - b.index))
    .map((entry) => canonicalizeMessage(entry.message));

  const triggerMessage =
    input.triggerMessageId === undefined
      ? messages.find((message) => message.ts === input.triggerTs)
      : messages.find(
          (message) =>
            message.messageId === input.triggerMessageId && message.ts === input.triggerTs,
        );
  if (triggerMessage === undefined) {
    return yield* new SlackThreadSnapshotError({
      reason: "trigger_not_found",
      message:
        input.triggerMessageId === undefined
          ? `No source message exists at trigger timestamp "${input.triggerTs}".`
          : `Trigger message "${input.triggerMessageId}" was not found at timestamp "${input.triggerTs}".`,
    });
  }

  const maxMessages = input.maxMessages ?? SLACK_THREAD_SNAPSHOT_MAX_MESSAGES;
  if (messages.length > maxMessages) {
    const canonicalJsonBytes = new TextEncoder().encode(
      encodeJsonString({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        channelName: input.channelName,
        threadTs: input.threadTs,
        triggerEventId: input.triggerEventId,
        triggerTs: input.triggerTs,
        triggerMessageId: triggerMessage.messageId,
        messages,
      }),
    ).byteLength;
    return yield* new SlackThreadSnapshotError({
      reason: "too_many_messages",
      message: `Slack thread snapshot has ${messages.length} messages; the limit is ${maxMessages}.`,
      messageCount: messages.length,
      canonicalJsonBytes,
    });
  }

  const maxBytes = input.maxBytes ?? SLACK_THREAD_SNAPSHOT_MAX_BYTES;
  const encodeSnapshot = (candidateMessages: ReadonlyArray<SlackThreadSnapshotMessage>) => {
    const payload = {
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      channelName: input.channelName,
      threadTs: input.threadTs,
      triggerEventId: input.triggerEventId,
      triggerTs: input.triggerTs,
      triggerMessageId: triggerMessage.messageId,
      messages: candidateMessages,
    };
    const canonicalJson = encodeJsonString(payload);
    return {
      payload,
      canonicalJson,
      byteLength: input.byteLengthOverride ?? new TextEncoder().encode(canonicalJson).byteLength,
    };
  };

  let encoded = encodeSnapshot(messages);
  if (
    encoded.byteLength > maxBytes &&
    input.trimToFit === true &&
    input.byteLengthOverride === undefined
  ) {
    const triggerIndex = messages.findIndex(
      (message) => message.messageId === triggerMessage.messageId,
    );
    let low = 0;
    let high = triggerIndex;
    let smallestFit: ReturnType<typeof encodeSnapshot> | undefined;
    while (low <= high) {
      const start = Math.floor((low + high) / 2);
      const candidate = encodeSnapshot(messages.slice(start, triggerIndex + 1));
      if (candidate.byteLength <= maxBytes) {
        smallestFit = candidate;
        high = start - 1;
      } else {
        low = start + 1;
      }
    }
    if (smallestFit !== undefined) encoded = smallestFit;
  }

  if (encoded.byteLength > maxBytes) {
    return yield* new SlackThreadSnapshotError({
      reason: "snapshot_too_large",
      message: `Slack thread snapshot is ${encoded.byteLength} bytes; the limit is ${maxBytes}.`,
      messageCount: encoded.payload.messages.length,
      canonicalJsonBytes: encoded.byteLength,
    });
  }

  return {
    ...encoded.payload,
    canonicalJson: encoded.canonicalJson,
    byteLength: encoded.byteLength,
  } satisfies SlackThreadSnapshot;
});

export const renderSlackThreadSnapshotMarkdown = (snapshot: SlackThreadSnapshot): string => {
  const lines = [
    "# Slack Source Thread",
    "",
    `Workspace: ${snapshot.workspaceId}`,
    `Channel: #${snapshot.channelName} (${snapshot.channelId})`,
    `Thread: ${snapshot.threadTs}`,
    `Trigger event: ${snapshot.triggerEventId}`,
    `Slack source: ${snapshot.workspaceId}/${snapshot.channelId}/${snapshot.threadTs}`,
    "",
  ];

  for (const message of snapshot.messages) {
    const marker = message.messageId === snapshot.triggerMessageId ? " [trigger]" : "";
    lines.push(`## ${message.authorLabel} at ${message.ts}${marker}`, "");
    if (message.editedTs !== undefined) {
      lines.push(`Edited: ${message.editedTs}`, "");
    }
    lines.push(message.text, "");
    if (message.attachments.length > 0) {
      lines.push("Attachments:");
      for (const attachment of message.attachments) {
        lines.push(
          `- ${attachment.filename} (${attachment.mediaType}, ${attachment.sizeBytes} bytes): ${attachment.permalink} [id: ${attachment.id}]`,
        );
      }
      lines.push("");
    }
  }

  return `${lines.join("\n").replace(/\r/g, "")}\n`;
};
