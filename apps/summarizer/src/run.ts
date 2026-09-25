import { Service } from "@opencode/client/service";
import {
  Clock,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Result,
} from "effect";
import type { Settings } from "./config.ts";
import {
  adoptInProgress,
  beginScan,
  dueJournalIds,
  pruneJournal,
  rewindRecent,
  scanPages,
  settleRecord,
} from "./channel-discovery.ts";
import {
  indexRecords,
  openChannelRecord,
  readJournal,
  type ChannelRecord,
  type Journal,
} from "./channel-record.ts";
import { Discord, DiscordLive, type DiscordApi } from "./discord-client.ts";
import type { DiscordThread } from "./discord-schema.ts";
import { linkFromPost, linkPostState } from "./link-post.ts";
import { OpenCode } from "./opencode-client.ts";
import { OpenCodeServer } from "./opencode-server.ts";
import { workOn } from "./run-attempt.ts";
import { SessionPublication } from "./session-publication.ts";
import { normalLowerBound } from "./window.ts";

type Channel = Settings["channels"][number];
type Resolved = { readonly channel: Channel; readonly guild: string };
class RunFailure extends Data.TaggedError("RunFailure")<{ readonly message: string }> {}

const emptyCounts = () => ({ inProgress: 0, givenUp: 0 });
const tally = (
  counts: ReturnType<typeof emptyCounts>,
  state: ReturnType<typeof linkPostState>,
) => ({
  inProgress: counts.inProgress + Number(state === "in-progress"),
  givenUp: counts.givenUp + Number(state === "given-up"),
});

const drySource = (api: DiscordApi, channel: string, id: string) =>
  api.getMessage(channel, id).pipe(
    Effect.catchIf(
      (error) => error.kind === "not-found",
      () => Effect.succeed(undefined),
    ),
  );

const directDryThread = (api: DiscordApi, parent: string, id: string) =>
  Effect.gen(function* () {
    const thread = yield* api.getChannel(id).pipe(
      Effect.catchIf(
        (error) => error.kind === "not-found",
        () => Effect.succeed(undefined),
      ),
    );
    if (!thread) return undefined;
    if (
      thread.type !== 11 ||
      thread.parent_id !== parent ||
      thread.owner_id === undefined ||
      thread.name === undefined ||
      thread.thread_metadata === undefined
    )
      return yield* new RunFailure({ message: `Invalid Summary Thread ${id}` });
    return { id: thread.id, owner_id: thread.owner_id, name: thread.name };
  });

const reconcileUnlisted = (
  api: DiscordApi,
  bot: string,
  channel: string,
  withoutThread: Set<string>,
  deadline: number,
  initial: ReturnType<typeof emptyCounts>,
) =>
  Effect.gen(function* () {
    let counts = initial;
    for (const id of withoutThread) {
      if ((yield* Clock.currentTimeMillis) >= deadline) return { counts, partial: true };
      const source = yield* drySource(api, channel, id);
      if (!source || !linkFromPost(source, bot)) {
        withoutThread.delete(id);
        continue;
      }
      const thread = yield* directDryThread(api, channel, id);
      if (!thread) continue;
      withoutThread.delete(id);
      counts = tally(counts, linkPostState(thread, bot));
    }
    return { counts, partial: false };
  });

const dryJournalStates = (
  api: DiscordApi,
  bot: string,
  channel: string,
  since: number,
  seen: Set<string>,
  withoutThread: Set<string>,
  deadline: number,
  journal?: Journal,
) =>
  Effect.gen(function* () {
    let counts = emptyCounts();
    if (!journal) return { counts, partial: false };
    for (const [id, status] of journal.entries) {
      if (seen.has(id) || status?.state === "terminal") continue;
      if ((yield* Clock.currentTimeMillis) >= deadline) return { counts, partial: true };
      const source = yield* drySource(api, channel, id);
      if (source && linkFromPost(source, bot)) {
        const state = linkPostState(source.thread, bot);
        if (Date.parse(source.timestamp) >= since || state === "in-progress") {
          seen.add(id);
          if (source.thread) counts = tally(counts, state);
          else withoutThread.add(id);
        }
      }
    }
    return { counts, partial: false };
  });

