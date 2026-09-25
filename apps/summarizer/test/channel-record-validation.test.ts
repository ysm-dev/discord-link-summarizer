import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { adoptInProgress, beginScan, rewindRecent, scanPages } from "../src/channel-discovery.ts";
import {
  indexRecords,
  journalPage,
  journalStatus,
  readJournal,
  snowflakeAt,
  updateRecord,
  type Journal,
  type Status,
} from "../src/channel-record.ts";
import { horizon, journaledLink, now, open, prepare, since } from "./channel-record-fixture.ts";

const readyStatusFor = (id: string): Status => ({
  id,
  state: "ready",
  count: 1,
  hash: "a".repeat(64),
  parts: ["1"],
});

it.effect("a deleted READY thread resets to Pending before the next Attempt", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const { source, journal: initial } = yield* journaledLink(fake, api, now - 100);
    let journal: Journal = yield* journalStatus(
      api,
      "20",
      "bot",
      initial,
      readyStatusFor(source.id),
    );
    journal = yield* rewindRecent(api, "20", "bot", journal, since, horizon);
    expect(journal.entries.get(source.id)?.state).toBe("pending");
    expect(
      fake.messages
        .get(journal.parent)
        ?.some((m) => m.content.includes(`"key":"reset/${source.id}:0"`)),
    ).toBe(true);
  }),
);

it.effect("Pending can become READY without discarding its verified parts", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const { source, journal: initial } = yield* journaledLink(fake, api, now);
    let journal: Journal = initial;
    journal = yield* journalStatus(api, "20", "bot", journal, { id: source.id, state: "pending" });
    journal = yield* journalStatus(api, "20", "bot", journal, readyStatusFor(source.id));
    expect((yield* open(api)).journal?.entries.get(source.id)).toEqual(
      journal.entries.get(source.id),
    );
  }),
);

it.effect("recent checks ignore old or non-link posts and propagate read failures", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const journal = (yield* open(api)).journal!;
    const old = fake.addMessage("10", "https://old.test", now - 9 * 86400000);
    fake.addMessage("10", "no link here", now - 100);
    expect(yield* rewindRecent(api, "20", "bot", journal, since, horizon)).toEqual(journal);
    fake.faults.push({ method: "GET", path: `/channels/${old.id}`, status: 403 });
    expect(yield* rewindRecent(api, "20", "bot", journal, since, horizon)).toEqual(journal);
    const recent = fake.addMessage("10", "https://recent.test", now - 50);
    fake.faults.push({ method: "GET", path: `/channels/${recent.id}`, status: 403 });
    expect(
      yield* Effect.flip(rewindRecent(api, "20", "bot", journal, since, horizon)),
    ).toMatchObject({
      kind: "forbidden",
    });
  }),
);

it.effect("a pending recent source without a thread is not an already-deleted completion", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const { source, journal } = yield* journaledLink(fake, api, now - 100);
    const pending = yield* journalStatus(api, "20", "bot", journal, {
      id: source.id,
      state: "pending",
    });
    const baseline = fake.messages.get(journal.parent)?.length;
    expect(yield* rewindRecent(api, "20", "bot", pending, since, horizon)).toEqual(pending);
    expect(fake.messages.get(journal.parent)?.length).toBe(baseline);
  }),
);

it.effect("only settled or terminal link posts trigger recent reset", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const noise = fake.addMessage("10", "noise", now - 300);
    const pending = fake.addMessage("10", "https://pending.test", now - 200);
    const done = fake.addMessage("10", "https://done.test", now - 100);
    const { journal } = yield* journaledLink(fake, api, now - 50);
    let record: Journal = yield* updateRecord(api, "20", journal, {
      ...journal.record,
      floor: noise.id,
    });
    expect(yield* rewindRecent(api, "20", "bot", record, since, horizon)).toEqual(record);
    record = yield* journalPage(api, "bot", record, "terminal", [done.id]);
    record = yield* journalStatus(api, "20", "bot", record, { id: done.id, state: "terminal" });
    const reset = yield* rewindRecent(api, "20", "bot", record, since, horizon);
    expect(reset.entries.get(done.id)?.state).toBe("pending");
    expect(reset.entries.has(pending.id)).toBe(false);
  }),
);

