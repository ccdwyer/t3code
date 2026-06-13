// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import type { BoardId, LaneKey, WorkflowDefinition } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry, type BoardRegistryShape } from "../Services/BoardRegistry.ts";
import { WorkflowEngine, type WorkflowEngineShape } from "../Services/WorkflowEngine.ts";
import {
  WorkSourceProviderRegistry,
  WorkSourceRateLimitError,
  WorkSourceTransientError,
  type ExternalWorkItem,
  type WorkSourcePage,
  type WorkSourceProvider,
  type WorkSourceProviderError,
} from "../Services/WorkSourceProvider.ts";
import {
  WorkflowSourceCommitter,
  type ReconcileLanes,
  type SourceDelta,
} from "../Services/WorkflowSourceCommitter.ts";
import {
  MAX_DELTAS_PER_RECONCILE_CHUNK,
  WorkflowSourceSyncerLive,
} from "./WorkflowSourceSyncer.ts";
import { WorkflowSourceSyncer } from "../Services/WorkflowSourceSyncer.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// A scriptable provider: each source maps to a sequence of pages keyed by
// pageToken (undefined = first page). getItem returns a configured map of
// externalId -> item|null (null = provider confirms deletion).
interface ProviderScript {
  readonly pages: ReadonlyArray<WorkSourcePage>;
  readonly getItems: ReadonlyMap<string, ExternalWorkItem | null>;
  readonly failWith?: WorkSourceRateLimitError | WorkSourceTransientError;
  // When set, getItem fails with this error instead of resolving an item — used
  // to prove a getItem ERROR does NOT confirm deletion (it feeds backoff).
  readonly getItemFailWith?: WorkSourceRateLimitError | WorkSourceTransientError;
}

const item = (externalId: string, overrides?: Partial<ExternalWorkItem>): ExternalWorkItem => ({
  provider: "github",
  externalId,
  url: `https://example.test/${externalId}`,
  lifecycle: "open",
  version: { updatedAt: "2026-06-13T00:00:00Z" },
  fields: { title: `Item ${externalId}` },
  ...overrides,
});

// Build a multi-page script. `pageTokens` are the nextPageToken values; the
// final page omits nextPageToken (exhaustion) unless `lastHasToken` is set.
const makePages = (
  itemsPerPage: ReadonlyArray<ReadonlyArray<ExternalWorkItem>>,
  options?: { readonly lastHasToken?: boolean },
): ReadonlyArray<WorkSourcePage> =>
  itemsPerPage.map((items, idx) => {
    const isLast = idx === itemsPerPage.length - 1;
    const hasToken = !isLast || options?.lastHasToken === true;
    return hasToken ? { items, nextPageToken: `tok-${idx + 1}` } : { items };
  });

// A recording stub committer: appends each reconcileChunk's deltas.
const recordingCommitter = (
  chunks: Ref.Ref<Array<{ boardId: string; lanes: ReconcileLanes; deltas: ReadonlyArray<SourceDelta> }>>,
) =>
  Layer.succeed(WorkflowSourceCommitter, {
    reconcileChunk: (boardId, lanes, deltas) =>
      Ref.update(chunks, (acc) => [...acc, { boardId: String(boardId), lanes, deltas }]),
  });

// A recording stub engine: counts recoverBoardWip calls per board. Optionally
// fails recoverBoardWip to prove the defensive wrap swallows it.
const recordingEngine = (
  recoveries: Ref.Ref<Array<string>>,
  options?: { readonly recoverFails?: boolean },
): WorkflowEngineShape =>
  ({
    recoverBoardWip: (boardId: BoardId) =>
      Effect.flatMap(
        Ref.update(recoveries, (acc) => [...acc, String(boardId)]),
        () =>
          options?.recoverFails === true
            ? Effect.die("recoverBoardWip boom")
            : Effect.void,
      ),
  }) as unknown as WorkflowEngineShape;

const board = (
  boardId: string,
  sources: WorkflowDefinition["sources"],
): { readonly boardId: BoardId; readonly definition: WorkflowDefinition } => ({
  boardId: boardId as BoardId,
  definition: {
    name: boardId,
    lanes: [
      { key: "todo" as LaneKey, name: "Todo", entry: "manual" },
      { key: "done" as LaneKey, name: "Done", entry: "manual", terminal: true },
    ],
    sources,
  } as unknown as WorkflowDefinition,
});

