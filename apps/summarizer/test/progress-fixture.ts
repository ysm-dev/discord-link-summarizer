import { it as test } from "@effect/vitest";
import { Effect, Scope } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProgressStore } from "../src/progress-store.ts";
export { expect } from "@effect/vitest";

export const temporaryDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "summarizer-progress-"))),
  (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
);
const storedTest = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, ProgressStore | Scope.Scope>,
) =>
  test.effect(name, () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      return yield* Effect.gen(function* () {
        yield* (yield* ProgressStore).owner("bot");
        return yield* body();
      }).pipe(Effect.provide(ProgressStore.layer(join(directory, "progress.sqlite"), false)));
    }),
  );
export const it = { effect: storedTest };
