import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import {
  adoptInProgress,
  beginScan,
  dueJournalIds,
  rewindRecent,
  scanPages,
  settleRecord,
} from "../src/channel-discovery.ts";
import {
  indexRecords,
  journalPage,
  journalStatus,
  persistReady,
  updateRecord,
  type Journal,
} from "../src/channel-record.ts";
import {
  horizon,
  hundredLinks,
  loseJournalReply,
  now,
  open,
  prepare,
  removeEntriesContaining,
  settledDone,
  since,
} from "./channel-record-fixture.ts";
import { readyDigest, readyManifest } from "./ready-fixture.ts";
import { verifyReady } from "../src/ready.ts";

it.effect(
  "READY and terminal markers reject malformed transitions and reconcile lost replies",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const source = fake.addMessage("10", "https://one.test", now - 100);
      let journal: Journal = yield* journalPage(api, "bot", (yield* open(api)).journal!, "manual", [
        source.id,
      ]);
      expect(
        (yield* Effect.flip(
          journalStatus(api, "20", "bot", journal, { id: "12", state: "terminal" }),
        )).message,
      ).toContain("without journaled");
      expect(
        (yield* Effect.flip(
          journalStatus(api, "20", "bot", journal, {
            id: source.id,
            state: "ready",
            count: 0,
            hash: "bad",
            parts: [],
          }),
        )).message,
      ).toContain("Invalid journal transition");
      fake.faults.push({
        method: "POST",
        path: `/channels/${journal.parent}/messages`,
        drop: true,
        after: true,
      });
      journal = yield* journalStatus(api, "20", "bot", journal, {
        id: source.id,
        state: "terminal",
      });
      expect(
        (yield* Effect.flip(
          journalStatus(api, "20", "bot", journal, {
            id: source.id,
            state: "ready",
            count: 1,
            hash: "f".repeat(64),
            parts: ["1"],
          }),
        )).message,
      ).toContain("Invalid journal transition");
      fake.addMessage(
        journal.parent,
        `DLS1 status {"id":"${source.id}","state":"ready"}`,
        now,
        "bot",
      );
      expect((yield* Effect.flip(open(api))).message).toContain("Malformed status");
      fake.messages.set(
        journal.parent,
        fake.messages.get(journal.parent)!.filter((m) => !m.content.endsWith('"ready"}')),
      );
      fake.addMessage(
        journal.parent,
        `DLS1 status {"id":"${source.id}","state":"pending"}`,
        now,
        "bot",
      );
      expect((yield* open(api)).journal?.entries.get(source.id)?.state).toBe("pending");
    }),
);

it.effect("empty scans, recent backfill and archived active work preserve history boundaries", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    let journal: Journal = (yield* open(api)).journal!;
    expect(yield* beginScan(api, "20", journal)).toEqual(journal);
    const earlier = DateTime.makeUnsafe(now - 2 * 86400000);
    journal = yield* rewindRecent(api, "20", "bot", journal, earlier, horizon);
    expect(journal.record.floor).toBe(journal.record.onboarding);
    expect(journal.record.since).toBe(DateTime.formatIso(earlier));
    const older = DateTime.makeUnsafe(now - 4 * 86400000);
    journal = yield* rewindRecent(api, "20", "bot", journal, older, horizon);
    expect(journal.record.floor).toBe(journal.record.onboarding);
    const work = fake.addMessage("10", "https://old.test", now - 9 * 86400000);
    fake.addThread("10", work.id, "⏳ Active", "bot", false);
    const adopted = yield* adoptInProgress(api, "20", "bot", journal, "guild", Infinity);
    expect(dueJournalIds([adopted]).map((item) => item.id)).toEqual([work.id]);
    expect((yield* settleRecord(api, "20", adopted)).record.phase).toBe("idle");
  }),
);

it.effect(
  "state indexing reads every page; ignores foreign and system messages but rejects malformed bot versions",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      for (let i = 0; i < 99; i++) fake.addMessage("20", "DLS1 record {bad", now + i, "human");
      const journal = (yield* open(api)).journal!;
      expect((yield* indexRecords(api, "20", "bot")).get("10")?.parent).toBe(journal.parent);
      fake.addMessage(journal.parent, "a system event", now, "bot", 18);
      expect((yield* open(api)).journal?.entries.size).toBe(0);
      const parent = fake.messages.get("20")!.find((m) => m.id === journal.parent)!;
      fake.messages.set(
        "20",
        fake.messages.get("20")!.map((m) =>
          m.id === journal.parent
            ? {
                ...m,
                content: parent.content.replace('"channel":"10"', '"channel":"not-a-snowflake"'),
              }
            : m,
        ),
      );
      expect((yield* Effect.flip(indexRecords(api, "20", "bot"))).message).toContain(
        "Malformed record",
      );
    }),
);

