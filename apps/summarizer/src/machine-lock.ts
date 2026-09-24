import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Data, Effect } from "effect";

export class MachineLockError extends Data.TaggedError("MachineLockError")<{
  readonly message: string;
}> {}

export const machineLockPath = () =>
  join(homedir(), ".local/state/discord-link-summarizer/run.lock");

/** Bun retains FD 3's underlying open file description after lockf exits. Scope includes Run cleanup. */
export const withMachineLock = <A, E, R>(
  run: Effect.Effect<A, E, R>,
  path = machineLockPath(),
): Effect.Effect<A | "already-running", E | MachineLockError, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fd = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            return openSync(
              path,
              constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
              0o600,
            );
          },
          catch: () => new MachineLockError({ message: "Cannot open machine lock" }),
        }),
        (descriptor) => Effect.sync(() => closeSync(descriptor)),
      );
      const code = yield* Effect.tryPromise({
        try: async () => {
          const child = Bun.spawn(["/usr/bin/lockf", "-t", "0", "3"], {
            stdio: ["ignore", "ignore", "ignore", fd],
          });
          return await child.exited;
        },
        catch: () => new MachineLockError({ message: "Cannot acquire machine lock" }),
      });
      if (code === 75) return "already-running" as const;
      if (code !== 0)
        return yield* new MachineLockError({ message: `Machine lock helper exited ${code}` });
      return yield* run;
    }),
  );
