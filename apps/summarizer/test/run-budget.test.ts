import { expect, it } from "@effect/vitest";
import { Clock, Effect, Fiber, Logger } from "effect";
import { TestClock } from "effect/testing";
import { decodeConfig } from "../src/config.ts";
import { fakeApi } from "./discord-api-fixture.ts";
import { at, config, seedJournal, setup, stalledWork } from "./run-fixture.ts";

const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let index = 0; index < 200 && !predicate(); index++) yield* Effect.yieldNow;
    expect(predicate()).toBe(true);
  });

it.effect("stops before claiming work when the discovery budget is spent", () =>
  Effect.gen(function* () {
    const { discord, invoke, getStarted } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    discord.faults.push({ method: "GET", path: "/channels/10/messages?", pause: 20 * 60_000 });
    const fiber = yield* Effect.forkChild(invoke());
    yield* waitFor(() =>
      discord.requests.some((request) => request.path.startsWith("/channels/10/messages?")),
    );
    yield* TestClock.adjust("20 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(yield* Clock.currentTimeMillis).toBe(at + 20 * 60_000);
    expect(discord.threads.get(post.id)).toBeUndefined();
    expect(getStarted()).toBe(0);
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
  }),
);

for (const partial of [false, true])
  it.effect(
    `reports a skipped channel after ${partial ? "partial" : "finished"} budget-limited discovery`,
    () =>
      Effect.gen(function* () {
        const { discord, invoke, getStarted } = yield* setup(
          {},
          config + '  - id: "11"\n    label: Unreadable\n',
        );
        discord.addChannel("11");
        if (partial)
          for (let index = 0; index < 101; index++)
            discord.addMessage("10", `plain message ${index}`, at - 1000 + index);
        discord.faults.push({ method: "GET", path: "/channels/11", status: 403 });
        discord.faults.push({
          method: "GET",
          path: partial ? "/channels/10/messages?limit=100&before=" : "/channels/10/messages?",
          pause: 20 * 60_000,
        });
        const fiber = yield* Effect.forkChild(invoke());
        yield* waitFor(() =>
          discord.requests.some((r) =>
            r.path.startsWith(
              partial ? "/channels/10/messages?limit=100&before=" : "/channels/10/messages?",
            ),
          ),
        );
        yield* TestClock.adjust("20 minutes");
        expect(yield* Fiber.join(fiber)).toBe(1);
        expect(getStarted()).toBe(0);
      }),
  );

it.effect("stops the queued second Attempt after the first consumes its Run budget", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup(
      { holdTerminal: true },
      config + "concurrency: 1\nrun_budget: 1 minute\n",
    );
    const first = discord.addMessage("10", "https://example.test/first", at - 2000);
    const second = discord.addMessage("10", "https://example.test/second", at - 1000);
    const fiber = yield* Effect.forkChild(invoke());
    yield* waitFor(() => openCode.requests.includes("POST /api/session/ses_one/command"));
    yield* TestClock.adjust("10 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(discord.messages.get(first.id)?.[0]?.content).toContain("(timeout)");
    expect(discord.threads.get(second.id)).toBeUndefined();
    expect(openCode.requests.filter((r) => r === "POST /api/session")).toHaveLength(1);
  }),
);

it.effect("does not start another queued Attempt at the exact Run budget", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup({}, config + "concurrency: 1\n");
    const first = discord.addMessage("10", "https://example.test/first", at - 2000);
    const second = discord.addMessage("10", "https://example.test/second", at - 1000);
    discord.faults.push({
      method: "GET",
      path: `/channels/10/messages/${first.id}`,
      pause: 20 * 60_000,
    });
    const fiber = yield* Effect.forkChild(invoke());
    yield* waitFor(() =>
      discord.requests.some((request) => request.path === `/channels/10/messages/${first.id}`),
    );
    yield* TestClock.adjust("20 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(discord.threads.get(first.id)?.thread_metadata.archived).toBe(true);
    expect(discord.threads.get(second.id)).toBeUndefined();
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(1);
  }),
);

it.effect("starts two Attempts concurrently when two slots are configured", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup({ holdTerminal: true }, config + "concurrency: 2\n");
    const first = discord.addMessage("10", "https://example.test/first", at - 2000);
    const second = discord.addMessage("10", "https://example.test/second", at - 1000);
    const fiber = yield* Effect.forkChild(invoke());
    yield* waitFor(() =>
      [first, second].every((post) =>
        discord.messages.get(post.id)?.some((message) => message.content.includes("요약 중")),
      ),
    );
    yield* Fiber.interrupt(fiber);
    for (const post of [first, second])
      expect(discord.messages.get(post.id)?.[0]?.content).toContain("요약 중단");
  }),
);