it.effect(
  "rejects divergent status histories and unknown parts rather than trusting model-like notes",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const source = fake.addMessage("10", "https://one.test", now - 100);
      let journal = yield* journalPage(api, "bot", (yield* open(api)).journal!, "manual", [
        source.id,
      ]);
      fake.addMessage(
        journal.parent,
        "DLS1 status " +
          JSON.stringify({
            id: source.id,
            state: "ready",
            count: 1,
            hash: "a".repeat(64),
            parts: ["1"],
          }),
        now,
        "bot",
      );
      fake.addMessage(
        journal.parent,
        "DLS1 status " +
          JSON.stringify({
            id: source.id,
            state: "ready",
            count: 1,
            hash: "b".repeat(64),
            parts: ["1"],
          }),
        now + 1,
        "bot",
      );
      expect((yield* Effect.flip(open(api))).message).toContain("Divergent journal status");
      removeEntriesContaining(fake, journal.parent, '"state":"ready"');
      fake.addMessage(
        journal.parent,
        "DLS1 status " +
          JSON.stringify({
            id: source.id,
            state: "ready",
            count: 2,
            hash: "a".repeat(64),
            parts: ["1", "1"],
          }),
        now,
        "bot",
      );
      expect((yield* Effect.flip(open(api))).message).toContain("Malformed status");
      removeEntriesContaining(fake, journal.parent, '"state":"ready"');
      journal = yield* journalStatus(api, "20", "bot", journal, {
        id: source.id,
        state: "terminal",
      });
      const stale = { ...journal, entries: new Map([[source.id, undefined]]) };
      fake.addMessage(
        journal.parent,
        `DLS1 status {"id":"${source.id}","state":"pending"}`,
        now + 2,
        "bot",
      );
      expect(
        (yield* Effect.flip(
          journalStatus(api, "20", "bot", stale, { id: source.id, state: "terminal" }),
        )).message,
      ).toContain("Unreconciled status");
    }),
);

it.effect(
  "large batch is resumable after partial writes, and oversized page keys are refused",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const ids = hundredLinks(fake).toReversed();
      let journal = yield* beginScan(api, "20", (yield* open(api)).journal!);
      loseJournalReply(fake, journal.parent, true);
      loseJournalReply(fake, journal.parent, false);
      expect((yield* Effect.flip(scanPages(api, "20", "bot", journal, 1))).message).toContain(
        "Unreconciled journal write",
      );
      expect((yield* open(api)).journal?.record.phase).toBe("scan");
      journal = yield* scanPages(api, "20", "bot", journal, 1);
      expect(journal.entries.size).toBe(100);
      expect(
        (yield* Effect.flip(journalPage(api, "bot", journal, "x".repeat(2010), [ids[0]!]))).message,
      ).toContain("key too long");
    }),
);

it.effect(
  "deleted parents terminate empty scans, forward Since never drops unfinished work, backfill rewinds within Horizon",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const post = fake.addMessage("10", "https://one.test", now - 100);
      let journal = yield* beginScan(api, "20", (yield* open(api)).journal!);
      expect(yield* beginScan(api, "20", journal)).toEqual(journal);
      fake.messages.set("10", []);
      journal = yield* scanPages(api, "20", "bot", journal, 1);
      expect(journal.record.phase).toBe("work");
      journal = yield* settleRecord(api, "20", journal);
      expect(journal.record.floor).toBe(post.id);
      const recent = DateTime.makeUnsafe(now - 86400000);
      journal = yield* rewindRecent(api, "20", "bot", journal, recent, horizon);
      expect(journal.record.floor).toBe(post.id);
      journal = yield* rewindRecent(api, "20", "bot", journal, since, horizon);
      expect(journal.record.floor).toBe(journal.record.onboarding);
      expect(yield* rewindRecent(api, "20", "bot", journal, since, horizon)).toEqual(journal);
    }),
);

