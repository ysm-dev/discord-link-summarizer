import { expect, it } from "@effect/vitest";
import { DateTime, Effect } from "effect";
import { DiscordFailure } from "../src/discord-client.ts";
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
  openChannelRecord,
  readJournal,
  type Journal,
} from "../src/channel-record.ts";
import {
  horizon,
  hundredLinks,
  journaledLink,
  loseJournalReply,
  now,
  open,
  prepare,
  settledDone,
  since,
  twoLinks,
} from "./channel-record-fixture.ts";
import { readyDigest, readyManifest } from "./ready-fixture.ts";
import { verifyReady } from "../src/ready.ts";

const batchKeyAt = (ids: readonly string[], length: number) =>
  "x".repeat(length - `DLS1 batch ${JSON.stringify({ key: ":0", ids })}`.length);

it.effect(
  "onboards at capped floor; dry-run does not initialize; rejects missing and ambiguous state",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const dry = yield* openChannelRecord(api, "20", "10", since, horizon, "bot", true);
      expect(dry.journal).toBeUndefined();
      expect(dry.proposedStart).toBe(now - 7 * 86400000);
      expect(fake.messages.get("20")).toBeUndefined();
      const first = (yield* open(api)).journal!;
      expect(first.record.phase).toBe("idle");
      expect(first.record.floor).toBe(first.record.onboarding);
      expect(fake.threads.get(first.parent)?.name).toBe("DLS1 10");
      const edits = fake.requests.filter((r) => r.method === "PATCH").length;
      expect((yield* open(api)).journal).toEqual(first);
      expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(edits);
      expect((yield* indexRecords(api, "20", "bot")).size).toBe(1);
      fake.threads.delete(first.parent);
      expect(yield* Effect.flip(open(api))).toMatchObject({ _tag: "RecordError" });
      fake.addThread("20", first.parent, "DLS1 10");
      fake.addMessage("20", fake.messages.get("20")![0]!.content, now, "bot");
      expect((yield* Effect.flip(indexRecords(api, "20", "bot"))).message).toContain("Duplicate");
    }),
);

it.effect(
  "scan pages before cursor advancement; continue oldest-first after budget and settle only when terminal",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const old = fake.addMessage("10", "old https://one.test", now - 3000);
      for (let i = 0; i < 104; i++) fake.addMessage("10", "noise", now - 2000 + i);
      const young = fake.addMessage("10", "young https://two.test", now - 100);
      let journal: Journal = (yield* open(api)).journal!;
      journal = yield* beginScan(api, "20", journal);
      journal = yield* scanPages(api, "20", "bot", journal, 1);
      expect(journal.record.phase).toBe("scan");
      expect(dueJournalIds([journal])).toEqual([]);
      expect(journal.entries.has(young.id)).toBe(true);
      journal = yield* scanPages(api, "20", "bot", (yield* open(api)).journal!, 1);
      expect(journal.record.phase).toBe("work");
      expect(dueJournalIds([journal]).map((item) => item.id)).toEqual([old.id, young.id]);
      expect((yield* settleRecord(api, "20", journal)).record.phase).toBe("work");
      journal = yield* journalStatus(api, "20", "bot", journal, {
        id: young.id,
        state: "terminal",
      });
      expect((yield* settleRecord(api, "20", journal)).record.floor).toBe(journal.record.floor);
      journal = yield* journalStatus(api, "20", "bot", journal, { id: old.id, state: "terminal" });
      journal = yield* settleRecord(api, "20", journal);
      expect(journal.record.phase).toBe("idle");
      expect(journal.record.floor).toBe(young.id);
      expect(dueJournalIds([journal])).toEqual([]);
    }),
);

