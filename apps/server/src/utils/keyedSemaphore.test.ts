import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeKeyedSemaphore } from "./keyedSemaphore.ts";

it.effect("serializes one key and removes it after the last waiter leaves", () =>
  Effect.gen(function* () {
    const locks = yield* makeKeyedSemaphore;
    const firstEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();

    const first = yield* Effect.forkChild(
      locks.withPermit(
        "thread-1",
        Deferred.succeed(firstEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
        ),
      ),
      { startImmediately: true },
    );
    yield* Deferred.await(firstEntered);

    const second = yield* Effect.forkChild(
      locks.withPermit("thread-1", Deferred.succeed(secondEntered, undefined)),
      { startImmediately: true },
    );
    yield* Effect.yieldNow;

    assert.equal(yield* Deferred.isDone(secondEntered), false);
    assert.equal(yield* locks.activeKeyCount, 1);

    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);

    assert.equal(yield* locks.activeKeyCount, 0);
  }),
);

it.effect("removes a key when the protected effect fails", () =>
  Effect.gen(function* () {
    const locks = yield* makeKeyedSemaphore;
    yield* Effect.exit(locks.withPermit("thread-failure", Effect.fail("expected")));
    assert.equal(yield* locks.activeKeyCount, 0);
  }),
);
