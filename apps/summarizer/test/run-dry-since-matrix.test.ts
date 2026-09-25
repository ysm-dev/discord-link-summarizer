import { expect, it } from "./progress-fixture.ts";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { journalStatus } from "../src/channel-record.ts";
import { at, captureLogs, seedJournal, setup, sinceDaysAgo, waitForFault } from "./run-fixture.ts";

const day = 86_400_000;
const states = ["in-progress", "given-up", "done", "foreign", "absent", "deleted"] as const;

const oldJournaledStart = (days: number) =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const source = fixture.discord.addMessage("10", "https://example.test/old", at - days * day);
    yield* seedJournal(fixture.discord, source);
    fixture.discord.addThread("10", source.id, "⏳ Started", "bot", true);
    fixture.discord.messages.set(
      "10",
      fixture.discord.messages.get("10")!.map((message) => ({ ...message, thread: undefined })),
    );
    return { ...fixture, source };
  });

for (const journaled of [false, true])
  for (const beforeSince of [false, true])
    for (const listed of [false, true])
      for (const state of states)
        it.effect(
          `dry-run ${journaled ? "journaled" : "normal"} ${beforeSince ? "old" : "eligible"} ${listed ? "listed" : "unlisted"} ${state} without an embed`,
          () =>
            Effect.gen(function* () {
              const { discord, invokeWith, getStarted } = yield* setup();
              const source = discord.addMessage(
                "10",
                "https://example.test/source",
                at - (beforeSince ? 4 : 1) * day,
              );
              if (journaled) {
                const journal = yield* seedJournal(discord, source);
                if (state === "done")
                  yield* journalStatus(journal, {
                    id: source.id,
                    state: "terminal",
                  });
              }
              if (state !== "absent") {
                discord.addThread(
                  "10",
                  source.id,
                  state === "given-up" ? "⚠️ Given" : state === "done" ? "Done" : "⏳ Started",
                  state === "foreign" ? "human" : "bot",
                  state !== "foreign",
                );
                discord.messages.set(
                  "10",
                  discord.messages.get("10")!.map((message) => ({ ...message, thread: undefined })),
                );
              }
              if (!listed) {
                discord.faults.push({
                  method: "GET",
                  path: "/guilds/guild/threads/active",
                  status: 200,
                  body: { threads: [] },
                });
                discord.faults.push({
                  method: "GET",
                  path: "/channels/10/threads/archived/public",
                  status: 200,
                  body: { threads: [], has_more: false },
                });
              }
              if (state === "deleted")
                for (let attempt = 0; attempt < 3; attempt++)
                  discord.faults.push({
                    method: "GET",
                    path: `/channels/10/messages/${source.id}`,
                    status: 404,
                  });
              const messages = structuredClone(discord.messages);
              const threads = structuredClone(discord.threads);
              const { logs, layer } = captureLogs();
              expect(yield* invokeWith(sinceDaysAgo(2), true).pipe(Effect.provide(layer))).toBe(0);
              const eligible = !beforeSince || journaled || listed;
              const inProgress = Number(state === "in-progress" && eligible);
              const givenUp = Number(state === "given-up" && !beforeSince);
              const pending = Number(state === "absent" && !beforeSince);
              expect(discord.threads).toEqual(threads);
              expect(logs.join(" ")).toContain(
                `Pending ${pending}, In progress ${inProgress}, Given up ${givenUp}`,
              );
              expect(logs.join(" ")).not.toContain("(partial)");
              expect(discord.messages).toEqual(messages);
              expect(getStarted()).toBe(0);
            }),
        );

it.effect("dry-run admits a journaled source exactly at Since from its listed thread", () =>
  Effect.gen(function* () {
    const { discord, invokeWith, getStarted, source } = yield* oldJournaledStart(10);
    discord.faults.push({ method: "GET", path: `/channels/${source.id}`, status: 403 });
    const messages = structuredClone(discord.messages);
    const { logs, layer } = captureLogs();
    expect(yield* invokeWith(sinceDaysAgo(10), true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Pending 0, In progress 1, Given up 0");
    expect(discord.messages).toEqual(messages);
    expect(getStarted()).toBe(0);
  }),
);

it.effect("dry-run labels an old journaled thread lookup that reaches the deadline partial", () =>
  Effect.gen(function* () {
    const { discord, invokeWith, getStarted, source } = yield* oldJournaledStart(4);
    discord.faults.push({
      method: "GET",
      path: `/channels/${source.id}`,
      pause: 30 * 60_000,
    });
    const messages = structuredClone(discord.messages);
    const threads = structuredClone(discord.threads);
    const { logs, layer } = captureLogs();
    const fiber = yield* Effect.forkChild(
      invokeWith(sinceDaysAgo(2), true).pipe(Effect.provide(layer)),
    );
    yield* waitForFault(discord);
    yield* TestClock.adjust("30 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(logs.join(" ")).toContain("Pending 0, In progress 1, Given up 0 (partial)");
    expect(discord.messages).toEqual(messages);
    expect(discord.threads).toEqual(threads);
    expect(getStarted()).toBe(0);
  }),
);
