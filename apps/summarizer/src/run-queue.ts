import { Clock, Effect, Exit, Option, Queue } from "effect";
import type { Settings } from "./config.ts";
import { beginScan, dueJournalIds, scanPages } from "./channel-discovery.ts";
import { fail, readJournal, settleRecord, type Journal } from "./channel-record.ts";
import type { DiscordApi } from "./discord-client.ts";
import { OpenCode } from "./opencode-client.ts";
import { workOn } from "./run-attempt.ts";
import { SessionPublication } from "./session-publication.ts";

const interval = 5_000;
type Entry = ReturnType<typeof dueJournalIds>[number];
type Work = ReturnType<typeof workOn>;
type Completion = {
  readonly id: string;
  readonly exit: Exit.Exit<Effect.Success<Work>, Effect.Error<Work>>;
};

const refresh = (journals: Map<string, Journal>) =>
  Effect.gen(function* () {
    for (const id of journals.keys()) {
      const journal = yield* readJournal(id);
      if (!journal) return yield* fail("Missing Channel Record during polling");
      journals.set(id, journal);
    }
    return void 0;
  });

const poll = (api: DiscordApi, bot: string, journals: Map<string, Journal>, budget: number) =>
  Effect.gen(function* () {
    for (const [id, journal] of journals) {
      if ((yield* Clock.currentTimeMillis) >= budget) break;
      const scanning = yield* beginScan(api, journal);
      if ((yield* Clock.currentTimeMillis) >= budget) break;
      journals.set(id, yield* scanPages(api, bot, scanning, 1));
    }
  });

const watchQueue = (
  api: DiscordApi,
  bot: string,
  settings: Settings,
  journals: Map<string, Journal>,
  budget: number,
  work: (entry: Entry) => Work,
) =>
  Effect.gen(function* () {
    const completed = yield* Queue.unbounded<Completion>();
    const active = new Set<string>();
    const retries = new Map<string, number>();
    let nextPoll = (yield* Clock.currentTimeMillis) + interval;
    yield* Effect.logInfo(
      "Watching for new Link Posts every 5 seconds until the Run budget expires",
    );
    const finish = (completion: Completion) =>
      Effect.gen(function* () {
        active.delete(completion.id);
        const result = yield* completion.exit;
        if (result.journal.entries.get(completion.id)?.state !== "terminal")
          retries.set(completion.id, result.retryAt ?? (yield* Clock.currentTimeMillis) + interval);
        yield* settleRecord(result.journal);
      });
    const collect = Queue.takeBetween(completed, 0, settings.concurrency).pipe(
      Effect.flatMap(Effect.forEach(finish)),
    );
    const admit = Effect.gen(function* () {
      for (const entry of dueJournalIds([...journals.values()])) {
        const now = yield* Clock.currentTimeMillis;
        if (now >= budget || active.size >= settings.concurrency) break;
        if (active.has(entry.id) || (retries.get(entry.id) ?? 0) > now) continue;
        retries.delete(entry.id);
        active.add(entry.id);
        yield* work(entry).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Queue.offer(completed, { id: entry.id, exit })),
          Effect.forkScoped,
        );
      }
    });

    while ((yield* Clock.currentTimeMillis) < budget) {
      yield* collect;
      yield* refresh(journals);
      const now = yield* Clock.currentTimeMillis;
      if (now >= nextPoll) {
        yield* poll(api, bot, journals, budget);
        const scanning = [...journals.values()].some((journal) => journal.record.phase === "scan");
        nextPoll = (yield* Clock.currentTimeMillis) + (scanning ? 0 : interval);
        yield* collect;
        yield* refresh(journals);
      }
      yield* admit;
      const after = yield* Clock.currentTimeMillis;
      const retryAt = active.size < settings.concurrency ? Math.min(...retries.values()) : Infinity;
      const wakeAt = Math.min(budget, nextPoll, retryAt);
      const completion = yield* Queue.take(completed).pipe(
        Effect.timeoutOption(Math.max(0, wakeAt - after)),
      );
      if (Option.isSome(completion)) yield* finish(completion.value);
    }
    while (active.size > 0) yield* finish(yield* Queue.take(completed));
  });

/** One writer; polling admits new work while scoped Attempts occupy bounded slots. */
export const runQueue = (
  api: DiscordApi,
  bot: string,
  settings: Settings,
  journals: Map<string, Journal>,
  budget: number,
  watch: boolean,
) =>
  Effect.gen(function* () {
    const client = yield* OpenCode;
    const publication = yield* SessionPublication;
    const runID = crypto.randomUUID();
    const queue = dueJournalIds([...journals.values()]);
    let admitted = queue.length === 0;
    const work = ({ id, channel: channelId }: Entry) => {
      admitted = true;
      return workOn(
        api,
        client,
        publication,
        bot,
        settings,
        journals.get(channelId)!,
        { id, channel: settings.channels.find((channel) => channel.id === channelId)! },
        runID,
      );
    };
    if (watch && journals.size > 0) yield* watchQueue(api, bot, settings, journals, budget, work);
    else
      yield* Effect.forEach(
        queue,
        (entry) =>
          Effect.gen(function* () {
            if ((yield* Clock.currentTimeMillis) >= budget) return;
            yield* work(entry);
          }),
        { concurrency: settings.concurrency },
      );
    return admitted;
  });
