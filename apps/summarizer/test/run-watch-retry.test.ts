import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { readJournal } from "../src/channel-record.ts";
import { expect, it } from "./progress-fixture.ts";
import { at, captureLogs, config, setup, waitFor } from "./run-fixture.ts";

const short = config + "run_budget: 16 seconds\nretry_waits: [12 seconds, 1 hour]\n";

it.effect("a waiting retry does not block new discovery or trigger repeated thread reads", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup({}, short);
    const old = discord.addMessage("10", "https://example.test/retry", at - 100);
    discord.addThread("10", old.id, "⏳ Retry");
    discord.addMessage(old.id, "⚠️ 요약 실패 (1/3): failed", at, "bot");
    const { logs, layer } = captureLogs();
    const fiber = yield* Effect.forkChild(invoke(false, true).pipe(Effect.provide(layer)));
    yield* waitFor(() => logs.some((line) => line.includes("Watching for new Link Posts")));
    yield* TestClock.adjust("1 second");
    const reads = discord.requests.filter(({ path }) =>
      path.startsWith(`/channels/${old.id}`),
    ).length;
    const newer = discord.addMessage("10", "https://example.test/newer", at + 1_000);
    yield* TestClock.adjust("4 seconds");
    yield* waitFor(() => discord.threads.get(newer.id)?.thread_metadata.archived === true);
    expect(discord.threads.get(old.id)?.name).toBe("⏳ Retry");
    const journal = yield* readJournal("10");
    expect(journal?.record.high).toBe(newer.id);
    expect(BigInt(journal!.record.floor)).toBeLessThan(BigInt(old.id));
    yield* TestClock.adjust("6999 millis");
    expect(
      discord.requests.filter(({ path }) => path.startsWith(`/channels/${old.id}`)),
    ).toHaveLength(reads);
    expect(openCode.sessionsCreated).toBe(1);
    yield* TestClock.adjust(1);
    yield* waitFor(() => discord.threads.get(old.id)?.thread_metadata.archived === true);
    yield* TestClock.adjust("4 seconds");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(openCode.sessionsCreated).toBe(2);
    expect((yield* readJournal("10"))?.entries.size).toBe(0);
  }),
);

it.effect("a failed Attempt retries on its deadline within the same Run", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup(
      { holdTerminal: true, event: "failed", outcome: "failed", errorType: "content" },
      short,
    );
    const source = discord.addMessage("10", "https://example.test/failure", at - 1);
    const fiber = yield* Effect.forkChild(invoke(false, true));
    yield* waitFor(() => openCode.requests.includes("POST /api/session/ses_one/command"));
    const reads = discord.requests.filter(
      ({ method, path }) => method === "GET" && path.startsWith(`/channels/${source.id}`),
    ).length;
    yield* TestClock.adjust("3 seconds");
    openCode.finish();
    yield* waitFor(
      () =>
        discord.messages
          .get(source.id)
          ?.some((message) => message.content.startsWith("⚠️ 요약 실패 (1/3)")) === true,
    );
    yield* TestClock.adjust("11999 millis");
    expect(openCode.sessionsCreated).toBe(1);
    expect(
      discord.requests.filter(
        ({ method, path }) => method === "GET" && path.startsWith(`/channels/${source.id}`),
      ),
    ).toHaveLength(reads);
    yield* TestClock.adjust(1);
    yield* waitFor(
      () =>
        openCode.requests.filter((request) => request === "POST /api/session/ses_one/command")
          .length === 2,
    );
    openCode.finish();
    yield* waitFor(
      () =>
        discord.messages
          .get(source.id)
          ?.some((message) => message.content.startsWith("⚠️ 요약 실패 (2/3)")) === true,
    );
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(openCode.sessionsCreated).toBe(2);
  }),
);