it.effect(
  "reconciles a persisted page after a lost POST; refuses an unpersisted page and an uncertain checkpoint",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const post = fake.addMessage("10", "link https://one.test", now - 100);
      let journal = yield* beginScan(api, "20", (yield* open(api)).journal!);
      loseJournalReply(fake, journal.parent, true);
      journal = yield* scanPages(api, "20", "bot", journal, 1);
      expect(journal.entries.has(post.id)).toBe(true);
      expect((yield* open(api)).journal!.record.phase).toBe("work");
      const pageCount = fake.messages.get(journal.parent)!.length;
      yield* journalPage(
        api,
        "bot",
        journal,
        `${journal.record.high}/${(BigInt(journal.record.high!) + 1n).toString()}/${post.id}`,
        [post.id],
      );
      expect(fake.messages.get(journal.parent)!.length).toBe(pageCount);
      fake.addMessage("10", "again https://two.test", now + 100);
      journal = yield* journalStatus(api, "20", "bot", journal, { id: post.id, state: "terminal" });
      journal = yield* settleRecord(api, "20", journal);
      journal = yield* beginScan(api, "20", (yield* open(api)).journal!);
      loseJournalReply(fake, journal.parent, false);
      expect(yield* Effect.exit(scanPages(api, "20", "bot", journal, 1))).toMatchObject({
        _tag: "Failure",
      });
      expect((yield* open(api)).journal!.record.phase).toBe("scan");
    }),
);

it.effect(
  "READY references bot part IDs and content; survives reload then transitions to terminal",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const source = fake.addMessage("10", "https://one.test", now - 100);
      let journal = (yield* open(api)).journal!;
      journal = yield* journalPage(api, "bot", journal, "manual", [source.id]);
      const part = fake.addMessage(source.id, "⏳ 요약 중 (1/3)", now, "bot");
      const human = fake.addMessage(source.id, "hi", now, "human");
      const status = readyManifest(source.id, [part]);
      expect(status.count).toBe(1);
      expect(status.parts).toEqual([part.id]);
      expect(status.hash).toBe(readyDigest([part.content]));
      journal = yield* journalStatus(api, "20", "bot", journal, status);
      const recovered = (yield* open(api)).journal!;
      expect(verifyReady(recovered.entries.get(source.id)!, [human, part], "bot")).toBe(true);
      expect(verifyReady(status, [human], "bot")).toBe(false);
      expect(verifyReady(status, [{ ...part, content: "partial" }], "bot")).toBe(false);
      expect(verifyReady({ id: source.id, state: "terminal" }, [part], "bot")).toBe(false);
      journal = yield* journalStatus(api, "20", "bot", journal, {
        id: source.id,
        state: "terminal",
      });
      expect(journal.entries.get(source.id)?.state).toBe("terminal");
    }),
);

it.effect("adopts archived In-progress work before raised Since across archive pages", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const journal = (yield* open(api)).journal!;
    const old = fake.addMessage("10", "https://old.test", now - 20 * 86400000);
    fake.addThread("10", old.id, "⏳ Old", "bot", true, now - 20 * 86400000);
    for (let i = 0; i < 101; i++) {
      const source = fake.addMessage("10", "https://other.test", now - i);
      fake.addThread("10", source.id, "Other", "human", true, now - i);
    }
    const adopted = yield* adoptInProgress(api, "20", "bot", journal, "guild", Infinity);
    expect(dueJournalIds([adopted])).toEqual([{ channel: "10", id: old.id }]);
    expect((yield* open(api)).journal?.entries.has(old.id)).toBe(true);
  }),
);

it.effect(
  "recent deleted Done thread rewinds durable floor and clears terminal; changed Since forward preserves scan",
  () =>
    Effect.gen(function* () {
      const { fake, api, post } = yield* settledDone;
      let journal: Journal = (yield* open(api)).journal!;
      fake.threads.delete(post.id);
      journal = yield* rewindRecent(api, "20", "bot", journal, since, horizon);
      expect(journal.record.floor).toBe((BigInt(post.id) - 1n).toString());
      expect(journal.entries.get(post.id)?.state).toBe("pending");
      const later = DateTime.makeUnsafe(now - 1000);
      journal = yield* beginScan(api, "20", journal);
      const moved = yield* rewindRecent(api, "20", "bot", journal, later, horizon);
      expect(moved.record.phase).toBe("scan");
      expect(moved.record.before).toBe(journal.record.before);
    }),
);

