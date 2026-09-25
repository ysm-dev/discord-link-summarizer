import { Clock, DateTime, Duration, Effect } from "effect";
import type { DiscordApi } from "./discord-client.ts";
import { linkFromPost } from "./link-post.ts";
import { normalLowerBound } from "./window.ts";
import {
  fail,
  journalPage,
  journalStatus,
  snowflakeAt,
  updateRecord,
  type Journal,
} from "./channel-record.ts";

const recentReset = (api: DiscordApi, botId: string, journal: Journal, newFloor: string) =>
  Effect.gen(function* () {
    let before: string | undefined;
    let reset: string | undefined;
    for (;;) {
      const page = yield* api.listMessages(journal.record.channel, before);
      for (const source of page) {
        if (BigInt(source.id) < BigInt(newFloor)) return reset;
        if (!linkFromPost(source, botId)) continue;
        const thread = yield* api.getChannel(source.id).pipe(
          Effect.catchIf(
            (e) => e.kind === "not-found",
            () => Effect.void,
          ),
        );
        if (
          !thread &&
          (journal.entries.get(source.id)?.state === "terminal" ||
            journal.entries.get(source.id)?.state === "ready" ||
            BigInt(source.id) <= BigInt(journal.record.floor))
        )
          reset = source.id;
      }
      if (page.length < 100) return reset;
      before = page[99]!.id;
    }
  });
/** Snapshot an actual message ID; a channel's last_message_id may point at a deletion. */
export const beginScan = (api: DiscordApi, stateId: string, journal: Journal) =>
  Effect.gen(function* () {
    if (journal.record.phase !== "idle") return journal;
    const highest = (yield* api.listMessages(journal.record.channel))[0]?.id;
    if (!highest || BigInt(highest) <= BigInt(journal.record.floor)) return journal;
    return yield* updateRecord(api, stateId, journal, {
      ...journal.record,
      phase: "scan",
      high: highest,
      before: (BigInt(highest) + 1n).toString(),
    });
  });

/** maxPages is the caller's remaining Run budget; scan phase blocks younger work globally. */
export const scanPages = (
  api: DiscordApi,
  stateId: string,
  botId: string,
  initial: Journal,
  maxPages: number,
) =>
  Effect.gen(function* () {
    let journal = initial;
    for (let count = 0; count < maxPages && journal.record.phase === "scan"; count++) {
      const page = yield* api.listMessages(journal.record.channel, journal.record.before!);
      const floor = BigInt(journal.record.floor);
      const eligible = page.filter(
        (m) =>
          BigInt(m.id) > floor &&
          BigInt(m.id) <= BigInt(journal.record.high!) &&
          linkFromPost(m, botId),
      );
      const low = page.at(-1)?.id;
      journal = yield* journalPage(
        api,
        botId,
        journal,
        `${journal.record.high}/${journal.record.before}/${low}`,
        eligible.map((m) => m.id),
      );
      const finished = page.length < 100 || BigInt(low!) <= floor;
      journal = yield* updateRecord(api, stateId, journal, {
        ...journal.record,
        phase: finished ? "work" : "scan",
        before: low ?? journal.record.before,
      });
    }
    return journal;
  });

const journalThreads = (
  api: DiscordApi,
  botId: string,
  journal: Journal,
  threads: readonly { id: string; owner_id: string; name: string }[],
) =>
  Effect.gen(function* () {
    let result = journal;
    for (const thread of threads)
      if (
        thread.owner_id === botId &&
        thread.name.startsWith("⏳ ") &&
        !result.entries.has(thread.id)
      )
        result = yield* journalPage(api, botId, result, `adopt/${thread.id}`, [thread.id]);
    return result;
  });

/** Journal each archive page before advancing its persistent cursor. */
export const adoptInProgress = (
  api: DiscordApi,
  stateId: string,
  botId: string,
  journal: Journal,
  guild: string,
  budget: number,
) =>
  Effect.gen(function* () {
    const active = (yield* api.listActiveThreads(guild)).filter(
      (t) => t.parent_id === journal.record.channel,
    );
    let result = yield* journalThreads(api, botId, journal, active);
    let before = journal.record.archiveBefore ?? undefined;
    for (;;) {
      const page = yield* api.listArchivedThreads(journal.record.channel, before);
      result = yield* journalThreads(api, botId, result, page.threads);
      if (!page.has_more) {
        if (before !== undefined)
          result = yield* updateRecord(api, stateId, result, {
            ...result.record,
            archiveBefore: null,
          });
        return result;
      }
      before = page.threads.at(-1)?.thread_metadata.archive_timestamp;
      if (!before) return yield* fail("Archived thread pagination lacks a cursor");
      result = yield* updateRecord(api, stateId, result, {
        ...result.record,
        archiveBefore: before,
      });
      if ((yield* Clock.currentTimeMillis) >= budget) return result;
    }
  });

