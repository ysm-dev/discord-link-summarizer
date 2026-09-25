import { Clock, Data, DateTime, Duration, Effect, Exit, Schema } from "effect";
import type { DiscordApi, DiscordFailure } from "./discord-client.ts";
import type { DiscordMessage } from "./discord-schema.ts";
import { normalLowerBound } from "./window.ts";
import { readyManifest, verifyReady } from "./ready.ts";

const snowflake = Schema.String.check(
  Schema.makeFilter((s) => (/^(?:0|[1-9]\d*)$/.test(s) ? undefined : "invalid Snowflake")),
);
const canonicalSince = Schema.String.check(
  Schema.makeFilter((s) => {
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === s
      ? undefined
      : "invalid Since";
  }),
);
const recordSchema = Schema.Struct({
  channel: snowflake,
  onboarding: snowflake,
  floor: snowflake,
  since: canonicalSince,
  high: Schema.NullOr(snowflake),
  before: Schema.NullOr(snowflake),
  phase: Schema.Literals(["idle", "scan", "work"]),
  checkpoint: Schema.optionalKey(snowflake),
  archiveBefore: Schema.optionalKey(Schema.NullOr(Schema.String)),
  journalReady: Schema.optionalKey(Schema.Boolean),
});
const batchSchema = Schema.Struct({ key: Schema.String, ids: Schema.Array(snowflake) });
const statusSchema = Schema.Struct({
  id: snowflake,
  state: Schema.Literals(["pending", "ready", "terminal"]),
  count: Schema.optionalKey(Schema.Finite),
  hash: Schema.optionalKey(Schema.String),
  parts: Schema.optionalKey(Schema.Array(snowflake)),
  first: Schema.optionalKey(snowflake),
  chunks: Schema.optionalKey(Schema.Finite),
});
const partsSchema = Schema.Struct({
  id: snowflake,
  hash: Schema.String,
  first: snowflake,
  index: Schema.Finite,
  ids: Schema.Array(snowflake),
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
const allMessages = (api: DiscordApi, channel: string, checkpoint?: string) =>
  Effect.gen(function* () {
    const seen: DiscordMessage[] = [];
    for (;;) {
      const page = yield* api.listMessages(channel, seen.at(-1)?.id);
      const newer = checkpoint
        ? page.filter((message) => BigInt(message.id) > BigInt(checkpoint))
        : page;
      seen.push(...newer);
      if (page.length < 100 || newer.length < page.length) return seen;
    }
  });
const same = (a: object, b: object) => JSON.stringify(a) === JSON.stringify(b);
const sameRecord = (a: ChannelRecord, b: ChannelRecord) =>
  JSON.stringify(Object.entries(a).toSorted(([left], [right]) => left.localeCompare(right))) ===
  JSON.stringify(Object.entries(b).toSorted(([left], [right]) => left.localeCompare(right)));
const owned = (message: DiscordMessage, botId: string) =>
  message.author.id === botId && message.type === 0;
const validStatus = (status: Status) =>
  status.state === "ready"
    ? Number.isSafeInteger(status.count) &&
      Number(status.count) > 0 &&
      new Set(status.parts).size === status.count &&
      /^[a-f0-9]{64}$/.test(String(status.hash)) &&
      status.first === undefined &&
      status.chunks === undefined
    : status.count === undefined &&
      status.hash === undefined &&
      status.parts === undefined &&
      status.first === undefined &&
      status.chunks === undefined;
const transition = (old: Status | undefined, next: Status) =>
  !old ||
  same(old, next) ||
  next.state === "pending" ||
  old.state === "pending" ||
  next.state === "terminal";
const readPart = (content: string, fragments: Map<string, readonly string[]>) =>
  Effect.gen(function* () {
    const part = yield* parse(partsSchema, content, "parts");
    if (!Number.isSafeInteger(part.index) || part.index < 0 || part.ids.length === 0)
      return yield* fail("Malformed READY parts");
    const key = `${part.id}/${part.hash}/${part.first}/${part.index}`;
    const previous = fragments.get(key);
    if (previous && !same(previous, part.ids)) return yield* fail("Divergent READY parts");
    fragments.set(key, part.ids);
    return void 0;
  });
const hydrateStatus = (stored: Status, fragments: ReadonlyMap<string, readonly string[]>) =>
  Effect.gen(function* () {
    if (stored.chunks === undefined) return stored;
    const { first, chunks: chunkCount, ...manifest } = stored;
    if (
      stored.state !== "ready" ||
      stored.parts !== undefined ||
      first === undefined ||
      !Number.isSafeInteger(chunkCount) ||
      chunkCount < 1
    )
      return yield* fail("Malformed READY manifest");
    const chunks = Array.from({ length: chunkCount }, (_, index) =>
      fragments.get(`${stored.id}/${stored.hash}/${first}/${index}`),
    );
    if (chunks.some((chunk) => chunk === undefined)) return yield* fail("Missing READY parts");
    return { ...manifest, parts: chunks.flatMap((chunk) => chunk!) } satisfies Status;
  });
const recordJournalMessage = (
  message: DiscordMessage,
  botId: string,
  pages: Map<string, readonly string[]>,
  states: Map<string, Status>,
  fragments: Map<string, readonly string[]>,
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
    if (message.content.startsWith("DLS1 parts ")) {
      return yield* readPart(message.content, fragments);
    }
    if (message.content === encode("checkpoint", {})) return void 0;
    if (!message.content.startsWith("DLS1 status ")) return yield* fail("Malformed journal entry");
    const status = yield* hydrateStatus(
      yield* parse(statusSchema, message.content, "status"),
      fragments,
    );
    if (!validStatus(status)) return yield* fail("Malformed status manifest");
    if (!transition(states.get(status.id), status)) return yield* fail("Divergent journal status");
    states.set(status.id, status);
    return void 0;
  });

const readEntries = (messages: readonly DiscordMessage[], botId: string) =>
  Effect.gen(function* () {
    const pages = new Map<string, readonly string[]>();
    const states = new Map<string, Status>();
    const fragments = new Map<string, readonly string[]>();
    for (const message of messages.toReversed())
      yield* recordJournalMessage(message, botId, pages, states, fragments);
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
    const stored = yield* parse(recordSchema, parentMessage.content, "record");
    if (
      thread.type !== 11 ||
      thread.id !== parent ||
      parentMessage.author.id !== botId ||
      !sameRecord(stored, record) ||
      thread.owner_id !== botId ||
      parentMessage.thread?.owner_id !== botId ||
      parentMessage.thread.parent_id !== stateId
    )
      return yield* fail("Missing or foreign Channel Record journal");
    if (record.checkpoint) {
      const marker = yield* api.getMessage(parent, record.checkpoint);
      if (!owned(marker, botId) || marker.content !== encode("checkpoint", {}))
        return yield* fail("Invalid Channel Record checkpoint");
    }
    const entries = yield* readEntries(yield* allMessages(api, parent, record.checkpoint), botId);
    return { record, parent, entries } satisfies Journal;
  });

const writeOnce = (
  api: DiscordApi,
  thread: string,
  botId: string,
  content: string,
  identity: (content: string) => boolean,
  checkpoint?: string,
) =>
  Effect.gen(function* () {
    const existing = (yield* allMessages(api, thread, checkpoint)).filter(
      (m) => owned(m, botId) && identity(m.content),
    );
    if (existing.some((m) => m.content !== content)) return yield* fail("Divergent journal write");
    if (existing.length) return void 0;
    const result = yield* Effect.exit(api.createMessage(thread, content));
    if (Exit.isSuccess(result)) return void 0;
    const reconciled = (yield* allMessages(api, thread, checkpoint)).filter(
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
): Effect.Effect<
  { readonly journal: Journal | undefined; readonly proposedStart: number | undefined },
  DiscordFailure | RecordError
> =>
  Effect.gen(function* () {
    const indexed = yield* indexRecords(api, stateId, botId);
    const found = indexed.get(channel);
    if (found) {
      let journal: Journal = yield* readJournal(
        api,
        stateId,
        botId,
        found.parent,
        found.record,
      ).pipe(
        Effect.catchIf(
          (error) =>
            error.message === "Missing Channel Record journal" &&
            found.record.journalReady === false,
          () =>
            Effect.gen(function* () {
              const parent = yield* api.getMessage(stateId, found.parent);
              if (parent.thread) return yield* fail("Missing Channel Record journal");
              if (!dryRun)
                yield* Effect.exit(api.startThread(stateId, found.parent, `DLS1 ${channel}`));
              if (dryRun)
                return {
                  record: found.record,
                  parent: found.parent,
                  entries: new Map(),
                } satisfies Journal;
              return yield* readJournal(api, stateId, botId, found.parent, found.record);
            }),
        ),
      );
      if (found.record.journalReady === false && !dryRun)
        journal = yield* updateRecord(api, stateId, journal, {
          ...found.record,
          journalReady: true,
        });
      return { journal, proposedStart: undefined };
    }
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
      journalReady: false,
    };
    const content = encode("record", record);
    const response = yield* Effect.exit(api.createMessage(stateId, content));
    const matches = (yield* allMessages(api, stateId)).filter(
      (m) => owned(m, botId) && m.content === content,
    );
    if (matches.length !== 1 || (Exit.isSuccess(response) && response.value.id !== matches[0]!.id))
      return yield* fail("Ambiguous Channel Record creation");
    const parent = matches[0]!.id;
    const existing = yield* api.getChannel(parent).pipe(
      Effect.catchIf(
        (error) => error.kind === "not-found",
        () => Effect.succeed(undefined),
      ),
    );
    if (!existing) yield* Effect.exit(api.startThread(stateId, parent, `DLS1 ${channel}`));
    const journal = yield* readJournal(api, stateId, botId, parent, record);
    return {
      journal: yield* updateRecord(api, stateId, journal, { ...record, journalReady: true }),
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
      yield* writeOnce(
        api,
        journal.parent,
        botId,
        content,
        (text) => text.startsWith(`DLS1 batch {"key":"${partKey}",`),
        journal.record.checkpoint,
      );
    }
    const entries = new Map(journal.entries);
    for (const source of ids) if (!entries.has(source)) entries.set(source, undefined);
    return { ...journal, entries } satisfies Journal;
  });

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

const writeReadyChunks = (api: DiscordApi, botId: string, journal: Journal, status: Status) =>
  Effect.gen(function* () {
    const chunks: string[][] = [];
    const first = status.parts![0]!;
    for (const id of status.parts!) {
      const last = chunks.at(-1);
      if (
        last &&
        encode("parts", {
          id: status.id,
          hash: status.hash!,
          first,
          index: chunks.indexOf(last),
          ids: [...last, id],
        }).length <= 2000
      )
        last.push(id);
      else chunks.push([id]);
    }
    for (const [index, ids] of chunks.entries()) {
      const fragment = encode("parts", { id: status.id, hash: status.hash, first, index, ids });
      if (fragment.length > 2000) return yield* fail("READY part ID too long");
      yield* writeOnce(
        api,
        journal.parent,
        botId,
        fragment,
        (text) =>
          text.startsWith(
            `DLS1 parts {"id":"${status.id}","hash":"${status.hash}","first":"${first}","index":${index},`,
          ),
        journal.record.checkpoint,
      );
    }
    return encode("status", {
      id: status.id,
      state: status.state,
      count: status.count,
      hash: status.hash,
      first,
      chunks: chunks.length,
    });
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
    let content = encode("status", status);
    if (content.length > 2000 && status.state === "ready") {
      content = yield* writeReadyChunks(api, botId, journal, status);
    }
    if (content.length > 2000) return yield* fail("READY manifest too long");
    // Historical equality cannot dedupe a new transition (pending → terminal → pending → terminal).
    // Reconcile only the latest marker for this source, never a prior generation.
    const latest = () =>
      allMessages(api, journal.parent, journal.record.checkpoint).pipe(
        Effect.map(
          (messages) =>
            messages.find(
              (message) =>
                owned(message, botId) &&
                message.content.startsWith(`DLS1 status {"id":"${status.id}",`),
            )?.content,
        ),
      );
    if ((yield* latest()) !== content) {
      yield* Effect.exit(api.createMessage(journal.parent, content));
      if ((yield* latest()) !== content) return yield* fail("Unreconciled status transition");
    }
    const confirmed = yield* readJournal(api, stateId, botId, journal.parent, journal.record);
    if (!same(confirmed.entries.get(status.id) ?? {}, status))
      return yield* fail("Unreconciled status transition");
    return { ...journal, entries: confirmed.entries } satisfies Journal;
  });