it.effect("a post exactly at the recent boundary is still rechecked", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const boundary = (BigInt(snowflakeAt(now - 7 * 86400000)) - 1n).toString();
    const original = fake.addMessage("10", "https://boundary.test", now - 7 * 86400000);
    fake.messages.set("10", [{ ...original, id: boundary }]);
    const journal = yield* journaledLink(fake, api, now - 100);
    let record: Journal = yield* updateRecord(api, "20", journal.journal, {
      ...journal.journal.record,
      floor: (BigInt(boundary) - 1n).toString(),
    });
    record = yield* journalPage(api, "bot", record, "boundary", [boundary]);
    record = yield* journalStatus(api, "20", "bot", record, { id: boundary, state: "terminal" });
    expect(
      (yield* rewindRecent(api, "20", "bot", record, since, horizon)).entries.get(boundary)?.state,
    ).toBe("pending");
  }),
);

it.effect("a page crossing the exclusive floor finishes even at exactly 100 messages", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const journal = (yield* open(api)).journal!;
    const boundary = fake.addMessage("10", "https://excluded.test", now - 7 * 86400000);
    fake.messages.set("10", [{ ...boundary, id: journal.record.floor }]);
    for (let i = 0; i < 99; i++) fake.addMessage("10", `https://due.test/${i}`, now - i);
    const scan = yield* beginScan(api, "20", journal);
    const worked = yield* scanPages(api, "20", "bot", scan, 1);
    expect(worked.record.phase).toBe("work");
    expect(worked.entries.size).toBe(99);
    expect(worked.entries.has(journal.record.floor)).toBe(false);
    expect(yield* scanPages(api, "20", "bot", worked, 1)).toEqual(worked);
    expect(yield* beginScan(api, "20", worked)).toEqual(worked);
  }),
);

it.effect("a late message above the epoch snapshot cannot enter its journal", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const old = fake.addMessage("10", "https://old.test", now - 100);
    const journal = yield* beginScan(api, "20", (yield* open(api)).journal!);
    const late = fake.addMessage("10", "https://late.test", now + 100);
    const inconsistent = {
      ...api,
      listMessages: (channel: string, before?: string) =>
        channel === "10" && before
          ? api.listMessages(channel, before).pipe(Effect.map((page) => [late, ...page]))
          : api.listMessages(channel, before),
    };
    const worked = yield* scanPages(inconsistent, "20", "bot", journal, 1);
    expect([...worked.entries.keys()]).toEqual([old.id]);
  }),
);

it.effect("work phase never scans a second page after discovery completes", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    fake.addMessage("10", "https://one.test", now - 100);
    const journal = yield* beginScan(api, "20", (yield* open(api)).journal!);
    const worked = yield* scanPages(api, "20", "bot", journal, 2);
    expect(worked.record.phase).toBe("work");
    expect(fake.requests.filter((r) => r.path.startsWith("/channels/10/messages?")).length).toBe(2);
  }),
);

it.effect("an empty archived continuation fails as a missing cursor", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const journal = (yield* open(api)).journal!;
    fake.faults.push({
      method: "GET",
      path: "/channels/10/threads/archived/public",
      status: 200,
      body: { threads: [], has_more: true },
    });
    expect(
      (yield* Effect.flip(adoptInProgress(api, "20", "bot", journal, "guild", Infinity))).message,
    ).toContain("cursor");
  }),
);

it.effect("an alternate spelling of the same Since timestamp cannot cause a backfill", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const post = fake.addMessage("10", "https://done.test", now - 100);
    fake.addThread("10", post.id, "Done", "bot");
    const journal = (yield* open(api)).journal!;
    const alternate = new Date(Date.parse(journal.record.since))
      .toISOString()
      .replace("Z", "+00:00");
    const changed = yield* updateRecord(api, "20", journal, {
      ...journal.record,
      since: alternate,
      floor: post.id,
    });
    const reset = yield* rewindRecent(api, "20", "bot", changed, since, horizon);
    expect(reset.record.floor).toBe(post.id);
    expect(reset.record.since).toBe(journal.record.since);
  }),
);

