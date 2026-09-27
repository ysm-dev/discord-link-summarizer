import { Context, Data, Effect, Layer, Schema } from "effect";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Journal } from "./channel-record.ts";

export class StoreError extends Data.TaggedError("StoreError")<{ readonly message: string }> {}
const attempt = <A>(f: () => A) =>
  Effect.try({ try: f, catch: (error) => new StoreError({ message: String(error) }) });
const row = Schema.Struct({ data: Schema.String });
const decodeRow = Schema.decodeUnknownSync(row);
const decodeObject = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));
const decodeHead = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ record: Schema.JsonObject, entries: Schema.Array(Schema.Never) }),
  ),
  { onExcessProperty: "error" },
);
const decodeEntry = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.String, data: Schema.NullOr(Schema.String) }),
);
type DecodeJournal = (channel: string, data: string) => Journal;
type JournalEdit = {
  readonly journal: Journal;
  readonly ids: readonly string[] | undefined;
  readonly clear: boolean;
};

/** One local writer, protected by the Run's OS lock. Each change commits one channel atomically. */
export class ProgressStore extends Context.Service<
  ProgressStore,
  {
    readonly owner: (bot: string) => Effect.Effect<void, StoreError>;
    readonly read: (channel: string) => Effect.Effect<string | undefined, StoreError>;
    readonly change: (
      channel: string,
      f: (stored: string | undefined) => string,
    ) => Effect.Effect<string, StoreError>;
    readonly loadJournal: (
      channel: string,
      decode: DecodeJournal,
    ) => Effect.Effect<Journal | undefined, StoreError>;
    readonly editJournal: (
      channel: string,
      decode: DecodeJournal,
      edit: (journal: Journal | undefined) => JournalEdit,
    ) => Effect.Effect<Journal, StoreError>;
  }
>()(import.meta.url) {
  static layer = (path: string, readOnly: boolean) =>
    Layer.effect(
      ProgressStore,
      Effect.gen(function* () {
        const fresh = !existsSync(path);
        if (readOnly && fresh)
          return {
            owner: () => Effect.void,
            read: () => Effect.succeed(undefined),
            change: () => new StoreError({ message: "Progress database is read-only" }),
            loadJournal: () => Effect.succeed(undefined),
            editJournal: () => new StoreError({ message: "Progress database is read-only" }),
          };
        const db = yield* Effect.acquireRelease(
          attempt(() => {
            // An existing read-only database already has its parent; recursive mkdir is a no-op there.
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            return new DatabaseSync(path, { readOnly });
          }),
          (database) => Effect.sync(() => database.close()),
        );
        yield* attempt(() => {
          if (!readOnly) chmodSync(path, 0o600);
          // Both supported runtimes default each connection to SQLite synchronous=FULL.
          if (fresh) {
            db.exec(
              "CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL); CREATE TABLE channels (id TEXT PRIMARY KEY, data TEXT NOT NULL);",
            );
          }
          // Preparing both statements rejects incomplete or unrelated databases before Discord writes.
          db.prepare("SELECT data FROM metadata WHERE id = 1");
          db.prepare("SELECT data FROM channels WHERE id = ?");
        });
        const normalized = yield* attempt(() => {
          if (!readOnly)
            db.exec(
              "CREATE TABLE IF NOT EXISTS journal_channels (id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS journal_entries (channel TEXT NOT NULL, id TEXT NOT NULL, data TEXT, PRIMARY KEY (channel, id));",
            );
          return (
            db.prepare("SELECT name FROM sqlite_master WHERE name = 'journal_channels'").get() !==
            undefined
          );
        });
        const cached = new Map<string, Journal>();
        const migrated = (channel: string) =>
          normalized &&
          db.prepare("SELECT id FROM journal_channels WHERE id = ?").get(channel) !== undefined;
        const read = (channel: string) => {
          const found = db.prepare("SELECT data FROM channels WHERE id = ?").get(channel);
          if (found === undefined) return undefined;
          const data = decodeRow(found).data;
          if (!migrated(channel)) return data;
          const entries = db
            .prepare("SELECT id, data FROM journal_entries WHERE channel = ? ORDER BY rowid")
            .all(channel)
            .map((value) => {
              const entry = decodeEntry(value);
              return {
                id: entry.id,
                status: entry.data === null ? null : decodeObject(entry.data),
              };
            });
          return JSON.stringify({ ...decodeHead(data), entries });
        };
        const load = (channel: string, decode: DecodeJournal) => {
          const present = cached.get(channel);
          if (present) return present;
          const text = read(channel);
          if (text === undefined) return undefined;
          const journal = decode(channel, text);
          cached.set(channel, journal);
          return journal;
        };
        const transaction = <A>(f: () => A) => {
          if (readOnly) throw new Error("Progress database is read-only");
          db.exec("BEGIN IMMEDIATE");
          try {
            const result = f();
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        };
        const put = db.prepare(
          "INSERT INTO channels (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
        );
        return {
          owner: (bot: string) =>
            attempt(() => {
              const stored = db.prepare("SELECT data FROM metadata WHERE id = 1").get();
              const identity = `DLS2:${bot}`;
              if (stored !== undefined) {
                const saved = decodeRow(stored).data;
                if (saved !== identity && saved !== `DLS1:${bot}`)
                  throw new Error("Progress database belongs to a different bot or version");
                if (!readOnly && saved !== identity)
                  db.prepare("UPDATE metadata SET data = ? WHERE id = 1").run(identity);
              } else {
                if (db.prepare("SELECT id FROM channels LIMIT 1").get() !== undefined)
                  throw new Error("Missing progress database owner");
                if (!readOnly)
                  db.prepare("INSERT INTO metadata (id, data) VALUES (1, ?)").run(identity);
              }
            }),
          read: (channel: string) => attempt(() => read(channel)),
          loadJournal: (channel: string, decode: DecodeJournal) =>
            attempt(() => load(channel, decode)),
          editJournal: (
            channel: string,
            decode: DecodeJournal,
            edit: (journal: Journal | undefined) => JournalEdit,
          ) =>
            attempt(() => {
              const journal = transaction(() => {
                const previous = load(channel, decode);
                const next = edit(previous);
                const first = !migrated(channel);
                if (first || previous?.record !== next.journal.record)
                  put.run(channel, JSON.stringify({ record: next.journal.record, entries: [] }));
                if (next.clear)
                  db.prepare("DELETE FROM journal_entries WHERE channel = ?").run(channel);
                const ids = first ? [...next.journal.entries.keys()] : (next.ids ?? []);
                const save = db.prepare(
                  "INSERT INTO journal_entries (channel, id, data) VALUES (?, ?, ?) ON CONFLICT(channel, id) DO UPDATE SET data = excluded.data",
                );
                for (const id of ids) {
                  const status = next.journal.entries.get(id);
                  save.run(channel, id, status === undefined ? null : JSON.stringify(status));
                }
                db.prepare("INSERT OR IGNORE INTO journal_channels (id) VALUES (?)").run(channel);
                return next.journal;
              });
              cached.set(channel, journal);
              return journal;
            }),
          change: (channel: string, f: (stored: string | undefined) => string) =>
            attempt(() => {
              const result = transaction(() => {
                const data = f(read(channel));
                put.run(channel, data);
                db.prepare("DELETE FROM journal_entries WHERE channel = ?").run(channel);
                db.prepare("DELETE FROM journal_channels WHERE id = ?").run(channel);
                return data;
              });
              cached.delete(channel);
              return result;
            }),
        };
      }),
    );
}
