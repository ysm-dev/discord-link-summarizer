import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { main } from "./main.ts";

BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