it.effect(
  "strict record and journal decoding rejects wrong identity, cursor combinations and excess fields",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      for (let i = 0; i < 101; i++) fake.addMessage("20", "operator chatter", now + i, "human");
      const journal = (yield* open(api)).journal!;
      expect((yield* indexRecords(api, "20", "bot")).get("10")?.parent).toBe(journal.parent);
      const original = fake.messages.get("20")!.find((m) => m.id === journal.parent)!;
      const variants = [
        { ...journal.record, phase: "idle", high: "1" },
        { ...journal.record, phase: "idle", before: "1" },
        { ...journal.record, phase: "scan", high: null, before: "1" },
        { ...journal.record, phase: "scan", high: "1", before: null },
        { ...journal.record, phase: "work", high: null, before: "1" },
        { ...journal.record, since: "not-a-date" },
        { ...journal.record, since: "2026-09-15" },
        { ...journal.record, unknown: true },
      ];
      for (const value of variants) {
        fake.messages.set(
          "20",
          fake.messages
            .get("20")!
            .map((m) =>
              m.id === journal.parent
                ? { ...m, content: `DLS1 record ${JSON.stringify(value)}` }
                : m,
            ),
        );
        expect(yield* Effect.exit(indexRecords(api, "20", "bot"))).toMatchObject({
          _tag: "Failure",
        });
        if (value.since === "not-a-date")
          expect((yield* Effect.flip(indexRecords(api, "20", "bot"))).message).toContain(
            "invalid Since",
          );
      }
      fake.messages.set(
        "20",
        fake.messages.get("20")!.map((m) => (m.id === journal.parent ? original : m)),
      );
      fake.addMessage("20", original.content, now + 200, "bot", 18);
      expect((yield* indexRecords(api, "20", "bot")).size).toBe(1);
      const badParent = { ...original, author: { id: "human" } };
      fake.messages.set(
        "20",
        fake.messages.get("20")!.map((m) => (m.id === journal.parent ? badParent : m)),
      );
      expect(
        (yield* Effect.flip(readJournal(api, "20", "bot", journal.parent, journal.record))).message,
      ).toContain("foreign");
      fake.messages.set(
        "20",
        fake.messages.get("20")!.map((m) => (m.id === journal.parent ? original : m)),
      );
    }),
);

it.effect(
  "state thread refuses malformed batches, unknown properties and bot-authored system markers",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const journal = (yield* open(api)).journal!;
      for (const content of [
        'DLS1 batch {"key":"p","ids":["x1"]}',
        'DLS1 batch {"key":"p","ids":["1x"]}',
        'DLS1 batch {"key":"p","ids":"1"}',
        'DLS1 batch {"key":"p","ids":["1"],"extra":true}',
        'DLS1 status {"id":"1","state":"what"}',
      ]) {
        fake.messages.set(journal.parent, []);
        fake.addMessage(journal.parent, content, now, "bot");
        expect(yield* Effect.exit(open(api))).toMatchObject({ _tag: "Failure" });
      }
      fake.messages.set(journal.parent, []);
      fake.addMessage(journal.parent, 'DLS1 batch {"key":"p","ids":["x1"]}', now, "bot");
      expect((yield* Effect.flip(open(api))).message).toContain("invalid Snowflake");
      fake.messages.set(journal.parent, []);
      const duplicate = fake.addMessage("20", fake.messages.get("20")![0]!.content, now, "bot", 18);
      expect((yield* indexRecords(api, "20", "bot")).size).toBe(1);
      fake.messages.set(
        "20",
        fake.messages.get("20")!.filter((m) => m.id !== duplicate.id),
      );
    }),
);

