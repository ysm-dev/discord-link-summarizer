import { Effect } from "effect";
import { beginScan, rewindRecent, scanPages } from "../src/channel-discovery.ts";
import {
  journalStatus,
  readJournal,
  settleRecord,
  updateRecord,
  type ChannelRecord,
} from "../src/channel-record.ts";
import { expect, it } from "./progress-fixture.ts";
import { horizon, now, open, prepare, settledDone, since } from "./channel-record-fixture.ts";

it.effect(
  "incremental discovery resumes a partial page range without losing older Pending work",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const older = fake.addMessage("10", "https://example.test/older", now - 1_000);
      const initial = yield* scanPages(api, "bot", yield* beginScan(api, yield* open()), 1);
      const newer = Array.from({ length: 101 }, (_, index) =>
        fake.addMessage("10", `https://example.test/${index}`, now - 500 + index),
      );
      const scanning = yield* beginScan(api, initial);
      expect(scanning.record.scanFloor).toBe(older.id);
      yield* scanPages(api, "bot", scanning, 1);
      const recovered = (yield* readJournal("10"))!;
      expect(recovered.record.scanFloor).toBe(older.id);
      expect(recovered.record.phase).toBe("scan");
      expect(recovered.entries.size).toBe(101);
      const complete = yield* scanPages(api, "bot", recovered, 1);
      expect(complete.entries.size).toBe(102);
      expect(complete.record.scanFloor).toBeUndefined();
      for (const source of newer)
        yield* journalStatus(complete, { id: source.id, state: "terminal" });
      expect((yield* settleRecord(complete)).record.floor).toBe(initial.record.floor);
      yield* journalStatus(complete, { id: older.id, state: "terminal" });
      const settled = yield* settleRecord(complete);
      expect(settled.record.floor).toBe(newer.at(-1)?.id);
      expect(settled.entries.size).toBe(0);
    }),
);

it.effect("rejects incremental scan bounds outside the undiscovered interval", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const post = fake.addMessage("10", "https://example.test/validation", now - 100);
    const scanning = yield* beginScan(api, yield* open());
    const invalid: ChannelRecord[] = [
      { ...scanning.record, scanFloor: (BigInt(scanning.record.floor) - 1n).toString() },
      { ...scanning.record, scanFloor: post.id },
      { ...scanning.record, scanFloor: (BigInt(post.id) + 1n).toString() },
      { ...scanning.record, phase: "work" },
      { ...scanning.record, phase: "idle", high: null, before: null },
    ];
    for (const record of invalid) {
      expect((yield* Effect.flip(updateRecord(scanning, record))).message).toContain(
        "Invalid record phase/cursors",
      );
      expect(yield* readJournal("10")).toEqual(scanning);
    }
  }),
);

it.effect("resumes a legacy scan without an incremental lower bound", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const source = fake.addMessage("10", "https://example.test/legacy", now - 100);
    const scanning = yield* beginScan(api, yield* open());
    const legacy = { ...scanning.record };
    delete legacy.scanFloor;
    yield* updateRecord(scanning, legacy);
    const resumed = yield* scanPages(api, "bot", (yield* readJournal("10"))!, 1);
    expect([...resumed.entries.keys()]).toEqual([source.id]);
    expect(resumed.record.phase).toBe("work");
  }),
);

it.effect("a deletion rewind clears an interrupted incremental bound and retains newer work", () =>
  Effect.gen(function* () {
    const { fake, api, post, journal } = yield* settledDone;
    for (let index = 0; index < 101; index++)
      fake.addMessage("10", `https://example.test/new/${index}`, now + index);
    const partial = yield* scanPages(api, "bot", yield* beginScan(api, journal), 1);
    expect(partial.record.scanFloor).toBe(post.id);
    fake.threads.delete(post.id);
    const rewound = yield* rewindRecent(api, "bot", partial, since, horizon);
    expect(rewound.record.scanFloor).toBeUndefined();
    expect(rewound.record.phase).toBe("idle");
    const rediscovered = yield* scanPages(api, "bot", yield* beginScan(api, rewound), 2);
    expect(rediscovered.entries.size).toBe(102);
    expect(rediscovered.entries.get(post.id)?.state).toBe("pending");
  }),
);
