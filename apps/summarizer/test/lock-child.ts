import { Effect } from "effect";
import { withMachineLock } from "../src/machine-lock.ts";

await Effect.runPromise(
  withMachineLock(
    Effect.gen(function* () {
      process.stdout.write("HELD\n");
      return yield* Effect.never;
    }),
    process.argv[2],
  ),
);