export const dueJournalIds = (journals: readonly Journal[]) =>
  journals.some((j) => j.record.phase === "scan" || Boolean(j.record.archiveBefore))
    ? []
    : journals
        .flatMap((j) =>
          [...j.entries]
            .filter(([, status]) => status?.state !== "terminal")
            .map(([source]) => ({ channel: j.record.channel, id: source })),
        )
        .toSorted((a, b) => Number(BigInt(a.id) - BigInt(b.id)));

/** Only #6 verifies source/thread and calls this after all entries are terminal. */
export const settleRecord = (api: DiscordApi, stateId: string, journal: Journal) =>
  Effect.gen(function* () {
    if (
      journal.record.phase === "scan" ||
      (journal.record.phase === "idle" &&
        (journal.record.checkpoint !== undefined || !journal.entries.size)) ||
      [...journal.entries].some(([, status]) => status?.state !== "terminal")
    )
      return journal;
    const settled =
      journal.record.phase === "work"
        ? yield* updateRecord(api, stateId, journal, {
            ...journal.record,
            floor: journal.record.high!,
            high: null,
            before: null,
            phase: "idle",
          })
        : journal;
    const content = "DLS1 checkpoint {}";
    const entries = () =>
      api
        .listThreadMessages(journal.parent)
        .pipe(
          Effect.map((messages) =>
            messages.filter(
              (message) =>
                message.content === content &&
                (settled.record.checkpoint === undefined ||
                  BigInt(message.id) > BigInt(settled.record.checkpoint)),
            ),
          ),
        );
    if (!(yield* entries()).length) yield* Effect.exit(api.createMessage(journal.parent, content));
    const markers = yield* entries();
    if (markers.length !== 1) return yield* fail("Unreconciled Channel Record checkpoint");
    return yield* updateRecord(api, stateId, settled, {
      ...settled.record,
      checkpoint: markers[0]!.id,
    });
  });

/** The parent checkpoint is durable before deletion. A later Run resumes bounded garbage collection. */
export const pruneJournal = (api: DiscordApi, botId: string, journal: Journal) =>
  Effect.gen(function* () {
    if (!journal.record.checkpoint) return;
    const old = yield* api.listThreadMessages(journal.parent, journal.record.checkpoint);
    for (const message of old.filter((item) => item.author.id === botId).slice(0, 50))
      yield* api.deleteMessage(journal.parent, message.id);
  });

/** Rescan recent history for deleted bot-owned threads, preserving unresolved journal entries. */
export const rewindRecent = (
  api: DiscordApi,
  stateId: string,
  botId: string,
  journal: Journal,
  since: DateTime.Utc,
  horizon: Duration.Duration,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const boundary = normalLowerBound(since, DateTime.makeUnsafe(now), horizon);
    const newFloor = (BigInt(snowflakeAt(boundary)) - 1n).toString();
    const reset = yield* recentReset(api, botId, journal, newFloor);
    const changedSince = DateTime.formatIso(since) !== journal.record.since;
    const backfill = Date.parse(journal.record.since) > DateTime.toEpochMillis(since);
    if (!reset && !changedSince) return journal;
    const floor = reset
      ? (BigInt(reset) - 1n).toString()
      : backfill
        ? newFloor
        : journal.record.floor;
    if (reset) {
      journal = yield* journalPage(api, botId, journal, `reset/${reset}`, [reset]);
      journal = yield* journalStatus(api, stateId, botId, journal, { id: reset, state: "pending" });
    }
    if (BigInt(floor) >= BigInt(journal.record.floor))
      return yield* updateRecord(api, stateId, journal, {
        ...journal.record,
        since: DateTime.formatIso(since),
      });
    const next = {
      ...journal.record,
      since: DateTime.formatIso(since),
      floor,
      phase: "idle" as const,
      high: null,
      before: null,
    };
    return yield* updateRecord(api, stateId, journal, next);
  });
