import { expect, it } from "./progress-fixture.ts";
import { DateTime, Effect } from "effect";
import {
  adoptInProgress,
  beginScan,
  dueJournalIds,
  rewindRecent,
  scanPages,
} from "../src/channel-discovery.ts";
import { journalPage, journalStatus, settleRecord, updateRecord } from "../src/channel-record.ts";
import { horizon, now, open, prepare, settledDone, since } from "./channel-record-fixture.ts";

it.effect("empty scans and Since changes preserve boundaries and unfinished work", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    let journal = yield* open();
    expect(yield* beginScan(api, journal)).toEqual(journal);
    expect(yield* rewindRecent(api, "bot", journal, since, horizon)).toEqual(journal);
    const post = fake.addMessage("10", "https://one.test", now - 100);
    journal = yield* beginScan(api, journal);
    expect(yield* beginScan(api, journal)).toEqual(journal);
    fake.messages.set("10", []);
    journal = yield* scanPages(api, "bot", journal, 1);
    expect(journal.record.phase).toBe("work");
    journal = yield* settleRecord(journal);
    expect(journal.record.floor).toBe(post.id);
    journal = yield* rewindRecent(
      api,
      "bot",
      journal,
      DateTime.makeUnsafe(now - 86400000),
      horizon,
    );
    expect(journal.record.floor).toBe(post.id);
    journal = yield* rewindRecent(api, "bot", journal, since, horizon);
    expect(journal.record.floor).toBe(journal.record.onboarding);
  }),
);

it.effect(
  "a deleted completion rewinds progress while a later Since preserves active discovery",
  () =>
    Effect.gen(function* () {
      const { fake, api, post, journal } = yield* settledDone;
      fake.threads.delete(post.id);
      const reset = yield* rewindRecent(api, "bot", journal, since, horizon);
      expect(reset.record.floor).toBe((BigInt(post.id) - 1n).toString());
      expect(reset.entries.get(post.id)?.state).toBe("pending");
      const scanning = yield* beginScan(api, reset);
      const later = yield* rewindRecent(
        api,
        "bot",
        scanning,
        DateTime.makeUnsafe(now - 1000),
        horizon,
      );
      expect(later.record.phase).toBe("scan");
      expect(later.record.before).toBe(scanning.record.before);
    }),
);

it.effect("recent rescan crosses full pages and finds deleted sources after journal cleanup", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const journal = yield* open();
    const deleted = fake.addMessage("10", "https://deleted.test", now - 5000);
    for (let i = 0; i < 104; i++) fake.addMessage("10", "noise", now - 4900 + i);
    const settled = yield* updateRecord(journal, { ...journal.record, floor: deleted.id });
    const reset = yield* rewindRecent(api, "bot", settled, since, horizon);
    expect(reset.record.floor).toBe((BigInt(deleted.id) - 1n).toString());
    expect(reset.entries.get(deleted.id)?.state).toBe("pending");
  }),
);

it.effect("archive pagination without a continuation cursor fails visibly", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    fake.faults.push({
      method: "GET",
      path: "/channels/10/threads/archived/public",
      status: 200,
      body: { threads: [], has_more: true },
    });
    expect(
      (yield* Effect.flip(adoptInProgress(api, "bot", yield* open(), "guild", Infinity))).message,
    ).toContain("cursor");
  }),
);

it.effect(
  "cross-channel order compares integer IDs, preserving ties and excluding terminal work",
  () =>
    Effect.gen(function* () {
      yield* prepare;
      const journal = yield* journalPage(yield* open(), ["10", "2", "1"]);
      const updated = yield* journalStatus(journal, { id: "1", state: "terminal" });
      const other = {
        ...journal,
        record: { ...journal.record, channel: "11" },
        entries: new Map([["2", undefined]]),
      };
      expect(dueJournalIds([updated, other])).toEqual([
        { channel: "10", id: "2" },
        { channel: "11", id: "2" },
        { channel: "10", id: "10" },
      ]);
      expect(dueJournalIds([other, updated])).toEqual([
        { channel: "11", id: "2" },
        { channel: "10", id: "2" },
        { channel: "10", id: "10" },
      ]);
    }),
);
