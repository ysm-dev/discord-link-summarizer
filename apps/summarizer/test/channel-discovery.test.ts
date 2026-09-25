import { expect, it } from "./progress-fixture.ts";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { beginScan, rewindRecent, scanPages } from "../src/channel-discovery.ts";
import {
  journalPage,
  journalStatus,
  readJournal,
  snowflakeAt,
  updateRecord,
} from "../src/channel-record.ts";
import { adoptInProgress } from "../src/channel-discovery.ts";
import { horizon, journaledLink, now, open, prepare, since } from "./channel-record-fixture.ts";
import { at, openRecord, setup } from "./run-fixture.ts";

it.effect(
  "a rescan deadline preserves existing cursors and never returns an unpersisted new cursor",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const post = fake.addMessage("10", "https://example.test", now - 100);
      const journal = yield* open();
      expect(yield* rewindRecent(api, "bot", journal, since, horizon, now)).toEqual(journal);
      expect(yield* readJournal("10")).toEqual(journal);
      const partial = yield* updateRecord(journal, {
        ...journal.record,
        recentBefore: post.id,
        recentFloor: journal.record.floor,
        recentSince: journal.record.since,
      });
      expect(yield* rewindRecent(api, "bot", partial, since, horizon, now)).toEqual(partial);
      expect(yield* readJournal("10")).toEqual(partial);
    }),
);

it.effect(
  "an interrupted recent page returns the same durable continuation that the next Run reads",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const older = fake.addMessage("10", "https://older.test", now - 200);
      const newer = fake.addMessage("10", "https://newer.test", now - 100);
      const delayed = {
        ...api,
        listMessages: (channel: string, before?: string) =>
          api
            .listMessages(channel, before)
            .pipe(Effect.tap(() => (before ? TestClock.adjust("2 seconds") : Effect.void))),
      };
      const partial = yield* rewindRecent(
        delayed,
        "bot",
        yield* open(),
        since,
        horizon,
        now + 1000,
      );
      expect(partial.record.recentBefore).toBe(newer.id);
      expect(partial.record.recentBefore).not.toBe(older.id);
      expect(yield* readJournal("10")).toEqual(partial);
    }),
);

it.effect("an empty first archive page leaves the record unchanged", () =>
  Effect.gen(function* () {
    const { api } = yield* prepare;
    const journal = yield* open();
    expect(yield* adoptInProgress(api, "bot", journal, "guild", Infinity)).toEqual(journal);
  }),
);

it.effect(
  "recent checks ignore old and non-link posts but propagate a recent link lookup failure",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const journal = yield* open();
      const old = fake.addMessage("10", "https://old.test", now - 9 * 86400000);
      fake.addMessage("10", "no link here", now - 100);
      expect(yield* rewindRecent(api, "bot", journal, since, horizon)).toEqual(journal);
      fake.faults.push({ method: "GET", path: `/channels/${old.id}`, status: 403 });
      expect(yield* rewindRecent(api, "bot", journal, since, horizon)).toEqual(journal);
      const recent = fake.addMessage("10", "https://recent.test", now - 50);
      fake.faults.push({ method: "GET", path: `/channels/${recent.id}`, status: 403 });
      expect(yield* Effect.flip(rewindRecent(api, "bot", journal, since, horizon))).toMatchObject({
        kind: "forbidden",
      });
    }),
);

it.effect("only settled or terminal links trigger a recent deletion reset", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const noise = fake.addMessage("10", "plain", now - 300);
    const pending = fake.addMessage("10", "https://pending.test", now - 200);
    const done = fake.addMessage("10", "https://done.test", now - 100);
    const { journal } = yield* journaledLink(fake, now - 50);
    let record = yield* updateRecord(journal, { ...journal.record, floor: noise.id });
    record = yield* journalStatus(record, { id: [...record.entries.keys()][0]!, state: "pending" });
    expect(yield* rewindRecent(api, "bot", record, since, horizon)).toEqual(record);
    record = yield* journalPage(record, [done.id]);
    record = yield* journalStatus(record, { id: done.id, state: "terminal" });
    const reset = yield* rewindRecent(api, "bot", record, since, horizon);
    expect(reset.entries.get(done.id)?.state).toBe("pending");
    expect(reset.entries.has(pending.id)).toBe(false);
  }),
);

it.effect("a deleted post exactly at the recent lower bound is rechecked", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const boundary = (BigInt(snowflakeAt(now - 7 * 86400000)) - 1n).toString();
    const source = fake.addMessage("10", "https://boundary.test", now - 7 * 86400000);
    fake.messages.set("10", [{ ...source, id: boundary }]);
    const journal = yield* journalPage(yield* open(), [boundary]);
    const terminal = yield* journalStatus(journal, { id: boundary, state: "terminal" });
    const reset = yield* rewindRecent(api, "bot", terminal, since, horizon);
    expect(reset.entries.get(boundary)?.state).toBe("pending");
  }),
);

for (const extra of [0, 1])
  it.effect(`a complete page crossing the exclusive floor excludes covered links (${extra})`, () =>
    Effect.gen(function* () {
      const { discord, invoke } = yield* setup();
      const { api, journal } = yield* openRecord(discord);
      const boundary = discord.addMessage("10", "https://boundary.test", at - 7 * 86400000);
      const covered = (BigInt(journal.record.floor) - BigInt(extra)).toString();
      discord.messages.set("10", [{ ...boundary, id: covered }]);
      discord.addThread("10", covered, "Done", "bot", true);
      discord.addMessage(covered, "Already summarized", at - 1000, "bot");
      const due = discord.addMessage("10", "https://due.test", at - 100);
      for (let i = 0; i < 98; i++) discord.addMessage("10", `plain ${i}`, at - i);
      const scan = yield* beginScan(api, journal);
      const finished = yield* scanPages(api, "bot", scan, 2);
      expect(finished.record.phase).toBe("work");
      expect([...finished.entries.keys()]).toEqual([due.id]);
      expect(
        discord.requests.filter((r) =>
          r.path.includes(`before=${(BigInt(journal.record.floor) - BigInt(extra)).toString()}`),
        ),
      ).toHaveLength(0);
      expect(yield* invoke()).toBe(0);
      expect(discord.threads.get(due.id)?.thread_metadata.archived).toBe(true);
      expect(discord.threads.size).toBe(2);
      expect(discord.messages.get(covered)?.map((m) => m.content)).toEqual(["Already summarized"]);
    }),
  );

it.effect("a late post beyond the snapshot waits for the next scan", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const old = fake.addMessage("10", "https://old.test", now - 100);
    const journal = yield* beginScan(api, yield* open());
    const late = fake.addMessage("10", "https://late.test", now + 100);
    const inconsistent = {
      ...api,
      listMessages: (channel: string, before?: string) =>
        api.listMessages(channel, before).pipe(Effect.map((page) => [late, ...page])),
    };
    expect([...(yield* scanPages(inconsistent, "bot", journal, 1)).entries.keys()]).toEqual([
      old.id,
    ]);
    const completed = yield* updateRecord(yield* open(), { ...journal.record, phase: "work" });
    expect(yield* beginScan(api, completed)).toEqual(completed);
    expect(yield* scanPages(api, "bot", completed, 1)).toEqual(completed);
  }),
);