it.effect("fails closed on malformed, foreign, divergent, or orphaned journal entries", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const journal = (yield* open(api)).journal!;
    fake.addMessage(journal.parent, "garbage", now, "bot");
    expect((yield* Effect.flip(open(api))).message).toContain("Malformed journal");
    fake.messages.set(journal.parent, []);
    fake.addMessage(journal.parent, 'DLS1 status {"id":"1","state":"terminal"}', now, "bot");
    expect((yield* Effect.flip(open(api))).message).toContain("Orphan");
    fake.messages.set(journal.parent, []);
    fake.addMessage(journal.parent, 'DLS1 batch {"key":"x","ids":["1"]}', now, "bot");
    fake.addMessage(journal.parent, 'DLS1 batch {"key":"x","ids":["2"]}', now + 1, "bot");
    expect((yield* Effect.flip(open(api))).message).toContain("Divergent");
    fake.messages.set(journal.parent, []);
    fake.addMessage(journal.parent, "hi", now, "human");
    expect((yield* Effect.flip(open(api))).message).toContain("Foreign");
    fake.messages.set(journal.parent, []);
    fake.messages.set(
      "20",
      fake.messages
        .get("20")!
        .map((m) => (m.id === journal.parent ? { ...m, content: "DLS1 record {broken" } : m)),
    );
    expect((yield* Effect.flip(indexRecords(api, "20", "bot"))).message).toContain(
      "Malformed record",
    );
  }),
);

it.effect(
  "rejects invalid state channel, record versions, parent edits and foreign journal ownership",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      fake.addChannel("20", "guild", 5);
      expect((yield* Effect.flip(indexRecords(api, "20", "bot"))).message).toContain(
        "text channel",
      );
      fake.addChannel("20");
      const foreign = fake.addMessage("20", "DLS1 record {broken", now, "human");
      const journal = (yield* open(api)).journal!;
      expect((yield* indexRecords(api, "20", "bot")).size).toBe(1);
      fake.messages.set(
        "20",
        fake.messages.get("20")!.filter((m) => m.id !== foreign.id),
      );
      const parent = fake.messages.get("20")!.find((m) => m.id === journal.parent)!;
      fake.messages.set("20", [{ ...parent, content: "DLS2 record {}" }]);
      expect((yield* Effect.flip(indexRecords(api, "20", "bot"))).message).toContain(
        "Malformed record",
      );
      fake.messages.set("20", [
        { ...parent, content: parent.content.replace('"phase":"idle"', '"phase":"scan"') },
      ]);
      expect((yield* Effect.flip(indexRecords(api, "20", "bot"))).message).toContain("phase");
      fake.messages.set("20", [parent]);
      fake.addThread("20", parent.id, "foreign", "human");
      expect((yield* Effect.flip(open(api))).message).toContain("foreign");
      fake.addThread("20", parent.id, "restored");
      expect(
        (yield* Effect.flip(
          readJournal(api, "20", "bot", parent.id, { ...journal.record, floor: "1" }),
        )).message,
      ).toContain("Missing or foreign");
    }),
);

it.effect(
  "repeats a terminal status after a durable pending reset instead of deduping ancient content",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const { source, journal: first } = yield* journaledLink(fake, api, now - 100);
      let journal = yield* journalStatus(api, "20", "bot", first, {
        id: source.id,
        state: "terminal",
      });
      journal = yield* journalStatus(api, "20", "bot", journal, {
        id: source.id,
        state: "pending",
      });
      journal = yield* journalStatus(api, "20", "bot", journal, {
        id: source.id,
        state: "terminal",
      });
      expect((yield* open(api)).journal?.entries.get(source.id)?.state).toBe("terminal");
      expect(
        fake.messages.get(journal.parent)?.filter((m) => m.content.includes('"state":"terminal"')),
      ).toHaveLength(2);
    }),
);