const stubBoardRegistry = (
  boards: ReadonlyArray<{ readonly boardId: BoardId; readonly definition: WorkflowDefinition }>,
): BoardRegistryShape =>
  ({
    listDefinitions: () => Effect.succeed(boards),
    getDefinition: (boardId: BoardId) =>
      Effect.succeed(boards.find((b) => b.boardId === boardId)?.definition ?? null),
  }) as unknown as BoardRegistryShape;

const stubProviderRegistry = (scripts: ReadonlyMap<string, ProviderScript>) => {
  const make = (): WorkSourceProvider => {
    // Track per-sourceKey page index so successive listPage calls advance.
    const cursors = new Map<string, number>();
    return {
      provider: "github",
      selectorSchema: undefined as never,
      listPage: (input): Effect.Effect<WorkSourcePage, WorkSourceProviderError> =>
        Effect.suspend(() => {
          const key = (input.selector as { readonly key: string }).key;
          const script = scripts.get(key);
          if (script === undefined) {
            return Effect.succeed<WorkSourcePage>({ items: [] });
          }
          if (script.failWith !== undefined) {
            return Effect.fail(script.failWith);
          }
          const idx = cursors.get(key) ?? 0;
          cursors.set(key, idx + 1);
          const page: WorkSourcePage = script.pages[idx] ?? { items: [] };
          return Effect.succeed(page);
        }),
      getItem: (input) =>
        Effect.suspend(() => {
          // Resolve which script this externalId belongs to (selector carries
          // the source key in these tests).
          const key = (input.selector as { readonly key?: string } | undefined)?.key;
          const keyedScript = key === undefined ? undefined : scripts.get(key);
          if (keyedScript?.getItemFailWith !== undefined) {
            return Effect.fail(keyedScript.getItemFailWith);
          }
          for (const script of scripts.values()) {
            if (script.getItemFailWith !== undefined && script.getItems.has(input.externalId)) {
              return Effect.fail(script.getItemFailWith);
            }
            if (script.getItems.has(input.externalId)) {
              return Effect.succeed(script.getItems.get(input.externalId) ?? null);
            }
          }
          return Effect.succeed(null);
        }),
    };
  };
  const provider = make();
  return Layer.succeed(WorkSourceProviderRegistry, {
    get: () => provider,
  });
};

// State-table helpers ---------------------------------------------------------

const readState = (boardId: string, sourceId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly consecutiveFailures: number;
      readonly backoffUntil: string | null;
      readonly lastFullRunAt: string | null;
      readonly lastError: string | null;
    }>`
      SELECT consecutive_failures AS "consecutiveFailures",
             backoff_until AS "backoffUntil",
             last_full_run_at AS "lastFullRunAt",
             last_error AS "lastError"
      FROM work_source_state
      WHERE board_id = ${boardId} AND source_id = ${sourceId}
    `;
    return rows[0] ?? null;
  });

const seedState = (
  boardId: string,
  sourceId: string,
  fields: { backoffUntil?: string | null; consecutiveFailures?: number; lastFullRunAt?: string | null },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO work_source_state (board_id, source_id, cursor_or_etag, last_full_run_at, backoff_until, consecutive_failures, last_error)
      VALUES (${boardId}, ${sourceId}, NULL, ${fields.lastFullRunAt ?? null}, ${fields.backoffUntil ?? null}, ${fields.consecutiveFailures ?? 0}, NULL)
    `;
  });

const seedMapping = (
  boardId: string,
  sourceId: string,
  externalId: string,
  ticketId: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO work_source_mapping (
        mapping_id, board_id, source_id, provider, external_id, ticket_id,
        provider_version, content_hash, lifecycle, sync_status,
        source_metadata_json, created_at, last_synced_at
      ) VALUES (
        ${`m-${externalId}`}, ${boardId}, ${sourceId}, 'github', ${externalId}, ${ticketId},
        NULL, ${"stale-hash"}, 'open', 'active', NULL, ${now}, ${now}
      )
    `;
  });

const githubSource = (
  id: string,
  selectorKey: string,
  enabled = true,
  extra?: { readonly syncIntervalSec?: number },
): WorkflowDefinition["sources"] =>
  [
    {
      id: id as never,
      provider: "github" as const,
      connectionRef: "conn-1",
      selector: { key: selectorKey },
      destinationLane: "todo" as LaneKey,
      closedLane: "done" as LaneKey,
      enabled,
      ...(extra?.syncIntervalSec === undefined ? {} : { syncIntervalSec: extra.syncIntervalSec }),
    },
  ] as unknown as WorkflowDefinition["sources"];

