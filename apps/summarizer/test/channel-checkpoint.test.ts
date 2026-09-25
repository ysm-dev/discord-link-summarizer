import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import {
  adoptInProgress,
  beginScan,
  dueJournalIds,
  pruneJournal,
  scanPages,
  settleRecord,
} from "../src/channel-discovery.ts";
import {
  indexRecords,
  journalPage,
  journalStatus,
  openChannelRecord,
  updateRecord,
} from "../src/channel-record.ts";
import {
  horizon,
  journaledLink,
  now,
  open,
  prepare,
  settledDone,
  since,
} from "./channel-record-fixture.ts";
import { DiscordFailure, type DiscordApi } from "../src/discord-client.ts";
import type { Journal } from "../src/channel-record.ts";
import type { DiscordMessage } from "../src/discord-schema.ts";
import { FakeDiscord } from "./discord-fake.ts";

const archivedLinks = (fake: FakeDiscord) =>
  Array.from({ length: 101 }, (_, index) => {
    const at = now - 1000 + index;
    const source = fake.addMessage("10", `https://example.test/${index}`, at);
    fake.addThread("10", source.id, "⏳ Pending", "bot", true, at);
    return source.id;
  });

const terminalJournal = Effect.gen(function* () {
  const { fake, api } = yield* prepare;
  const source = fake.addMessage("10", "https://example.test/a", now - 100);
  let journal = yield* journalPage(api, "bot", (yield* open(api)).journal!, "page", [source.id]);
  journal = yield* journalStatus(api, "20", "bot", journal, { id: source.id, state: "terminal" });
  return { fake, api, journal, source };
});

const expectStatusConflict = (api: DiscordApi, journal: Journal, id: string) =>
  Effect.gen(function* () {
    expect(
      (yield* Effect.flip(journalStatus(api, "20", "bot", journal, { id, state: "terminal" })))
        .message,
    ).toContain("Unreconciled status transition");
  });

const raceOnReadback = (
  api: DiscordApi,
  journal: Journal,
  change: (page: readonly DiscordMessage[]) => readonly DiscordMessage[],
): DiscordApi => {
  let reads = 0;
  return {
    ...api,
    listMessages: (channel, before) =>
      api
        .listMessages(channel, before)
        .pipe(
          Effect.map((page) => (channel === journal.parent && ++reads === 3 ? change(page) : page)),
        ),
  };
};

const expectPausedArchive = (journal: Journal) => {
  expect(journal.record.archiveBefore).toBeDefined();
  expect(journal.entries.size).toBe(100);
  expect(dueJournalIds([journal])).toEqual([]);
};

it.effect("does not turn an onboarding journal lookup outage into a fresh thread", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const unreliable = {
      ...api,
      getChannel: (id: string) =>
        id === "20" ? api.getChannel(id) : Effect.fail(new DiscordFailure("outage", 503)),
    };
    expect(yield* Effect.flip(open(unreliable))).toMatchObject({ kind: "outage" });
    expect(fake.threads.size).toBe(0);
  }),
);

it.effect("does not claim an already-created onboarding thread a second time", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const alreadyCreated = {
      ...api,
      createMessage: (channel: string, content: string) =>
        api.createMessage(channel, content).pipe(
          Effect.tap((message) =>
            Effect.sync(() => {
              if (channel === "20") fake.addThread(channel, message.id, "DLS1 10");
            }),
          ),
        ),
    };
    const journal = (yield* open(alreadyCreated)).journal!;
    expect(fake.threads.has(journal.parent)).toBe(true);
    expect(
      fake.requests.filter((request) =>
        request.path.includes(`/messages/${journal.parent}/threads`),
      ),
    ).toHaveLength(0);
  }),
);

