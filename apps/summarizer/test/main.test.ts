import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { main } from "../src/main.ts";

it.effect("reports that the Run is not integrated", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(main);
    expect(error).toBe("Summarizer Run is not integrated yet.");
  }),
);
