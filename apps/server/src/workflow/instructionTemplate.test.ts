import { assert, describe, it } from "@effect/vitest";

import {
  applyInstructionTemplate,
  renderTicketDiscussion,
  unknownTicketPlaceholders,
  type DiscussionMessage,
} from "./instructionTemplate.ts";

const vars = {
  title: "Fix login bug",
  description: "Users get logged out",
  id: "ticket-42",
  baseRef: "refs/t3/tickets/abc/base",
  discussion: "(no discussion yet)",
};

describe("applyInstructionTemplate", () => {
  it("substitutes known ticket placeholders", () => {
    const result = applyInstructionTemplate(
      "Review {{ticket.title}} ({{ticket.id}}): diff against {{ ticket.baseRef }}.",
      vars,
    );
    assert.equal(
      result,
      "Review Fix login bug (ticket-42): diff against refs/t3/tickets/abc/base.",
    );
  });

  it("substitutes description and tolerates repeated placeholders", () => {
    const result = applyInstructionTemplate(
      "{{ticket.description}} / {{ticket.description}}",
      vars,
    );
    assert.equal(result, "Users get logged out / Users get logged out");
  });

  it("leaves unknown ticket placeholders literal", () => {
    const result = applyInstructionTemplate("Check {{ticket.priority}}", vars);
    assert.equal(result, "Check {{ticket.priority}}");
  });

  it("ignores non-ticket handlebars text", () => {
    const result = applyInstructionTemplate("Use {{value}} and {{ other.thing }}", vars);
    assert.equal(result, "Use {{value}} and {{ other.thing }}");
  });
});

describe("applyInstructionTemplate discussion", () => {
  it("substitutes the discussion placeholder", () => {
    const result = applyInstructionTemplate("Context:\n{{ticket.discussion}}", vars);
    assert.equal(result, "Context:\n(no discussion yet)");
  });
});

const message = (overrides: Partial<DiscussionMessage>): DiscussionMessage => ({
  author: "user",
  body: "Looks good",
  createdAt: "2026-06-09T10:00:00.000Z",
  attachmentCount: 0,
  ...overrides,
});

describe("renderTicketDiscussion", () => {
  it("renders an empty string for no messages", () => {
    assert.equal(renderTicketDiscussion([]), "");
  });

  it("renders authors, timestamps, and bodies in order", () => {
    const rendered = renderTicketDiscussion([
      message({
        author: "user",
        body: "Use the retry helper",
        createdAt: "2026-06-09T10:00:00.000Z",
      }),
      message({ author: "agent", body: "Will do", createdAt: "2026-06-09T10:05:00.000Z" }),
    ]);
    assert.equal(
      rendered,
      [
        "### User — 2026-06-09T10:00:00.000Z",
        "Use the retry helper",
        "",
        "### Agent — 2026-06-09T10:05:00.000Z",
        "Will do",
      ].join("\n"),
    );
  });

  it("notes attachments without inlining them", () => {
    const rendered = renderTicketDiscussion([
      message({ body: "See screenshot", attachmentCount: 2 }),
    ]);
    assert.include(rendered, "See screenshot");
    assert.include(rendered, "[2 attachments omitted]");
  });

  it("notes a single attachment with singular wording", () => {
    const rendered = renderTicketDiscussion([message({ attachmentCount: 1 })]);
    assert.include(rendered, "[1 attachment omitted]");
  });

  it("keeps only the newest messages past the message cap and flags truncation", () => {
    const messages = Array.from({ length: 35 }, (_, index) =>
      message({
        body: `note ${index}`,
        createdAt: `2026-06-09T10:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    const rendered = renderTicketDiscussion(messages);
    assert.include(rendered, "_(earlier messages omitted)_");
    assert.notInclude(rendered, "note 4\n");
    assert.include(rendered, "note 34");
    assert.include(rendered, "note 5");
  });

  it("keeps only the newest messages within the character budget", () => {
    const big = "x".repeat(5000);
    const messages = Array.from({ length: 6 }, (_, index) =>
      message({ body: `${big} tail-${index}`, createdAt: `2026-06-09T10:0${index}:00.000Z` }),
    );
    const rendered = renderTicketDiscussion(messages);
    assert.isAtMost(rendered.length, 13_000);
    assert.include(rendered, "_(earlier messages omitted)_");
    assert.include(rendered, "tail-5");
    assert.notInclude(rendered, "tail-0");
  });
});

describe("unknownTicketPlaceholders", () => {
  it("reports unknown ticket fields once each", () => {
    const unknown = unknownTicketPlaceholders(
      "{{ticket.title}} {{ticket.priority}} {{ticket.priority}} {{ticket.owner.name}}",
    );
    assert.deepEqual([...unknown].sort(), ["owner.name", "priority"]);
  });

  it("reports nothing for known fields or non-ticket braces", () => {
    assert.deepEqual(
      unknownTicketPlaceholders("{{ticket.title}} {{ticket.baseRef}} {{whatever}}"),
      [],
    );
  });
});
