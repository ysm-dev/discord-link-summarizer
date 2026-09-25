import { Clock, Data, DateTime, Duration, Effect, Schema } from "effect";
import { isDeepStrictEqual } from "node:util";
import { allMessages, type DiscordApi, type DiscordFailure } from "./discord-client.ts";
import type { DiscordMessage } from "./discord-schema.ts";
import { ProgressStore, type StoreError } from "./progress-store.ts";
import { readyManifest, verifyReady } from "./ready.ts";
import { normalLowerBound } from "./window.ts";

const snowflake = Schema.String.check(Schema.isPattern(/^(?:0|[1-9]\d*)$/));
const canonicalSince = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
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
  archiveBefore: Schema.optionalKey(Schema.NullOr(Schema.String)),
  recentBefore: Schema.optionalKey(snowflake),
  recentFloor: Schema.optionalKey(snowflake),
  recentSince: Schema.optionalKey(canonicalSince),
  recentReset: Schema.NullOr(snowflake),
}).check(
  Schema.makeFilter((record) =>
    (record.phase === "idle"
      ? record.high === null && record.before === null
      : record.high !== null && record.before !== null) &&
    (record.recentBefore === undefined) === (record.recentFloor === undefined) &&
    (record.recentBefore === undefined) === (record.recentSince === undefined) &&
    (record.recentReset === null || record.recentBefore !== undefined)
      ? undefined
      : "Invalid record phase/cursors",
  ),
);
const statusSchema = Schema.Struct({
  id: snowflake,
  state: Schema.Literals(["pending", "ready", "terminal"]),
  count: Schema.optionalKey(Schema.Finite),
  hash: Schema.optionalKey(Schema.String),
  parts: Schema.optionalKey(Schema.Array(snowflake)),
}).check(
  Schema.makeFilter((status) =>
    (
      status.state === "ready"
        ? Number(status.count) > 0 &&
          status.parts?.length === status.count &&
          new Set(status.parts).size === status.count &&
          /^[a-f0-9]{64}$/.test(String(status.hash))
        : status.count === undefined && status.hash === undefined && status.parts === undefined
    )
      ? undefined
      : "Invalid journal status",
  ),
);
const storedSchema = Schema.Struct({
  record: recordSchema,
  entries: Schema.Array(Schema.Struct({ id: snowflake, status: Schema.NullOr(statusSchema) })),
}).check(
  Schema.makeFilter(({ entries }) =>
    new Set(entries.map((entry) => entry.id)).size === entries.length &&
    entries.every((entry) => entry.status === null || entry.status.id === entry.id)
      ? undefined
      : "Invalid journal entries",
  ),
);
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(storedSchema), {
  onExcessProperty: "error",
});
export type ChannelRecord = Schema.Schema.Type<typeof recordSchema>;
export type Status = Schema.Schema.Type<typeof statusSchema>;
export interface Journal {
  readonly record: ChannelRecord;
  readonly entries: ReadonlyMap<string, Status | undefined>;
}
class RecordError extends Data.TaggedError("RecordError")<{ readonly message: string }> {}
export const fail = (message: string) => new RecordError({ message });
export const snowflakeAt = (ms: number) =>
  ((BigInt(Math.max(1420070400000, Math.ceil(ms))) - 1420070400000n) << 22n).toString();
const parse = (channel: string, data: string): Journal => {
  const stored = decode(data);
  if (stored.record.channel !== channel) throw fail("Mismatched Channel Record");
  return {
    record: stored.record,
    entries: new Map(stored.entries.map(({ id, status }) => [id, status ?? undefined])),
  };
};
const encode = (journal: Journal) =>
  JSON.stringify({
    record: journal.record,
    entries: [...journal.entries].map(([id, status]) => ({ id, status: status ?? null })),
  });
const change = (channel: string, f: (journal: Journal | undefined) => Journal) =>
  Effect.gen(function* () {
    const store = yield* ProgressStore;
    const text = yield* store.change(channel, (stored) => {
      const result = f(stored === undefined ? undefined : parse(channel, stored));
      const data = encode(result);
      parse(channel, data);
      return data;
    });
    return parse(channel, text);
  });
const requireJournal = (journal: Journal | undefined) => {
  if (!journal) throw fail("Missing Channel Record");
  return journal;
};
export const readJournal = (channel: string) =>
  Effect.gen(function* () {
    const store = yield* ProgressStore;
    const text = yield* store.read(channel);
    if (text === undefined) return undefined;
    return yield* Effect.try({
      try: () => parse(channel, text),
      catch: (error) => fail(String(error)),
    });
  });
export const openChannelRecord = (
  channel: string,
  since: DateTime.Utc,
  horizon: Duration.Duration,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const floor = (
      BigInt(snowflakeAt(normalLowerBound(since, DateTime.makeUnsafe(now), horizon))) - 1n
    ).toString();
    return yield* change(
      channel,
      (existing) =>
        existing ?? {
          record: {
            channel,
            onboarding: floor,
            floor,
            since: DateTime.formatIso(since),
            high: null,
            before: null,
            phase: "idle",
            recentReset: null,
          },
          entries: new Map(),
        },
    );
  });
export const updateRecord = (journal: Journal, next: ChannelRecord) =>
  change(journal.record.channel, (stored) => ({ ...requireJournal(stored), record: next }));
export const journalPage = (journal: Journal, ids: readonly string[]) =>
  change(journal.record.channel, (stored) => {
    const current = requireJournal(stored);
    const entries = new Map(current.entries);
    for (const id of ids) if (!entries.has(id)) entries.set(id, undefined);
    return { ...current, entries };
  });
export const journalStatus = (journal: Journal, status: Status) =>
  change(journal.record.channel, (stored) => {
    const current = requireJournal(stored);
    if (!current.entries.has(status.id)) throw fail("Status without journaled Link Post");
    const old = current.entries.get(status.id);
    if (
      old &&
      !isDeepStrictEqual(old, status) &&
      status.state !== "pending" &&
      old.state !== "pending" &&
      status.state !== "terminal"
    )
      throw fail("Invalid journal transition");
    const entries = new Map(current.entries);
    entries.set(status.id, status);
    return { ...current, entries };
  });
/** Discord publication is reconciled before committing the local READY manifest. */
export const persistReady = (
  api: DiscordApi,
  botId: string,
  journal: Journal,
  source: string,
  parts: readonly DiscordMessage[],
): Effect.Effect<Journal, DiscordFailure | RecordError | StoreError, ProgressStore> =>
  Effect.gen(function* () {
    const status = readyManifest(source, parts);
    const messages = yield* allMessages(api, source);
    if (!verifyReady(status, messages, botId))
      return yield* fail("Summary parts do not match READY manifest");
    return yield* journalStatus(journal, status);
  });
/** Check the latest entries and commit the floor plus cleanup in the same SQLite transaction. */
export const settleRecord = (journal: Journal) =>
  change(journal.record.channel, (stored) => {
    const current = requireJournal(stored);
    if (
      current.record.phase === "scan" ||
      [...current.entries.values()].some((status) => status?.state !== "terminal")
    )
      return current;
    return {
      record:
        current.record.phase === "work"
          ? {
              ...current.record,
              floor: current.record.high!,
              high: null,
              before: null,
              phase: "idle",
            }
          : current.record,
      entries: new Map(),
    };
  });