const dryThreadStates = (
  api: DiscordApi,
  bot: string,
  resolved: Resolved,
  seen: Set<string>,
  withoutThread: Set<string>,
  deadline: number,
  journal?: Journal,
) =>
  Effect.gen(function* () {
    let counts = emptyCounts();
    const consider = (thread: DiscordThread) =>
      Effect.gen(function* () {
        const candidate = withoutThread.has(thread.id);
        if (
          thread.parent_id !== resolved.channel.id ||
          (seen.has(thread.id) && !candidate) ||
          (!candidate &&
            (thread.owner_id !== bot ||
              !thread.name.startsWith("⏳ ") ||
              journal?.entries.get(thread.id)?.state === "terminal"))
        )
          return;
        const source = yield* drySource(api, resolved.channel.id, thread.id);
        withoutThread.delete(thread.id);
        if (source && linkFromPost(source, bot)) {
          seen.add(thread.id);
          counts = tally(counts, linkPostState(thread, bot));
        }
      });
    for (const thread of yield* api.listActiveThreads(resolved.guild)) {
      if ((yield* Clock.currentTimeMillis) >= deadline) return { counts, partial: true };
      yield* consider(thread);
    }
    let before: string | undefined;
    for (;;) {
      if ((yield* Clock.currentTimeMillis) >= deadline) return { counts, partial: true };
      const page = yield* api.listArchivedThreads(resolved.channel.id, before);
      for (const thread of page.threads) {
        if ((yield* Clock.currentTimeMillis) >= deadline) return { counts, partial: true };
        yield* consider(thread);
      }
      if (!page.has_more) break;
      before = page.threads.at(-1)?.thread_metadata.archive_timestamp;
      if (!before)
        return yield* new RunFailure({ message: "Archived thread pagination lacks a cursor" });
    }
    return yield* reconcileUnlisted(api, bot, resolved.channel.id, withoutThread, deadline, counts);
  });

const preflight = (api: DiscordApi, config: Settings) =>
  Effect.gen(function* () {
    const valid: Resolved[] = [];
    let skipped = false;
    for (const channel of config.channels) {
      const result = yield* api.getChannel(channel.id).pipe(Effect.result);
      if (Result.isFailure(result)) {
        if (result.failure.kind !== "forbidden" && result.failure.kind !== "not-found")
          return yield* Effect.fail(result.failure);
        skipped = true;
        yield* Effect.logError(`Unreadable watched channel ${channel.label} (${channel.id})`);
        continue;
      }
      if (![0, 5].includes(result.success.type) || !result.success.guild_id)
        return yield* new RunFailure({ message: `Unsupported Watched Channel ${channel.id}` });
      valid.push({ channel, guild: result.success.guild_id });
    }
    return { valid, skipped };
  });

const dryCounts = (
  api: DiscordApi,
  bot: string,
  resolved: Resolved,
  since: number,
  bound: number,
  deadline: number,
  journal?: Journal,
) =>
  Effect.gen(function* () {
    let counts = emptyCounts();
    const seen = new Set<string>();
    const withoutThread = new Set<string>();
    let before: string | undefined;
    let partial = false;
    for (;;) {
      const page = yield* api.listMessages(resolved.channel.id, before);
      for (const message of page) {
        if (Date.parse(message.timestamp) < bound || !linkFromPost(message, bot)) continue;
        seen.add(message.id);
        if (message.thread) counts = tally(counts, linkPostState(message.thread, bot));
        else withoutThread.add(message.id);
      }
      if (page.length < 100 || Date.parse(page.at(-1)!.timestamp) < bound) break;
      before = page.at(-1)!.id;
      const now = yield* Clock.currentTimeMillis;
      if (now >= deadline) {
        partial = true;
        break;
      }
    }
    if (partial) return { ...counts, pending: withoutThread.size, partial };
    // An older started Link remains work even after Since or Horizon moves forward.
    const extra = yield* dryJournalStates(
      api,
      bot,
      resolved.channel.id,
      since,
      seen,
      withoutThread,
      deadline,
      journal,
    );
    const combined = {
      inProgress: counts.inProgress + extra.counts.inProgress,
      givenUp: counts.givenUp + extra.counts.givenUp,
    };
    if (extra.partial) return { ...combined, pending: withoutThread.size, partial: true };
    const threads = yield* dryThreadStates(
      api,
      bot,
      resolved,
      seen,
      withoutThread,
      deadline,
      journal,
    );
    return {
      ...combined,
      pending: withoutThread.size,
      inProgress: combined.inProgress + threads.counts.inProgress,
      givenUp: combined.givenUp + threads.counts.givenUp,
      partial: threads.partial,
    };
  });

