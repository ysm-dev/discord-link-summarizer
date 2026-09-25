import { expect, it } from "./progress-fixture.ts";
import { Effect } from "effect";
import { journalPage, journalStatus } from "../src/channel-record.ts";
import type { FakeDiscord } from "./discord-fake.ts";
import { at, captureLogs, openRecord, setup, sinceDaysAgo } from "./run-fixture.ts";

const old = at - 9 * 86_400_000;

const omitEmbeddedThreads = (discord: FakeDiscord) =>
  discord.messages.set(
    "10",
    discord.messages
      .get("10")!
      .map((message) => (message.thread ? { ...message, thread: undefined } : message)),
  );

const omitArchivedThreads = (discord: FakeDiscord) =>
  discord.faults.push({
    method: "GET",
    path: "/channels/10/threads/archived/public",
    status: 200,
    body: { threads: [], has_more: false },
  });

for (const kind of ["listed-deleted", "unlisted-deleted", "unlisted-edited"] as const)
  it.effect(`dry-run drops a ${kind} source after the history scan`, () =>
    Effect.gen(function* () {
      const { discord, invoke, getStarted } = yield* setup();
      const source = discord.addMessage("10", "https://example.test/stale", at - 100);
      if (kind === "listed-deleted") {
        discord.addThread("10", source.id, "⚠️ Given", "bot", true);
        omitEmbeddedThreads(discord);
      }
      discord.faults.push({
        method: "GET",
        path: `/channels/10/messages/${source.id}`,
        status: kind === "unlisted-edited" ? 200 : 404,
        ...(kind === "unlisted-edited" && { body: { ...source, content: "no link here" } }),
      });
      const { logs, layer } = captureLogs();
      expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
      expect(logs.join(" ")).toContain("Pending 0, In progress 0, Given up 0");
      expect(getStarted()).toBe(0);
    }),
  );

for (const [description, invalid] of [
  ["wrong channel type", { type: 0 }],
  ["wrong parent", { parent_id: "11" }],
  ["missing owner", { owner_id: undefined }],
  ["missing name", { name: undefined }],
  ["missing thread metadata", { thread_metadata: undefined }],
] as const)
  it.effect(`dry-run rejects a direct thread with ${description}`, () =>
    Effect.gen(function* () {
      const { discord, invoke, getStarted } = yield* setup();
      const source = discord.addMessage("10", "https://example.test/source", at - 100);
      discord.addThread("10", source.id, "⏳ Draft", "bot", true);
      omitEmbeddedThreads(discord);
      omitArchivedThreads(discord);
      discord.faults.push({
        method: "GET",
        path: `/channels/${source.id}`,
        status: 200,
        body: {
          id: source.id,
          type: 11,
          parent_id: "10",
          owner_id: "bot",
          name: "⏳ Draft",
          thread_metadata: { archived: false },
          ...invalid,
        },
      });
      expect((yield* Effect.flip(invoke(true))).message).toContain("Invalid Summary Thread");
      expect(getStarted()).toBe(0);
    }),
  );

it.effect("dry-run propagates forbidden direct thread reads", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const source = discord.addMessage("10", "https://example.test/source", at - 100);
    discord.faults.push({ method: "GET", path: `/channels/${source.id}`, status: 403 });
    expect(yield* Effect.flip(invoke(true))).toMatchObject({ kind: "forbidden" });
  }),
);

it.effect("dry-run classifies normally embedded bot threads without listing them twice", () =>
  Effect.gen(function* () {
    const { discord, invoke, getStarted } = yield* setup();
    const started = discord.addMessage("10", "https://example.test/started", at - 1000);
    const given = discord.addMessage("10", "https://example.test/given", at - 900);
    discord.addMessage("10", "https://example.test/pending", at - 800);
    discord.addThread("10", started.id, "⏳ Started", "bot");
    discord.addThread("10", given.id, "⚠️ Given", "bot", true);
    discord.faults.push({
      method: "GET",
      path: "/guilds/guild/threads/active",
      status: 200,
      body: { threads: [] },
    });
    omitArchivedThreads(discord);
    discord.faults.push({ method: "GET", path: `/channels/${started.id}`, status: 404 });
    discord.faults.push({ method: "GET", path: `/channels/${given.id}`, status: 404 });
    const { logs, layer } = captureLogs();
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Pending 1, In progress 1, Given up 1");
    expect(getStarted()).toBe(0);
  }),
);

