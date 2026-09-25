import { Context, Data, Effect, Layer, Schema } from "effect";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class StoreError extends Data.TaggedError("StoreError")<{ readonly message: string }> {}
const attempt = <A>(f: () => A) =>
  Effect.try({ try: f, catch: (error) => new StoreError({ message: String(error) }) });
const row = Schema.Struct({ data: Schema.String });
const decodeRow = Schema.decodeUnknownSync(row);

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
        const read = (channel: string) => {
          const found = db.prepare("SELECT data FROM channels WHERE id = ?").get(channel);
          return found === undefined ? undefined : decodeRow(found).data;
        };
        return {
          owner: (bot: string) =>
            attempt(() => {
              const stored = db.prepare("SELECT data FROM metadata WHERE id = 1").get();
              const identity = `DLS1:${bot}`;
              if (stored !== undefined) {
                if (decodeRow(stored).data !== identity)
                  throw new Error("Progress database belongs to a different bot or version");
              } else {
                if (db.prepare("SELECT id FROM channels LIMIT 1").get() !== undefined)
                  throw new Error("Missing progress database owner");
                if (!readOnly)
                  db.prepare("INSERT INTO metadata (id, data) VALUES (1, ?)").run(identity);
              }
            }),
          read: (channel: string) => attempt(() => read(channel)),
          change: (channel: string, f: (stored: string | undefined) => string) =>
            attempt(() => {
              // ponytail: one JSON row per channel; normalize entries if backlog rewrites become costly.
              if (readOnly) throw new Error("Progress database is read-only");
              db.exec("BEGIN IMMEDIATE");
              try {
                const data = f(read(channel));
                db.prepare(
                  "INSERT INTO channels (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                ).run(channel, data);
                db.exec("COMMIT");
                return data;
              } catch (error) {
                db.exec("ROLLBACK");
                throw error;
              }
            }),
        };
      }),
    );
}
