import { describe, expect, it } from "vite-plus/test";

import {
  canvasLayoutStorageKey,
  loadLanePositions,
  saveLanePositions,
  type LayoutStorage,
} from "./canvasLayoutStorage";

const makeStorage = (initial: Record<string, string> = {}): LayoutStorage & {
  readonly data: Map<string, string>;
} => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
};

describe("canvasLayoutStorage", () => {
  it("round-trips lane positions per board", () => {
    const storage = makeStorage();
    saveLanePositions("board-a", { work: { x: 120, y: 80 } }, storage);
    expect(loadLanePositions("board-a", storage)).toEqual({ work: { x: 120, y: 80 } });
    expect(loadLanePositions("board-b", storage)).toEqual({});
  });

  it("clears the stored entry when saving an empty layout", () => {
    const storage = makeStorage();
    saveLanePositions("board-a", { work: { x: 10, y: 10 } }, storage);
    saveLanePositions("board-a", {}, storage);
    expect(storage.data.has(canvasLayoutStorageKey("board-a"))).toBe(false);
    expect(loadLanePositions("board-a", storage)).toEqual({});
  });

  it("returns {} for missing or corrupt payloads", () => {
    const storage = makeStorage({
      [canvasLayoutStorageKey("corrupt")]: "not json {",
      [canvasLayoutStorageKey("array")]: JSON.stringify([1, 2]),
      [canvasLayoutStorageKey("scalar")]: JSON.stringify(7),
    });
    expect(loadLanePositions("missing", storage)).toEqual({});
    expect(loadLanePositions("corrupt", storage)).toEqual({});
    expect(loadLanePositions("array", storage)).toEqual({});
    expect(loadLanePositions("scalar", storage)).toEqual({});
  });

  it("drops invalid entries but keeps valid ones", () => {
    const storage = makeStorage({
      [canvasLayoutStorageKey("mixed")]: JSON.stringify({
        good: { x: 40, y: 12.6 },
        negative: { x: -5, y: 10 },
        nonNumeric: { x: "10", y: 10 },
        infinite: { x: Infinity, y: 0 },
        missing: { x: 3 },
        nullEntry: null,
      }),
    });
    expect(loadLanePositions("mixed", storage)).toEqual({ good: { x: 40, y: 13 } });
  });

  it("tolerates a throwing storage on both read and write", () => {
    const throwing: LayoutStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadLanePositions("board", throwing)).toEqual({});
    expect(() => saveLanePositions("board", { a: { x: 1, y: 2 } }, throwing)).not.toThrow();
    expect(() => saveLanePositions("board", {}, throwing)).not.toThrow();
  });

  it("no-ops on an empty board id and a null storage", () => {
    const storage = makeStorage();
    saveLanePositions("", { a: { x: 1, y: 2 } }, storage);
    expect(storage.data.size).toBe(0);
    expect(loadLanePositions("", storage)).toEqual({});
    expect(loadLanePositions("board", null)).toEqual({});
    expect(() => saveLanePositions("board", { a: { x: 1, y: 2 } }, null)).not.toThrow();
  });
});
