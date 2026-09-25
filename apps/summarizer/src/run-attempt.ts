import { Clock, Data, DateTime, Duration, Effect, Exit, Option } from "effect";
import type { Settings } from "./config.ts";
import { attemptStatus, formatNote, parseNote, summaryParts, type Note } from "./attempt.ts";
import { journalStatus, persistReady, type Journal } from "./channel-record.ts";
import { verifyReady } from "./ready.ts";
import type { DiscordApi } from "./discord-client.ts";
import type { DiscordMessage } from "./discord-schema.ts";
import { linkFromPost, linkPostState, threadTitle } from "./link-post.ts";
import type { OpenCodeAttempt, OpenCodeError, OpenCodeResult } from "./opencode-client.ts";
import type { PublicationResult } from "./session-publication.ts";
import { splitSummary } from "./summary.ts";

export interface Work {
  readonly id: string;
  readonly channel: Settings["channels"][number];
}

const history = (api: DiscordApi, thread: string) =>
  Effect.gen(function* () {
    const messages: DiscordMessage[] = [];
    for (;;) {
      const page = yield* api.listThreadMessages(thread, messages.at(-1)?.id);
      messages.push(...page);
      if (page.length < 100) return messages.toReversed();
    }
  });

const writeMessage = (api: DiscordApi, thread: string, content: string) =>
  Effect.gen(function* () {
    const before = new Set((yield* history(api, thread)).map((m) => m.id));
    const result = yield* Effect.exit(api.createMessage(thread, content));
    if (Exit.isSuccess(result)) return result.value;
    const matches = (yield* history(api, thread)).filter(
      (m) => !before.has(m.id) && m.content === content,
    );
    if (matches.length === 1) return matches[0]!;
    return yield* Effect.failCause(result.cause);
  });

const rename = (api: DiscordApi, id: string, name: string) => {
  let fallback = false;
  const alternative = name.startsWith("⚠️") ? "⚠️ 요약" : "요약";
  return api.modifyThread(id, name, true).pipe(
    Effect.catchIf(
      (error) => error.kind === "name-rejected" && name !== alternative,
      () => {
        fallback = true;
        return api.modifyThread(id, alternative, true);
      },
    ),
    Effect.catch((error) =>
      api.getChannel(id).pipe(
        Effect.filterOrFail(
          (thread) =>
            thread.thread_metadata?.archived === true &&
            (thread.name === name || (fallback && thread.name === alternative)),
          () => error,
        ),
      ),
    ),
  );
};

const threadFor = (api: DiscordApi, source: DiscordMessage, name: string, bot: string) =>
  Effect.gen(function* () {
    let thread = source.thread;
    if (!thread) {
      const created = yield* api.startThread(source.channel_id, source.id, `⏳ ${name}`).pipe(
        Effect.catchIf(
          (error) => error.kind === "name-rejected",
          () => api.startThread(source.channel_id, source.id, "⏳ 요약"),
        ),
        Effect.catchIf(
          (error) => error.kind === "thread-exists" || error.kind === "outage",
          () => api.getMessage(source.channel_id, source.id).pipe(Effect.map((m) => m.thread)),
        ),
      );
      thread = created;
    }
    return thread?.owner_id === bot ? thread : undefined;
  });

const notesOf = (messages: readonly DiscordMessage[], bot: string) =>
  messages.flatMap((message) => {
    const note = message.author.id === bot ? parseNote(message.content) : undefined;
    return note
      ? [
          {
            message,
            note,
            at: DateTime.makeUnsafe(Date.parse(message.edited_timestamp ?? message.timestamp)),
          },
        ]
      : [];
  });

const interrupted = (api: DiscordApi, thread: string, note: DiscordMessage, value: Note) =>
  api
    .editMessage(
      thread,
      note.id,
      formatNote({
        kind: "interrupted",
        number: value.number,
        maximum: value.maximum,
      }),
    )
    .pipe(Effect.ignore);

type Client = {
  readonly run: (
    attempt: OpenCodeAttempt,
    timeout: number,
    deleteSession: boolean,
  ) => Effect.Effect<OpenCodeResult, OpenCodeError>;
};
type Publisher = {
  readonly publish: (id: string, deleteSessions: boolean) => Effect.Effect<PublicationResult>;
};
class AttemptFailure extends Data.TaggedError("AttemptFailure")<{ readonly message: string }> {}

