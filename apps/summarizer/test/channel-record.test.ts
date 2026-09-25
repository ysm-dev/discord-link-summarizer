import { expect, it } from "./progress-fixture.ts";
import { DateTime, Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { beginScan, dueJournalIds, scanPages } from "../src/channel-discovery.ts";
import {
  journalPage,
  journalStatus,
  openChannelRecord,
  readJournal,
  settleRecord,
  snowflakeAt,
  updateRecord,
} from "../src/channel-record.ts";
import { ProgressStore } from "../src/progress-store.ts";
import { now, open, prepare, since } from "./channel-record-fixture.ts";

it.effect("onboarding persists its original floor without creating any Discord bookkeeping", () =>
  Effect.gen(function* () {
    const { fake } = yield* prepare;
    expect(yield* readJournal("10")).toBeUndefined();
    const first = yield* open();
    expect(first.record).toEqual({
      channel: "10",
      onboarding: (BigInt(snowflakeAt(now - 7 * 86400000)) - 1n).toString(),
      floor: first.record.onboarding,
      since: DateTime.formatIso(since),
      high: null,
      before: null,
      phase: "idle",
      recentReset: null,
    });
    yield* TestClock.adjust("30 days");
    expect(yield* openChannelRecord("10", DateTime.makeUnsafe(now), Duration.days(1))).toEqual(
      first,
    );
    expect(fake.messages.size).toBe(0);
    expect(fake.threads.size).toBe(0);
    expect(fake.requests).toHaveLength(0);
    expect(snowflakeAt(0)).toBe("0");
    expect(snowflakeAt(1420070400000.1)).toBe("4194304");
  }),
);

it.effect(
  "resumes discovery before working younger links, and settles only when all work is terminal",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const old = fake.addMessage("10", "https://old.test", now - 3000);
      for (let i = 0; i < 104; i++) fake.addMessage("10", "noise", now - 2000 + i);
      const young = fake.addMessage("10", "https://young.test", now - 100);
      let journal = yield* beginScan(api, yield* open());
      journal = yield* scanPages(api, "bot", journal, 1);
      expect(journal.record.phase).toBe("scan");
      expect(dueJournalIds([journal])).toEqual([]);
      expect(journal.entries.has(young.id)).toBe(true);
      expect(yield* settleRecord(journal)).toEqual(journal);
      journal = yield* scanPages(api, "bot", yield* open(), 1);
      expect(dueJournalIds([journal]).map(({ id }) => id)).toEqual([old.id, young.id]);
      yield* journalStatus(journal, { id: young.id, state: "terminal" });
      expect((yield* settleRecord(journal)).record.floor).toBe(journal.record.floor);
      yield* journalStatus(journal, { id: old.id, state: "terminal" });
      journal = yield* settleRecord(journal);
      expect(journal.record.phase).toBe("idle");
      expect(journal.record.floor).toBe(young.id);
      expect(journal.entries.size).toBe(0);
      expect(yield* readJournal("10")).toEqual(journal);
    }),
);

it.effect("stale concurrent snapshots preserve other statuses, pages, and record updates", () =>
  Effect.gen(function* () {
    yield* prepare;
    const first = yield* journalPage(yield* open(), ["1", "2"]);
    yield* Effect.all(
      [
        journalStatus(first, { id: "1", state: "terminal" }),
        journalStatus(first, { id: "2", state: "pending" }),
      ],
      { concurrency: 2 },
    );
    yield* journalPage(first, ["1", "3"]);
    const updated = yield* updateRecord(first, {
      ...first.record,
      since: DateTime.formatIso(DateTime.makeUnsafe(now)),
    });
    expect([...updated.entries]).toEqual([
      ["1", { id: "1", state: "terminal" }],
      ["2", { id: "2", state: "pending" }],
      ["3", undefined],
    ]);
    expect((yield* settleRecord(first)).entries.size).toBe(3);
    yield* journalStatus(first, { id: "1", state: "pending" });
    yield* journalStatus(first, { id: "1", state: "terminal" });
    const replay = yield* journalStatus(first, { id: "1", state: "terminal" });
    expect(replay.record.since).toBe(updated.record.since);
    expect(replay.entries.get("1")?.state).toBe("terminal");
  }),
);

it.effect(
  "rejects invalid transitions and missing records without committing partial changes",
  () =>
    Effect.gen(function* () {
      yield* prepare;
      const empty = yield* open();
      expect(
        (yield* Effect.flip(journalStatus(empty, { id: "1", state: "terminal" }))).message,
      ).toContain("without journaled");
      const journal = yield* journalPage(empty, ["1"]);
      const ready = {
        id: "1",
        state: "ready" as const,
        count: 1,
        parts: ["2"],
        hash: "a".repeat(64),
      };
      yield* journalStatus(journal, ready);
      expect(yield* journalStatus(journal, ready)).toEqual(yield* readJournal("10"));
      expect(
        (yield* Effect.flip(journalStatus(journal, { ...ready, hash: "b".repeat(64) }))).message,
      ).toContain("transition");
      yield* journalStatus(journal, { id: "1", state: "terminal" });
      expect((yield* Effect.flip(journalStatus(journal, ready))).message).toContain("transition");
      const missing = { ...empty, record: { ...empty.record, channel: "99" } };
      expect((yield* Effect.flip(journalPage(missing, ["1"]))).message).toContain(
        "Missing Channel Record",
      );
      expect(
        (yield* Effect.flip(updateRecord(empty, { ...empty.record, channel: "11" }))).message,
      ).toContain("Mismatched");
      expect((yield* readJournal("10"))?.entries.get("1")?.state).toBe("terminal");
      expect(yield* readJournal("11")).toBeUndefined();
    }),
);

it.effect("the last terminal commit and cleanup use fresh persisted entries", () =>
  Effect.gen(function* () {
    yield* prepare;
    const first = yield* journalPage(yield* open(), ["1"]);
    yield* journalStatus(first, { id: "1", state: "terminal" });
    expect((yield* settleRecord(first)).entries.size).toBe(0);
    expect(yield* settleRecord(yield* open())).toEqual(yield* open());
    const store = yield* ProgressStore;
    yield* store.change("10", () => "broken");
    expect((yield* Effect.flip(readJournal("10"))).message).toContain("JSON");
    expect((yield* Effect.flip(open())).message).toContain("JSON");
  }),
);