it.effect("full recent and archive pagination fails closed on a missing continuation cursor", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const journal = (yield* open(api)).journal!;
    for (let i = 0; i < 101; i++) fake.addMessage("10", "noise", now - 9 * 86400000 + i);
    const recent = fake.addMessage("10", "https://one.test", now - 100);
    fake.addThread("10", recent.id, "Done", "bot", true);
    expect(yield* rewindRecent(api, "20", "bot", journal, since, horizon)).toEqual(journal);
    for (let i = 0; i < 101; i++) {
      const source = fake.addMessage("10", "https://old.test", now + i);
      fake.addThread("10", source.id, "⏳ Pending", "human", true, now + i);
    }
    const archived = [...fake.threads.values()].slice(0, 100);
    archived[99] = { ...archived[99]!, thread_metadata: { archived: true } };
    fake.faults.push({
      method: "GET",
      path: "/channels/10/threads/archived/public",
      status: 200,
      body: { threads: archived, has_more: true },
    });
    expect(
      (yield* Effect.flip(adoptInProgress(api, "20", "bot", journal, "guild", Infinity))).message,
    ).toContain("pagination lacks a cursor");
    expect(
      dueJournalIds([
        journal,
        {
          ...journal,
          record: { ...journal.record, channel: "11" },
          entries: new Map([[recent.id, undefined]]),
        },
      ]).map((item) => item.id),
    ).toEqual([recent.id]);
  }),
);

it.effect(
  "recent rescan traverses complete pages and revisits a settled deleted source whose journal was collected",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const journal = (yield* open(api)).journal!;
      const deleted = fake.addMessage("10", "https://deleted.test", now - 5000);
      for (let i = 0; i < 104; i++) fake.addMessage("10", "noise", now - 4900 + i);
      let settled = yield* updateRecord(api, "20", journal, {
        ...journal.record,
        floor: deleted.id,
      });
      settled = yield* rewindRecent(api, "20", "bot", settled, since, horizon);
      expect(settled.record.floor).toBe((BigInt(deleted.id) - 1n).toString());
      expect(settled.entries.get(deleted.id)?.state).toBe("pending");
    }),
);

it.effect(
  "cross-channel ordering compares integer IDs and resolves ties without a lexical shortcut",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const first = fake.addMessage("10", "https://first.test", now - 100);
      const second = fake.addMessage("10", "https://second.test", now - 10);
      const journal = (yield* open(api)).journal!;
      const queue = dueJournalIds([
        {
          ...journal,
          entries: new Map([
            [second.id, undefined],
            [first.id, undefined],
          ]),
        },
        {
          ...journal,
          record: { ...journal.record, channel: "11" },
          entries: new Map([[first.id, undefined]]),
        },
      ]);
      expect(queue).toEqual([
        { channel: "10", id: first.id },
        { channel: "11", id: first.id },
        { channel: "10", id: second.id },
      ]);
      expect(
        dueJournalIds([
          {
            ...journal,
            entries: new Map([
              [first.id, undefined],
              [second.id, undefined],
            ]),
          },
        ]).map((item) => item.id),
      ).toEqual([first.id, second.id]);
    }),
);

it.effect("valid pending-to-terminal recovery and incomplete READY manifests fail closed", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const post = fake.addMessage("10", "https://one.test", now - 100);
    let journal = yield* journalPage(api, "bot", (yield* open(api)).journal!, "manual", [post.id]);
    journal = yield* journalStatus(api, "20", "bot", journal, { id: post.id, state: "pending" });
    journal = yield* journalStatus(api, "20", "bot", journal, { id: post.id, state: "terminal" });
    expect((yield* open(api)).journal?.entries.get(post.id)?.state).toBe("terminal");
    fake.addMessage(
      journal.parent,
      `DLS1 status {"id":"${post.id}","state":"pending"}`,
      now,
      "bot",
    );
    fake.addMessage(
      journal.parent,
      `DLS1 status {"id":"${post.id}","state":"ready","count":1,"parts":["1"]}`,
      now + 1,
      "bot",
    );
    expect((yield* Effect.flip(open(api))).message).toContain("Malformed status");
  }),
);

