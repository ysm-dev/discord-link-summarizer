import { expect, it } from "./progress-fixture.ts";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { adoptInProgress, beginScan, dueJournalIds, scanPages } from "../src/channel-discovery.ts";
import { journalPage, journalStatus, readJournal, settleRecord } from "../src/channel-record.ts";
import { now, open, prepare, settledDone } from "./channel-record-fixture.ts";
import { at, openRecord, setup } from "./run-fixture.ts";

it.effect("adopts archived In-progress work across multiple pages in one Run", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const old = fake.addMessage("10", "https://old.test", now - 20 * 86400000);
    fake.addThread("10", old.id, "⏳ Old", "bot", true, now - 20 * 86400000);
    for (let i = 0; i < 101; i++) {
      const source = fake.addMessage("10", "https://other.test", now - i);
      fake.addThread("10", source.id, "Other", "human", true, now - i);
    }
    const adopted = yield* adoptInProgress(api, "bot", yield* open(), "guild", Infinity);
    expect(dueJournalIds([adopted])).toEqual([{ channel: "10", id: old.id }]);
  }),
);

it.effect(
  "a confirmed page survives a Run reload without duplicate summaries or bookkeeping posts",
  () =>
    Effect.gen(function* () {
      const { discord, invoke } = yield* setup();
      const source = discord.addMessage("10", "https://example.test/reloaded", at - 100);
      yield* journalPage((yield* openRecord(discord)).journal, [source.id]);
      expect(yield* invoke()).toBe(0);
      expect(yield* invoke()).toBe(0);
      expect(
        discord.messages.get(source.id)?.filter((m) => m.content === "안녕하세요"),
      ).toHaveLength(1);
      expect(discord.threads.size).toBe(1);
      expect(discord.requests.some((r) => r.path.startsWith("/channels/20"))).toBe(false);
    }),
);

for (const delay of [0, 1000, 2000])
  it.effect(`persists archived pagination at or beyond the budget (${delay})`, () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const ids = Array.from({ length: 101 }, (_, i) => {
        const source = fake.addMessage("10", `https://example.test/${i}`, now - 1000 + i);
        fake.addThread("10", source.id, "⏳ Pending", "bot", true, now - 1000 + i);
        return source.id;
      });
      const delayed = {
        ...api,
        listActiveThreads: (guild: string) =>
          api.listActiveThreads(guild).pipe(Effect.tap(() => TestClock.adjust(delay))),
      };
      const partial = yield* adoptInProgress(delayed, "bot", yield* open(), "guild", now + delay);
      expect(partial.record.archiveBefore).toBeDefined();
      expect(partial.record.archiveBefore).toBe(new Date(now - 999).toISOString());
      expect(partial.entries.size).toBe(100);
      expect(dueJournalIds([partial])).toEqual([]);
      const cursors: (string | undefined)[] = [];
      const resumed = yield* adoptInProgress(
        {
          ...api,
          listArchivedThreads: (channel, before) => {
            cursors.push(before);
            return api.listArchivedThreads(channel, before);
          },
        },
        "bot",
        yield* open(),
        "guild",
        Infinity,
      );
      expect(cursors).toEqual([partial.record.archiveBefore]);
      expect(resumed.record.archiveBefore).toBeNull();
      expect(resumed.entries.size).toBe(101);
      expect(ids.every((id) => resumed.entries.has(id))).toBe(true);
    }),
  );

it.effect("advances the floor and clears terminal entries atomically over repeated epochs", () =>
  Effect.gen(function* () {
    const { fake, api, journal: first } = yield* settledDone;
    expect(yield* beginScan(api, first)).toEqual(first);
    const newer = fake.addMessage("10", "https://example.test/new", now - 50);
    let journal = yield* beginScan(api, yield* open());
    journal = yield* scanPages(api, "bot", journal, 1);
    yield* journalStatus(journal, { id: newer.id, state: "terminal" });
    journal = yield* settleRecord(journal);
    expect(BigInt(journal.record.floor)).toBeGreaterThan(BigInt(first.record.floor));
    expect(journal.record.floor).toBe(newer.id);
    expect(journal.entries.size).toBe(0);
    expect(yield* readJournal("10")).toEqual(journal);
  }),
);

it.effect(
  "adopts only owned In-progress threads and blocks all work during incomplete discovery",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      for (const [channel, owner, name] of [
        ["10", "human", "⏳ Human"],
        ["10", "bot", "Done"],
        ["20", "bot", "⏳ Other"],
      ]) {
        const source = fake.addMessage(channel!, "https://example.test", now - 100);
        fake.addThread(channel!, source.id, name!, owner);
      }
      const pending = fake.addMessage("10", "https://pending.test", now);
      fake.addThread("10", pending.id, "⏳ Pending", "bot");
      const adopted = yield* adoptInProgress(api, "bot", yield* open(), "guild", Infinity);
      expect([...adopted.entries.keys()]).toEqual([pending.id]);
      expect((yield* adoptInProgress(api, "bot", adopted, "guild", Infinity)).entries.size).toBe(1);
      const scanning = yield* beginScan(api, adopted);
      yield* journalStatus(scanning, { id: pending.id, state: "terminal" });
      const unsettled = yield* settleRecord(scanning);
      expect(unsettled.record.phase).toBe("scan");
      expect(unsettled.entries.get(pending.id)?.state).toBe("terminal");
      expect(dueJournalIds([adopted, scanning])).toEqual([]);
    }),
);
