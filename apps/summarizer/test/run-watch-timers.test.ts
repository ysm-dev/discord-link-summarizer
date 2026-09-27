import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { ProgressStore } from "../src/progress-store.ts";
import { expect, it } from "./progress-fixture.ts";
import { at, config, setup, waitFor, waitForFault } from "./run-fixture.ts";

const countedWatch = (yaml = config + "run_budget: 20 seconds\n") =>
  Effect.gen(function* () {
    const fixture = yield* setup({ holdTerminal: true }, yaml);
    const store = yield* ProgressStore;
    let reads = 0;
    const counted = {
      ...store,
      loadJournal: (...args: Parameters<typeof store.loadJournal>) => {
        reads++;
        return store.loadJournal(...args);
      },
    };
    return {
      ...fixture,
      getReads: () => reads,
      start: () =>
        Effect.forkChild(
          fixture.invoke(false, true).pipe(Effect.provideService(ProgressStore, counted)),
        ),
    };
  });

// Give an accidentally zero-delay scheduler time to expose a journal busy loop.
const yieldTurns = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow);

for (const refused of [false, true])
  it.effect(
    `completed work leaves no expired wakeup spinning on the journal (claim refused: ${refused})`,
    () =>
      Effect.gen(function* () {
        const { discord, openCode, start, getReads } = yield* countedWatch();
        const source = discord.addMessage("10", "https://example.test/settled-timer", at - 1);
        if (refused)
          discord.faults.push({
            method: "POST",
            path: `/channels/10/messages/${source.id}/threads`,
            status: 400,
            code: 160004,
          });
        const fiber = yield* start();
        if (refused) {
          yield* waitForFault(discord);
          yield* TestClock.adjust("5 seconds");
        }
        yield* waitFor(() => openCode.requests.includes("POST /api/session/ses_one/command"));
        openCode.finish();
        yield* waitFor(() => discord.threads.get(source.id)?.thread_metadata.archived === true);
        yield* TestClock.adjust("1 second");
        const before = getReads();
        yield* TestClock.adjust("5 seconds");
        yield* yieldTurns;
        expect(getReads() - before).toBeLessThanOrEqual(4);
        expect(openCode.sessionsCreated).toBe(1);
        yield* Fiber.interrupt(fiber);
      }),
  );

it.effect("an overdue retry waits for a full worker pool without spinning", () =>
  Effect.gen(function* () {
    const { discord, openCode, start, getReads } = yield* countedWatch(
      config + "run_budget: 12 seconds\nretry_waits: [7 seconds]\nconcurrency: 1\n",
    );
    const retry = discord.addMessage("10", "https://example.test/retry-full", at - 2);
    discord.addThread("10", retry.id, "⏳ Retry");
    discord.addMessage(retry.id, "⚠️ 요약 실패 (1/2): failure", at, "bot");
    const slow = discord.addMessage("10", "https://example.test/full", at - 1);
    const fiber = yield* start();
    yield* waitFor(() => openCode.requests.includes("POST /api/session/ses_one/command"));
    const before = getReads();
    yield* TestClock.adjust("7 seconds");
    yield* yieldTurns;
    expect(getReads() - before).toBeLessThanOrEqual(4);
    expect(openCode.sessionsCreated).toBe(1);
    openCode.finish();
    yield* waitFor(
      () =>
        openCode.requests.filter((request) => request === "POST /api/session/ses_one/command")
          .length === 2,
    );
    expect(discord.threads.get(slow.id)?.thread_metadata.archived).toBe(true);
    openCode.finish();
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(discord.threads.get(retry.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("watch wakes at the earliest of multiple retry deadlines between polls", () =>
  Effect.gen(function* () {
    const { discord, openCode, start } = yield* countedWatch(
      config + "run_budget: 12 seconds\nretry_waits: [7 seconds, 9 seconds]\n",
    );
    const first = discord.addMessage("10", "https://example.test/earliest", at - 2);
    const second = discord.addMessage("10", "https://example.test/later-retry", at - 1);
    for (const source of [first, second]) {
      discord.addThread("10", source.id, "⏳ Retry");
      discord.addMessage(source.id, "⚠️ 요약 실패 (1/3): failure", at, "bot");
    }
    discord.addMessage(second.id, "⚠️ 요약 실패 (2/3): failure", at, "bot");
    const fiber = yield* start();
    yield* TestClock.adjust("6999 millis");
    expect(openCode.sessionsCreated).toBe(0);
    yield* TestClock.adjust(1);
    yield* waitFor(() => openCode.requests.includes("POST /api/session/ses_one/command"));
    expect(
      discord.messages.get(first.id)?.some((message) => message.content === "⏳ 요약 중 (2/3)"),
    ).toBe(true);
    expect(discord.messages.get(second.id)).toHaveLength(2);
    openCode.finish();
    yield* TestClock.adjust("2 seconds");
    yield* waitFor(
      () =>
        openCode.requests.filter((request) => request === "POST /api/session/ses_one/command")
          .length === 2,
    );
    openCode.finish();
    yield* TestClock.adjust("3 seconds");
    expect(yield* Fiber.join(fiber)).toBe(0);
    for (const source of [first, second])
      expect(discord.threads.get(source.id)?.thread_metadata.archived).toBe(true);
  }),
);