it.effect(
  "lost onboarding replies reconcile; missing parent or child writes never silently initialize",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      fake.faults.push({ method: "POST", path: "/channels/20/messages", drop: true, after: true });
      fake.faults.push({ method: "POST", path: "/channels/20/messages/", drop: true, after: true });
      expect((yield* open(api)).journal?.record.phase).toBe("idle");
      const { fake: missing, api: missingApi } = yield* prepare;
      missing.faults.push({ method: "POST", path: "/channels/20/messages", drop: true });
      expect((yield* Effect.flip(open(missingApi))).message).toContain("Ambiguous");
      const { fake: orphan, api: orphanApi } = yield* prepare;
      orphan.faults.push({ method: "POST", path: "/channels/20/messages/", drop: true });
      expect((yield* Effect.flip(open(orphanApi))).message).toContain(
        "Missing Channel Record journal",
      );
      expect((yield* open(orphanApi)).journal?.record.phase).toBe("idle");
      const parent = orphan.messages.get("20")![0]!;
      orphan.threads.delete(parent.id);
      orphan.messages.set("20", [{ ...parent, thread: undefined }]);
      expect((yield* Effect.flip(open(orphanApi))).message).toContain(
        "Missing Channel Record journal",
      );
      expect((yield* Effect.flip(open(orphanApi))).message).toContain(
        "Missing Channel Record journal",
      );
    }),
);

it.effect(
  "split pages persist all parts before checkpoint; lost PATCH reconciles, divergent records stop",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const ids = hundredLinks(fake);
      let journal: Journal = (yield* open(api)).journal!;
      journal = yield* beginScan(api, "20", journal);
      fake.faults.push({
        method: "POST",
        path: `/channels/${journal.parent}/messages`,
        drop: true,
        after: true,
      });
      fake.faults.push({
        method: "PATCH",
        path: `/channels/20/messages/${journal.parent}`,
        drop: true,
        after: true,
      });
      journal = yield* scanPages(api, "20", "bot", journal, 1);
      expect(journal.entries.size).toBe(100);
      expect(fake.messages.get(journal.parent)!.length).toBeGreaterThan(1);
      expect((yield* open(api)).journal?.record.phase).toBe("scan");
      const first = fake.messages.get(journal.parent)![0]!;
      fake.messages.set(
        journal.parent,
        fake.messages.get(journal.parent)!.map((message) =>
          message.id === first.id
            ? {
                ...message,
                content: message.content.replace(`"ids":["${ids.at(-1)}`, '"ids":["42'),
              }
            : message,
        ),
      );
      expect(
        (yield* Effect.flip(
          journalPage(
            api,
            "bot",
            journal,
            `${journal.record.high}/${(BigInt(journal.record.high!) + 1n).toString()}/${ids[0]}`,
            ids.toReversed(),
          ),
        )).message,
      ).toContain("Divergent");
      const { fake: lost, api: lostApi } = yield* prepare;
      lost.addMessage("10", "https://one.test", now - 100);
      let retry = yield* beginScan(lostApi, "20", (yield* open(lostApi)).journal!);
      lost.faults.push({
        method: "PATCH",
        path: `/channels/20/messages/${retry.parent}`,
        drop: true,
      });
      expect((yield* Effect.flip(scanPages(lostApi, "20", "bot", retry, 1))).message).toContain(
        "Unreconciled Channel Record",
      );
      retry = (yield* open(lostApi)).journal!;
      expect(retry.record.phase).toBe("scan");
      expect(retry.entries.size).toBe(1);
      retry = yield* scanPages(lostApi, "20", "bot", retry, 1);
      expect(retry.record.phase).toBe("work");
    }),
);

it.effect("a failed state-thread creation cannot accept a normal channel in its place", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    fake.faults.push({ method: "POST", path: "/channels/20/messages/", drop: true });
    const parentId = (((BigInt(now) - 1420070400000n) << 22n) + 1n).toString();
    fake.addChannel(parentId);
    expect((yield* Effect.flip(open(api))).message).toContain(
      "Missing or foreign Channel Record journal",
    );
  }),
);

