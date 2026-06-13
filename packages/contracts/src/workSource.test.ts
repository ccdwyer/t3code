import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { GithubSelector, AsanaSelector, WorkflowSourceConfig, SourceId } from "./workSource.ts";

describe("workSource contracts", () => {
  it("defaults github selector state to 'all'", () => {
    const sel = Schema.decodeUnknownSync(GithubSelector)({ owner: "o", repo: "r" });
    expect(sel.state).toBe("all");
  });
  it("defaults asana includeCompleted to true", () => {
    const sel = Schema.decodeUnknownSync(AsanaSelector)({ projectGid: "123" });
    expect(sel.includeCompleted).toBe(true);
  });
  it("decodes a github source config", () => {
    const cfg = Schema.decodeUnknownSync(WorkflowSourceConfig)({
      id: "src-1", provider: "github", connectionRef: "conn-1",
      selector: { owner: "o", repo: "r" },
      destinationLane: "inbox", closedLane: "done", enabled: true,
    });
    expect(cfg.provider).toBe("github");
    expect(SourceId.is(cfg.id)).toBe(true);
  });
  it("rejects an unknown provider", () => {
    expect(() => Schema.decodeUnknownSync(WorkflowSourceConfig)({
      id: "s", provider: "jira", connectionRef: "c", selector: {},
      destinationLane: "a", closedLane: "b", enabled: true,
    })).toThrow();
  });
});