it.effect("READY binds exact ordered bot message identities and a length-delimited digest", () =>
  Effect.gen(function* () {
    const { fake } = yield* prepare;
    const first = fake.addMessage("1", "a", now, "bot");
    const second = fake.addMessage("1", "bc", now + 1, "bot");
    const manifest = readyManifest("1", [first, second]);
    expect(manifest.hash).toBe("5310a58788781ab25d5ad7c3f85035824b4eb7bdfa394e0ac2186271472b5492");
    expect(readyDigest(["ab", "c"])).toBe(
      "430fb1b4ac43316eca81fab27a1930ab8eff8fef6a1dc7903dce44bbc2790dc5",
    );
    expect(verifyReady(manifest, [second, first], "bot")).toBe(true);
    expect(
      verifyReady(
        { ...manifest, parts: [second.id, first.id], hash: readyDigest(["bc", "a"]) },
        [first, second],
        "bot",
      ),
    ).toBe(false);
    expect(verifyReady({ ...manifest, state: "terminal" }, [first, second], "bot")).toBe(false);
    expect(
      verifyReady(
        { id: manifest.id, state: manifest.state, count: manifest.count, hash: manifest.hash },
        [first, second],
        "bot",
      ),
    ).toBe(false);
    expect(verifyReady({ ...manifest, count: 3 }, [first, second], "bot")).toBe(false);
    expect(verifyReady(manifest, [first], "bot")).toBe(false);
    expect(verifyReady(manifest, [{ ...first, author: { id: "human" } }, second], "bot")).toBe(
      false,
    );
    expect(verifyReady(manifest, [{ ...first, id: "999" }, second], "bot")).toBe(false);
    expect(verifyReady(manifest, [{ ...first, content: "changed" }, second], "bot")).toBe(false);
    expect(
      verifyReady(
        { ...manifest, parts: [first.id, first.id], hash: readyDigest(["a", "a"]) },
        [first, second],
        "bot",
      ),
    ).toBe(false);
  }),
);

it.effect("READY is written only after reading back every matching bot part", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const source = fake.addMessage("10", "https://one.test", now - 100);
    const journal = yield* journalPage(api, "bot", (yield* open(api)).journal!, "manual", [
      source.id,
    ]);
    fake.addThread("10", source.id, "⏳ Working");
    const part = fake.addMessage(source.id, "Complete summary", now, "bot");
    fake.messages.set(source.id, [{ ...part, content: "Incomplete summary" }]);
    expect(
      (yield* Effect.flip(persistReady(api, "20", "bot", journal, source.id, [part]))).message,
    ).toContain("do not match");
    expect((yield* open(api)).journal?.entries.get(source.id)).toBeUndefined();
    fake.messages.set(source.id, [part]);
    const ready = yield* persistReady(api, "20", "bot", journal, source.id, [part]);
    expect(ready.entries.get(source.id)?.state).toBe("ready");
  }),
);

it.effect(
  "adoption distinguishes bot ownership and in-progress names; any scanning channel blocks work",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const journal = (yield* open(api)).journal!;
      const human = fake.addMessage("10", "https://human.test", now - 300);
      fake.addThread("10", human.id, "⏳ Human", "human");
      const done = fake.addMessage("10", "https://done.test", now - 200);
      fake.addThread("10", done.id, "Done", "bot");
      const pending = fake.addMessage("10", "https://pending.test", now - 100);
      fake.addThread("10", pending.id, "⏳ Pending", "bot");
      const other = fake.addMessage("20", "https://other.test", now - 50);
      fake.addThread("20", other.id, "⏳ Other", "bot");
      const adopted = yield* adoptInProgress(api, "20", "bot", journal, "guild", Infinity);
      expect([...adopted.entries.keys()]).toEqual([pending.id]);
      expect(
        fake.messages
          .get(journal.parent)
          ?.some((m) => m.content.includes(`"key":"adopt/${pending.id}:0"`)),
      ).toBe(true);
      expect(
        (yield* adoptInProgress(api, "20", "bot", adopted, "guild", Infinity)).entries.size,
      ).toBe(1);
      expect(
        dueJournalIds([adopted, { ...adopted, record: { ...adopted.record, phase: "scan" } }]),
      ).toEqual([]);
    }),
);

it.effect(
  "settlement does not repeat in idle and unchanged recent checks do not rewrite state",
  () =>
    Effect.gen(function* () {
      const { fake, api, journal } = yield* settledDone;
      const baseline = fake.requests.length;
      expect(yield* settleRecord(api, "20", journal)).toEqual(journal);
      expect(yield* rewindRecent(api, "20", "bot", journal, since, horizon)).toEqual(journal);
      expect(fake.requests.slice(baseline).some((r) => r.method === "PATCH")).toBe(false);
      expect(yield* beginScan(api, "20", journal)).toEqual(journal);
    }),
);
