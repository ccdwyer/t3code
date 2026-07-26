import * as Effect from "effect/Effect";

/**
 * SQLite reports a re-added column as "duplicate column name", but that text
 * sits several `cause` levels below the SqlError the driver surfaces, so a
 * shallow message check never sees it.
 */
const mentionsDuplicateColumn = (error: unknown, depth = 0): boolean => {
  if (depth > 8 || error === null || error === undefined) {
    return false;
  }
  if (typeof error === "string") {
    return /duplicate column name/i.test(error);
  }
  if (typeof error !== "object") {
    return false;
  }
  const candidate = error as { readonly message?: unknown; readonly cause?: unknown };
  if (typeof candidate.message === "string" && /duplicate column name/i.test(candidate.message)) {
    return true;
  }
  return mentionsDuplicateColumn(candidate.cause, depth + 1);
};

/**
 * Run an `ALTER TABLE ... ADD COLUMN` that may already have been applied.
 *
 * The workflow migrations were renumbered (034 -> 035 and up) when an upstream
 * rebase claimed 034. A database that recorded the OLD ids sees the renumbered
 * ones as unapplied and replays them against tables that already exist: every
 * `CREATE TABLE IF NOT EXISTS` no-ops, and then the first bare ADD COLUMN
 * aborts the migration with "duplicate column name", leaving the server unable
 * to start.
 *
 * Swallowing exactly that error — and nothing else — lets such a database
 * converge instead of having to be wiped.
 */
export const addColumnIfMissing = <A, E>(statement: Effect.Effect<A, E>): Effect.Effect<void, E> =>
  statement.pipe(
    Effect.catch((error: E) => (mentionsDuplicateColumn(error) ? Effect.void : Effect.fail(error))),
    Effect.asVoid,
  );
