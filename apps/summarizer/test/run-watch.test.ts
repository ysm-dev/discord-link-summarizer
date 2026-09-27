import { Clock, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { expect, it } from "./progress-fixture.ts";
import { at, captureLogs, config, setup, waitFor } from "./run-fixture.ts";

const short = config + "run_budget: 16 seconds\n";

it.effect("watch polls every five seconds and reuses one server without repeating recovery", () =>
  Effect.gen(function* () {
    const { discord, invoke, getStarted } = yield* setup({}, short);
    const { logs, layer } = captureLogs();
    const fiber = yield* Effect.forkChild(invoke(false, true).pipe(Effect.provide(layer)));
    yield* waitFor(() => logs.some((line) => line.includes("Watching for new Link Posts")));
    expect(getStarted()).toBe(1);
    expect(
      discord.requests.filter(({ path }) => path.startsWith("/channels/10/messages?")),
    ).toHaveLength(2);
    const startupRequests = discord.requests.length;
    const first = discord.addMessage("10", "https://example.test/first", at + 1);
    yield* TestClock.adjust(4_999);
    expect(discord.requests).toHaveLength(startupRequests);
    expect(discord.threads.has(first.id)).toBe(false);
    yield* TestClock.adjust(1);
    yield* waitFor(() => discord.threads.get(first.id)?.thread_metadata.archived === true);
    expect(discord.threads.get(first.id)?.thread_metadata.archived).toBe(true);
    const second = discord.addMessage("10", "https://example.test/second", at + 5_001);
    yield* TestClock.adjust("5 seconds");
    yield* waitFor(() => discord.threads.get(second.id)?.thread_metadata.archived === true);
    expect(discord.threads.get(second.id)?.thread_metadata.archived).toBe(true);
    yield* TestClock.adjust("6 seconds");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(getStarted()).toBe(1);
    expect(discord.requests.filter(({ path }) => path.includes("/threads/archived/"))).toHaveLength(
      1,
    );
    expect(discord.requests.filter(({ path }) => path.includes("/threads/active"))).toHaveLength(1);
    for (const source of [first, second])
      expect(
        discord.messages.get(source.id)?.filter((message) => message.content === "안녕하세요"),
      ).toHaveLength(1);
  }),
);

it.effect("watch discovers and summarizes a new post while an older Attempt is running", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode, getStarted } = yield* setup({ holdTerminal: true }, short);
    const first = discord.addMessage("10", "https://example.test/slow", at - 100);
    const fiber = yield* Effect.forkChild(invoke(false, true));
    yield* waitFor(() => openCode.requests.includes("POST /api/session/ses_one/command"));
    expect(discord.messages.get(first.id)?.[0]?.content).toBe("⏳ 요약 중 (1/3)");
    const second = discord.addMessage("10", "https://example.test/new", at + 1);
    yield* TestClock.adjust("5 seconds");
    yield* waitFor(
      () =>
        openCode.requests.filter((request) => request === "POST /api/session/ses_one/command")
          .length === 2,
    );
    openCode.finish();
    yield* waitFor(() => discord.threads.get(second.id)?.thread_metadata.archived === true);
    expect(discord.threads.get(second.id)?.thread_metadata.archived).toBe(true);
    expect(discord.messages.get(first.id)?.[0]?.content).toBe("⏳ 요약 중 (1/3)");
    expect(getStarted()).toBe(1);
    yield* Fiber.interrupt(fiber);
    expect(discord.messages.get(first.id)?.[0]?.content).toContain("⏸️ 요약 중단");
    expect(openCode.requests).toContain("POST /api/session/ses_one/interrupt?resume=false");
  }),
);

it.effect(
  "watch fills a freed slot immediately and never exceeds concurrency or duplicates active work",
  () =>
    Effect.gen(function* () {
      const { discord, invoke, openCode } = yield* setup(
        { holdTerminal: true },
        short + "concurrency: 2\n",
      );
      const posts = Array.from({ length: 3 }, (_, index) =>
        discord.addMessage("10", `https://example.test/${index}`, at - 3 + index),
      );
      const fiber = yield* Effect.forkChild(invoke(false, true));
      yield* waitFor(
        () =>
          openCode.requests.filter((request) => request === "POST /api/session/ses_one/command")
            .length === 2,
      );
      expect(discord.threads.size).toBe(2);
      yield* TestClock.adjust("5 seconds");
      expect(discord.threads.size).toBe(2);
      expect(openCode.sessionsCreated).toBe(2);
      openCode.finish();
      yield* waitFor(
        () =>
          openCode.requests.filter((request) => request === "POST /api/session/ses_one/command")
            .length === 3,
      );
      openCode.finish();
      yield* waitFor(() => discord.threads.get(posts[2]!.id)?.thread_metadata.archived === true);
      expect(yield* Clock.currentTimeMillis).toBe(at + 5_000);
      expect(openCode.sessionsCreated).toBe(3);
      expect(discord.messages.get(posts[0]!.id)?.[0]?.content).toBe("⏳ 요약 중 (1/3)");
      yield* Fiber.interrupt(fiber);
    }),
);

it.effect("watch drains an active Attempt at the budget without admitting later posts", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup({ holdTerminal: true }, short);
    const first = discord.addMessage("10", "https://example.test/drain", at - 100);
    const fiber = yield* Effect.forkChild(invoke(false, true));
    yield* waitFor(() => openCode.requests.includes("POST /api/session/ses_one/command"));
    yield* TestClock.adjust("16 seconds");
    expect(discord.messages.get(first.id)?.[0]?.content).toBe("⏳ 요약 중 (1/3)");
    const requests = discord.requests.length;
    const later = discord.addMessage("10", "https://example.test/later", at + 16_000);
    yield* TestClock.adjust("5 seconds");
    expect(discord.requests).toHaveLength(requests);
    openCode.finish();
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(discord.threads.get(first.id)?.thread_metadata.archived).toBe(true);
    expect(discord.threads.has(later.id)).toBe(false);
  }),
);

it.effect(
  "watch stops on a polling outage and interrupts in-flight work for the next crnd Run",
  () =>
    Effect.gen(function* () {
      const { discord, invoke, openCode } = yield* setup({ holdTerminal: true }, short);
      const source = discord.addMessage("10", "https://example.test/outage", at - 100);
      const fiber = yield* Effect.forkChild(invoke(false, true).pipe(Effect.result));
      yield* waitFor(() => openCode.requests.includes("POST /api/session/ses_one/command"));
      discord.faults.push({ method: "GET", path: "/channels/10/messages?", status: 503 });
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "Failure",
        failure: { kind: "outage" },
      });
      expect(discord.messages.get(source.id)?.[0]?.content).toContain("⏸️ 요약 중단");
    }),
);