it.effect("skips a completed channel during a multi-channel discovery round", () =>
  Effect.gen(function* () {
    const yaml = config + '  - id: "11"\n    label: Empty\n';
    const { discord, invoke } = yield* setup({}, yaml);
    discord.addChannel("11");
    const post = discord.addMessage("10", "https://example.test/a", at - 2000);
    for (let index = 0; index < 100; index++)
      discord.addMessage("10", `plain message ${index}`, at - 1000 + index);
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
  }),
);

const busyChannels = (prefix: string) =>
  Effect.gen(function* () {
    const result = yield* setup({}, config + '  - id: "11"\n    label: Second\n');
    result.discord.addChannel("11");
    for (let index = 0; index < 101; index++) {
      result.discord.addMessage("10", `${prefix}first ${index}`, at - 1000 + index);
      result.discord.addMessage("11", `${prefix}second ${index}`, at - 1000 + index);
    }
    return result;
  });

it.effect("does not scan the next channel once the first consumes the discovery budget", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* busyChannels("plain ");
    const high = (BigInt(discord.messages.get("10")!.at(-1)!.id) + 1n).toString();
    const prefix = `/channels/10/messages?limit=100&before=${high}`;
    discord.faults.push({ method: "GET", path: prefix, pause: 20 * 60_000 });
    const fiber = yield* Effect.forkChild(invoke());
    yield* waitFor(() => discord.requests.some((r) => r.path.startsWith(prefix)));
    expect(discord.faults).toEqual([]);
    const secondPages = discord.requests.filter((r) =>
      r.path.startsWith("/channels/11/messages?limit=100&before="),
    ).length;
    yield* TestClock.adjust("20 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(yield* Clock.currentTimeMillis).toBe(at + 20 * 60_000);
    expect(
      discord.requests.filter((r) => r.path.startsWith("/channels/11/messages?limit=100&before=")),
    ).toHaveLength(secondPages);
  }),
);

it.effect("a page finishing at the exact Run deadline cannot start the next channel page", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* busyChannels("");
    const next = (channel: string) =>
      `/channels/${channel}/messages?limit=100&before=${(BigInt(discord.messages.get(channel)!.at(-1)!.id) + 1n).toString()}`;
    discord.faults.push({ method: "GET", path: next("10"), status: 200 });
    discord.faults.push({ method: "GET", path: next("10"), pause: 20 * 60_000 });
    discord.faults.push({ method: "GET", path: next("11"), status: 200 });
    discord.faults.push({ method: "GET", path: next("11"), status: 403 });
    const fiber = yield* Effect.forkChild(invoke());
    yield* waitFor(() => discord.requests.filter((r) => r.path === next("10")).length === 2);
    yield* TestClock.adjust("20 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
  }),
);

