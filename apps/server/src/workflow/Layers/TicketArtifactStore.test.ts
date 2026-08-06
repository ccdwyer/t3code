// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDateInEffect:off
import { randomUUID } from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as NodePath from "node:path";

import { TicketId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { TicketArtifactPaths, TicketArtifactStore } from "../Services/TicketArtifactStore.ts";
import { classifyEntries, TicketArtifactStoreLive } from "./TicketArtifactStore.ts";

const testPathsLayer = Layer.effect(
  TicketArtifactPaths,
  Effect.promise(async () => ({
    rootDir: await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "ticket-artifacts-store-")),
  })),
);

const storeLayer = it.layer(
  TicketArtifactStoreLive.pipe(
    Layer.provideMerge(testPathsLayer),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const seedTicket = (ticketId: string, boardId = "board-1") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_ticket
        (ticket_id, board_id, title, current_lane_key, status, created_at, updated_at)
      VALUES (${ticketId}, ${boardId}, ${"t"}, ${"lane"}, ${"idle"}, ${"2026-08-05T00:00:00Z"}, ${"2026-08-05T00:00:00Z"})
    `;
  });

const makeSourceDir = () =>
  Effect.promise(() => Fs.mkdtemp(NodePath.join(Os.tmpdir(), "ticket-artifacts-src-")));

const write = (dir: string, name: string, content: string | Buffer) =>
  Effect.promise(async () => {
    const full = NodePath.join(dir, name);
    await Fs.mkdir(NodePath.dirname(full), { recursive: true });
    await Fs.writeFile(full, content);
  });

const freshTicketId = () => TicketId.make(randomUUID());

describe("classifyEntries", () => {
  it("splits candidates, winning sidecars, orphan sidecars, and skips", () => {
    const result = classifyEntries([
      "after.png",
      "after.png.caption.md",
      "after.png.caption.MD",
      "lonely.png.caption.md",
      "diagram.svg",
      "notes.md",
    ]);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.rawName),
      ["after.png", "notes.md"],
    );
    assert.equal(result.sidecarByBase.get("after.png"), "after.png.caption.MD");
    assert.isFalse(result.sidecarByBase.has("lonely.png"));
    assert.deepEqual(result.skips.map((skip) => `${skip.reason}:${skip.name}`).sort(), [
      "name-collision:after.png.caption.md",
      "orphan-sidecar:lonely.png.caption.md",
      "unknown-extension:diagram.svg",
    ]);
  });

  it("NFC collision keeps the byte-order winner", () => {
    const nfc = "café.md";
    const nfd = "café.md";
    const result = classifyEntries([nfc, nfd]);
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.rawName),
      [nfd],
    );
    assert.deepEqual(result.skips, [
      { name: nfc, reason: "name-collision", detail: "normalizes to a duplicate name" },
    ]);
  });
});

storeLayer("TicketArtifactStore", (it) => {
  it.effect("ingests files with captions and lists in canonical order", () =>
    Effect.gen(function* () {
      const store = yield* TicketArtifactStore;
      const ticketId = freshTicketId();
      yield* seedTicket(String(ticketId));
      const src = yield* makeSourceDir();
      yield* write(src, "b-plan.md", "# Plan");
      yield* write(src, "a/after.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      yield* write(src, "a/after.png.caption.md", "  After the fix  ");

      const report = yield* store.ingestBatch({
        ticketId,
        stepRunId: "step-1",
        artifactsRootAbsolutePath: src,
        entries: ["b-plan.md", "a/after.png", "a/after.png.caption.md"],
      });
      assert.isFalse(report.ticketMissing);
      assert.deepEqual([...report.ingested].sort(), ["a/after.png", "b-plan.md"]);
      assert.lengthOf(report.skips, 0);

      const rows = yield* store.list(ticketId);
      assert.deepEqual(
        rows.map((row) => row.name),
        ["a/after.png", "b-plan.md"],
      );
      const image = rows[0];
      assert.isDefined(image);
      if (image !== undefined) {
        assert.equal(image.kind, "image");
        assert.equal(image.description, "After the fix");
        assert.equal(image.stepRunId, "step-1");
        assert.equal(image.byteSize, 4);
      }

      const markdown = rows[1];
      assert.isDefined(markdown);
      if (markdown !== undefined) {
        const text = yield* store.readInlineText(ticketId, markdown.artifactId, 1024);
        assert.equal(text, "# Plan");
      }
    }),
  );

  it.effect(
    "caption-only change updates description without churn; idle settle writes nothing",
    () =>
      Effect.gen(function* () {
        const store = yield* TicketArtifactStore;
        const ticketId = freshTicketId();
        yield* seedTicket(String(ticketId));
        const src = yield* makeSourceDir();
        yield* write(src, "shot.png", Buffer.from([1, 2, 3]));
        yield* write(src, "shot.png.caption.md", "v1");
        const entries = ["shot.png", "shot.png.caption.md"];

        yield* store.ingestBatch({ ticketId, artifactsRootAbsolutePath: src, entries });
        const first = (yield* store.list(ticketId))[0];
        assert.isDefined(first);
        if (first === undefined) return;
        assert.equal(first.description, "v1");

        // Idle re-settle: nothing changed → NO row updates (updated_at stable).
        const idle = yield* store.ingestBatch({
          ticketId,
          artifactsRootAbsolutePath: src,
          entries,
        });
        assert.lengthOf(idle.ingested, 0);
        const afterIdle = (yield* store.list(ticketId))[0];
        assert.equal(afterIdle?.updatedAt, first.updatedAt);
        assert.equal(afterIdle?.blobId, first.blobId);

        // Caption-only edit: description + updated_at move; bytes/provenance don't.
        yield* write(src, "shot.png.caption.md", "v2 better");
        const captionOnly = yield* store.ingestBatch({
          ticketId,
          stepRunId: "step-9",
          artifactsRootAbsolutePath: src,
          entries,
        });
        assert.deepEqual(captionOnly.ingested, ["shot.png"]);
        const updated = (yield* store.list(ticketId))[0];
        assert.equal(updated?.description, "v2 better");
        assert.equal(updated?.blobId, first.blobId);
        assert.equal(updated?.stepRunId, first.stepRunId);

        // Sidecar absence preserves the description (last-wins).
        yield* Effect.promise(() => Fs.rm(NodePath.join(src, "shot.png.caption.md")));
        yield* store.ingestBatch({
          ticketId,
          artifactsRootAbsolutePath: src,
          entries: ["shot.png"],
        });
        const preserved = (yield* store.list(ticketId))[0];
        assert.equal(preserved?.description, "v2 better");
      }),
  );

  it.effect("byte change swaps the blob and updates provenance; old blob removed", () =>
    Effect.gen(function* () {
      const store = yield* TicketArtifactStore;
      const paths = yield* TicketArtifactPaths;
      const ticketId = freshTicketId();
      yield* seedTicket(String(ticketId));
      const src = yield* makeSourceDir();
      yield* write(src, "doc.md", "one");
      yield* store.ingestBatch({
        ticketId,
        stepRunId: "s1",
        artifactsRootAbsolutePath: src,
        entries: ["doc.md"],
      });
      const first = (yield* store.list(ticketId))[0];
      assert.isDefined(first);
      if (first === undefined) return;

      // Force a different mtime tick, then change bytes.
      yield* Effect.promise(async () => {
        const full = NodePath.join(src, "doc.md");
        await Fs.writeFile(full, "two!");
        await Fs.utimes(full, new Date(), new Date(Date.now() + 1500));
      });
      yield* store.ingestBatch({
        ticketId,
        stepRunId: "s2",
        artifactsRootAbsolutePath: src,
        entries: ["doc.md"],
      });
      const second = (yield* store.list(ticketId))[0];
      assert.isDefined(second);
      if (second === undefined) return;
      assert.notEqual(second.blobId, first.blobId);
      assert.equal(second.stepRunId, "s2");
      assert.equal(second.byteSize, 4);

      const oldBlob = NodePath.join(paths.rootDir, String(ticketId), first.blobId);
      const oldExists = yield* Effect.promise(() =>
        Fs.stat(oldBlob).then(
          () => true,
          () => false,
        ),
      );
      assert.isFalse(oldExists);
    }),
  );

  it.effect("repair adoption: same bytes but missing blob re-lands the blob", () =>
    Effect.gen(function* () {
      const store = yield* TicketArtifactStore;
      const paths = yield* TicketArtifactPaths;
      const ticketId = freshTicketId();
      yield* seedTicket(String(ticketId));
      const src = yield* makeSourceDir();
      yield* write(src, "spec.md", "stable content");
      yield* store.ingestBatch({ ticketId, artifactsRootAbsolutePath: src, entries: ["spec.md"] });
      const first = (yield* store.list(ticketId))[0];
      assert.isDefined(first);
      if (first === undefined) return;

      // Simulate the lost-rename crash state: row exists, blob gone.
      yield* Effect.promise(() =>
        Fs.rm(NodePath.join(paths.rootDir, String(ticketId), first.blobId), { force: true }),
      );
      assert.isNull(yield* store.openVerifiedBlob(first));

      const report = yield* store.ingestBatch({
        ticketId,
        artifactsRootAbsolutePath: src,
        entries: ["spec.md"],
      });
      assert.deepEqual(report.ingested, ["spec.md"]);
      const repaired = (yield* store.list(ticketId))[0];
      assert.isDefined(repaired);
      if (repaired === undefined) return;
      assert.notEqual(repaired.blobId, first.blobId);
      assert.equal(repaired.sha256, first.sha256);
      // Provenance unchanged: repair adoption is not a byte change.
      assert.equal(repaired.stepRunId, first.stepRunId);
      const blob = yield* store.openVerifiedBlob(repaired);
      assert.isNotNull(blob);
      if (blob !== null) yield* blob.close();
    }),
  );

  it.effect("count cap gates new names only; bytes cap uses replacement deltas", () =>
    Effect.gen(function* () {
      const store = yield* TicketArtifactStore;
      const sql = yield* SqlClient.SqlClient;
      const ticketId = freshTicketId();
      yield* seedTicket(String(ticketId));
      const src = yield* makeSourceDir();
      yield* write(src, "keep.md", "original");
      yield* store.ingestBatch({ ticketId, artifactsRootAbsolutePath: src, entries: ["keep.md"] });

      // Seed 99 synthetic rows → ticket sits at the 100-artifact count cap.
      for (let i = 0; i < 99; i += 1) {
        yield* sql`
          INSERT INTO workflow_ticket_artifact
            (artifact_id, blob_id, ticket_id, board_id, name, kind, mime,
             byte_size, sha256, source_mtime_ms, description, step_run_id,
             created_at, updated_at)
          VALUES
            (${randomUUID()}, ${randomUUID()}, ${String(ticketId)}, ${"board-1"},
             ${`filler/${String(i).padStart(3, "0")}.md`}, ${"markdown"},
             ${"text/markdown; charset=utf-8"}, ${10}, ${"x"}, ${0},
             ${null}, ${null}, ${"2026-08-05T00:00:00Z"}, ${"2026-08-05T00:00:00Z"})
        `;
      }

      yield* Effect.promise(async () => {
        const full = NodePath.join(src, "keep.md");
        await Fs.writeFile(full, "rewritten longer content");
        await Fs.utimes(full, new Date(), new Date(Date.now() + 2000));
      });
      yield* write(src, "new-name.md", "should be blocked");
      const report = yield* store.ingestBatch({
        ticketId,
        artifactsRootAbsolutePath: src,
        entries: ["keep.md", "new-name.md"],
      });
      // The UPDATE to an existing name lands; the NEW name is count-capped.
      assert.include(report.ingested, "keep.md");
      assert.deepEqual(
        report.skips.map((skip) => `${skip.reason}:${skip.name}`),
        ["over-ticket-count-cap:new-name.md"],
      );

      // Bytes cap: seed sum near the cap, then a small NEW file (after making
      // room in the count) must be bytes-capped.
      yield* sql`DELETE FROM workflow_ticket_artifact
        WHERE ticket_id = ${String(ticketId)} AND name LIKE 'filler/%'`;
      yield* sql`
        INSERT INTO workflow_ticket_artifact
          (artifact_id, blob_id, ticket_id, board_id, name, kind, mime,
           byte_size, sha256, source_mtime_ms, description, step_run_id,
           created_at, updated_at)
        VALUES
          (${randomUUID()}, ${randomUUID()}, ${String(ticketId)}, ${"board-1"},
           ${"huge.webm"}, ${"video"}, ${"video/webm"},
           ${250 * 1024 * 1024 - 8}, ${"y"}, ${0}, ${null}, ${null},
           ${"2026-08-05T00:00:00Z"}, ${"2026-08-05T00:00:00Z"})
      `;
      yield* write(src, "tiny-new.md", "0123456789");
      const bytesReport = yield* store.ingestBatch({
        ticketId,
        artifactsRootAbsolutePath: src,
        entries: ["tiny-new.md"],
      });
      assert.deepEqual(
        bytesReport.skips.map((skip) => `${skip.reason}:${skip.name}`),
        ["over-ticket-bytes-cap:tiny-new.md"],
      );
    }),
  );

  it.effect("missing ticket no-ops the whole batch and removes staged blobs", () =>
    Effect.gen(function* () {
      const store = yield* TicketArtifactStore;
      const paths = yield* TicketArtifactPaths;
      const ticketId = freshTicketId();
      // NOT seeded: projection_ticket row does not exist.
      const src = yield* makeSourceDir();
      yield* write(src, "orphan.md", "content");
      const report = yield* store.ingestBatch({
        ticketId,
        artifactsRootAbsolutePath: src,
        entries: ["orphan.md"],
      });
      assert.isTrue(report.ticketMissing);
      assert.lengthOf(report.ingested, 0);
      const dir = NodePath.join(paths.rootDir, String(ticketId));
      const files = yield* Effect.promise(() => Fs.readdir(dir).catch(() => []));
      assert.lengthOf(files, 0);
    }),
  );

  it.effect("openVerifiedBlob refuses symlinked and size-mismatched blobs across readers", () =>
    Effect.gen(function* () {
      const store = yield* TicketArtifactStore;
      const paths = yield* TicketArtifactPaths;
      const ticketId = freshTicketId();
      yield* seedTicket(String(ticketId));
      const src = yield* makeSourceDir();
      yield* write(src, "a.md", "hello");
      yield* store.ingestBatch({ ticketId, artifactsRootAbsolutePath: src, entries: ["a.md"] });
      const row = (yield* store.list(ticketId))[0];
      assert.isDefined(row);
      if (row === undefined) return;

      const blobPath = NodePath.join(paths.rootDir, String(ticketId), row.blobId);

      // Size mismatch → unavailable on BOTH the primitive and the text reader.
      yield* Effect.promise(() => Fs.appendFile(blobPath, "!"));
      assert.isNull(yield* store.openVerifiedBlob(row));
      assert.isNull(yield* store.readInlineText(ticketId, row.artifactId, 1024));
      yield* Effect.promise(() => Fs.truncate(blobPath, row.byteSize));
      const healthy = yield* store.openVerifiedBlob(row);
      assert.isNotNull(healthy);
      if (healthy !== null) yield* healthy.close();

      // Symlinked blob → unavailable.
      const outside = NodePath.join(yield* makeSourceDir(), "outside.md");
      yield* Effect.promise(async () => {
        await Fs.writeFile(outside, "hello");
        await Fs.rm(blobPath, { force: true });
        await Fs.symlink(outside, blobPath);
      });
      assert.isNull(yield* store.openVerifiedBlob(row));

      // Cross-ticket bind: valid ids, wrong ticket → null row.
      assert.isNull(yield* store.getRow(TicketId.make(randomUUID()), row.artifactId));
    }),
  );

  it.effect("deletion returns refs inside the tx and removeDisk clears bytes", () =>
    Effect.gen(function* () {
      const store = yield* TicketArtifactStore;
      const paths = yield* TicketArtifactPaths;
      const sql = yield* SqlClient.SqlClient;
      const ticketId = freshTicketId();
      yield* seedTicket(String(ticketId), "board-del");
      const src = yield* makeSourceDir();
      yield* write(src, "one.md", "1");
      yield* write(src, "two.md", "2");
      yield* store.ingestBatch({
        ticketId,
        artifactsRootAbsolutePath: src,
        entries: ["one.md", "two.md"],
      });

      const refs = yield* sql.withTransaction(store.deleteRowsForBoard("board-del"));
      assert.lengthOf(refs, 2);
      assert.lengthOf(yield* store.list(ticketId), 0);

      yield* store.removeDisk(refs);
      const dirGone = yield* Effect.promise(() =>
        Fs.stat(NodePath.join(paths.rootDir, String(ticketId))).then(
          () => false,
          () => true,
        ),
      );
      assert.isTrue(dirGone);
    }),
  );

  it.effect("reconcileOrphans honors the grace period and reclaims orphans", () =>
    Effect.gen(function* () {
      const store = yield* TicketArtifactStore;
      const paths = yield* TicketArtifactPaths;
      const ticketId = freshTicketId();
      yield* seedTicket(String(ticketId));
      const src = yield* makeSourceDir();
      yield* write(src, "live.md", "kept");
      yield* store.ingestBatch({ ticketId, artifactsRootAbsolutePath: src, entries: ["live.md"] });
      const row = (yield* store.list(ticketId))[0];
      assert.isDefined(row);
      if (row === undefined) return;

      const dir = NodePath.join(paths.rootDir, String(ticketId));
      const orphanBlob = NodePath.join(dir, randomUUID());
      const tmp = NodePath.join(dir, `.tmp-${randomUUID()}`);
      const zeroRowDir = NodePath.join(paths.rootDir, "dead-ticket");
      yield* Effect.promise(async () => {
        await Fs.writeFile(orphanBlob, "orphan");
        await Fs.writeFile(tmp, "tmp");
        await Fs.mkdir(zeroRowDir, { recursive: true });
        await Fs.writeFile(NodePath.join(zeroRowDir, randomUUID()), "x");
      });

      // Inside the grace window nothing is touched (real now, default grace).
      yield* store.reconcileOrphans({ nowMs: Date.now() });
      const untouched = yield* Effect.promise(() => Fs.readdir(dir));
      assert.include(untouched, NodePath.basename(orphanBlob));

      // Past the grace: orphan blob + tmp + zero-row dir reclaimed; live kept.
      yield* store.reconcileOrphans({ graceMs: 0, nowMs: Date.now() });
      const after = yield* Effect.promise(() => Fs.readdir(dir));
      assert.deepEqual(after, [row.blobId]);
      const deadGone = yield* Effect.promise(() =>
        Fs.stat(zeroRowDir).then(
          () => false,
          () => true,
        ),
      );
      assert.isTrue(deadGone);

      const blob = yield* store.openVerifiedBlob(row);
      assert.isNotNull(blob);
      if (blob !== null) yield* blob.close();
    }),
  );
});