it.effect("a status reply is insufficient when readback cannot confirm the transition", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const post = fake.addMessage("10", "https://one.test", now - 100);
    const journal = yield* journalPage(api, "bot", (yield* open(api)).journal!, "manual", [
      post.id,
    ]);
    const inconsistent = {
      ...api,
      createMessage: () => Effect.succeed(fake.messages.get("20")![0]!),
    };
    expect(
      (yield* Effect.flip(
        journalStatus(inconsistent, "20", "bot", journal, { id: post.id, state: "terminal" }),
      )).message,
    ).toContain("Unreconciled status");
  }),
);

it.effect(
  "onboarding identifies its own bot parent among other channels and rejects forged write replies",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      yield* openChannelRecord(api, "20", "11", since, horizon, "bot", false);
      const journal = (yield* open(api)).journal!;
      expect(fake.threads.get(journal.parent)?.name).toBe("DLS1 10");
      expect((yield* indexRecords(api, "20", "bot")).size).toBe(2);
      const another = yield* prepare;
      const forged = {
        ...another.api,
        createMessage: (channel: string, content: string) =>
          Effect.gen(function* () {
            const actual = yield* another.api.createMessage(channel, content);
            another.fake.addMessage(channel, content, now, "human");
            return actual;
          }),
      };
      expect((yield* open(forged)).journal?.record.channel).toBe("10");
      const bad = yield* prepare;
      const mismatched = {
        ...bad.api,
        createMessage: (channel: string, content: string) =>
          Effect.gen(function* () {
            const actual = yield* bad.api.createMessage(channel, content);
            return { ...actual, id: (BigInt(actual.id) + 1n).toString() };
          }),
      };
      expect((yield* Effect.flip(open(mismatched))).message).toContain(
        "Ambiguous Channel Record creation",
      );
    }),
);

it.effect("lost batch reply with divergent same-key writes stops without advancing discovery", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const source = fake.addMessage("10", "https://one.test", now);
    const journal = yield* beginScan(api, "20", (yield* open(api)).journal!);
    const conflicting = {
      ...api,
      createMessage: (channel: string, content: string) =>
        Effect.gen(function* () {
          yield* api.createMessage(channel, content);
          fake.addMessage(
            channel,
            content.replace(`"ids":["${source.id}"]`, '"ids":["999"]'),
            now,
            "bot",
          );
          return yield* Effect.fail(new DiscordFailure("outage"));
        }),
    };
    expect((yield* Effect.flip(scanPages(conflicting, "20", "bot", journal, 1))).message).toContain(
      "Unreconciled journal write",
    );
    expect((yield* api.getMessage("20", journal.parent)).content).toContain('"phase":"scan"');
  }),
);

it.effect("exactly 2,000-character batches stay intact and replay retains terminal work", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const [first, second] = twoLinks(fake);
    let journal: Journal = (yield* open(api)).journal!;
    const key = batchKeyAt([first.id, second.id], 2000);
    journal = yield* journalPage(api, "bot", journal, key, [first.id, second.id]);
    expect(fake.messages.get(journal.parent)?.map((m) => m.content.length)).toEqual([2000]);
    expect((yield* open(api)).journal?.entries.size).toBe(2);
    journal = yield* journalStatus(api, "20", "bot", journal, { id: first.id, state: "terminal" });
    const replay = yield* journalPage(api, "bot", journal, key, [first.id, second.id]);
    expect(replay.entries.get(first.id)?.state).toBe("terminal");
    expect(replay.entries.get(second.id)).toBeUndefined();
  }),
);

it.effect("a batch just above Discord's limit is split before any oversized write", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const [first, second] = twoLinks(fake);
    const journal = (yield* open(api)).journal!;
    const key = batchKeyAt([first.id, second.id], 2001);
    yield* journalPage(api, "bot", journal, key, [first.id, second.id]);
    expect(fake.messages.get(journal.parent)?.length).toBe(2);
    expect(fake.messages.get(journal.parent)?.every((m) => m.content.length <= 2000)).toBe(true);
    expect((yield* open(api)).journal?.entries.size).toBe(2);
  }),
);