it.effect("a confirmed journal page write needs no second readback", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const journal = (yield* open(api)).journal!;
    const before = fake.requests.filter((request) =>
      request.path.startsWith(`/channels/${journal.parent}/messages?`),
    ).length;
    yield* journalPage(api, "bot", journal, "once", ["1"]);
    expect(
      fake.requests.filter((request) =>
        request.path.startsWith(`/channels/${journal.parent}/messages?`),
      ),
    ).toHaveLength(before + 1);
  }),
);

it.effect("checkpoint stops rereading old history and bounded deletion resumes across Runs", () =>
  Effect.gen(function* () {
    const { fake, api, journal } = yield* settledDone;
    const before = fake.messages.get(journal.parent)?.length ?? 0;
    const human = fake.addMessage(
      journal.parent,
      "Keep this state-channel reply",
      now - 2000,
      "human",
    );
    for (let index = 0; index < 101; index++)
      fake.addMessage(journal.parent, "old history", now - 1000 + index, "bot");
    expect((yield* open(api)).journal?.entries.size).toBe(0);
    yield* pruneJournal(api, "bot", journal);
    expect(fake.messages.get(journal.parent)).toHaveLength(before + 52);
    yield* pruneJournal(api, "bot", journal);
    expect(fake.messages.get(journal.parent)).toHaveLength(before + 2);
    yield* pruneJournal(api, "bot", journal);
    expect((yield* open(api)).journal?.entries.size).toBe(0);
    expect(fake.messages.get(journal.parent)?.map((m) => m.id)).toEqual([
      journal.record.checkpoint,
      human.id,
    ]);
  }),
);

it.effect("persists archived pagination across budget exhaustion", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const journal = (yield* open(api)).journal!;
    const ids = archivedLinks(fake);
    let page = 0;
    const delayed = {
      ...api,
      listArchivedThreads: (channel: string, before?: string) =>
        api
          .listArchivedThreads(channel, before)
          .pipe(Effect.tap(() => (++page === 1 ? TestClock.adjust("2 seconds") : Effect.void))),
    };
    const partial = yield* adoptInProgress(delayed, "20", "bot", journal, "guild", now + 1000);
    expectPausedArchive(partial);
    const cursors: (string | undefined)[] = [];
    const resumedApi = {
      ...api,
      listArchivedThreads: (channel: string, before?: string) => {
        cursors.push(before);
        return api.listArchivedThreads(channel, before);
      },
    };
    const resumed = yield* adoptInProgress(
      resumedApi,
      "20",
      "bot",
      (yield* open(api)).journal!,
      "guild",
      Infinity,
    );
    expect(resumed.record.archiveBefore).toBeNull();
    expect(cursors).toEqual([partial.record.archiveBefore]);
    expect(resumed.entries.size).toBe(101);
    expect(ids.every((id) => resumed.entries.has(id))).toBe(true);
  }),
);

it.effect("advances the durable checkpoint after a second settled scan epoch", () =>
  Effect.gen(function* () {
    const { fake, api, journal: first } = yield* settledDone;
    const newer = fake.addMessage("10", "https://example.test/next", now - 50);
    let journal = yield* beginScan(api, "20", (yield* open(api)).journal!);
    journal = yield* scanPages(api, "20", "bot", journal, 1);
    journal = yield* journalStatus(api, "20", "bot", journal, { id: newer.id, state: "terminal" });
    journal = yield* settleRecord(api, "20", journal);
    expect(BigInt(journal.record.checkpoint!)).toBeGreaterThan(BigInt(first.record.checkpoint!));
    expect((yield* open(api)).journal?.record.checkpoint).toBe(journal.record.checkpoint);
  }),
);

it.effect("reconciles a checkpoint marker whose write reply was lost", () =>
  Effect.gen(function* () {
    const { fake, api, journal } = yield* terminalJournal;
    const marker = fake.addMessage(journal.parent, "DLS1 checkpoint {}", now, "bot");
    const settled = yield* settleRecord(api, "20", journal);
    expect(settled.record.checkpoint).toBe(marker.id);
    expect(
      fake.messages.get(journal.parent)?.filter((m) => m.content === marker.content),
    ).toHaveLength(1);
  }),
);