it.effect(
  "READY and terminal statuses require exactly their fields; invalid hashes and part lists fail visibly",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const source = fake.addMessage("10", "https://one.test", now);
      const journal = yield* journalPage(api, "bot", (yield* open(api)).journal!, "page", [
        source.id,
      ]);
      const base = [...fake.messages.get(journal.parent)!];
      const h = "a".repeat(64);
      const cases: readonly Status[] = [
        { id: source.id, state: "ready", count: 0, hash: h, parts: [] },
        { id: source.id, state: "ready", count: 1.5, hash: h, parts: ["1"] },
        { id: source.id, state: "ready", count: 1, hash: h, parts: [] },
        { id: source.id, state: "ready", count: 2, hash: h, parts: ["1", "1"] },
        { id: source.id, state: "ready", count: 2, hash: h, parts: ["1", "2", "3"] },
        { id: source.id, state: "ready", count: 1, hash: `x${h}`, parts: ["1"] },
        { id: source.id, state: "ready", count: 1, hash: `${h}x`, parts: ["1"] },
        { id: source.id, state: "ready", count: 1, parts: ["1"] },
        { id: source.id, state: "terminal", count: 1 },
        { id: source.id, state: "terminal", hash: h },
        { id: source.id, state: "terminal", parts: ["1"] },
        { id: source.id, state: "terminal", first: "1" },
        { id: source.id, state: "terminal", chunks: 1 },
        { id: source.id, state: "ready", count: 1, hash: h, parts: ["1"], first: "1" },
        { id: source.id, state: "ready", count: 1, hash: h, parts: ["1"], chunks: 1 },
      ];
      for (const status of cases) {
        fake.messages.set(journal.parent, base);
        fake.addMessage(journal.parent, `DLS1 status ${JSON.stringify(status)}`, now + 1, "bot");
        expect(yield* Effect.exit(open(api))).toMatchObject({ _tag: "Failure" });
      }
      for (const status of [
        { id: source.id, state: "terminal" as const, chunks: 1 },
        { id: source.id, state: "ready" as const, count: 1, hash: h, parts: ["1"], chunks: 1 },
      ]) {
        fake.messages.set(journal.parent, base);
        expect(
          (yield* Effect.flip(journalStatus(api, "20", "bot", journal, status))).message,
        ).toContain("Invalid journal transition");
        expect(fake.messages.get(journal.parent)).toEqual(base);
      }
      fake.messages.set(journal.parent, base);
      fake.addMessage(
        journal.parent,
        `DLS1 status ${JSON.stringify({ id: source.id, state: "terminal", extra: true })}`,
        now + 1,
        "bot",
      );
      expect(yield* Effect.exit(open(api))).toMatchObject({ _tag: "Failure" });
      fake.messages.set(journal.parent, base);
      expect(
        (yield* Effect.flip(
          journalStatus(api, "20", "bot", journal, {
            id: source.id,
            state: "ready",
            count: 0,
            hash: h,
            parts: [],
          }),
        )).message,
      ).toContain("Invalid journal transition");
      fake.messages.set(journal.parent, base);
      fake.addMessage(
        journal.parent,
        `DLS1 status ${JSON.stringify({ id: source.id, state: "ready", count: 1, parts: ["1"] })}`,
        now,
        "bot",
      );
      expect((yield* Effect.flip(open(api))).message).toContain("Malformed status manifest");
    }),
);

it.effect(
  "parent and journal identity checks fail closed on mismatched IDs, owners and transport permissions",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const journal = (yield* open(api)).journal!;
      const parent = fake.messages.get("20")!.find((m) => m.id === journal.parent)!;
      const originalThread = fake.threads.get(journal.parent)!;
      for (const thread of [
        undefined,
        { ...parent.thread!, owner_id: "human" },
        { ...parent.thread!, parent_id: "11" },
      ]) {
        fake.messages.set("20", [{ ...parent, thread }]);
        expect(
          (yield* Effect.flip(readJournal(api, "20", "bot", journal.parent, journal.record)))
            .message,
        ).toContain("foreign");
      }
      fake.messages.set("20", [parent]);
      for (const change of [{ id: "999" }, { type: 0 }, { owner_id: "human" }]) {
        fake.faults.push({
          method: "GET",
          path: `/channels/${journal.parent}`,
          status: 200,
          body: { ...originalThread, type: 11, ...change },
        });
        expect(
          (yield* Effect.flip(readJournal(api, "20", "bot", journal.parent, journal.record)))
            .message,
        ).toContain("foreign");
      }
      fake.faults.push({ method: "GET", path: `/channels/${journal.parent}`, status: 403 });
      expect(
        yield* Effect.flip(readJournal(api, "20", "bot", journal.parent, journal.record)),
      ).toMatchObject({ kind: "forbidden" });
    }),
);

it.effect(
  "READY resets to Pending only on an explicit journal transition; terminal cannot become READY",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const source = fake.addMessage("10", "https://one.test", now);
      let journal = yield* journalPage(api, "bot", (yield* open(api)).journal!, "page", [
        source.id,
      ]);
      const ready: Status = {
        id: source.id,
        state: "ready",
        count: 1,
        hash: "a".repeat(64),
        parts: ["1"],
      };
      journal = yield* journalStatus(api, "20", "bot", journal, ready);
      journal = yield* journalStatus(api, "20", "bot", journal, {
        id: source.id,
        state: "pending",
      });
      expect(journal.entries.get(source.id)?.state).toBe("pending");
      journal = yield* journalStatus(api, "20", "bot", journal, {
        id: source.id,
        state: "terminal",
      });
      expect(
        (yield* Effect.flip(journalStatus(api, "20", "bot", journal, ready))).message,
      ).toContain("Invalid journal transition");
    }),
);
