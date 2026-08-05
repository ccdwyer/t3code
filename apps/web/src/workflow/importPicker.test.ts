import { describe, expect, it } from "vite-plus/test";

import {
  applyPickerFilters,
  defaultChecked,
  groupSelectedBySource,
  isUrl,
  selectionKey,
  urlMatchesRow,
  workItemUrlIdentity,
  type FilterState,
} from "./importPicker.ts";

const base: FilterState = { search: "", assignedToMe: false, hideTasked: false };

const row = (over: Partial<Parameters<typeof applyPickerFilters>[0][number]> = {}) => ({
  provider: "github" as const,
  sourceId: "s1",
  externalId: "1",
  displayRef: "#1",
  title: "Fix bug",
  container: "a/b",
  url: "https://github.com/a/b/issues/1",
  assignees: ["alice"],
  lifecycle: "open" as const,
  mappedTicketId: null,
  mappedLane: null,
  ...over,
});

describe("applyPickerFilters", () => {
  it("hide tasked drops mapped rows", () => {
    const out = applyPickerFilters(
      [row({ mappedTicketId: "t1" as any }), row({ externalId: "2" })],
      { ...base, hideTasked: true },
      {},
    );
    expect(out.map((r) => r.externalId)).toEqual(["2"]);
  });

  it("assigned-to-me uses the row's source viewer aliases", () => {
    const out = applyPickerFilters(
      [row({ assignees: ["alice"] }), row({ externalId: "2", assignees: ["bob"] })],
      { ...base, assignedToMe: true },
      { s1: { id: "alice", aliases: ["alice"] } },
    );
    expect(out.map((r) => r.externalId)).toEqual(["1"]);
  });

  it("assigned-to-me disabled for a source with null viewer (drops those rows)", () => {
    const out = applyPickerFilters([row({})], { ...base, assignedToMe: true }, { s1: null });
    expect(out.map((r) => r.externalId)).toEqual([]);
  });

  it("search matches title and displayRef, case-insensitive", () => {
    const out = applyPickerFilters(
      [row({ title: "Fix bug" }), row({ externalId: "2", title: "Other" })],
      { ...base, search: "fix" },
      {},
    );
    expect(out.map((r) => r.externalId)).toEqual(["1"]);
  });

  it("a pasted URL filters to the row whose url matches", () => {
    const out = applyPickerFilters(
      [
        row({ url: "https://github.com/a/b/issues/1" }),
        row({ externalId: "2", url: "https://github.com/a/b/issues/2" }),
      ],
      { ...base, search: "https://github.com/a/b/issues/2" },
      {},
    );
    expect(out.map((r) => r.externalId)).toEqual(["2"]);
  });

  it("a pasted URL bypasses hideTasked and assignedToMe (direct lookup)", () => {
    const out = applyPickerFilters(
      [row({ mappedTicketId: "t1" as any, assignees: ["bob"] })],
      {
        search: "https://github.com/a/b/issues/1",
        hideTasked: true,
        assignedToMe: true,
      },
      { s1: { id: "alice", aliases: ["alice"] } },
    );
    expect(out.map((r) => r.externalId)).toEqual(["1"]);
  });

  it("a pasted URL matches exactly, not as a prefix (issues/1 not issues/10)", () => {
    const out = applyPickerFilters(
      [
        row({ url: "https://github.com/a/b/issues/1" }),
        row({ externalId: "10", url: "https://github.com/a/b/issues/10" }),
      ],
      { ...base, search: "https://github.com/a/b/issues/1" },
      {},
    );
    expect(out.map((r) => r.externalId)).toEqual(["1"]);
  });

  it("combines hideTasked and search", () => {
    const out = applyPickerFilters(
      [
        row({ externalId: "1", title: "Fix bug", mappedTicketId: "t1" as any }),
        row({ externalId: "2", title: "Fix bug" }),
        row({ externalId: "3", title: "Other" }),
      ],
      { ...base, hideTasked: true, search: "fix" },
      {},
    );
    expect(out.map((r) => r.externalId)).toEqual(["2"]);
  });

  it("returns [] for empty input", () => {
    expect(applyPickerFilters([], base, {})).toEqual([]);
  });
});

describe("selection + grouping", () => {
  it("defaultChecked: closed/mapped unchecked, open+unmapped checked", () => {
    expect(defaultChecked(row({ lifecycle: "closed" }))).toBe(false);
    expect(defaultChecked(row({ mappedTicketId: "t" as any }))).toBe(false);
    expect(defaultChecked(row({}))).toBe(true);
  });

  it("selectionKey + groupSelectedBySource bucket externalIds per source", () => {
    const keys = new Set([
      selectionKey(row({})),
      selectionKey(row({ sourceId: "s2", externalId: "9" })),
    ]);
    const groups = groupSelectedBySource(keys);
    expect(groups).toEqual({ s1: ["1"], s2: ["9"] });
  });

  it("isUrl detects http(s) urls", () => {
    expect(isUrl("https://x/y")).toBe(true);
    expect(isUrl("fix bug")).toBe(false);
  });

  it("url search matches through normalization variants", () => {
    const rows = [row({ url: "https://github.com/acme/widgets/issues/42" })];
    for (const pasted of [
      "https://github.com/acme/widgets/issues/42",
      "https://github.com/acme/widgets/issues/42/",
      "https://github.com/acme/widgets/issues/42?ref=notifications#issuecomment-1",
      "https://www.github.com/acme/widgets/issues/42",
      "http://github.com/acme/widgets/issues/42",
      "https://github.com/ACME/widgets/pull/42",
    ]) {
      expect(applyPickerFilters(rows, { ...base, search: pasted }, {})).toHaveLength(1);
    }
    expect(
      applyPickerFilters(
        rows,
        { ...base, search: "https://github.com/acme/widgets/issues/43" },
        {},
      ),
    ).toHaveLength(0);
    expect(
      applyPickerFilters(rows, { ...base, search: "https://github.com/acme/other/issues/42" }, {}),
    ).toHaveLength(0);
  });
});

