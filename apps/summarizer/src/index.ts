import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun";
import { homedir } from "node:os";
import { Effect } from "effect";
import { invoke } from "./invocation.ts";

BunRuntime.runMain(
  invoke(process.argv.slice(2), process.env, homedir()).pipe(
    Effect.flatMap((code) =>
      Effect.sync(() => {
        process.exitCode = code;
      }),
    ),
    Effect.provide([BunServices.layer, BunHttpClient.layer]),
  ),
);
