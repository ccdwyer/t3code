/**
 * Per-board persistence for the workflow canvas's manually arranged lane
 * positions. Positions are a client-side presentation preference, so they live
 * in localStorage rather than the board file — the definition (and its hash /
 * version history) never changes when a user tidies the canvas.
 */

export interface LanePositionPoint {
  readonly x: number;
  readonly y: number;
}

export type StoredLanePositions = Readonly<Record<string, LanePositionPoint>>;

/** The subset of the DOM Storage interface the helpers need. */
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_PREFIX = "t3.workflow.canvasLayout.";

export const canvasLayoutStorageKey = (boardId: string): string =>
  `${STORAGE_PREFIX}${boardId}`;

const defaultStorage = (): LayoutStorage | null => {
  try {
    const storage = (globalThis as { localStorage?: LayoutStorage }).localStorage;
    return storage ?? null;
  } catch {
    // Accessing localStorage can itself throw (privacy modes, sandboxed frames).
    return null;
  }
};

const isValidPoint = (value: unknown): value is LanePositionPoint => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const point = value as { x?: unknown; y?: unknown };
  return (
    typeof point.x === "number" &&
    Number.isFinite(point.x) &&
    point.x >= 0 &&
    typeof point.y === "number" &&
    Number.isFinite(point.y) &&
    point.y >= 0
  );
};

/**
 * Load the stored lane positions for a board. Tolerant of missing, corrupt, or
 * partially invalid payloads — invalid entries are dropped, failures yield {}.
 */
export const loadLanePositions = (
  boardId: string,
  storage: LayoutStorage | null = defaultStorage(),
): StoredLanePositions => {
  if (storage === null || boardId === "") {
    return {};
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(canvasLayoutStorageKey(boardId));
  } catch {
    return {};
  }
  if (raw === null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<string, LanePositionPoint> = {};
  for (const [laneKey, value] of Object.entries(parsed)) {
    if (isValidPoint(value)) {
      result[laneKey] = { x: Math.round(value.x), y: Math.round(value.y) };
    }
  }
  return result;
};

/**
 * Persist the lane positions for a board. An empty record clears the entry
 * (matching "Reset layout"). Write failures (quota, privacy mode) are ignored —
 * layout persistence is best-effort.
 */
export const saveLanePositions = (
  boardId: string,
  positions: StoredLanePositions,
  storage: LayoutStorage | null = defaultStorage(),
): void => {
  if (storage === null || boardId === "") {
    return;
  }
  try {
    if (Object.keys(positions).length === 0) {
      storage.removeItem(canvasLayoutStorageKey(boardId));
      return;
    }
    storage.setItem(canvasLayoutStorageKey(boardId), JSON.stringify(positions));
  } catch {
    // Best-effort: never let layout persistence break the editor.
  }
};