const verifyCommitted = (
  api: DiscordApi,
  channel: string,
  id: string,
  bot: string,
  journal: Journal,
) =>
  Effect.gen(function* () {
    const source = yield* api.getMessage(channel, id).pipe(
      Effect.catchIf(
        (error) => error.kind === "not-found",
        () => Effect.succeed(undefined),
      ),
    );
    if (!source) return void 0;
    const thread = yield* api.getChannel(id);
    const ready = journal.entries.get(id);
    const messages = yield* history(api, id);
    if (
      thread.parent_id !== channel ||
      thread.owner_id !== bot ||
      !thread.thread_metadata?.archived ||
      !thread.name ||
      thread.name.startsWith("⏳ ") ||
      thread.name.startsWith("⚠️ ") ||
      (ready?.state === "ready" && !verifyReady(ready, messages, bot)) ||
      !messages.some((message) => message.author.id === bot)
    )
      return yield* new AttemptFailure({ message: `Unverified terminal Summary Thread ${id}` });
    return void 0;
  });

const verifyGivenUp = (api: DiscordApi, channel: string, id: string, bot: string) =>
  Effect.gen(function* () {
    const thread = yield* api.getChannel(id);
    const messages = yield* history(api, id);
    if (
      thread.parent_id !== channel ||
      thread.owner_id !== bot ||
      !thread.name?.startsWith("⚠️ ") ||
      !thread.thread_metadata?.archived ||
      !notesOf(messages, bot).some(({ note }) => note.kind === "failed")
    )
      return yield* new AttemptFailure({ message: `Unverified Given-up Summary Thread ${id}` });
    return void 0;
  });

const settleReady = (
  api: DiscordApi,
  stateId: string,
  bot: string,
  journal: Journal,
  id: string,
  thread: string,
  name: string,
  messages: readonly DiscordMessage[],
) =>
  Effect.gen(function* () {
    const ready = journal.entries.get(id)!;
    if (!verifyReady(ready, messages, bot))
      return yield* new AttemptFailure({ message: "READY parts mismatch" });
    for (const message of messages.filter(
      (m) => m.author.id === bot && !ready.parts!.includes(m.id),
    ))
      yield* api.deleteMessage(thread, message.id);
    yield* rename(api, thread, name);
    yield* verifyCommitted(api, journal.record.channel, id, bot, journal);
    return yield* journalStatus(api, stateId, bot, journal, { id, state: "terminal" });
  });

const failed = (
  api: DiscordApi,
  thread: string,
  note: DiscordMessage,
  number: number,
  maximum: number,
  name: string,
  reason: string,
) =>
  Effect.gen(function* () {
    yield* api.editMessage(
      thread,
      note.id,
      formatNote({ kind: "failed", number, maximum, reason }),
    );
    if (number === maximum) yield* rename(api, thread, `⚠️ ${name}`);
  });

const finishFailure = (
  api: DiscordApi,
  stateId: string,
  bot: string,
  journal: Journal,
  item: Work,
  note: DiscordMessage,
  number: number,
  maximum: number,
  name: string,
  reason: string,
) =>
  Effect.gen(function* () {
    yield* failed(api, item.id, note, number, maximum, name, reason);
    if (number !== maximum) return journal;
    yield* verifyGivenUp(api, item.channel.id, item.id, bot);
    return yield* journalStatus(api, stateId, bot, journal, {
      id: item.id,
      state: "terminal",
    });
  });

