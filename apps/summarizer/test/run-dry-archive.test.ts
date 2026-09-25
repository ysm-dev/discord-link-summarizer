import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { journalPage, journalStatus } from "../src/channel-record.ts";
import { at, captureLogs, openRecord, seedJournal, setup, sinceDaysAgo } from "./run-fixture.ts";

const old = at - 9 * 86_400_000;

for (const archived of [false, true])
  for (const journaled of [false, true])
    it.effect(
      `dry-run recognizes ${archived ? "archived" : "active"} work without an embedded thread, ${journaled ? "journaled" : "new"}`,
      () =>
        Effect.gen(function* () {
          const { discord, invoke, getStarted } = yield* setup();
          const source = discord.addMessage("10", "https://example.test/started", at - 86_400_000);
          discord.addMessage("10", "https://example.test/pending", at - 100);
          if (journaled) yield* seedJournal(discord, source);
          discord.addThread("10", source.id, "⏳ Started", "bot", archived);
          discord.messages.set(
            "10",
            discord.messages
              .get("10")!
              .map((message) =>
                message.id === source.id ? { ...message, thread: undefined } : message,
              ),
          );
          const messages = structuredClone(discord.messages);
          const threads = structuredClone(discord.threads);
          const { logs, layer } = captureLogs();
          expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
          expect(logs.join(" ")).toContain("Pending 1, In progress 1, Given up 0");
          expect(logs.join(" ")).not.toContain("(partial)");
          expect(discord.messages).toEqual(messages);
          expect(discord.threads).toEqual(threads);
          expect(getStarted()).toBe(0);
        }),
    );

it.effect("dry-run counts owned active and archived work, not unrelated or terminal threads", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const { api, journal } = yield* openRecord(discord);
    const active = discord.addMessage("10", "https://example.test/active", old);
    discord.addThread("10", active.id, "⏳ Active", "bot");
    const archived = discord.addMessage("10", "https://example.test/archived", old + 1);
    discord.addThread("10", archived.id, "⏳ Archived", "bot", true);
    const foreign = discord.addMessage("10", "https://example.test/foreign", old + 2);
    discord.addThread("10", foreign.id, "⏳ Foreign", "human", true);
    discord.addChannel("11");
    const misplaced = discord.addMessage("10", "https://example.test/misplaced", old + 3);
    discord.addThread("11", misplaced.id, "⏳ Elsewhere", "bot");
    const finished = discord.addMessage("10", "https://example.test/terminal", old + 4);
    discord.addThread("10", finished.id, "⏳ Terminal", "bot", true);
    const recent = discord.addMessage("10", "https://example.test/recent", at - 100);
    discord.addThread("10", recent.id, "⏳ Recent", "bot", true);
    const marked = yield* journalPage(api, "bot", journal, "terminal", [finished.id, recent.id]);
    yield* journalStatus(api, "20", "bot", marked, { id: finished.id, state: "terminal" });
    const { logs, layer } = captureLogs();
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Pending 0, In progress 3, Given up 0");
    expect(logs.join(" ")).not.toContain("(partial)");
  }),
);

it.effect(
  "dry-run reconciles older journaled sources without embedded threads before tallying",
  () =>
    Effect.gen(function* () {
      const { discord, invoke } = yield* setup();
      const started = discord.addMessage("10", "https://example.test/started", old);
      const oldPending = discord.addMessage("10", "https://example.test/old-pending", old + 1);
      const { api, journal } = yield* openRecord(discord);
      yield* journalPage(api, "bot", journal, "old", [started.id, oldPending.id]);
      discord.addThread("10", started.id, "⏳ Started", "bot", true);
      discord.addMessage("10", "https://example.test/recent", at - 100);
      discord.messages.set(
        "10",
        discord.messages
          .get("10")!
          .map((message) =>
            message.id === started.id ? { ...message, thread: undefined } : message,
          ),
      );
      const { logs, layer } = captureLogs();
      expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
      expect(logs.join(" ")).toContain("Pending 2, In progress 1, Given up 0");
    }),
);

it.effect("dry-run propagates forbidden reads of unadopted archived sources", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const source = discord.addMessage("10", "https://example.test/old", old);
    discord.addThread("10", source.id, "⏳ Old", "bot", true);
    discord.faults.push({ method: "GET", path: `/channels/10/messages/${source.id}`, status: 403 });
    expect(yield* Effect.flip(invoke(true))).toMatchObject({ kind: "forbidden" });
  }),
);

it.effect("dry-run omits an archived thread whose source was deleted", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const source = discord.addMessage("10", "https://example.test/deleted", old);
    discord.addThread("10", source.id, "⏳ Deleted", "bot", true);
    discord.messages.set("10", []);
    const { logs, layer } = captureLogs();
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Pending 0, In progress 0, Given up 0");
  }),
);

it.effect("dry-run deduplicates a thread changing archive state during enumeration", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const source = discord.addMessage("10", "https://example.test/changing", old);
    const thread = discord.addThread("10", source.id, "⏳ Changing", "bot", true);
    discord.faults.push({
      method: "GET",
      path: "/guilds/guild/threads/active",
      status: 200,
      body: { threads: [thread] },
    });
    const { logs, layer } = captureLogs();
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("In progress 1, Given up 0");
  }),
);

it.effect("dry-run counts pre-Since journaled In-progress work if archive listing omits it", () =>
  Effect.gen(function* () {
    const { discord, invokeWith } = yield* setup();
    const source = discord.addMessage("10", "https://example.test/journaled", old);
    const { api, journal } = yield* openRecord(discord);
    yield* journalPage(api, "bot", journal, "old", [source.id]);
    discord.addThread("10", source.id, "⏳ Journaled", "bot", true);
    discord.faults.push({
      method: "GET",
      path: "/channels/10/threads/archived/public",
      status: 200,
      body: { threads: [], has_more: false },
    });
    const { logs, layer } = captureLogs();
    expect(yield* invokeWith(sinceDaysAgo(2), true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Pending 0, In progress 1, Given up 0");
  }),
);
