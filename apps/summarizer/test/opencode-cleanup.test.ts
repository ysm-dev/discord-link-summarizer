import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { OpenCode } from "../src/opencode-client.ts";
import { attempt, fakeOpenCode, session, withFake } from "./opencode-fake.ts";
import { captureLogs, waitFor } from "./run-fixture.ts";

const warning = "Cannot delete OpenCode session ses_one; cleanup will retry next Run";

it.effect("preserves the attempt outcome when deletion fails and retries in the next sweep", () =>
  Effect.gen(function* () {
    for (const [outcome, expected] of [
      ["succeeded", { type: "succeeded", text: "안녕하세요" }],
      ["failed", { type: "failed", reason: "execution-failed" }],
      ["interrupted", { type: "interrupted" }],
    ] as const) {
      const fake = fakeOpenCode({ deleteFailures: 1, outcome });
      const { logs, layer } = captureLogs();
      const result = yield* withFake(
        Effect.gen(function* () {
          return yield* (yield* OpenCode).run(attempt, 1000);
        }),
        fake,
      ).pipe(Effect.provide(layer));
      expect(result).toEqual(expected);
      expect(fake.retained.has("ses_one")).toBe(true);
      expect(logs).toEqual([warning]);

      yield* withFake(
        Effect.gen(function* () {
          const client = yield* OpenCode;
          expect(yield* client.sweep(0)).toBe(1);
          expect(yield* client.sweep(0)).toBe(0);
        }),
        fake,
      );
      expect(fake.retained.size).toBe(0);
    }
  }),
);

for (const [label, config, removed, warnings] of [
  [
    "404 without warnings in finalization and sweep",
    { deleteMissing: true, pages: [[session("ses_old")]] },
    1,
    [],
  ],
  [
    "a lost DELETE reply with a warning and no session left to sweep",
    { deleteLostReply: true },
    0,
    [warning],
  ],
] as const)
  it.effect(`preserves success on ${label}`, () =>
    Effect.gen(function* () {
      const fake = fakeOpenCode(config);
      const { logs, layer } = captureLogs();
      yield* withFake(
        Effect.gen(function* () {
          const client = yield* OpenCode;
          expect(yield* client.run(attempt, 1000)).toEqual({
            type: "succeeded",
            text: "안녕하세요",
          });
          expect(yield* client.sweep(500)).toBe(removed);
          expect(yield* client.sweep(500)).toBe(0);
        }),
        fake,
      ).pipe(Effect.provide(layer));
      expect(fake.retained.size).toBe(0);
      expect(logs).toEqual(warnings);
    }),
  );

it.effect("bounds a hanging DELETE to 15 seconds without changing success", () =>
  Effect.gen(function* () {
    const fake = fakeOpenCode({ hangDelete: true });
    const { logs, layer } = captureLogs();
    const fiber = yield* Effect.forkChild(
      withFake(
        Effect.gen(function* () {
          return yield* (yield* OpenCode).run(attempt, 1000);
        }),
        fake,
      ).pipe(Effect.provide(layer)),
    );
    yield* waitFor(() => fake.requests.includes("DELETE /api/session/ses_one"));
    yield* TestClock.adjust("14999 millis");
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust("1 millis");
    expect(yield* Fiber.join(fiber)).toEqual({ type: "succeeded", text: "안녕하세요" });
    expect(fake.retained.has("ses_one")).toBe(true);
    expect(logs).toEqual([warning]);
  }),
);

it.effect(
  "deletes a delayed successful creation even when its parent cancels before the reply",
  () =>
    Effect.gen(function* () {
      const fake = fakeOpenCode({ createDelay: 1000 });
      const fiber = yield* Effect.forkChild(
        withFake(
          Effect.gen(function* () {
            return yield* (yield* OpenCode).run(attempt, 1000);
          }),
          fake,
        ),
      );
      yield* waitFor(() => fake.requests.includes("POST /api/session"));
      const cancellation = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(cancellation);
      expect(fake.requests).toContain("DELETE /api/session/ses_one");
      expect(fake.requests).not.toContain("POST /api/session/ses_one/command");
      expect(fake.retained.size).toBe(0);
    }),
);