it.effect(
  "checks the first archived page even when the active-thread lookup spent the budget",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const journal = (yield* open(api)).journal!;
      archivedLinks(fake);
      const delayed = {
        ...api,
        listActiveThreads: (guild: string) =>
          api.listActiveThreads(guild).pipe(Effect.tap(() => TestClock.adjust("2 seconds"))),
      };
      const partial = yield* adoptInProgress(delayed, "20", "bot", journal, "guild", now + 1000);
      expectPausedArchive(partial);
    }),
);

it.effect("stops archive pagination at the exact Run budget", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const journal = (yield* open(api)).journal!;
    archivedLinks(fake);
    expectPausedArchive(yield* adoptInProgress(api, "20", "bot", journal, "guild", now));
  }),
);

it.effect("does not queue a journaled Link until its page scan finishes", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const { source, journal } = yield* journaledLink(fake, api, now - 100);
    expect(dueJournalIds([journal]).map((item) => item.id)).toEqual([source.id]);
    const scanning = yield* beginScan(api, "20", journal);
    expect(scanning.record.phase).toBe("scan");
    expect(dueJournalIds([scanning])).toEqual([]);
  }),
);

it.effect("does not settle terminal entries while another page is still undiscovered", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const source = fake.addMessage("10", "https://example.test/old", now - 100);
    let journal: Journal = yield* journalPage(api, "bot", (yield* open(api)).journal!, "old", [
      source.id,
    ]);
    journal = yield* journalStatus(api, "20", "bot", journal, {
      id: source.id,
      state: "terminal",
    });
    journal = yield* beginScan(api, "20", journal);
    expect(journal.record.phase).toBe("scan");
    expect(yield* settleRecord(api, "20", journal)).toEqual(journal);
    expect((yield* open(api)).journal?.record).toEqual(journal.record);
  }),
);

it.effect("does not rewrite an empty archive cursor on a complete first page", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const journal = (yield* open(api)).journal!;
    const before = fake.requests.filter((r) => r.method === "PATCH").length;
    const complete = yield* adoptInProgress(api, "20", "bot", journal, "guild", Infinity);
    expect(complete.record.archiveBefore).toBeUndefined();
    expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(before);
  }),
);

it.effect("rejects two ambiguous checkpoint markers before collecting settled history", () =>
  Effect.gen(function* () {
    const { fake, api, journal, source } = yield* terminalJournal;
    fake.addMessage(journal.parent, "DLS1 checkpoint {}", now, "bot");
    fake.addMessage(journal.parent, "DLS1 checkpoint {}", now + 1, "bot");
    expect((yield* open(api)).journal?.entries.get(source.id)?.state).toBe("terminal");
    expect((yield* Effect.flip(settleRecord(api, "20", journal))).message).toContain(
      "Unreconciled Channel Record checkpoint",
    );
  }),
);

it.effect("refuses a missing or replaced durable checkpoint", () =>
  Effect.gen(function* () {
    const { fake, api, journal } = yield* settledDone;
    const checkpoint = journal.record.checkpoint!;
    fake.messages.set(
      journal.parent,
      (fake.messages.get(journal.parent) ?? []).map((message) =>
        message.id === checkpoint ? { ...message, content: "replaced" } : message,
      ),
    );
    expect((yield* Effect.flip(open(api))).message).toContain("Invalid Channel Record checkpoint");
  }),
);

it.effect("does not replay the checkpoint message as a journal entry", () =>
  Effect.gen(function* () {
    const { api, journal } = yield* settledDone;
    const boundary = journal.record.checkpoint!;
    const inconsistent = {
      ...api,
      listMessages: (channel: string, before?: string) =>
        api
          .listMessages(channel, before)
          .pipe(
            Effect.map((page) =>
              channel === journal.parent && !before
                ? page.map((message) =>
                    message.id === boundary ? { ...message, content: "corrupt boundary" } : message,
                  )
                : page,
            ),
          ),
    };
    expect((yield* open(inconsistent)).journal?.entries.size).toBe(0);
  }),
);

