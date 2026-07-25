import { describe, expect, it } from "vite-plus/test";

import {
  computePathOverlap,
  decideOverlapAction,
  filterIgnored,
  pathIgnored,
} from "./worktreeOverlap.ts";

describe("worktreeOverlap", () => {
  it("computes sorted unique intersection", () => {
    expect(computePathOverlap(["b.ts", "a.ts", "c.ts"], ["c.ts", "a.ts", "d.ts"])).toEqual([
      "a.ts",
      "c.ts",
    ]);
  });

  it("applies ignore prefixes", () => {
    expect(pathIgnored("node_modules/x", ["node_modules/"])).toBe(true);
    expect(pathIgnored("src/a.ts", ["node_modules/"])).toBe(false);
    expect(filterIgnored(["src/a.ts", "dist/out.js"], ["dist/"])).toEqual(["src/a.ts"]);
  });

  it("decides warn vs serialize vs off", () => {
    const left = ["src/a.ts"];
    const right = ["src/a.ts", "src/b.ts"];
    expect(decideOverlapAction("off", left, right).action).toBe("none");
    expect(decideOverlapAction("warn", left, right)).toEqual({
      action: "warned",
      paths: ["src/a.ts"],
    });
    expect(decideOverlapAction("serialize", left, right).action).toBe("serialized");
    expect(decideOverlapAction("warn", left, ["other.ts"]).action).toBe("none");
  });
});
