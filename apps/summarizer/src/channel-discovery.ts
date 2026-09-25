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
  delete next.recentReset;
  return next;
};

const checkpointRecent = (
  api: DiscordApi,
  stateId: string,
  journal: Journal,
  before: string,
  reset?: string,
) =>
  updateRecord(api, stateId, journal, {
    ...clearRecent(journal.record),
    recentBefore: before,
    recentFloor: journal.record.recentFloor!,
    recentSince: journal.record.recentSince!,
    ...(reset === undefined ? {} : { recentReset: reset }),
  });

const scanRecent = (
  api: DiscordApi,
  stateId: string,
  botId: string,
  initial: Journal,
  budget: number,
) =>
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
          journal = yield* checkpointRecent(api, stateId, journal, before, reset);
          return { journal, complete: false };
        }
      }
      if (finished) return { journal, reset, complete: true };
      journal = yield* checkpointRecent(api, stateId, journal, before, reset);
    }
  });

const completeRecent = (
  api: DiscordApi,
  stateId: string,
  botId: string,
  journal: Journal,
  since: DateTime.Utc,
  newFloor: string,
  reset?: string,
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
      journal = yield* journalPage(api, botId, journal, `reset/${reset}`, [reset]);
      journal = yield* journalStatus(api, stateId, botId, journal, { id: reset, state: "pending" });
    }
    if (BigInt(floor) >= BigInt(journal.record.floor)) {
      if (sinceText === journal.record.since && journal.record.recentBefore === undefined)
        return journal;
      return yield* updateRecord(api, stateId, journal, {
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
    return yield* updateRecord(api, stateId, journal, next);
  });

/** Rescan recent history with a durable cursor and a bounded time slice. */
export const rewindRecent = (
  api: DiscordApi,
  stateId: string,
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
      if (!first) return yield* completeRecent(api, stateId, botId, initial, since, newFloor);
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
    const scanned = yield* scanRecent(api, stateId, botId, journal, budget);
    const confirmed = scanned.journal === journal ? initial : scanned.journal;
    return scanned.complete
      ? yield* completeRecent(
          api,
          stateId,
          botId,
          confirmed,
          since,
          journal.record.recentFloor!,
          scanned.reset,
        )
      : confirmed;
  });
