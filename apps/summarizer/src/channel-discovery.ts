import { Clock, DateTime, Duration, Effect } from "effect";
import type { DiscordApi } from "./discord-client.ts";
import type { DiscordMessage } from "./discord-schema.ts";
import { linkFromPost } from "./link-post.ts";
import { normalLowerBound } from "./window.ts";
import {
  fail,
  journalPage,
  journalStatus,
  snowflakeAt,
  updateRecord,
  type ChannelRecord,
  type Journal,
} from "./channel-record.ts";

/** Snapshot an actual message ID; a channel's last_message_id may point at a deletion. */
export const beginScan = (api: DiscordApi, journal: Journal) =>
  Effect.gen(function* () {
    if (journal.record.phase !== "idle") return journal;
    const highest = (yield* api.listMessages(journal.record.channel))[0]?.id;
    if (!highest || BigInt(highest) <= BigInt(journal.record.floor)) return journal;
    return yield* updateRecord(journal, {
      ...journal.record,
      phase: "scan",
      high: highest,
      before: (BigInt(highest) + 1n).toString(),
    });
  });

/** maxPages is the caller's remaining Run budget; scan phase blocks younger work globally. */
export const scanPages = (api: DiscordApi, botId: string, initial: Journal, maxPages: number) =>
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
        journal,
        eligible.map((m) => m.id),
      );
      const finished = page.length < 100 || BigInt(low!) <= floor;
      journal = yield* updateRecord(journal, {
        ...journal.record,
        phase: finished ? "work" : "scan",
        before: low ?? journal.record.before,
      });
    }
    return journal;
  });

const journalThreads = (
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
        result = yield* journalPage(result, [thread.id]);
    return result;
  });

/** Journal each archive page before advancing its persistent cursor. */
export const adoptInProgress = (
  api: DiscordApi,
  botId: string,
  journal: Journal,
  guild: string,
  budget: number,
) =>
  Effect.gen(function* () {
    const active = (yield* api.listActiveThreads(guild)).filter(
      (t) => t.parent_id === journal.record.channel,
    );
    let result = yield* journalThreads(botId, journal, active);
    let before = journal.record.archiveBefore ?? undefined;
    for (;;) {
      const page = yield* api.listArchivedThreads(journal.record.channel, before);
      result = yield* journalThreads(botId, result, page.threads);
      if (!page.has_more) {
        if (before !== undefined)
          result = yield* updateRecord(result, {
            ...result.record,
            archiveBefore: null,
          });
        return result;
      }
      before = page.threads.at(-1)?.thread_metadata.archive_timestamp;
      if (!before) return yield* fail("Archived thread pagination lacks a cursor");
      result = yield* updateRecord(result, {
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

const deletedThread = (api: DiscordApi, botId: string, journal: Journal, source: DiscordMessage) =>
  Effect.gen(function* () {
    if (!linkFromPost(source, botId)) return false;
    const thread = yield* api.getChannel(source.id).pipe(
      Effect.catchIf(
        (error) => error.kind === "not-found",
        () => Effect.succeed(undefined),
      ),
    );
    const state = journal.entries.get(source.id)?.state;
    return !thread && (state === "terminal" || BigInt(source.id) <= BigInt(journal.record.floor));
  });

const clearRecent = (record: ChannelRecord): ChannelRecord => {
  const next = { ...record };
  delete next.recentBefore;
  delete next.recentFloor;
  delete next.recentSince;
  next.recentReset = null;
  return next;
};

const checkpointRecent = (journal: Journal, before: string, reset: string | null) =>
  updateRecord(journal, {
    ...clearRecent(journal.record),
    recentBefore: before,
    recentFloor: journal.record.recentFloor!,
    recentSince: journal.record.recentSince!,
    recentReset: reset,
  });

const scanRecent = (api: DiscordApi, botId: string, initial: Journal, budget: number) =>
  Effect.gen(function* () {
    let journal = initial;
    let reset = journal.record.recentReset;
    for (;;) {
      if ((yield* Clock.currentTimeMillis) >= budget) return { journal, complete: false };
      const page = yield* api.listMessages(journal.record.channel, journal.record.recentBefore);
      let before = journal.record.recentBefore!;
      let finished = page.length < 100;
      for (const source of page) {
        if (BigInt(source.id) < BigInt(journal.record.recentFloor!)) {
          finished = true;
          break;
        }
        if (yield* deletedThread(api, botId, journal, source)) reset = source.id;
        before = source.id;
        if (budget <= (yield* Clock.currentTimeMillis)) {
          journal = yield* checkpointRecent(journal, before, reset);
          return { journal, complete: false };
        }
      }
      if (finished) return { journal, reset, complete: true };
      journal = yield* checkpointRecent(journal, before, reset);
    }
  });

const completeRecent = (
  journal: Journal,
  since: DateTime.Utc,
  newFloor: string,
  reset?: string | null,
) =>
  Effect.gen(function* () {
    const sinceText = DateTime.formatIso(since);
    const backfill = Date.parse(journal.record.since) > DateTime.toEpochMillis(since);
    const floor = reset
      ? (BigInt(reset) - 1n).toString()
      : backfill
        ? newFloor
        : journal.record.floor;
    if (reset) {
      journal = yield* journalPage(journal, [reset]);
      journal = yield* journalStatus(journal, { id: reset, state: "pending" });
    }
    if (BigInt(floor) >= BigInt(journal.record.floor)) {
      return yield* updateRecord(journal, {
        ...clearRecent(journal.record),
        since: sinceText,
      });
    }
    const next = {
      ...clearRecent(journal.record),
      since: sinceText,
      floor,
      phase: "idle" as const,
      high: null,
      before: null,
    };
    return yield* updateRecord(journal, next);
  });

/** Rescan recent history with a durable cursor and a bounded time slice. */
export const rewindRecent = (
  api: DiscordApi,
  botId: string,
  initial: Journal,
  since: DateTime.Utc,
  horizon: Duration.Duration,
  budget = Infinity,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const boundary = normalLowerBound(since, DateTime.makeUnsafe(now), horizon);
    const newFloor = (BigInt(snowflakeAt(boundary)) - 1n).toString();
    const sinceText = DateTime.formatIso(since);
    let journal = initial;
    if (journal.record.recentSince !== sinceText) {
      const first = (yield* api.listMessages(journal.record.channel))[0]?.id;
      if (!first) return yield* completeRecent(initial, since, newFloor);
      journal = {
        ...journal,
        record: {
          ...clearRecent(journal.record),
          recentBefore: (BigInt(first) + 1n).toString(),
          recentFloor: newFloor,
          recentSince: sinceText,
        },
      };
    }
    const scanned = yield* scanRecent(api, botId, journal, budget);
    const confirmed = scanned.journal === journal ? initial : scanned.journal;
    return scanned.complete
      ? yield* completeRecent(confirmed, since, journal.record.recentFloor!, scanned.reset)
      : confirmed;
  });