describe("workItemUrlIdentity", () => {
  it("identifies github issue and pull urls as the same item", () => {
    expect(workItemUrlIdentity("https://github.com/Acme/Widgets/issues/7")).toBe(
      "github:acme/widgets#7",
    );
    expect(workItemUrlIdentity("https://github.com/acme/widgets/pull/7?diff=split")).toBe(
      "github:acme/widgets#7",
    );
  });

  it("matches deep-linked github tabs to the same item", () => {
    expect(workItemUrlIdentity("https://github.com/acme/widgets/pull/7/files")).toBe(
      "github:acme/widgets#7",
    );
    expect(workItemUrlIdentity("https://github.com/acme/widgets/issues/7/timeline")).toBe(
      "github:acme/widgets#7",
    );
  });

  it("prefers the segment after a task/item marker over later long numerics", () => {
    expect(
      workItemUrlIdentity(
        "https://app.asana.com/1/1100000000000001/project/1200000000000001/task/1200000000000042/comment/1300000000000099",
      ),
    ).toBe("asana:1200000000000042");
  });

  it("takes the second numeric (the task) in marker-less /0/ paths with trailing ids", () => {
    expect(
      workItemUrlIdentity(
        "https://app.asana.com/0/1200000000000001/1200000000000042/1300000000000099",
      ),
    ).toBe("asana:1200000000000042");
  });

  it("extracts the asana task gid across permalink generations", () => {
    expect(workItemUrlIdentity("https://app.asana.com/0/1200000000000001/1200000000000042")).toBe(
      "asana:1200000000000042",
    );
    expect(workItemUrlIdentity("https://app.asana.com/0/1200000000000001/1200000000000042/f")).toBe(
      "asana:1200000000000042",
    );
    expect(
      workItemUrlIdentity(
        "https://app.asana.com/1/1100000000000001/project/1200000000000001/task/1200000000000042",
      ),
    ).toBe("asana:1200000000000042");
  });

  it("identifies jira browse urls case-insensitively on the key prefix", () => {
    expect(workItemUrlIdentity("https://acme.atlassian.net/browse/PROJ-12")).toBe(
      "jira:acme.atlassian.net/PROJ-12",
    );
    expect(workItemUrlIdentity("https://acme.atlassian.net/browse/proj-12/")).toBe(
      "jira:acme.atlassian.net/PROJ-12",
    );
  });

  it("returns null for non-provider or unparseable urls", () => {
    expect(workItemUrlIdentity("https://example.com/things/9")).toBeNull();
    expect(workItemUrlIdentity("not a url")).toBeNull();
    expect(workItemUrlIdentity("ftp://github.com/a/b/issues/1")).toBeNull();
    expect(workItemUrlIdentity("https://app.asana.com/0/browse")).toBeNull();
  });
});

describe("urlMatchesRow", () => {
  it("falls back to normalized comparison for unknown hosts", () => {
    expect(
      urlMatchesRow("https://tracker.example.com/item/5/", "http://tracker.example.com/item/5"),
    ).toBe(true);
    expect(
      urlMatchesRow("https://tracker.example.com/item/5", "https://tracker.example.com/item/6"),
    ).toBe(false);
  });

  it("keeps query params significant in the fallback comparison", () => {
    expect(
      urlMatchesRow(
        "https://tracker.example.com/view?id=5",
        "https://tracker.example.com/view?id=6",
      ),
    ).toBe(false);
    expect(
      urlMatchesRow(
        "https://tracker.example.com/view?id=5",
        "http://tracker.example.com/view?id=5",
      ),
    ).toBe(true);
  });

  it("keeps hash fragments significant in the fallback comparison", () => {
    expect(
      urlMatchesRow(
        "https://tracker.example.com/app#/task/5",
        "https://tracker.example.com/app#/task/6",
      ),
    ).toBe(false);
    expect(
      urlMatchesRow(
        "https://tracker.example.com/app#/task/5",
        "http://tracker.example.com/app#/task/5",
      ),
    ).toBe(true);
  });

  it("keeps distinct ports distinct in the fallback comparison", () => {
    expect(
      urlMatchesRow("http://tracker.example.com:8080/item/5", "http://tracker.example.com/item/5"),
    ).toBe(false);
  });

  it("never cross-matches identity urls against lookalike plain urls", () => {
    // Pasted parses to a github identity; the row is a different provider shape.
    expect(
      urlMatchesRow(
        "https://github.com/acme/widgets/issues/7",
        "https://example.com/github.com/acme/widgets/issues/7",
      ),
    ).toBe(false);
  });
});