for (const mode of ["active", "archived", "direct"] as const)
  for (const journaled of [false, true])
    it.effect(
      `dry-run classifies ${mode} threads without embedded state, ${journaled ? "journaled" : "new"}`,
      () =>
        Effect.gen(function* () {
          const { discord, invoke, getStarted } = yield* setup();
          const started = discord.addMessage("10", "https://example.test/started", at - 86_400_000);
          const given = discord.addMessage("10", "https://example.test/given", at - 85_000_000);
          const done = discord.addMessage("10", "https://example.test/done", at - 84_000_000);
          const foreign = discord.addMessage("10", "https://example.test/foreign", at - 83_000_000);
          discord.addMessage("10", "https://example.test/pending", at - 100);
          if (journaled) {
            const { journal } = yield* openRecord(discord);
            const marked = yield* journalPage(journal, [started.id, given.id, done.id, foreign.id]);
            yield* journalStatus(marked, { id: done.id, state: "terminal" });
          }
          discord.addThread("10", started.id, "⏳ Started", "bot", mode === "archived");
          discord.addThread("10", given.id, "⚠️ Given", "bot", true);
          discord.addThread("10", done.id, "Done", "bot", true);
          discord.addThread("10", foreign.id, "⏳ Foreign", "human");
          omitEmbeddedThreads(discord);
          if (mode === "direct") {
            discord.faults.push({
              method: "GET",
              path: "/guilds/guild/threads/active",
              status: 200,
              body: { threads: [] },
            });
            omitArchivedThreads(discord);
          }
          const messages = structuredClone(discord.messages);
          const threads = structuredClone(discord.threads);
          const { logs, layer } = captureLogs();
          expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
          expect(logs.join(" ")).toContain("Pending 1, In progress 1, Given up 1");
          expect(logs.join(" ")).not.toContain("(partial)");
          expect(discord.messages).toEqual(messages);
          expect(discord.threads).toEqual(threads);
          expect(getStarted()).toBe(0);
        }),
    );

it.effect("dry-run counts owned active and archived work, not unrelated or terminal threads", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const { journal } = yield* openRecord(discord);
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
    const oldGiven = discord.addMessage("10", "https://example.test/given", old + 5);
    discord.addThread("10", oldGiven.id, "⚠️ Given", "bot", true);
    const oldDone = discord.addMessage("10", "https://example.test/done", old + 6);
    discord.addThread("10", oldDone.id, "Done", "bot", true);
    const recent = discord.addMessage("10", "https://example.test/recent", at - 100);
    discord.addThread("10", recent.id, "⏳ Recent", "bot", true);
    const marked = yield* journalPage(journal, [finished.id, recent.id]);
    yield* journalStatus(marked, { id: finished.id, state: "terminal" });
    discord.faults.push({
      method: "GET",
      path: `/channels/10/messages/${foreign.id}`,
      status: 403,
    });
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
      const { journal } = yield* openRecord(discord);
      yield* journalPage(journal, [started.id, oldPending.id]);
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
    const { journal } = yield* openRecord(discord);
    const excluded = discord.addMessage("10", "https://example.test/excluded", old + 1);
    yield* journalPage(journal, [source.id, excluded.id]);
    discord.addThread("10", source.id, "⏳ Journaled", "bot", true);
    discord.addThread("10", excluded.id, "⚠️ Given", "bot", true);
    omitArchivedThreads(discord);
    const { logs, layer } = captureLogs();
    expect(yield* invokeWith(sinceDaysAgo(2), true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Pending 0, In progress 1, Given up 0");
  }),
);

it.effect("dry-run keeps after-Since journaled Given-up work when archive listings omit it", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const given = discord.addMessage("10", "https://example.test/given", old);
    const { journal } = yield* openRecord(discord);
    yield* journalPage(journal, [given.id]);
    discord.addThread("10", given.id, "⚠️ Given", "bot", true);
    omitArchivedThreads(discord);
    discord.faults.push({ method: "GET", path: `/channels/${given.id}`, status: 404 });
    const { logs, layer } = captureLogs();
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Pending 0, In progress 0, Given up 1");
  }),
);
