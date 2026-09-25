import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { journalPage, journalStatus } from "../src/channel-record.ts";
import { fakeApi } from "./discord-api-fixture.ts";
import { readyManifest } from "./ready-fixture.ts";
import {
  at,
  captureLogs,
  config,
  openRecord,
  seedJournal,
  setup,
  sinceDaysAgo,
  waitForFault,
} from "./run-fixture.ts";

const day = 86_400_000;
const advanced = config.replace(
  "2026-09-01T00:00:00Z",
  DateTime.formatIso(DateTime.makeUnsafe(at - 2 * day)),
);

it.effect(
  "recent rescans checkpoint across budget-limited Runs and recover deleted completion without starving journal work",
  () =>
    Effect.gen(function* () {
      const { discord, invoke } = yield* setup();
      const done = discord.addMessage("10", "https://example.test/old", at - 5 * day);
      expect(yield* invoke()).toBe(0);
      discord.threads.delete(done.id);
      const pending = discord.addMessage("10", "https://example.test/pending", at - 4 * day);
      yield* seedJournal(discord, pending);
      const remaining = [
        discord.addMessage("10", "https://example.test/one", at - 3 * day),
        discord.addMessage("10", "https://example.test/two", at - 2 * day),
      ].toReversed();
      for (const source of remaining) {
        discord.faults.push({ method: "GET", path: `/channels/${source.id}`, pause: 11 * 60_000 });
        const fiber = yield* Effect.forkChild(invoke());
        yield* waitForFault(discord);
        yield* TestClock.adjust("11 minutes");
        expect(yield* Fiber.join(fiber)).toBe(0);
        expect(discord.threads.get(pending.id)?.thread_metadata.archived).toBe(true);
        expect(discord.threads.get(done.id)).toBeUndefined();
      }
      expect(yield* invoke()).toBe(0);
      expect(discord.threads.get(done.id)?.thread_metadata.archived).toBe(true);
      for (const source of remaining)
        expect(
          discord.messages.get(source.id)?.filter((m) => m.content === "안녕하세요"),
        ).toHaveLength(1);
      expect(
        discord.messages.get(done.id)?.filter((message) => message.content === "안녕하세요"),
      ).toHaveLength(1);
      expect(yield* invoke()).toBe(0);
      expect(
        discord.messages.get(done.id)?.filter((message) => message.content === "안녕하세요"),
      ).toHaveLength(1);
    }),
);

it.effect(
  "advanced Since excludes journaled Pending at admission while archived In-progress and READY complete",
  () =>
    Effect.gen(function* () {
      const { discord, invokeWith } = yield* setup();
      const settled = discord.addMessage("10", "https://example.test/settled", at - 6 * day);
      expect(yield* invokeWith(config)).toBe(0);
      expect(discord.threads.get(settled.id)?.thread_metadata.archived).toBe(true);
      const pending = discord.addMessage("10", "https://example.test/old-pending", at - 5 * day);
      const started = discord.addMessage("10", "https://example.test/started", at - 4 * day);
      const ready = discord.addMessage("10", "https://example.test/ready", at - 3 * day);
      const current = discord.addMessage("10", "https://example.test/current", at - day);
      const journal = yield* seedJournal(discord, pending);
      const api = yield* fakeApi(discord);
      const marked = yield* journalPage(api, "bot", journal, "started", [started.id, ready.id]);
      discord.addThread("10", started.id, "⏳ Started", "bot", true);
      discord.addThread("10", ready.id, "⏳ Ready", "bot", true);
      const part = discord.addMessage(ready.id, "Verified summary", at, "bot");
      yield* journalStatus(api, "20", "bot", marked, readyManifest(ready.id, [part]));
      const { logs, layer } = captureLogs();
      const messages = structuredClone(discord.messages);
      const threads = structuredClone(discord.threads);
      expect(yield* invokeWith(advanced, true).pipe(Effect.provide(layer))).toBe(0);
      expect(logs.join(" ")).toContain(
        `effective start ${new Date(at - 2 * day).toISOString()} current; Pending 1, In progress 2, Given up 0`,
      );
      expect(discord.messages).toEqual(messages);
      expect(discord.threads).toEqual(threads);
      expect(yield* invokeWith(advanced)).toBe(0);
      expect(discord.threads.get(pending.id)).toBeUndefined();
      for (const source of [started, ready, current])
        expect(discord.threads.get(source.id)?.thread_metadata.archived).toBe(true);
      expect(discord.threads.get(started.id)?.name).not.toContain("⏳");
      expect(
        discord.messages.get(started.id)?.some((message) => message.content === "안녕하세요"),
      ).toBe(true);
      expect(discord.threads.get(ready.id)?.name).not.toContain("⏳");
      expect(
        discord.messages.get(ready.id)?.some((message) => message.content === "Verified summary"),
      ).toBe(true);
      expect(discord.threads.get(pending.id)).toBeUndefined();
    }),
);

