import { expect, it } from "./progress-fixture.ts";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { journalStatus, readJournal, type Status } from "../src/channel-record.ts";
import { readyManifest } from "./ready-fixture.ts";
import { at, seedJournal, setup, sinceDaysAgo, waitForFault } from "./run-fixture.ts";

const day = 86_400_000;
const readyStatusFor = (id: string): Status => ({
  id,
  state: "ready",
  count: 1,
  hash: "a".repeat(64),
  parts: ["1"],
});

it.effect("a deleted recent READY thread is rebuilt before its next Attempt", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const source = discord.addMessage("10", "https://example.test/ready", at - 100);
    const journal = yield* seedJournal(discord, source);
    discord.addThread("10", source.id, "⏳ Old", "bot", true);
    yield* journalStatus(journal, readyStatusFor(source.id));
    discord.threads.delete(source.id);
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(source.id)?.thread_metadata.archived).toBe(true);
    expect(discord.messages.get(source.id)?.some((m) => m.content === "안녕하세요")).toBe(true);
  }),
);

it.effect("a deleted completion survives a time-sliced rescan and is rebuilt next Run", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const older = discord.addMessage("10", "https://example.test/older", at - 5 * day);
    const done = discord.addMessage("10", "https://example.test/done", at - 4 * day);
    expect(yield* invoke()).toBe(0);
    discord.threads.delete(done.id);
    discord.messages.delete(done.id);
    discord.faults.push({ method: "GET", path: `/channels/${done.id}`, pause: 10 * 60_000 });
    const fiber = yield* Effect.forkChild(invoke());
    yield* waitForFault(discord);
    yield* TestClock.adjust("10 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(discord.threads.get(done.id)).toBeUndefined();
    expect(discord.threads.get(older.id)?.thread_metadata.archived).toBe(true);
    discord.faults.push({ method: "GET", path: "/channels/10", pause: 10 * 60_000 });
    discord.faults.push({ method: "GET", path: `/channels/${older.id}`, status: 403 });
    const messageState = structuredClone(discord.messages);
    const paused = yield* Effect.forkChild(invoke());
    yield* waitForFault(discord, 1);
    yield* TestClock.adjust("10 minutes");
    expect(yield* Fiber.join(paused)).toBe(0);
    expect(discord.threads.get(done.id)).toBeUndefined();
    expect(discord.messages).toEqual(messageState);
    discord.faults.length = 0;
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(done.id)?.thread_metadata.archived).toBe(true);
    expect(discord.messages.get(done.id)?.filter((m) => m.content === "안녕하세요")).toHaveLength(
      1,
    );
  }),
);

it.effect("a changed Since takes effect only after its budget-limited rescan completes", () =>
  Effect.gen(function* () {
    const recent = sinceDaysAgo(2);
    const backfill = sinceDaysAgo(10);
    const { discord, invokeWith } = yield* setup({}, recent);
    const old = discord.addMessage("10", "https://example.test/old", at - 5 * day);
    const current = discord.addMessage("10", "https://example.test/current", at - day);
    expect(yield* invokeWith(recent)).toBe(0);
    expect(discord.threads.get(old.id)).toBeUndefined();
    discord.faults.push({ method: "GET", path: `/channels/${current.id}`, pause: 16 * 60_000 });
    const fiber = yield* Effect.forkChild(invokeWith(backfill));
    yield* waitForFault(discord);
    yield* TestClock.adjust("16 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(discord.threads.get(old.id)).toBeUndefined();
    expect(yield* invokeWith(backfill)).toBe(0);
    expect(discord.threads.get(old.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("an unchanged rescan does not repeat a completed Summary", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const source = discord.addMessage("10", "https://example.test/once", at - 100);
    expect(yield* invoke()).toBe(0);
    const stored = yield* readJournal("10");
    yield* TestClock.adjust("1 second");
    expect(yield* invoke()).toBe(0);
    expect(yield* readJournal("10")).toEqual(stored);
    expect(discord.messages.get(source.id)?.filter((m) => m.content === "안녕하세요")).toHaveLength(
      1,
    );
  }),
);

it.effect("a completed rescan revisits newer deletions after its cursor is cleared", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const older = discord.addMessage("10", "https://example.test/older", at - 3 * day);
    const newer = discord.addMessage("10", "https://example.test/newer", at - 2 * day);
    expect(yield* invoke()).toBe(0);
    discord.faults.push({ method: "GET", path: `/channels/${newer.id}`, pause: 10 * 60_000 });
    const partial = yield* Effect.forkChild(invoke());
    yield* waitForFault(discord);
    yield* TestClock.adjust("10 minutes");
    expect(yield* Fiber.join(partial)).toBe(0);
    expect(discord.threads.get(older.id)?.thread_metadata.archived).toBe(true);
    expect(yield* invoke()).toBe(0);
    discord.threads.delete(newer.id);
    discord.messages.delete(newer.id);
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(newer.id)?.thread_metadata.archived).toBe(true);
    expect(discord.messages.get(newer.id)?.filter((m) => m.content === "안녕하세요")).toHaveLength(
      1,
    );
  }),
);

it.effect("an exact rescan deadline defers the deleted thread check until the next Run", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const source = discord.addMessage("10", "https://example.test/deleted", at - 100);
    expect(yield* invoke()).toBe(0);
    discord.threads.delete(source.id);
    discord.messages.delete(source.id);
    discord.faults.push({ method: "GET", path: "/channels/10", pause: 10 * 60_000 });
    discord.faults.push({ method: "GET", path: `/channels/${source.id}`, status: 403 });
    const fiber = yield* Effect.forkChild(invoke());
    yield* waitForFault(discord, 1);
    yield* TestClock.adjust("10 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(discord.threads.get(source.id)).toBeUndefined();
    discord.faults.length = 0;
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(source.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("Pending can become READY without discarding its verified parts", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const source = discord.addMessage("10", "https://example.test/pending", at);
    const journal = yield* seedJournal(discord, source);
    const pending = yield* journalStatus(journal, {
      id: source.id,
      state: "pending",
    });
    discord.addThread("10", source.id, "⏳ Draft", "bot", true);
    const part = discord.addMessage(source.id, "Saved summary", at, "bot");
    yield* journalStatus(pending, readyManifest(source.id, [part]));
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(source.id)?.thread_metadata.archived).toBe(true);
    expect(
      discord.messages.get(source.id)?.filter((m) => m.content === "Saved summary"),
    ).toHaveLength(1);
    expect(discord.messages.get(source.id)?.some((m) => m.content === "안녕하세요")).toBe(false);
  }),
);