it.effect("a slow first history page leaves a second channel for the next Run", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup({}, config + '  - id: "11"\n    label: Second\n');
    discord.addChannel("11");
    const first = discord.addMessage("10", "https://example.test/first", at - 2000);
    for (let index = 0; index < 100; index++)
      discord.addMessage("10", `noise ${index}`, at - 1000 + index);
    const second = discord.addMessage("11", "https://example.test/second", at - 1000);
    const high = (BigInt(discord.messages.get("10")!.at(-1)!.id) + 1n).toString();
    const path = `/channels/10/messages?limit=100&before=${high}`;
    discord.faults.push({ method: "GET", path, status: 200 });
    discord.faults.push({ method: "GET", path, pause: 20 * 60_000 });
    const fiber = yield* Effect.forkChild(invoke());
    for (let turn = 0; turn < 200 && discord.faults.length; turn++) yield* Effect.yieldNow;
    expect(discord.faults).toHaveLength(0);
    yield* TestClock.adjust("20 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(discord.threads.get(first.id)).toBeUndefined();
    expect(discord.threads.get(second.id)).toBeUndefined();
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(first.id)?.thread_metadata.archived).toBe(true);
    expect(discord.threads.get(second.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("bounds a stalled Discord read at the whole-Run deadline", () =>
  Effect.gen(function* () {
    const { discord, invoke, getStarted } = yield* setup();
    discord.faults.push({ method: "GET", path: "/channels/20/messages?", pause: 40 * 60_000 });
    const fiber = yield* Effect.forkChild(invoke());
    yield* waitFor(() =>
      discord.requests.some((request) => request.path.startsWith("/channels/20/messages?")),
    );
    yield* TestClock.adjust("31 minutes");
    expect(yield* Fiber.join(fiber)).toBe(1);
    expect(getStarted()).toBe(0);
  }),
);

it.effect("labels a deadline-limited dry-run scan partial without mutations", () =>
  Effect.gen(function* () {
    const { discord, invoke, getStarted } = yield* setup();
    const logs: string[] = [];
    const logger = Logger.make((event) => {
      logs.push(JSON.stringify(event.message));
    });
    for (let index = 0; index < 201; index++)
      discord.addMessage("10", `https://example.test/${index}`, at - 201_000 + index * 1000);
    discord.faults.push({
      method: "GET",
      path: "/channels/10/messages?limit=100&before=",
      pause: 30 * 60_000,
    });
    discord.faults.push({
      method: "GET",
      path: "/channels/10/messages?limit=100&before=",
      status: 403,
    });
    discord.faults.push({ method: "GET", path: "/guilds/guild/threads/active", status: 403 });
    const fiber = yield* Effect.forkChild(
      invoke(true).pipe(Effect.provide(Logger.layer([logger]))),
    );
    yield* waitFor(() => discord.requests.some((request) => request.path.includes("&before=")));
    yield* TestClock.adjust("30 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(logs.join(" ")).toContain("(partial)");
    expect(discord.requests.some((request) => request.method !== "GET")).toBe(false);
    expect(getStarted()).toBe(0);
  }),
);

it.effect("interrupts an Attempt without counting it when session creation stalls", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup({ hangCreate: true });
    const post = discord.addMessage("10", "https://example.test/slow-create", at - 1000);
    const fiber = yield* Effect.forkChild(invoke());
    yield* waitFor(() => openCode.requests.includes("POST /api/session"));
    yield* TestClock.adjust("15 seconds");
    expect(yield* Effect.flip(Fiber.join(fiber))).toMatchObject({
      reason: "Cannot create OpenCode session",
    });
    expect(discord.messages.get(post.id)?.[0]?.content).toContain("요약 중단");
    expect(discord.threads.get(post.id)?.name).toContain("⏳");
  }),
);

it.effect("interrupts a whole Run with an active private session and preserves its Attempt", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode, getStarted } = yield* setup({ holdTerminal: true });
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    const fiber = yield* Effect.forkChild(invoke());
    yield* waitFor(() => openCode.requests.includes("POST /api/session/ses_one/command"));
    expect(discord.messages.get(post.id)?.[0]?.content).toBe("⏳ 요약 중 (1/3)");
    yield* Fiber.interrupt(fiber);
    expect(discord.messages.get(post.id)?.[0]?.content).toBe(
      "⏸️ 요약 중단 (1/3): 재시도 횟수에 포함되지 않음",
    );
    expect(openCode.requests).toContain("POST /api/session/ses_one/interrupt?resume=false");
    expect(getStarted()).toBe(1);
  }),
);

for (const mode of ["timeout", "interrupt"] as const)
  it.effect(`records ${mode} for a started Attempt whose client never settles`, () =>
    Effect.gen(function* () {
      const { discord } = yield* setup();
      const post = discord.addMessage("10", `https://example.test/${mode}`, at - 1000);
      const journal = yield* seedJournal(discord, post);
      const api = yield* fakeApi(discord);
      const settings = yield* decodeConfig(config, "/home/test");
      const fiber = yield* Effect.forkChild(stalledWork(api, settings, journal, post.id));
      yield* waitFor(
        () => discord.messages.get(post.id)?.some((m) => m.content.includes("요약 중")) === true,
      );
      expect(
        discord.requests.filter((request) =>
          request.path.startsWith(`/channels/${post.id}/messages?`),
        ),
      ).toHaveLength(2);
      if (mode === "timeout") {
        yield* TestClock.adjust("10 minutes");
        expect((yield* Fiber.join(fiber)).entries.get(post.id)).toBeUndefined();
        expect(discord.messages.get(post.id)?.[0]?.content).toContain("(timeout)");
      } else {
        yield* Fiber.interrupt(fiber);
        expect(discord.messages.get(post.id)?.[0]?.content).toBe(
          "⏸️ 요약 중단 (1/3): 재시도 횟수에 포함되지 않음",
        );
      }
    }),
  );