// Compose the syncer under test with all stub deps + real sqlite.
const makeLayer = (params: {
  readonly boards: ReadonlyArray<{ readonly boardId: BoardId; readonly definition: WorkflowDefinition }>;
  readonly scripts: ReadonlyMap<string, ProviderScript>;
  readonly chunks: Ref.Ref<Array<{ boardId: string; lanes: ReconcileLanes; deltas: ReadonlyArray<SourceDelta> }>>;
  readonly recoveries: Ref.Ref<Array<string>>;
  readonly recoverFails?: boolean;
}) =>
  WorkflowSourceSyncerLive.pipe(
    Layer.provide(Layer.succeed(BoardRegistry, stubBoardRegistry(params.boards))),
    Layer.provide(stubProviderRegistry(params.scripts)),
    Layer.provide(recordingCommitter(params.chunks)),
    Layer.provide(Layer.succeed(WorkflowEngine, recordingEngine(params.recoveries, { recoverFails: params.recoverFails ?? false }))),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it.effect("multi-page scan that exhausts → scanCompleted true, missing detected, last_full_run_at set", () =>
  Effect.gen(function* () {
    const chunks = yield* Ref.make<Array<{ boardId: string; lanes: ReconcileLanes; deltas: ReadonlyArray<SourceDelta> }>>([]);
    const recoveries = yield* Ref.make<Array<string>>([]);
    const scripts = new Map<string, ProviderScript>([
      [
        "src-a",
        {
          // 2 pages, exhausts (last has no token). Item "1" present.
          pages: makePages([[item("1")], [item("2")]]),
          getItems: new Map(),
        },
      ],
    ]);
    const boards = [board("board-1", githubSource("source-a", "src-a"))];

    const run = Effect.gen(function* () {
      // Pre-existing mapping "gone" not in the scan → should produce a missing delta.
      yield* seedMapping("board-1", "source-a", "gone", "ticket-gone");
      const syncer = yield* WorkflowSourceSyncer;
      yield* syncer.sweep;

      const recorded = yield* Ref.get(chunks);
      const allDeltas = recorded.flatMap((c) => c.deltas);
      const tags = allDeltas.map((d) => d._tag);
      assert.include(tags, "new"); // items 1,2 unmapped
      assert.include(tags, "missing"); // "gone" mapping not in scan
      const state = yield* readState("board-1", "source-a");
      assert.isNotNull(state!.lastFullRunAt);
    });
    yield* run.pipe(Effect.provide(makeLayer({ boards, scripts, chunks, recoveries })));
  }),
);

it.effect("page cap hit with nextPageToken still present → scanCompleted false, NO missing, last_full_run_at NOT set", () =>
  Effect.gen(function* () {
    const chunks = yield* Ref.make<Array<{ boardId: string; lanes: ReconcileLanes; deltas: ReadonlyArray<SourceDelta> }>>([]);
    const recoveries = yield* Ref.make<Array<string>>([]);
    // 12 pages each still carrying a nextPageToken (lastHasToken) → MAX_PAGES cap (10) reached
    // while nextPageToken still present.
    const pages = makePages(
      Array.from({ length: 12 }, (_, i) => [item(`p${i}`)]),
      { lastHasToken: true },
    );
    const scripts = new Map<string, ProviderScript>([
      ["src-cap", { pages, getItems: new Map() }],
    ]);
    const boards = [board("board-1", githubSource("source-cap", "src-cap"))];

    const run = Effect.gen(function* () {
      yield* seedMapping("board-1", "source-cap", "gone", "ticket-gone");
      const syncer = yield* WorkflowSourceSyncer;
      yield* syncer.sweep;

      const recorded = yield* Ref.get(chunks);
      const tags = recorded.flatMap((c) => c.deltas).map((d) => d._tag);
      assert.notInclude(tags, "missing");
      const state = yield* readState("board-1", "source-cap");
      assert.isNull(state!.lastFullRunAt);
    });
    yield* run.pipe(Effect.provide(makeLayer({ boards, scripts, chunks, recoveries })));
  }),
);

it.effect("rate-limit error → backoff_until from retryAfterMs, consecutive_failures incremented; other sources still processed", () =>
  Effect.gen(function* () {
    const chunks = yield* Ref.make<Array<{ boardId: string; lanes: ReconcileLanes; deltas: ReadonlyArray<SourceDelta> }>>([]);
    const recoveries = yield* Ref.make<Array<string>>([]);
    const scripts = new Map<string, ProviderScript>([
      ["src-fail", { pages: [], getItems: new Map(), failWith: new WorkSourceRateLimitError({ retryAfterMs: 60_000 }) }],
      ["src-ok", { pages: makePages([[item("ok1")]]), getItems: new Map() }],
    ]);
    // Two boards so isolation across the sweep is exercised.
    const boards = [
      board("board-fail", githubSource("source-fail", "src-fail")),
      board("board-ok", githubSource("source-ok", "src-ok")),
    ];

    const run = Effect.gen(function* () {
      const syncer = yield* WorkflowSourceSyncer;
      yield* syncer.sweep;

      const failState = yield* readState("board-fail", "source-fail");
      assert.equal(failState!.consecutiveFailures, 1);
      assert.isNotNull(failState!.backoffUntil);
      assert.isNotNull(failState!.lastError);

      // The OK source still produced a chunk.
      const recorded = yield* Ref.get(chunks);
      assert.isTrue(recorded.some((c) => c.boardId === "board-ok"));
      // recoverBoardWip still called for BOTH boards.
      const recs = yield* Ref.get(recoveries);
      assert.include(recs, "board-fail");
      assert.include(recs, "board-ok");
    });
    yield* run.pipe(Effect.provide(makeLayer({ boards, scripts, chunks, recoveries })));
  }),
);

it.effect("success after failure → consecutive_failures reset to 0, backoff cleared", () =>
  Effect.gen(function* () {
    const chunks = yield* Ref.make<Array<{ boardId: string; lanes: ReconcileLanes; deltas: ReadonlyArray<SourceDelta> }>>([]);
    const recoveries = yield* Ref.make<Array<string>>([]);
    const scripts = new Map<string, ProviderScript>([
      ["src-recover", { pages: makePages([[item("r1")]]), getItems: new Map() }],
    ]);
    const boards = [board("board-1", githubSource("source-recover", "src-recover"))];

    const run = Effect.gen(function* () {
      // Seed a PAST backoff + prior failures: backoff has elapsed so the source runs.
      yield* seedState("board-1", "source-recover", {
        backoffUntil: "2000-01-01T00:00:00Z",
        consecutiveFailures: 3,
      });
      const syncer = yield* WorkflowSourceSyncer;
      yield* syncer.sweep;

      const state = yield* readState("board-1", "source-recover");
      assert.equal(state!.consecutiveFailures, 0);
      assert.isNull(state!.backoffUntil);
      assert.isNull(state!.lastError);
    });
    yield* run.pipe(Effect.provide(makeLayer({ boards, scripts, chunks, recoveries })));
  }),
);

it.effect("deltas chunked at MAX_DELTAS_PER_RECONCILE_CHUNK → multiple reconcileChunk calls", () =>
  Effect.gen(function* () {
    const chunks = yield* Ref.make<Array<{ boardId: string; lanes: ReconcileLanes; deltas: ReadonlyArray<SourceDelta> }>>([]);
    const recoveries = yield* Ref.make<Array<string>>([]);
    const count = MAX_DELTAS_PER_RECONCILE_CHUNK + 5; // forces 2 chunks
    const items = Array.from({ length: count }, (_, i) => item(`x${i}`));
    const scripts = new Map<string, ProviderScript>([
      ["src-big", { pages: makePages([items]), getItems: new Map() }],
    ]);
    const boards = [board("board-1", githubSource("source-big", "src-big"))];

    const run = Effect.gen(function* () {
      const syncer = yield* WorkflowSourceSyncer;
      yield* syncer.sweep;
      const recorded = yield* Ref.get(chunks);
      assert.equal(recorded.length, 2);
      assert.equal(recorded[0]!.deltas.length, MAX_DELTAS_PER_RECONCILE_CHUNK);
      assert.equal(recorded[1]!.deltas.length, 5);
      // Lanes threaded through from the source config.
      assert.equal(recorded[0]!.lanes.destinationLane, "todo");
      assert.equal(recorded[0]!.lanes.closedLane, "done");
    });
    yield* run.pipe(Effect.provide(makeLayer({ boards, scripts, chunks, recoveries })));
  }),
);

it.effect("missing mapping → getItem called; null → confirmedDeleted true; non-null → confirmedDeleted false", () =>
  Effect.gen(function* () {
    const chunks = yield* Ref.make<Array<{ boardId: string; lanes: ReconcileLanes; deltas: ReadonlyArray<SourceDelta> }>>([]);
    const recoveries = yield* Ref.make<Array<string>>([]);
    // Scan exhausts with NO items → both seeded mappings are "missing".
    // getItem: "deleted-id" → null (confirmed deleted); "exists-id" → still exists.
    const scripts = new Map<string, ProviderScript>([
      [
        "src-miss",
        {
          pages: makePages([[]]),
          getItems: new Map<string, ExternalWorkItem | null>([
            ["deleted-id", null],
            ["exists-id", item("exists-id")],
          ]),
        },
      ],
    ]);
    const boards = [board("board-1", githubSource("source-miss", "src-miss"))];

    const run = Effect.gen(function* () {
      yield* seedMapping("board-1", "source-miss", "deleted-id", "ticket-del");
      yield* seedMapping("board-1", "source-miss", "exists-id", "ticket-ex");
      const syncer = yield* WorkflowSourceSyncer;
      yield* syncer.sweep;

      const recorded = yield* Ref.get(chunks);
      const missing = recorded
        .flatMap((c) => c.deltas)
        .filter((d): d is Extract<SourceDelta, { _tag: "missing" }> => d._tag === "missing");
      assert.equal(missing.length, 2);
      const del = missing.find((d) => d.item.externalId === "deleted-id");
      const exist = missing.find((d) => d.item.externalId === "exists-id");
      assert.equal(del!.confirmedDeleted, true);
      assert.equal(exist!.confirmedDeleted, false);
    });
    yield* run.pipe(Effect.provide(makeLayer({ boards, scripts, chunks, recoveries })));
  }),
);

it.effect("Finding #5: zero-delta board STILL calls recoverBoardWip; a recoverBoardWip failure is caught (sweep continues)", () =>
  Effect.gen(function* () {
    const chunks = yield* Ref.make<Array<{ boardId: string; lanes: ReconcileLanes; deltas: ReadonlyArray<SourceDelta> }>>([]);
    const recoveries = yield* Ref.make<Array<string>>([]);
    // A source whose scan exhausts with NO items and NO mappings → zero deltas.
    const scripts = new Map<string, ProviderScript>([
      ["src-empty", { pages: makePages([[]]), getItems: new Map() }],
    ]);
    const boards = [board("board-empty", githubSource("source-empty", "src-empty"))];

    const run = Effect.gen(function* () {
      const syncer = yield* WorkflowSourceSyncer;
      // recoverFails: true → must be swallowed, sweep must not crash.
      yield* syncer.sweep;
      const recorded = yield* Ref.get(chunks);
      assert.equal(recorded.flatMap((c) => c.deltas).length, 0);
      const recs = yield* Ref.get(recoveries);
      assert.include(recs, "board-empty");
    });
    yield* run.pipe(Effect.provide(makeLayer({ boards, scripts, chunks, recoveries, recoverFails: true })));
  }),
);

it.effect("source in backoff (backoff_until in the future) is SKIPPED this tick", () =>
  Effect.gen(function* () {
    const chunks = yield* Ref.make<Array<{ boardId: string; lanes: ReconcileLanes; deltas: ReadonlyArray<SourceDelta> }>>([]);
    const recoveries = yield* Ref.make<Array<string>>([]);
    const scripts = new Map<string, ProviderScript>([
      ["src-backoff", { pages: makePages([[item("s1")]]), getItems: new Map() }],
    ]);
    const boards = [board("board-1", githubSource("source-backoff", "src-backoff"))];

    const run = Effect.gen(function* () {
      yield* seedState("board-1", "source-backoff", {
        backoffUntil: "2999-01-01T00:00:00Z",
        consecutiveFailures: 2,
      });
      const syncer = yield* WorkflowSourceSyncer;
      yield* syncer.sweep;

      const recorded = yield* Ref.get(chunks);
      // Source skipped → no chunks at all.
      assert.equal(recorded.length, 0);
      // State untouched (still 2 failures).
      const state = yield* readState("board-1", "source-backoff");
      assert.equal(state!.consecutiveFailures, 2);
      // recoverBoardWip STILL runs per board (Finding #5) even with a skipped source.
      const recs = yield* Ref.get(recoveries);
      assert.include(recs, "board-1");
    });
    yield* run.pipe(Effect.provide(makeLayer({ boards, scripts, chunks, recoveries })));
  }),
);

it.effect("Fix 2: a getItem ERROR does NOT confirm deletion (no terminal-route) and feeds backoff", () =>
  Effect.gen(function* () {
    const chunks = yield* Ref.make<Array<{ boardId: string; lanes: ReconcileLanes; deltas: ReadonlyArray<SourceDelta> }>>([]);
    const recoveries = yield* Ref.make<Array<string>>([]);
    // Scan exhausts with NO items → the seeded mapping is "missing".
    // getItem FAILS (transient) → must NOT mark confirmedDeleted; the whole
    // source pass becomes a recorded backoff, so NO chunk is committed.
    const scripts = new Map<string, ProviderScript>([
      [
        "src-err",
        {
          pages: makePages([[]]),
          getItems: new Map<string, ExternalWorkItem | null>([["orphan-id", null]]),
          getItemFailWith: new WorkSourceTransientError({ message: "github 500 (getItem)" }),
        },
      ],
    ]);
    const boards = [board("board-1", githubSource("source-err", "src-err"))];

    const run = Effect.gen(function* () {
      yield* seedMapping("board-1", "source-err", "orphan-id", "ticket-orphan");
      const syncer = yield* WorkflowSourceSyncer;
      yield* syncer.sweep;

      // No chunk committed → ticket never terminal-routed on a getItem error.
      const recorded = yield* Ref.get(chunks);
      assert.equal(recorded.flatMap((c) => c.deltas).length, 0);
      // The error fed the per-source backoff (consecutive_failures incremented,
      // backoff_until set) — i.e. it behaved like a listPage failure.
      const state = yield* readState("board-1", "source-err");
      assert.equal(state!.consecutiveFailures, 1);
      assert.isNotNull(state!.backoffUntil);
    });
    yield* run.pipe(Effect.provide(makeLayer({ boards, scripts, chunks, recoveries })));
  }),
);

it.effect("Fix 4: a source with syncIntervalSec=600 + a recent last_full_run_at is SKIPPED this sweep", () =>
  Effect.gen(function* () {
    const chunks = yield* Ref.make<Array<{ boardId: string; lanes: ReconcileLanes; deltas: ReadonlyArray<SourceDelta> }>>([]);
    const recoveries = yield* Ref.make<Array<string>>([]);
    const scripts = new Map<string, ProviderScript>([
      ["src-throttle", { pages: makePages([[item("t1")]]), getItems: new Map() }],
    ]);
    const boards = [
      board("board-1", githubSource("source-throttle", "src-throttle", true, { syncIntervalSec: 600 })),
    ];

    const run = Effect.gen(function* () {
      // The due-gate compares last_full_run_at + interval against the REAL wall
      // clock (DateTime.isFutureUnsafe), not the test clock. Seed a far-future
      // last_full_run_at so last_full_run_at + 600s is unambiguously in the
      // future → the source is throttled/SKIPPED this sweep.
      yield* seedState("board-1", "source-throttle", {
        lastFullRunAt: "2999-01-01T00:00:00Z",
      });
      const syncer = yield* WorkflowSourceSyncer;
      yield* syncer.sweep;

      const recorded = yield* Ref.get(chunks);
      assert.equal(recorded.length, 0); // throttled → no listPage/commit this tick
      const recs = yield* Ref.get(recoveries);
      assert.include(recs, "board-1"); // recoverBoardWip still runs per board
    });
    yield* run.pipe(Effect.provide(makeLayer({ boards, scripts, chunks, recoveries })));
  }),
);

it.effect("Fix 4: a source with a STALE last_full_run_at (older than the interval) RUNS", () =>
  Effect.gen(function* () {
    const chunks = yield* Ref.make<Array<{ boardId: string; lanes: ReconcileLanes; deltas: ReadonlyArray<SourceDelta> }>>([]);
    const recoveries = yield* Ref.make<Array<string>>([]);
    const scripts = new Map<string, ProviderScript>([
      ["src-due", { pages: makePages([[item("d1")]]), getItems: new Map() }],
    ]);
    const boards = [
      board("board-1", githubSource("source-due", "src-due", true, { syncIntervalSec: 600 })),
    ];

    const run = Effect.gen(function* () {
      // last_full_run_at far in the past → due → RUNS this tick.
      yield* seedState("board-1", "source-due", { lastFullRunAt: "2000-01-01T00:00:00Z" });
      const syncer = yield* WorkflowSourceSyncer;
      yield* syncer.sweep;

      const recorded = yield* Ref.get(chunks);
      const tags = recorded.flatMap((c) => c.deltas).map((d) => d._tag);
      assert.include(tags, "new"); // it ran → produced a "new" delta for d1
    });
    yield* run.pipe(Effect.provide(makeLayer({ boards, scripts, chunks, recoveries })));
  }),
);
