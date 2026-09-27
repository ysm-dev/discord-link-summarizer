import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { measured } from "../src/performance.ts";
import { Discord, DiscordLive } from "../src/discord-client.ts";
import { captureLogs } from "./run-fixture.ts";
import { FakeDiscord } from "./discord-fake.ts";

it.effect(
  "reports elapsed phase time and preserves successful, failed and interrupted results",
  () =>
    Effect.gen(function* () {
      const { logs, layer } = captureLogs();
      const task = measured("example", Effect.sleep(125).pipe(Effect.as(42)));
      const fiber = yield* Effect.forkChild(task.pipe(Effect.provide(layer)));
      yield* TestClock.adjust(125);
      expect(yield* Fiber.join(fiber)).toBe(42);
      expect(logs).toEqual(["performance phase=example elapsed_ms=125"]);
      expect(
        yield* Effect.flip(measured("failed", Effect.fail("original")).pipe(Effect.provide(layer))),
      ).toBe("original");
      const interrupted = yield* Effect.forkChild(
        measured("interrupted", Effect.never).pipe(Effect.provide(layer)),
      );
      yield* TestClock.adjust(10);
      yield* Fiber.interrupt(interrupted);
      expect(logs.slice(1)).toEqual([
        "performance phase=failed elapsed_ms=0",
        "performance phase=interrupted elapsed_ms=10",
      ]);
    }),
);

it.effect("reports actual requests and lane/rate-limit waits once the Discord scope closes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1000);
    const fake = new FakeDiscord();
    fake.addChannel("10");
    fake.faults.push({
      method: "GET",
      path: "/channels/10",
      pause: 100,
      status: 429,
      body: { retry_after: 0.2 },
    });
    const { logs, layer } = captureLogs();
    const program = Effect.gen(function* () {
      const api = yield* Discord;
      return yield* Effect.all([api.getChannel("10"), api.getChannel("10")], { concurrency: 2 });
    }).pipe(
      Effect.provide(DiscordLive(Redacted.make("secret")).pipe(Layer.provide([fake.layer, layer]))),
    );
    const fiber = yield* Effect.forkChild(program);
    yield* TestClock.adjust(300);
    expect((yield* Fiber.join(fiber)).map((channel) => channel.id)).toEqual(["10", "10"]);
    expect(logs).toEqual(["performance discord_requests=3 discord_wait_ms=500"]);
  }),
);

for (const [status, kind] of [
  [200, "invalid-response"],
  [403, "forbidden"],
  [429, "outage"],
] as const)
  it.effect(`bounds a stalled ${status} response body without replaying writes`, () =>
    Effect.gen(function* () {
      let requests = 0;
      const client = HttpClient.make((request) => {
        requests++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(new ReadableStream(), { status })),
        );
      });
      const task = Discord.pipe(
        Effect.flatMap((api) => api.createMessage("10", "summary")),
        Effect.provide(
          DiscordLive(Redacted.make("secret")).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          ),
        ),
      );
      const fiber = yield* Effect.forkChild(task.pipe(Effect.result));
      yield* TestClock.adjust("14999 millis");
      expect(requests).toBe(1);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 millis");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "Failure",
        failure: { kind },
      });
      expect(requests).toBe(1);
    }),
  );