it.effect("a Pending Link Post exactly at the advanced Since is eligible", () =>
  Effect.gen(function* () {
    const { discord, invokeWith } = yield* setup();
    const boundary = discord.addMessage("10", "https://example.test/boundary", at - 2 * day);
    expect(yield* invokeWith(advanced)).toBe(0);
    expect(discord.threads.get(boundary.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("rebuilds a deleted old READY thread from a cleared manifest", () =>
  Effect.gen(function* () {
    const { discord, invokeWith } = yield* setup();
    const source = discord.addMessage("10", "https://example.test/old-ready", at - 9 * day);
    const journal = yield* seedJournal(discord, source);
    const api = yield* fakeApi(discord);
    discord.addThread("10", source.id, "⏳ Old", "bot", true);
    const oldPart = discord.addMessage(source.id, "Deleted draft", at, "bot");
    yield* journalStatus(api, "20", "bot", journal, readyManifest(source.id, [oldPart]));
    discord.threads.delete(source.id);
    discord.messages.delete(source.id);
    const backfill = config.replace("2026-09-01T00:00:00Z", new Date(at - 10 * day).toISOString());
    expect(yield* invokeWith(backfill)).toBe(0);
    expect(discord.threads.get(source.id)?.thread_metadata.archived).toBe(true);
    expect(
      discord.messages.get(source.id)?.some((message) => message.content === "안녕하세요"),
    ).toBe(true);
    expect(
      discord.messages.get(source.id)?.some((message) => message.content === "Deleted draft"),
    ).toBe(false);
    expect(yield* invokeWith(backfill)).toBe(0);
    expect(
      discord.messages.get(source.id)?.filter((message) => message.content === "안녕하세요"),
    ).toHaveLength(1);
  }),
);

it.effect("a multi-Run backfill discovers the frozen Horizon tail after time passes", () =>
  Effect.gen(function* () {
    const recent = sinceDaysAgo(2);
    const backfill = sinceDaysAgo(10);
    const { discord, invokeWith } = yield* setup({}, recent);
    const tail = discord.addMessage("10", "https://example.test/tail", at - 7 * day + 5 * 60_000);
    const newer = discord.addMessage("10", "https://example.test/new", at - day);
    expect(yield* invokeWith(recent)).toBe(0);
    expect(discord.threads.get(tail.id)).toBeUndefined();
    discord.faults.push({ method: "GET", path: `/channels/${newer.id}`, pause: 11 * 60_000 });
    const fiber = yield* Effect.forkChild(invokeWith(backfill));
    yield* waitForFault(discord);
    yield* TestClock.adjust("11 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(yield* invokeWith(backfill)).toBe(0);
    expect(discord.threads.get(tail.id)?.thread_metadata.archived).toBe(true);
    expect(discord.messages.get(tail.id)?.some((message) => message.content === "안녕하세요")).toBe(
      true,
    );
  }),
);

it.effect("distinct deleted completions recover across an interrupted reset", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const first = discord.addMessage("10", "https://example.test/first", at - 4 * day);
    const second = discord.addMessage("10", "https://example.test/second", at - 3 * day);
    expect(yield* invoke()).toBe(0);
    const { journal } = yield* openRecord(discord);
    discord.threads.delete(first.id);
    discord.messages.delete(first.id);
    discord.faults.push({
      method: "POST",
      path: `/channels/${journal.parent}/messages`,
      pause: 20 * 60_000,
    });
    const interrupted = yield* Effect.forkChild(invoke());
    yield* waitForFault(discord);
    yield* TestClock.adjust("20 minutes");
    expect(yield* Fiber.join(interrupted)).toBe(0);
    const { api, journal: paused } = yield* openRecord(discord);
    const withSecond = yield* journalPage(api, "bot", paused, "seed/second", [second.id]);
    yield* journalStatus(api, "20", "bot", withSecond, { id: second.id, state: "terminal" });
    discord.addThread("10", first.id, "⏳ Reclaimed", "bot", true);
    discord.threads.delete(second.id);
    discord.messages.delete(second.id);
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(first.id)?.thread_metadata.archived).toBe(true);
    expect(discord.threads.get(second.id)?.thread_metadata.archived).toBe(true);
    expect(discord.messages.get(second.id)?.some((m) => m.content === "안녕하세요")).toBe(true);
  }),
);

it.effect("a slow rescan in one channel leaves time to recover a second channel", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup({}, config + '  - id: "11"\n    label: Second\n');
    discord.addChannel("11");
    const first = Array.from({ length: 4 }, (_, index) =>
      discord.addMessage("10", `https://example.test/${index}`, at - 5 * day + index),
    );
    const second = discord.addMessage("11", "https://example.test/second", at - 5 * day);
    expect(yield* invoke()).toBe(0);
    discord.threads.delete(second.id);
    for (const source of first)
      discord.faults.push({ method: "GET", path: `/channels/${source.id}`, pause: 4 * 60_000 });
    const fiber = yield* Effect.forkChild(invoke());
    for (
      let turn = 0;
      turn < 200 && !discord.requests.some((r) => r.path === `/channels/${first[3]!.id}`);
      turn++
    )
      yield* Effect.yieldNow;
    yield* TestClock.adjust("4 minutes");
    for (
      let turn = 0;
      turn < 200 && !discord.requests.some((r) => r.path === `/channels/${first[2]!.id}`);
      turn++
    )
      yield* Effect.yieldNow;
    yield* TestClock.adjust("4 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(discord.threads.get(second.id)?.thread_metadata.archived).toBe(true);
    expect(
      discord.messages.get(second.id)?.filter((message) => message.content === "안녕하세요"),
    ).toHaveLength(1);
  }),
);

it.effect("fresh admission skips a deleted or edited journaled source", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const edited = discord.addMessage("10", "https://example.test/edited", at - 2000);
    const deleted = discord.addMessage("10", "https://example.test/deleted", at - 1000);
    const journal = yield* seedJournal(discord, edited);
    const api = yield* fakeApi(discord);
    yield* journalPage(api, "bot", journal, "deleted", [deleted.id]);
    discord.messages.set(
      "10",
      discord.messages
        .get("10")!
        .filter((message) => message.id !== deleted.id)
        .map((message) =>
          message.id === edited.id ? { ...message, content: "wachi: edited" } : message,
        ),
    );
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(edited.id)).toBeUndefined();
    expect(discord.threads.get(deleted.id)).toBeUndefined();
  }),
);
