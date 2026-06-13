import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { MigrationsLive } from "../../persistence/Migrations.ts";
import { sanitizeExternalEventPayload } from "../externalEvent.ts";
import { WorkflowWebhook } from "../Services/WorkflowWebhook.ts";
import { WorkflowWebhookLive } from "./WorkflowWebhook.ts";

const layer = it.layer(
  WorkflowWebhookLive.pipe(
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("WorkflowWebhook", (it) => {
  it.effect("issues a token once, reveals it only on create/rotate, and verifies it", () =>
    Effect.gen(function* () {
      const webhook = yield* WorkflowWebhook;

      const created = yield* webhook.getConfig("board-hook" as never, false);
      assert.equal(created.hasToken, true);
      assert.isString(created.token);
      assert.equal(created.token?.length, 64);
      assert.equal(created.tokenPrefix, created.token?.slice(0, 8));
      assert.equal(created.path, "/hooks/workflow/board-hook");

      // Subsequent reads never reveal the secret again.
      const read = yield* webhook.getConfig("board-hook" as never, false);
      assert.equal(read.hasToken, true);
      assert.equal(read.token, undefined);
      assert.equal(read.tokenPrefix, created.tokenPrefix);

      assert.isTrue(yield* webhook.verifyToken("board-hook" as never, created.token ?? ""));
      assert.isFalse(yield* webhook.verifyToken("board-hook" as never, "wrong"));
      assert.isFalse(yield* webhook.verifyToken("board-unknown" as never, created.token ?? ""));

      // Rotation invalidates the old token.
      const rotated = yield* webhook.getConfig("board-hook" as never, true);
      assert.isString(rotated.token);
      assert.notEqual(rotated.token, created.token);
      assert.isFalse(yield* webhook.verifyToken("board-hook" as never, created.token ?? ""));
      assert.isTrue(yield* webhook.verifyToken("board-hook" as never, rotated.token ?? ""));
    }),
  );

  it.effect("dedupes deliveries per board", () =>
    Effect.gen(function* () {
      const webhook = yield* WorkflowWebhook;

      assert.isFalse(yield* webhook.recordDelivery("board-a" as never, "delivery-1"));
      assert.isTrue(yield* webhook.recordDelivery("board-a" as never, "delivery-1"));
      // Different board, same delivery id: independent.
      assert.isFalse(yield* webhook.recordDelivery("board-b" as never, "delivery-1"));
    }),
  );

  it.effect("releaseDelivery lets the sender's retry be ingested after a failed ingest", () =>
    Effect.gen(function* () {
      const webhook = yield* WorkflowWebhook;

      // Delivery recorded, then ingest fails: releasing must make the
      // identical retry look fresh (not "duplicate") so the event is not lost.
      assert.isFalse(yield* webhook.recordDelivery("board-retry" as never, "delivery-1"));
      yield* webhook.releaseDelivery("board-retry" as never, "delivery-1");
      assert.isFalse(yield* webhook.recordDelivery("board-retry" as never, "delivery-1"));
      // Once the retry succeeds, dedupe is back in force.
      assert.isTrue(yield* webhook.recordDelivery("board-retry" as never, "delivery-1"));

      // Releasing only forgets the exact (board, delivery) pair.
      assert.isFalse(yield* webhook.recordDelivery("board-retry" as never, "delivery-2"));
      assert.isFalse(yield* webhook.recordDelivery("board-other" as never, "delivery-1"));
      yield* webhook.releaseDelivery("board-retry" as never, "delivery-1");
      assert.isTrue(yield* webhook.recordDelivery("board-retry" as never, "delivery-2"));
      assert.isTrue(yield* webhook.recordDelivery("board-other" as never, "delivery-1"));
    }),
  );

  it.effect("deleteForBoard revokes the token and forgets deliveries", () =>
    Effect.gen(function* () {
      const webhook = yield* WorkflowWebhook;

      const created = yield* webhook.getConfig("board-gone" as never, false);
      assert.isFalse(yield* webhook.recordDelivery("board-gone" as never, "delivery-1"));

      yield* webhook.deleteForBoard("board-gone" as never);

      // A recreated board with the same id must not inherit the old token.
      assert.isFalse(yield* webhook.verifyToken("board-gone" as never, created.token ?? ""));
      assert.isFalse(yield* webhook.recordDelivery("board-gone" as never, "delivery-1"));
    }),
  );
});

describe("sanitizeExternalEventPayload", () => {
  it("bounds depth, breadth, and string length while keeping valid JSON", () => {
    const deep: Record<string, unknown> = { level: 0 };
    let cursor = deep;
    for (let depth = 1; depth < 10; depth += 1) {
      const next: Record<string, unknown> = { level: depth };
      cursor["child"] = next;
      cursor = next;
    }
    const sanitized = sanitizeExternalEventPayload({
      deep,
      long: "x".repeat(5_000),
      many: Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`k${index}`, index])),
      list: Array.from({ length: 300 }, (_, index) => index),
      fn: () => "never",
    }) as Record<string, unknown>;

    assert.equal((sanitized["long"] as string).length, 2_000);
    assert.isAtMost(Object.keys(sanitized["many"] as object).length, 100);
    assert.equal((sanitized["list"] as unknown[]).length, 100);
    assert.isUndefined(sanitized["fn"]);
    // Depth capped — walking 6 levels in ends before level 9.
    let walker = sanitized["deep"] as Record<string, unknown> | undefined;
    let levels = 0;
    while (walker !== undefined && typeof walker === "object" && "child" in walker) {
      walker = walker["child"] as Record<string, unknown> | undefined;
      levels += 1;
    }
    assert.isAtMost(levels, 6);
    // Round-trips as JSON.
    assert.doesNotThrow(() => JSON.stringify(sanitized));
  });

  it("drops prototype-polluting keys", () => {
    const sanitized = sanitizeExternalEventPayload(
      JSON.parse('{"__proto__":{"admin":true},"constructor":1,"prototype":2,"ok":3}'),
    ) as Record<string, unknown>;
    assert.deepEqual(sanitized, { ok: 3 });
    assert.isUndefined((sanitized as { admin?: unknown }).admin);
    assert.isUndefined(Object.getPrototypeOf(sanitized)?.admin);
  });
});
