import { createHash } from "node:crypto";
import { Clock, Data, DateTime, Duration, Effect, Exit, Schema } from "effect";
import type { DiscordApi } from "./discord-client.ts";
import type { DiscordMessage } from "./discord-schema.ts";
import { normalLowerBound } from "./window.ts";

const snowflake = Schema.String.check(
  Schema.makeFilter((s) => (/^(?:0|[1-9]\d*)$/.test(s) ? undefined : "invalid Snowflake")),
);
const recordSchema = Schema.Struct({
  channel: snowflake,
  onboarding: snowflake,
  floor: snowflake,
  since: Schema.String,
  high: Schema.NullOr(snowflake),
  before: Schema.NullOr(snowflake),
  phase: Schema.Literals(["idle", "scan", "work"]),
});
const batchSchema = Schema.Struct({ key: Schema.String, ids: Schema.Array(snowflake) });
const statusSchema = Schema.Struct({
  id: snowflake,
  state: Schema.Literals(["pending", "ready", "terminal"]),
  count: Schema.optionalKey(Schema.Finite),
  hash: Schema.optionalKey(Schema.String),
  parts: Schema.optionalKey(Schema.Array(snowflake)),
});
export type ChannelRecord = Schema.Schema.Type<typeof recordSchema>;
export type Status = Schema.Schema.Type<typeof statusSchema>;
export interface Journal {
  readonly record: ChannelRecord;
  readonly parent: string;
  readonly entries: ReadonlyMap<string, Status | undefined>;
}
class RecordError extends Data.TaggedError("RecordError")<{ readonly message: string }> {}
export const fail = (message: string) => new RecordError({ message });
export const snowflakeAt = (ms: number) =>
  ((BigInt(Math.max(1420070400000, Math.ceil(ms))) - 1420070400000n) << 22n).toString();
const encode = (kind: string, value: object) => `DLS1 ${kind} ${JSON.stringify(value)}`;
const parse = <S extends Schema.ConstraintDecoder<Schema.Schema.Type<S>>>(
  schema: S,
  content: string,
  kind: string,
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema), { onExcessProperty: "error" })(
    content.slice(kind.length + 6),
  ).pipe(Effect.mapError((error) => fail(`Malformed ${kind} marker: ${String(error)}`)));
const allMessages = (api: DiscordApi, channel: string) =>
  Effect.gen(function* () {
    const seen: DiscordMessage[] = [];
    for (;;) {
      const page = yield* api.listMessages(channel, seen.at(-1)?.id);
      seen.push(...page);
      if (page.length < 100) return seen;
    }
  });
const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);
const owned = (message: DiscordMessage, botId: string) =>
  message.author.id === botId && message.type === 0;
const validStatus = (status: Status) =>
  status.state === "ready"
    ? Number.isSafeInteger(status.count) &&
      Number(status.count) > 0 &&
      new Set(status.parts).size === status.count &&
      /^[a-f0-9]{64}$/.test(String(status.hash))
    : status.count === undefined && status.hash === undefined && status.parts === undefined;
const transition = (old: Status | undefined, next: Status) =>
  !old ||
  same(old, next) ||
  next.state === "pending" ||
  old.state === "pending" ||
  next.state === "terminal";
const recordJournalMessage = (
  message: DiscordMessage,
  botId: string,
  pages: Map<string, readonly string[]>,
  states: Map<string, Status>,
) =>
  Effect.gen(function* () {
    if (message.type !== 0) return void 0;
    if (message.author.id !== botId) return yield* fail("Foreign journal entry");
    if (message.content.startsWith("DLS1 batch ")) {
      const batch = yield* parse(batchSchema, message.content, "batch");
      const previous = pages.get(batch.key);
      if (previous && !same(previous, batch.ids)) return yield* fail("Divergent journal page");
      pages.set(batch.key, batch.ids);
      return void 0;
    }
    if (!message.content.startsWith("DLS1 status ")) return yield* fail("Malformed journal entry");
    const status = yield* parse(statusSchema, message.content, "status");
    if (!validStatus(status)) return yield* fail("Malformed status manifest");
    if (!transition(states.get(status.id), status)) return yield* fail("Divergent journal status");
    states.set(status.id, status);
    return void 0;
  });