const attempt = (
  api: DiscordApi,
  openCode: Client,
  publication: Publisher,
  stateId: string,
  bot: string,
  settings: Settings,
  journal: Journal,
  item: Work,
  runID: string,
  link: string,
  name: string,
  messages: readonly DiscordMessage[],
  number: number,
) =>
  Effect.gen(function* () {
    const thread = item.id;
    const value: Note = { kind: "started", number, maximum: settings.maxAttempts };
    const note = yield* writeMessage(api, thread, formatNote(value));
    return yield* Effect.gen(function* () {
      const outcome = yield* openCode
        .run(
          {
            channelID: item.channel.id,
            messageID: item.id,
            runID,
            label: item.channel.label,
            link,
            command: item.channel.command,
          },
          Duration.toMillis(settings.summaryTimeout),
          settings.deleteSessions,
        )
        .pipe(Effect.timeoutOption(Duration.toMillis(settings.summaryTimeout)));
      if (Option.isNone(outcome)) {
        return yield* finishFailure(
          api,
          stateId,
          bot,
          journal,
          item,
          note,
          number,
          settings.maxAttempts,
          name,
          "시간 초과 (timeout)",
        );
      }
      const result = outcome.value;
      const published = yield* publication.publish(result.sessionID, settings.deleteSessions);
      if (published.type === "deferred")
        yield* Effect.logWarning(`Publication deferred ${result.sessionID}: ${published.reason}`);
      if (result.type !== "succeeded") {
        const reason = result.type === "failed" ? result.reason : "interrupted";
        if (
          /^(?:provider\.(?:auth|quota|no-route|transport|rate-limit|internal|timeout)|disk)/u.test(
            reason,
          )
        ) {
          yield* interrupted(api, thread, note, value);
          return yield* new AttemptFailure({ message: `OpenCode infrastructure: ${reason}` });
        }
        return yield* finishFailure(
          api,
          stateId,
          bot,
          journal,
          item,
          note,
          number,
          settings.maxAttempts,
          name,
          `요약 실패 (${reason})`,
        );
      }
      for (const old of summaryParts(messages, bot)) yield* api.deleteMessage(thread, old.id);
      const parts: DiscordMessage[] = [];
      for (const content of splitSummary(result.text))
        parts.push(yield* writeMessage(api, thread, content));
      const ready = yield* persistReady(api, stateId, bot, journal, item.id, parts);
      for (const old of [...notesOf(messages, bot).map((entry) => entry.message), note])
        yield* api.deleteMessage(thread, old.id);
      yield* rename(api, thread, name);
      yield* verifyCommitted(api, item.channel.id, item.id, bot, ready);
      return yield* journalStatus(api, stateId, bot, ready, { id: item.id, state: "terminal" });
    }).pipe(Effect.onError(() => interrupted(api, thread, note, value)));
  });

/** The journal is the durable commit marker. Never infer success from draft parts alone. */
export const workOn = (
  api: DiscordApi,
  openCode: Client,
  publication: Publisher,
  stateId: string,
  bot: string,
  settings: Settings,
  initial: Journal,
  item: Work,
  runID: string,
) =>
  Effect.gen(function* () {
    const journal = initial;
    const source = yield* api.getMessage(item.channel.id, item.id).pipe(
      Effect.catchIf(
        (error) => error.kind === "not-found",
        () => Effect.succeed(undefined),
      ),
    );
    const link = source && linkFromPost(source, bot);
    if (!link)
      return yield* journalStatus(api, stateId, bot, journal, { id: item.id, state: "terminal" });
    const name = threadTitle(source.content, link);
    let thread = yield* threadFor(api, source, name, bot);
    if (source.thread && !thread)
      return yield* journalStatus(api, stateId, bot, journal, { id: item.id, state: "terminal" });
    if (thread && linkPostState(thread, bot) !== "in-progress") {
      if (linkPostState(thread, bot) === "done")
        yield* verifyCommitted(api, item.channel.id, item.id, bot, journal);
      else yield* verifyGivenUp(api, item.channel.id, item.id, bot);
      return yield* journalStatus(api, stateId, bot, journal, { id: item.id, state: "terminal" });
    }
    if (!thread) return journal;
    if (thread.thread_metadata.archived)
      thread = yield* api.modifyThread(thread.id, thread.name, false);
    const messages = yield* history(api, thread.id);
    const ready = journal.entries.get(item.id);
    if (ready?.state === "ready")
      return yield* settleReady(api, stateId, bot, journal, item.id, thread.id, name, messages);
    const notes = notesOf(messages, bot);
    const status = attemptStatus(
      notes,
      DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
      settings.summaryTimeout,
      settings.retryWaits,
    );
    if (status.live || (!status.due && !status.giveUp)) return journal;
    if (status.giveUp) {
      yield* rename(api, thread.id, `⚠️ ${name}`);
      yield* verifyGivenUp(api, item.channel.id, item.id, bot);
      return yield* journalStatus(api, stateId, bot, journal, { id: item.id, state: "terminal" });
    }
    return yield* attempt(
      api,
      openCode,
      publication,
      stateId,
      bot,
      settings,
      journal,
      item,
      runID,
      link,
      name,
      messages,
      status.counted + 1,
    );
  });
