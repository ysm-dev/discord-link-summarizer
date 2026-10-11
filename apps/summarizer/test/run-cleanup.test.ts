import { expect, it } from "./progress-fixture.ts";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { ProgressStore } from "../src/progress-store.ts";
import { readJournal } from "../src/channel-record.ts";
import { at, captureLogs, config, setup, waitFor } from "./run-fixture.ts";
import { session } from "./opencode-fake.ts";

it.effect("keeps a completed Summary only on Discord and sweeps previously retained sessions", () =>
  Effect.gen(function* () {
    const old = session("ses_old", "succeeded");
    const { discord, invoke, openCode } = yield* setup({
      pages: [
        [{ ...old, metadata: { summarizer: { ...old.metadata.summarizer, published: true } } }],
      ],
    });
    const post = discord.addMessage("10", "https://example.test/cleanup", at - 1000);
    const { logs, layer } = captureLogs();
    expect(yield* invoke().pipe(Effect.provide(layer))).toBe(0);
    expect(discord.messages.get(post.id)?.map((message) => message.content)).toEqual([
      "안녕하세요",
    ]);
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
    expect(openCode.retained.size).toBe(0);
    expect(logs).toContain("Deleted 1 leftover OpenCode sessions");
    expect(logs.some((line) => line.includes("Publication deferred"))).toBe(false);
    expect(openCode.requests.some((request) => request.includes("/api/experimental/"))).toBe(false);
    expect(yield* invoke()).toBe(0);
    expect(openCode.sessionsCreated).toBe(1);
    expect(openCode.retained.size).toBe(0);
  }),
);

it.effect(
  "delivers a Summary despite failed cleanup and deletes the leftover on the next Run",
  () =>
    Effect.gen(function* () {
      const { discord, invoke, openCode } = yield* setup({ deleteFailures: 1 });
      const post = discord.addMessage("10", "https://example.test/retry-cleanup", at - 1000);
      const { logs, layer } = captureLogs();
      expect(yield* invoke().pipe(Effect.provide(layer))).toBe(0);
      expect(logs).toContain("Cannot delete OpenCode session ses_one; cleanup will retry next Run");
      expect(openCode.retained.size).toBe(1);
      expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
      expect(yield* invoke().pipe(Effect.provide(layer))).toBe(0);
      expect(logs).toContain("Deleted 1 leftover OpenCode sessions");
      expect(openCode.retained.size).toBe(0);
      expect(openCode.sessionsCreated).toBe(1);
      expect(discord.messages.get(post.id)?.map((message) => message.content)).toEqual([
        "안녕하세요",
      ]);
    }),
);

it.effect("deletes the session when the whole Attempt times out", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup(
      { noEvent: true },
      config + "summary_timeout: 1 second\n",
    );
    const post = discord.addMessage("10", "https://example.test/timeout-cleanup", at - 1000);
    const fiber = yield* Effect.forkChild(invoke());
    yield* waitFor(() => openCode.requests.includes("POST /api/session/ses_one/command"));
    yield* TestClock.adjust("2 seconds");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(discord.messages.get(post.id)?.[0]?.content).toContain("시간 초과 (timeout)");
    expect(openCode.retained.size).toBe(0);
  }),
);

it.effect("deletes the session even when Discord delivery fails", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/failed-delivery", at - 1000);
    const path = `/channels/${post.id}/messages`;
    discord.faults.push({ method: "POST", path, status: 200 });
    discord.faults.push({ method: "POST", path, status: 403 });
    expect(yield* Effect.flip(invoke())).toMatchObject({ kind: "forbidden" });
    expect(openCode.sessionsCreated).toBe(1);
    expect(openCode.retained.size).toBe(0);
  }),
);

it.effect("a failed local post-commit write recovers without another model call", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    const store = yield* ProgressStore;
    const failing = ProgressStore.of({
      ...store,
      editJournal: (channel, decode, f) =>
        store.editJournal(channel, decode, (stored) => {
          const next = f(stored);
          if (discord.threads.get(post.id)?.thread_metadata.archived) throw new Error("disk full");
          return next;
        }),
    });
    expect(
      (yield* Effect.flip(invoke().pipe(Effect.provideService(ProgressStore, failing)))).message,
    ).toContain("disk full");
    expect((yield* readJournal("10"))?.entries.get(post.id)?.state).toBe("ready");
    expect(yield* invoke()).toBe(0);
    expect((yield* readJournal("10"))?.entries.size).toBe(0);
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(1);
    expect(discord.messages.get(post.id)?.filter((m) => m.content === "안녕하세요")).toHaveLength(
      1,
    );
  }),
);

it.effect("corrupt local progress aborts before Discord writes or OpenCode startup", () =>
  Effect.gen(function* () {
    const { discord, invoke, getStarted } = yield* setup();
    discord.addMessage("10", "https://example.test/a", at - 1000);
    const store = yield* ProgressStore;
    yield* store.change("10", () => "broken");
    expect(yield* Effect.exit(invoke())).toMatchObject({ _tag: "Failure" });
    expect(discord.requests.every((r) => r.method === "GET")).toBe(true);
    expect(getStarted()).toBe(0);
  }),
);