const readEntries = (messages: readonly DiscordMessage[], botId: string) =>
  Effect.gen(function* () {
    const pages = new Map<string, readonly string[]>();
    const states = new Map<string, Status>();
    for (const message of messages.toReversed())
      yield* recordJournalMessage(message, botId, pages, states);
    const entries = new Map<string, Status | undefined>();
    for (const ids of pages.values()) for (const source of ids) entries.set(source, undefined);
    for (const [source, status] of states) {
      if (!entries.has(source)) return yield* fail("Orphan journal status");
      entries.set(source, status);
    }
    return entries;
  });

/** Index the complete state channel; foreign messages do not confer ownership of markers. */
export const indexRecords = (api: DiscordApi, stateId: string, botId: string) =>
  Effect.gen(function* () {
    const state = yield* api.getChannel(stateId);
    if (state.type !== 0) return yield* fail("State channel must be a text channel");
    const records = new Map<string, { parent: string; record: ChannelRecord }>();
    for (const message of yield* allMessages(api, stateId)) {
      if (!owned(message, botId)) continue;
      const record = yield* parse(recordSchema, message.content, "record");
      if (
        (record.phase === "idle") !== (record.high === null && record.before === null) ||
        (record.phase !== "idle" && (record.high === null || record.before === null))
      )
        return yield* fail("Invalid record phase/cursors");
      if (records.has(record.channel))
        return yield* fail(`Duplicate Channel Record ${record.channel}`);
      records.set(record.channel, { record, parent: message.id });
    }
    return records;
  });

/** Parent and journal are one address; a missing journal never creates a new floor. */
export const readJournal = (
  api: DiscordApi,
  stateId: string,
  botId: string,
  parent: string,
  record: ChannelRecord,
) =>
  Effect.gen(function* () {
    const thread = yield* api.getChannel(parent).pipe(
      Effect.catchIf(
        (e) => e.kind === "not-found",
        () => Effect.fail(fail("Missing Channel Record journal")),
      ),
    );
    const parentMessage = yield* api.getMessage(stateId, parent);
    if (
      thread.type !== 11 ||
      thread.id !== parent ||
      parentMessage.author.id !== botId ||
      parentMessage.content !== encode("record", record) ||
      parentMessage.thread?.owner_id !== botId ||
      parentMessage.thread.parent_id !== stateId
    )
      return yield* fail("Missing or foreign Channel Record journal");
    const entries = yield* readEntries(yield* allMessages(api, parent), botId);
    return { record, parent, entries } satisfies Journal;
  });

const writeOnce = (
  api: DiscordApi,
  thread: string,
  botId: string,
  content: string,
  identity: (content: string) => boolean,
) =>
  Effect.gen(function* () {
    const existing = (yield* allMessages(api, thread)).filter(
      (m) => owned(m, botId) && identity(m.content),
    );
    if (existing.some((m) => m.content !== content)) return yield* fail("Divergent journal write");
    if (existing.length) return void 0;
    const result = yield* Effect.exit(api.createMessage(thread, content));
    if (Exit.isSuccess(result)) return void 0;
    const reconciled = (yield* allMessages(api, thread)).filter(
      (m) => owned(m, botId) && identity(m.content),
    );
    if (reconciled.length && reconciled.every((m) => m.content === content)) return void 0;
    return yield* fail("Unreconciled journal write");
  });

export const updateRecord = (
  api: DiscordApi,
  stateId: string,
  journal: Journal,
  next: ChannelRecord,
) =>
  Effect.gen(function* () {
    const content = encode("record", next);
    yield* Effect.exit(api.editMessage(stateId, journal.parent, content));
    const message = yield* api.getMessage(stateId, journal.parent);
    if (message.content !== content) return yield* fail("Unreconciled Channel Record write");
    return { ...journal, record: next } satisfies Journal;
  });

