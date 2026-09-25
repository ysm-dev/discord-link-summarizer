import { Effect, FileSystem } from "effect";
import { join } from "node:path";
import { decodeCli, decodeConfig, decodeEnvironment } from "./config.ts";
import { withMachineLock } from "./machine-lock.ts";
import { run } from "./run.ts";

/** The lock function is the platform boundary; production retains its FD through all Run cleanup. */
export const invoke = (
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  home: string,
  lock: typeof withMachineLock = withMachineLock,
) =>
  Effect.gen(function* () {
    const cli = yield* decodeCli(args, home);
    const secrets = yield* decodeEnvironment(environment);
    const fs = yield* FileSystem.FileSystem;
    const settings = yield* decodeConfig(yield* fs.readFileString(cli.configPath), home);
    const result = yield* lock(
      run(
        settings,
        cli.dryRun,
        secrets.token,
        secrets.opencodeDb,
        Object.fromEntries(
          Object.entries(environment).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      ),
      join(home, ".local/state/discord-link-summarizer/run.lock"),
    );
    if (result === "already-running")
      yield* Effect.logInfo("Another Run holds the machine lock; skipping tick");
    return result === "already-running" ? 0 : result;
  }).pipe(Effect.catch((error) => Effect.logError(String(error)).pipe(Effect.as(1))));
