import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

interface KeyedSemaphoreEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly references: number;
}

export interface KeyedSemaphore {
  readonly withPermit: <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly activeKeyCount: Effect.Effect<number>;
}

export const makeKeyedSemaphore = Effect.gen(function* () {
  const entries = yield* SynchronizedRef.make<ReadonlyMap<string, KeyedSemaphoreEntry>>(new Map());

  const acquire = (key: string) =>
    SynchronizedRef.modifyEffect(entries, (current) => {
      const existing = current.get(key);
      if (existing !== undefined) {
        const next = new Map(current);
        next.set(key, { ...existing, references: existing.references + 1 });
        return Effect.succeed([existing.semaphore, next] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(key, { semaphore, references: 1 });
          return [semaphore, next] as const;
        }),
      );
    });

  const release = (key: string, semaphore: Semaphore.Semaphore) =>
    SynchronizedRef.update(entries, (current) => {
      const existing = current.get(key);
      if (existing === undefined || existing.semaphore !== semaphore) return current;
      const next = new Map(current);
      if (existing.references === 1) {
        next.delete(key);
      } else {
        next.set(key, { ...existing, references: existing.references - 1 });
      }
      return next;
    });

  const withPermit: KeyedSemaphore["withPermit"] = (key, effect) =>
    Effect.acquireUseRelease(
      acquire(key),
      (semaphore) => semaphore.withPermits(1)(effect),
      (semaphore) => release(key, semaphore),
    );

  return {
    withPermit,
    activeKeyCount: SynchronizedRef.get(entries).pipe(Effect.map((current) => current.size)),
  } satisfies KeyedSemaphore;
});
