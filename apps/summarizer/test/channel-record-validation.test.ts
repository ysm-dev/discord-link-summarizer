import { expect, it } from "./progress-fixture.ts";
import { Effect } from "effect";
import { ProgressStore } from "../src/progress-store.ts";
import { journalPage, journalStatus, readJournal, type Status } from "../src/channel-record.ts";
import { now, open, prepare } from "./channel-record-fixture.ts";

it.effect("reports actionable reasons for corrupt dates, cursors and duplicate entries", () =>
  Effect.gen(function* () {
    yield* prepare;
    const journal = yield* open();
    const store = yield* ProgressStore;
    for (const [data, reason] of [
      [{ record: { ...journal.record, since: "invalid" }, entries: [] }, "invalid Since"],
      [
        { record: { ...journal.record, phase: "scan" }, entries: [] },
        "Invalid record phase/cursors",
      ],
      [
        {
          record: journal.record,
          entries: [
            { id: "1", status: null },
            { id: "1", status: null },
          ],
        },
        "Invalid journal entries",
      ],
    ] as const) {
      yield* store.change("10", () => JSON.stringify(data));
      const error = yield* Effect.flip(readJournal("10"));
      expect(error).toMatchObject({ _tag: "RecordError" });
      expect(error.message).toContain(reason);
    }
  }),
);

it.effect("corrupt persisted records fail closed instead of resetting onboarding", () =>
  Effect.gen(function* () {
    yield* prepare;
    const initial = yield* open();
    const store = yield* ProgressStore;
    for (const change of [
      { channel: "11" },
      { channel: "01" },
      { floor: "x" },
      { floor: "x1" },
      { onboarding: "01" },
      { onboarding: "1x" },
      { phase: "scan" },
      { high: "1" },
      { before: "1" },
      { phase: "work", high: "1" },
      { phase: "scan", before: "1" },
      { since: "invalid" },
      { since: new Date(now).toISOString().replace("Z", "+00:00") },
      { recentBefore: "1" },
      { recentFloor: "1" },
      { recentSince: initial.record.since },
      { recentReset: "1" },
      { extra: true },
    ]) {
      yield* store.change("10", () =>
        JSON.stringify({ record: { ...initial.record, ...change }, entries: [] }),
      );
      expect(yield* Effect.exit(readJournal("10"))).toMatchObject({ _tag: "Failure" });
    }
  }),
);

it.effect("invalid READY and non-READY fields are rejected without changing durable entries", () =>
  Effect.gen(function* () {
    yield* prepare;
    const journal = yield* journalPage(yield* open(), ["1"]);
    const base: Status = { id: "1", state: "ready", count: 1, parts: ["2"], hash: "a".repeat(64) };
    for (const status of [
      { ...base, count: 0 },
      { ...base, count: 0, parts: [] },
      { ...base, count: -1 },
      { ...base, count: 1.5 },
      { ...base, count: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, count: 2 },
      { ...base, count: 2, parts: ["2", "2"] },
      { ...base, count: 1, parts: ["2", "2"] },
      { ...base, hash: "a".repeat(63) },
      { ...base, hash: "a".repeat(65) },
      { ...base, hash: "g".repeat(64) },
      { ...base, hash: "A".repeat(64) },
      { ...base, parts: ["2x"] },
      { id: "1", state: "ready" as const, count: 1, hash: base.hash! },
      { id: "1", state: "ready" as const },
      { id: "1", state: "pending" as const, count: 1 },
      { id: "1", state: "pending" as const, hash: base.hash! },
      { id: "1", state: "terminal" as const, parts: ["2"] },
    ]) {
      const error = yield* Effect.flip(journalStatus(journal, status));
      expect(error.message).toContain(
        "parts" in status && status.parts?.includes("2x")
          ? '["parts"][0]'
          : "Invalid journal status",
      );
      expect(yield* readJournal("10")).toEqual(journal);
    }
  }),
);

it.effect("duplicate, mismatched and malformed persisted entries cannot be replayed", () =>
  Effect.gen(function* () {
    yield* prepare;
    const journal = yield* open();
    const store = yield* ProgressStore;
    for (const entries of [
      [
        { id: "1", status: null },
        { id: "1", status: null },
      ],
      [{ id: "1", status: { id: "2", state: "pending" } }],
      [{ id: "1", status: { id: "1", state: "other" } }],
      [{ id: "x", status: null }],
      [{ id: "1", status: { id: "1", state: "ready", count: 1, hash: "a".repeat(64) } }],
    ]) {
      yield* store.change("10", () => JSON.stringify({ record: journal.record, entries }));
      expect(yield* Effect.exit(readJournal("10"))).toMatchObject({ _tag: "Failure" });
    }
  }),
);
