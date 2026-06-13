/**
 * Ticket-context placeholders usable inside agent step instructions.
 *
 * Only `{{ticket.<field>}}` tokens participate in templating; any other
 * `{{...}}` text is left untouched so instructions can freely contain
 * handlebars-style examples. Unknown `ticket.*` fields are left literal at
 * runtime and surfaced as lint errors at save time.
 */
export const TICKET_TEMPLATE_FIELDS = [
  "title",
  "description",
  "id",
  "baseRef",
  "discussion",
] as const;
export type TicketTemplateField = (typeof TICKET_TEMPLATE_FIELDS)[number];

export type TicketTemplateVars = Readonly<Record<TicketTemplateField, string>>;

const PLACEHOLDER_PATTERN = /\{\{\s*ticket\.([A-Za-z0-9_.]+)\s*\}\}/g;

const isTemplateField = (field: string): field is TicketTemplateField =>
  (TICKET_TEMPLATE_FIELDS as ReadonlyArray<string>).includes(field);

export const applyInstructionTemplate = (instruction: string, vars: TicketTemplateVars): string =>
  instruction.replace(PLACEHOLDER_PATTERN, (match, field: string) =>
    isTemplateField(field) ? vars[field] : match,
  );

export interface DiscussionMessage {
  readonly author: "agent" | "user";
  readonly body: string;
  readonly createdAt: string;
  readonly attachmentCount: number;
}

export const DISCUSSION_MESSAGE_CAP = 30;
const DISCUSSION_CHAR_BUDGET = 12_000;
const DISCUSSION_TRUNCATION_NOTE = "_(earlier messages omitted)_";

const renderDiscussionMessage = (message: DiscussionMessage): string => {
  const author = message.author === "user" ? "User" : "Agent";
  const attachmentNote =
    message.attachmentCount > 0
      ? `\n[${message.attachmentCount} attachment${message.attachmentCount === 1 ? "" : "s"} omitted]`
      : "";
  return `### ${author} — ${message.createdAt}\n${message.body}${attachmentNote}`;
};

/**
 * Render a ticket's message thread as a markdown transcript for agent
 * instructions. Keeps the newest messages within a message count and
 * character budget; attachments are noted, never inlined (they are data
 * URLs). Returns the empty string when there is nothing to show.
 */
export const renderTicketDiscussion = (messages: ReadonlyArray<DiscussionMessage>): string => {
  if (messages.length === 0) {
    return "";
  }
  const kept: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const source = messages[index];
    const entry = source === undefined ? "" : renderDiscussionMessage(source);
    if (
      kept.length >= DISCUSSION_MESSAGE_CAP ||
      (kept.length > 0 && used + entry.length > DISCUSSION_CHAR_BUDGET)
    ) {
      kept.unshift(DISCUSSION_TRUNCATION_NOTE);
      break;
    }
    kept.unshift(entry);
    used += entry.length + 2;
  }
  return kept.join("\n\n");
};

export const hasDiscussionPlaceholder = (instruction: string): boolean =>
  /\{\{\s*ticket\.discussion\s*\}\}/.test(instruction);

export const unknownTicketPlaceholders = (instruction: string): ReadonlyArray<string> => {
  const unknown = new Set<string>();
  for (const match of instruction.matchAll(PLACEHOLDER_PATTERN)) {
    const field = match[1];
    if (field !== undefined && !isTemplateField(field)) {
      unknown.add(field);
    }
  }
  return [...unknown];
};