/** Dry-run can return the proposed floor without writing either marker. */
export const openChannelRecord = (
  api: DiscordApi,
  stateId: string,
  channel: string,
  since: DateTime.Utc,
  horizon: Duration.Duration,
  botId: string,
  dryRun: boolean,
) =>
  Effect.gen(function* () {
    const indexed = yield* indexRecords(api, stateId, botId);
    const found = indexed.get(channel);
    if (found)
      return {
        journal: yield* readJournal(api, stateId, botId, found.parent, found.record),
        proposedStart: undefined,
      };
    const now = yield* Clock.currentTimeMillis;
    const start = normalLowerBound(since, DateTime.makeUnsafe(now), horizon);
    if (dryRun) return { journal: undefined, proposedStart: start };
    const floor = (BigInt(snowflakeAt(start)) - 1n).toString();
    const record: ChannelRecord = {
      channel,
      onboarding: floor,
      floor,
      since: DateTime.formatIso(since),
      high: null,
      before: null,
      phase: "idle",
    };
    const content = encode("record", record);
    const response = yield* Effect.exit(api.createMessage(stateId, content));
    const matches = (yield* allMessages(api, stateId)).filter(
      (m) => owned(m, botId) && m.content === content,
    );
    if (matches.length !== 1 || (Exit.isSuccess(response) && response.value.id !== matches[0]!.id))
      return yield* fail("Ambiguous Channel Record creation");
    const parent = matches[0]!.id;
    yield* Effect.exit(api.startThread(stateId, parent, `DLS1 ${channel}`));
    return {
      journal: yield* readJournal(api, stateId, botId, parent, record),
      proposedStart: undefined,
    };
  });

/** A page becomes checkpointable only after every split batch is visible in the journal. */
export const journalPage = (
  api: DiscordApi,
  botId: string,
  journal: Journal,
  key: string,
  ids: readonly string[],
) =>
  Effect.gen(function* () {
    const chunks: string[][] = [];
    const capacityKey = `${key}:${ids.length}`;
    for (const source of ids) {
      const last = chunks.at(-1);
      if (!last || encode("batch", { key: capacityKey, ids: [...last, source] }).length > 2000)
        chunks.push([source]);
      else last.push(source);
    }
    for (const [index, chunk] of chunks.entries()) {
      const partKey = `${key}:${index}`;
      const content = encode("batch", { key: partKey, ids: chunk });
      if (content.length > 2000) return yield* fail("Journal page key too long");
      yield* writeOnce(api, journal.parent, botId, content, (text) =>
        text.startsWith(`DLS1 batch {"key":"${partKey}",`),
      );
    }
    const entries = new Map(journal.entries);
    for (const source of ids) if (!entries.has(source)) entries.set(source, undefined);
    return { ...journal, entries } satisfies Journal;
  });

export const readyDigest = (parts: readonly string[]) => {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part)));
    hash.update(":");
    hash.update(part);
  }
  return hash.digest("hex");
};
export const readyManifest = (source: string, parts: readonly DiscordMessage[]) =>
  ({
    id: source,
    state: "ready" as const,
    count: parts.length,
    hash: readyDigest(parts.map((part) => part.content)),
    parts: parts.map((part) => part.id),
  }) satisfies Status;
/** Match explicit message identities, not note-shaped model text. */
export const verifyReady = (status: Status, messages: readonly DiscordMessage[], botId: string) => {
  const parts = status.parts?.map((partId) =>
    messages.find((message) => message.id === partId && message.author.id === botId),
  );
  return (
    status.state === "ready" &&
    parts !== undefined &&
    parts.length === status.count &&
    parts.every((part) => part !== undefined) &&
    parts.every((part, index) => index === 0 || BigInt(parts[index - 1]!.id) < BigInt(part.id)) &&
    status.hash === readyDigest(parts.map((part) => part.content))
  );
};

/** Read back the exact draft parts before making READY durable. */
export const persistReady = (
  api: DiscordApi,
  stateId: string,
  botId: string,
  journal: Journal,
  source: string,
  parts: readonly DiscordMessage[],
) =>
  Effect.gen(function* () {
    const status = readyManifest(source, parts);
    const readback = yield* allMessages(api, source);
    if (!validStatus(status) || !verifyReady(status, readback, botId))
      return yield* fail("Summary parts do not match READY manifest");
    return yield* journalStatus(api, stateId, botId, journal, status);
  });

export const journalStatus = (
  api: DiscordApi,
  stateId: string,
  botId: string,
  journal: Journal,
  status: Status,
) =>
  Effect.gen(function* () {
    if (!journal.entries.has(status.id)) return yield* fail("Status without journaled Link Post");
    const old = journal.entries.get(status.id);
    if (!validStatus(status) || !transition(old, status))
      return yield* fail("Invalid journal transition");
    const content = encode("status", status);
    yield* writeOnce(api, journal.parent, botId, content, (text) => text === content);
    const confirmed = yield* readJournal(api, stateId, botId, journal.parent, journal.record);
    if (!same(confirmed.entries.get(status.id) ?? {}, status))
      return yield* fail("Unreconciled status transition");
    return { ...journal, entries: confirmed.entries } satisfies Journal;
  });