const reportDry = (
  api: DiscordApi,
  bot: string,
  settings: Settings,
  valid: readonly Resolved[],
  indexed: ReadonlyMap<string, { parent: string; record: ChannelRecord }>,
  deadline: number,
) =>
  Effect.gen(function* () {
    for (const resolved of valid) {
      const { channel } = resolved;
      const found = indexed.get(channel.id);
      const journal = found
        ? yield* readJournal(api, settings.stateChannelId, bot, found.parent, found.record)
        : undefined;
      const since = DateTime.toEpochMillis(channel.since);
      const normal = normalLowerBound(
        channel.since,
        DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
        settings.horizon,
      );
      const floor = journal
        ? Number((BigInt(journal.record.floor) + 1n) >> 22n) + 1420070400000
        : normal;
      const bound = Math.max(since, Math.min(floor, normal));
      const catchUp = Boolean(
        journal &&
        ((floor < normal && floor >= since) ||
          [...journal.entries].some(
            ([id, status]) =>
              status?.state !== "terminal" && Number(BigInt(id) >> 22n) + 1420070400000 >= since,
          )),
      );
      const counts = yield* dryCounts(api, bot, resolved, since, bound, deadline, journal);
      yield* Effect.logInfo(
        `${channel.label}: effective start ${new Date(bound).toISOString()} ${!journal ? "uninitialized" : catchUp ? "catch-up" : "current"}; Pending ${counts.pending}, In progress ${counts.inProgress}, Given up ${counts.givenUp}${counts.partial || Boolean(journal?.record.recentBefore) || journal?.record.phase === "scan" ? " (partial)" : ""}`,
      );
    }
  });

const discover = (
  api: DiscordApi,
  bot: string,
  settings: Settings,
  valid: readonly Resolved[],
  budget: number,
) =>
  Effect.gen(function* () {
    const journals = new Map<string, Journal>();
    for (const { channel, guild } of valid) {
      let journal: Journal = (yield* openChannelRecord(
        api,
        settings.stateChannelId,
        channel.id,
        channel.since,
        settings.horizon,
        bot,
        false,
      )).journal!;
      journal = yield* rewindRecent(
        api,
        settings.stateChannelId,
        bot,
        journal,
        channel.since,
        settings.horizon,
        Math.min(
          budget - Duration.toMillis(settings.runBudget) / 2,
          (yield* Clock.currentTimeMillis) +
            Duration.toMillis(settings.runBudget) / (2 * valid.length),
        ),
      );
      journal = yield* adoptInProgress(api, settings.stateChannelId, bot, journal, guild, budget);
      journal = yield* settleRecord(api, settings.stateChannelId, journal);
      yield* pruneJournal(api, bot, journal).pipe(
        Effect.catch((error) => Effect.logWarning(`Journal cleanup deferred: ${String(error)}`)),
      );
      journals.set(channel.id, yield* beginScan(api, settings.stateChannelId, journal));
    }
    while (
      [...journals.values()].some((j) => j.record.phase === "scan") &&
      (yield* Clock.currentTimeMillis) < budget
    ) {
      for (const { channel } of valid) {
        const journal = journals.get(channel.id)!;
        if ((yield* Clock.currentTimeMillis) < budget)
          journals.set(channel.id, yield* scanPages(api, settings.stateChannelId, bot, journal, 1));
      }
    }
    return journals;
  });

