import { Clock, Effect } from "effect";

/** Wall time includes queueing and interruption; labels never contain URLs or credentials. */
export const measured = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    return yield* effect.pipe(
      Effect.onExit(() =>
        Effect.gen(function* () {
          const elapsed = (yield* Clock.currentTimeMillis) - started;
          yield* Effect.logInfo(`performance phase=${phase} elapsed_ms=${elapsed}`);
        }),
      ),
    );
  });
