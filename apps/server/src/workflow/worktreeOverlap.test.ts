import { describe, expect, it } from "vite-plus/test";

import {
  computePathOverlap,
  decideOverlapAction,
  filterIgnored,
  isParallelismHoldReason,
  normalizeRepoPath,
  pathIgnored,
  PARALLELISM_HOLD_REASON_ACTIVE,
  serializeHoldReason,
} from "./worktreeOverlap.ts";

describe("worktreeOverlap", () => {
  it("computes sorted unique intersection", () => {
    expect(computePathOverlap(["b.ts", "a.ts", "c.ts"], ["c.ts", "a.ts", "d.ts"])).toEqual([
      "a.ts",
      "c.ts",
    ]);
  });

  it("normalizes ./ and duplicate slashes before intersection", () => {
    expect(normalizeRepoPath("./src//a.ts")).toBe("src/a.ts");
    expect(computePathOverlap(["./src/a.ts"], ["src//a.ts"])).toEqual(["src/a.ts"]);
  });

  it("case-insensitive path overlap (macOS/Windows safety)", () => {
    expect(computePathOverlap(["Src/A.ts"], ["src/a.ts"])).toEqual(["Src/A.ts"]);
  });

  it("applies ignore prefixes", () => {
    expect(pathIgnored("node_modules/x", ["node_modules/"])).toBe(true);
    expect(pathIgnored("src/a.ts", ["node_modules/"])).toBe(false);
    expect(filterIgnored(["src/a.ts", "dist/out.js"], ["dist/"])).toEqual(["src/a.ts"]);
  });

  it("matches /** under a directory but not the directory itself", () => {
    expect(pathIgnored("src/a.ts", ["src/**"])).toBe(true);
    expect(pathIgnored("src", ["src/**"])).toBe(false);
    expect(pathIgnored("src/x/y.ts", ["src/**"])).toBe(true);
  });

  it("matches /* one-level children only", () => {
    expect(pathIgnored("src/a.ts", ["src/*"])).toBe(true);
    expect(pathIgnored("src/x/y.ts", ["src/*"])).toBe(false);
  });

  it("matches basename globs and bare *", () => {
    expect(pathIgnored("src/a.log", ["*.log"])).toBe(true);
    expect(pathIgnored("a.log", ["*.log"])).toBe(true);
    expect(pathIgnored("src/a.ts", ["*.log"])).toBe(false);
    expect(pathIgnored("package-lock.json", ["*lock*"])).toBe(true);
    expect(pathIgnored("src/a.ts", ["*"])).toBe(true);
  });

  it("decides warn vs serialize vs off", () => {
    const left = ["src/a.ts"];
    const right = ["src/a.ts", "src/b.ts"];
    expect(decideOverlapAction("off", left, right).action).toBe("none");
    expect(decideOverlapAction(undefined, left, right).action).toBe("none");
    expect(decideOverlapAction("warn", left, right)).toEqual({
      action: "warned",
      paths: ["src/a.ts"],
      totalPathCount: 1,
      truncated: false,
    });
    expect(decideOverlapAction("serialize", left, right).action).toBe("serialized");
    expect(decideOverlapAction("warn", left, ["other.ts"]).action).toBe("none");
  });

  it("reports totalPathCount when truncating at 50", () => {
    const left = Array.from({ length: 60 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`);
    const right = left;
    const decision = decideOverlapAction("warn", left, right);
    expect(decision.action).toBe("warned");
    if (decision.action === "warned") {
      expect(decision.paths).toHaveLength(50);
      expect(decision.totalPathCount).toBe(60);
      expect(decision.truncated).toBe(true);
    }
  });

  it("identifies serialize-hold reasons for engine routing bypass", () => {
    expect(isParallelismHoldReason(PARALLELISM_HOLD_REASON_ACTIVE)).toBe(true);
    expect(isParallelismHoldReason(serializeHoldReason("t-early"))).toBe(true);
    expect(isParallelismHoldReason("approval required")).toBe(false);
    expect(isParallelismHoldReason(undefined)).toBe(false);
  });
});