/** All Discord writes and private-server lifetime occur under the caller's machine lock. */
export const run = (
  settings: Settings,
  dryRun: boolean,
  token: Redacted.Redacted,
  database: string,
  environment: Readonly<Record<string, string>>,
  discoverService: typeof Service.discover = Service.discover,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const budget = started + Duration.toMillis(settings.runBudget);
    const api = yield* Discord;
    const identity = yield* api.currentUser;
    if (Math.abs(identity.date.getTime() - (yield* Clock.currentTimeMillis)) > 60_000)
      return yield* Effect.fail(
        new RunFailure({ message: "Machine clock differs from Discord by more than 60 seconds" }),
      );
    const { valid, skipped } = yield* preflight(api, settings);
    // A state-channel failure aborts before even one watched-channel mutation.
    const indexed = yield* indexRecords(api, settings.stateChannelId, identity.user.id);
    if (dryRun) {
      yield* reportDry(
        api,
        identity.user.id,
        settings,
        valid,
        indexed,
        started +
          Duration.toMillis(settings.runBudget) +
          Duration.toMillis(settings.summaryTimeout),
      );
      return skipped ? 1 : 0;
    }
    const journals = yield* discover(api, identity.user.id, settings, valid, budget);
    const queue = dueJournalIds([...journals.values()]);
    if ((yield* Clock.currentTimeMillis) >= budget) return skipped ? 1 : 0;
    const serverLayer = OpenCodeServer.layer({
      directory: settings.opencode.directory,
      database,
      environment,
    });
    const server = Context.get(yield* Layer.build(serverLayer), OpenCodeServer);
    const privateLayer = OpenCode.layer({
      ...server,
      directory: settings.opencode.directory,
      agent: settings.opencode.agent,
    });
    const layer = SessionPublication.layer(settings.opencode.directory, discoverService).pipe(
      Layer.provideMerge(privateLayer),
    );
    return yield* Effect.gen(function* () {
      const client = yield* OpenCode;
      const publication = yield* SessionPublication;
      yield* client.commands([...new Set(valid.map(({ channel }) => channel.command))]);
      const stale =
        (yield* Clock.currentTimeMillis) - Duration.toMillis(settings.summaryTimeout) - 120_000;
      yield* client.sweep(stale, settings.deleteSessions);
      const pending = yield* publication
        .pending(settings.deleteSessions)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(`Publication deferred: ${error.reason}`).pipe(Effect.as(undefined)),
          ),
        );
      if (pending)
        for (const result of pending)
          if (result.type === "deferred")
            yield* Effect.logWarning(`Publication deferred ${result.id}: ${result.reason}`);
      const runID = crypto.randomUUID();
      yield* Effect.forEach(
        queue,
        ({ id, channel: channelId }) =>
          Effect.gen(function* () {
            if ((yield* Clock.currentTimeMillis) >= budget) return void 0;
            const channel = valid.find((entry) => entry.channel.id === channelId)!.channel;
            yield* workOn(
              api,
              client,
              publication,
              settings.stateChannelId,
              identity.user.id,
              settings,
              journals.get(channelId)!,
              { id, channel },
              runID,
            );
            return void 0;
          }),
        { concurrency: settings.concurrency },
      );
      for (const { channel } of valid) {
        const latest = journals.get(channel.id)!;
        const refreshed = yield* readJournal(
          api,
          settings.stateChannelId,
          identity.user.id,
          latest.parent,
          latest.record,
        );
        const settled = yield* settleRecord(api, settings.stateChannelId, refreshed);
        yield* pruneJournal(api, identity.user.id, settled).pipe(
          Effect.catch((error) => Effect.logWarning(`Journal cleanup deferred: ${String(error)}`)),
        );
      }
      return skipped ? 1 : 0;
    }).pipe(Effect.provide(layer));
  }).pipe(
    Effect.scoped,
    Effect.provide(DiscordLive(token)),
    Effect.timeoutOption(
      Duration.toMillis(settings.runBudget) + Duration.toMillis(settings.summaryTimeout) + 60_000,
    ),
    Effect.map((value) => Option.getOrElse(value, () => 1)),
  );