it.effect("watch preserves every post in a multipage burst while an older link awaits retry", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup(
      {},
      config + '  - id: "20"\n    label: Second\nrun_budget: 10 seconds\nconcurrency: 1\n',
    );
    const old = discord.addMessage("10", "https://example.test/old", at - 100);
    discord.addThread("10", old.id, "⏳ Waiting");
    discord.addMessage(old.id, "⚠️ 요약 실패 (1/3): failed", at, "bot");
    const { logs, layer } = captureLogs();
    const fiber = yield* Effect.forkChild(invoke(false, true).pipe(Effect.provide(layer)));
    yield* waitFor(() => logs.some((line) => line.includes("Watching for new Link Posts")));
    const posts = Array.from({ length: 101 }, (_, index) =>
      discord.addMessage("10", `https://example.test/burst/${index}`, at + index + 1),
    );
    yield* TestClock.adjust("5 seconds");
    // Wait on the running program rather than advancing its admission budget while it processes the burst.
    for (const source of posts)
      yield* waitFor(() => discord.threads.get(source.id)?.thread_metadata.archived === true);
    expect(discord.threads.get(old.id)?.name).toBe("⏳ Waiting");
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(fiber)).toBe(0);
    const journal = yield* readJournal("10");
    expect(journal?.entries.has(old.id)).toBe(true);
    expect(journal?.record.high).toBe(posts.at(-1)?.id);
    expect(BigInt(journal!.record.floor)).toBeLessThan(BigInt(old.id));
    for (const source of posts)
      expect(
        discord.messages.get(source.id)?.filter((message) => message.content === "안녕하세요"),
      ).toHaveLength(1);
  }),
);

it.effect("watch exits on a provider outage instead of retrying it every five seconds", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup(
      { event: "failed", outcome: "failed", errorType: "provider.auth" },
      short + "concurrency: 1\n",
    );
    const old = discord.addMessage("10", "https://example.test/auth", at - 2);
    const later = discord.addMessage("10", "https://example.test/later", at - 1);
    const failure = yield* Effect.flip(invoke(false, true));
    expect(failure.message).toContain("provider.auth");
    expect(discord.messages.get(old.id)?.[0]?.content).toContain("⏸️ 요약 중단");
    expect(discord.threads.has(later.id)).toBe(false);
    expect(openCode.sessionsCreated).toBe(1);
  }),
);

it.effect("a new watching Run reconstructs its retry deadline from the failure note", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup(
      { event: "failed", outcome: "failed", errorType: "content" },
      short.replace("16 seconds", "10 seconds"),
    );
    const source = discord.addMessage("10", "https://example.test/restart", at - 1);
    const first = yield* Effect.forkChild(invoke(false, true));
    yield* waitFor(() => discord.messages.get(source.id)?.[0]?.content.startsWith("⚠️") === true);
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(first)).toBe(0);
    const second = yield* Effect.forkChild(invoke(false, true));
    yield* TestClock.adjust("1999 millis");
    expect(openCode.sessionsCreated).toBe(1);
    yield* TestClock.adjust(1);
    yield* waitFor(() => openCode.sessionsCreated === 2);
    yield* TestClock.adjust("8 seconds");
    expect(yield* Fiber.join(second)).toBe(0);
  }),
);

it.effect("watch leaves an orphaned live Attempt alone until its exact stale deadline", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup(
      {},
      short.replace("16 seconds", "124 seconds") + "summary_timeout: 1 second\n",
    );
    const source = discord.addMessage("10", "https://example.test/orphan", at - 1);
    discord.addThread("10", source.id, "⏳ Orphan");
    discord.addMessage(source.id, "⏳ 요약 중 (1/3)", at, "bot");
    const fiber = yield* Effect.forkChild(invoke(false, true));
    yield* TestClock.adjust("120999 millis");
    expect(openCode.sessionsCreated).toBe(0);
    yield* TestClock.adjust(1);
    yield* waitFor(() => discord.threads.get(source.id)?.thread_metadata.archived === true);
    yield* TestClock.adjust("3 seconds");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(openCode.sessionsCreated).toBe(1);
  }),
);