for (const sabotage of [false, true])
  it.effect(
    `${sabotage ? "rejects a foreign" : "finishes an"} interrupted first-time journal initialization`,
    () =>
      Effect.gen(function* () {
        const { fake, api } = yield* prepare;
        const initial = (yield* open(api)).journal!;
        const incomplete = yield* updateRecord(api, "20", initial, {
          ...initial.record,
          journalReady: false,
        });
        fake.threads.delete(incomplete.parent);
        fake.messages.set(
          "20",
          fake.messages
            .get("20")!
            .map((message) =>
              message.id === incomplete.parent ? { ...message, thread: undefined } : message,
            ),
        );
        const proposed = yield* openChannelRecord(api, "20", "10", since, horizon, "bot", true);
        expect(proposed.journal?.record.floor).toBe(incomplete.record.floor);
        expect(fake.threads.has(incomplete.parent)).toBe(false);
        const recovering = sabotage
          ? {
              ...api,
              startThread: (channel: string, parent: string, name: string) =>
                api.startThread(channel, parent, name).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      const thread = fake.threads.get(parent)!;
                      fake.threads.set(parent, { ...thread, owner_id: "human" });
                    }),
                  ),
                ),
            }
          : api;
        if (sabotage) {
          expect((yield* Effect.flip(open(recovering))).message).toContain("foreign");
          expect((yield* indexRecords(api, "20", "bot")).get("10")?.record.journalReady).toBe(
            false,
          );
        } else {
          const resumed = (yield* open(recovering)).journal!;
          expect(resumed.record.journalReady).toBe(true);
          expect(resumed.record.floor).toBe(incomplete.record.floor);
          expect(fake.threads.has(incomplete.parent)).toBe(true);
          expect(fake.threads.get(incomplete.parent)?.name).toBe("DLS1 10");
        }
      }),
  );

it.effect("does not recreate a deleted established journal or a dangling parent reference", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const journal = (yield* open(api)).journal!;
    fake.threads.delete(journal.parent);
    expect((yield* Effect.flip(open(api))).message).toContain("Missing Channel Record journal");
    const initializing = yield* updateRecord(api, "20", journal, {
      ...journal.record,
      journalReady: false,
    });
    expect(initializing.record.journalReady).toBe(false);
    expect((yield* Effect.flip(open(api))).message).toContain("Missing Channel Record journal");
  }),
);

it.effect("does not repair a foreign journal during interrupted initialization", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const journal = (yield* open(api)).journal!;
    yield* updateRecord(api, "20", journal, { ...journal.record, journalReady: false });
    const thread = fake.threads.get(journal.parent)!;
    fake.threads.set(journal.parent, { ...thread, owner_id: "human" });
    expect((yield* Effect.flip(open(api))).message).toContain("foreign Channel Record journal");
  }),
);

it.effect(
  "fails closed when another status arrives between write reconciliation and readback",
  () =>
    Effect.gen(function* () {
      const { fake, api } = yield* prepare;
      const { source, journal } = yield* journaledLink(fake, api, now - 100);
      const competing = raceOnReadback(api, journal, (page) => [
        fake.addMessage(
          journal.parent,
          `DLS1 status {"id":"${source.id}","state":"pending"}`,
          now + 1,
          "bot",
        ),
        ...page,
      ]);
      yield* expectStatusConflict(competing, journal, source.id);
    }),
);

it.effect("refuses a terminal status that disappears before final readback", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* prepare;
    const { source, journal } = yield* journaledLink(fake, api, now - 100);
    const missing = raceOnReadback(api, journal, (page) =>
      page.filter((message) => !message.content.startsWith("DLS1 status")),
    );
    yield* expectStatusConflict(missing, journal, source.id);
  }),
);
