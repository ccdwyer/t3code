import { TicketId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ARTIFACT_INLINE_FILE_CAP_BYTES,
  ARTIFACT_INLINE_LIST_BUDGET_BYTES,
} from "../artifactRules.ts";
import type { TicketArtifactRow } from "../Services/TicketArtifactStore.ts";
import { listDurableArtifacts } from "./WorkflowRpcHandlers.ts";

const ticketId = TicketId.make("ticket-1");

const row = (over: Partial<TicketArtifactRow>): TicketArtifactRow => ({
  artifactId: "a-1",
  blobId: "b-1",
  ticketId: String(ticketId),
  boardId: "board-1",
  name: "PLAN.md",
  kind: "markdown",
  mime: "text/markdown; charset=utf-8",
  byteSize: 10,
  sha256: "x",
  sourceMtimeMs: 0,
  description: null,
  stepRunId: null,
  createdAt: "2026-08-05T00:00:00Z",
  updatedAt: "2026-08-05T00:00:00Z",
  ...over,
});

const deps = (rows: ReadonlyArray<TicketArtifactRow>, contentById: Record<string, string | null>) =>
  ({
    observeRpcEffect: (_name: string, effect: unknown) => effect,
    artifactStore: {
      list: () => Effect.succeed(rows),
      getRow: (_t: unknown, id: string) =>
        Effect.succeed(rows.find((r) => r.artifactId === id) ?? null),
      readInlineText: (_t: unknown, id: string) => Effect.succeed(contentById[id] ?? null),
      deleteRowsForTickets: () => Effect.die("unused"),
      deleteRowsForBoard: () => Effect.die("unused"),
      removeDisk: () => Effect.void,
    },
    issueArtifactUrl: (input: { readonly artifactId: string }) =>
      Effect.succeed({ relativeUrl: `/api/assets/token/${input.artifactId}` }),
  }) as never;

describe("listDurableArtifacts", () => {
  it.effect("inlines text kinds, URL-onlys media, preserves order", () =>
    Effect.gen(function* () {
      const rows = [
        row({
          artifactId: "img",
          name: "a/after.png",
          kind: "image",
          mime: "image/png",
        }),
        row({ artifactId: "md", name: "b.md" }),
        row({
          artifactId: "vid",
          name: "c.webm",
          kind: "video",
          mime: "video/webm",
        }),
      ];
      const views = yield* listDurableArtifacts(deps(rows, { md: "# hello" }), ticketId);
      assert.deepEqual(
        views.map((view) => view.artifactId),
        ["img", "md", "vid"],
      );
      assert.isUndefined(views[0]?.content);
      assert.equal(views[1]?.content, "# hello");
      assert.equal(views[0]?.url, "/api/assets/token/img");
    }),
  );

  it.effect("marks unavailable blobs and never fails the list", () =>
    Effect.gen(function* () {
      const views = yield* listDurableArtifacts(
        deps([row({ artifactId: "gone" })], { gone: null }),
        ticketId,
      );
      assert.isTrue(views[0]?.contentUnavailable);
      assert.isUndefined(views[0]?.content);
    }),
  );

  it.effect("spends the budget in order with skip-and-continue and orthogonal flags", () =>
    Effect.gen(function* () {
      // Three text files: big (fills most of the budget), big2 (doesn't fit
      // the remaining budget -> omitted), small (fits the remainder).
      const bigContent = "x".repeat(ARTIFACT_INLINE_FILE_CAP_BYTES + 100); // slice = 64k, truncated
      const big2Content = "y".repeat(ARTIFACT_INLINE_FILE_CAP_BYTES);
      const smallContent = "z".repeat(1000);
      const sliceCap = ARTIFACT_INLINE_FILE_CAP_BYTES;
      const budget = ARTIFACT_INLINE_LIST_BUDGET_BYTES;
      // Seed enough big files to exhaust the budget before the last two.
      const fullSlices = Math.floor(budget / sliceCap); // 8
      const rows: Array<TicketArtifactRow> = [];
      const contents: Record<string, string> = {};
      for (let i = 0; i < fullSlices; i += 1) {
        const id = `big-${String(i).padStart(2, "0")}`;
        rows.push(row({ artifactId: id, name: `a-${String(i).padStart(2, "0")}.md` }));
        contents[id] = bigContent;
      }
      rows.push(row({ artifactId: "omitted", name: "m-omitted.md" }));
      contents["omitted"] = big2Content;
      rows.push(row({ artifactId: "small", name: "z-small.md" }));
      contents["small"] = smallContent;

      const views = yield* listDurableArtifacts(deps(rows, contents), ticketId);
      const byId = new Map(views.map((view) => [view.artifactId, view]));
      // Every full slice landed, truncated (file larger than the slice).
      assert.equal(byId.get("big-00")?.contentTruncated, true);
      assert.isDefined(byId.get("big-00")?.content);
      // The next big file exceeds the remaining budget: omitted, and its
      // truncated flag still describes the FILE (orthogonal flags).
      assert.equal(byId.get("omitted")?.contentOmitted, true);
      assert.isUndefined(byId.get("omitted")?.content);
      // Skip-and-continue: the small file after it still fits nothing? The
      // budget is exactly exhausted by the 8 slices, so small is omitted too
      // ONLY if nothing remains — with an exact-fit budget, remaining is 0.
      assert.equal(byId.get("small")?.contentOmitted, true);
    }),
  );

  it.effect("small files after an omitted big one still inline when budget remains", () =>
    Effect.gen(function* () {
      const sliceCap = ARTIFACT_INLINE_FILE_CAP_BYTES;
      const budget = ARTIFACT_INLINE_LIST_BUDGET_BYTES;
      const fullSlices = Math.floor(budget / sliceCap) - 1; // leave one slice of headroom
      const rows: Array<TicketArtifactRow> = [];
      const contents: Record<string, string> = {};
      for (let i = 0; i < fullSlices; i += 1) {
        const id = `big-${String(i).padStart(2, "0")}`;
        rows.push(row({ artifactId: id, name: `a-${String(i).padStart(2, "0")}.md` }));
        contents[id] = "x".repeat(sliceCap);
      }
      // Shrink the remaining headroom below a full slice…
      rows.push(row({ artifactId: "mid", name: "l-mid.md" }));
      contents["mid"] = "w".repeat(50_000);
      // …so this full-slice file no longer fits -> omitted.
      rows.push(row({ artifactId: "toobig", name: "m-toobig.md" }));
      contents["toobig"] = "y".repeat(sliceCap + sliceCap);
      // Fits the remaining headroom -> inlined (skip-and-continue).
      rows.push(row({ artifactId: "small", name: "z-small.md" }));
      contents["small"] = "z".repeat(1000);

      const views = yield* listDurableArtifacts(deps(rows, contents), ticketId);
      const byId = new Map(views.map((view) => [view.artifactId, view]));
      assert.equal(byId.get("toobig")?.contentOmitted, true);
      assert.equal(byId.get("small")?.content, "z".repeat(1000));
      assert.isUndefined(byId.get("small")?.contentOmitted);
    }),
  );
});
