import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProgressStore } from "../src/progress-store.ts";
import {
  journalPage,
  journalStatus,
  openChannelRecord,
  readJournal,
  settleRecord,
} from "../src/channel-record.ts";
import { horizon, since } from "./channel-record-fixture.ts";
import { temporaryDirectory } from "./progress-fixture.ts";

const ownedStore = ProgressStore.pipe(Effect.tap((store) => store.owner("bot")));
const unexpectedDecode = () => {
  throw new Error("unexpected backlog decode");
};

const legacyDatabase = Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  const path = join(directory, "progress.sqlite");
  const record = {
    channel: "10",
    onboarding: "0",
    floor: "0",
    since: "2026-09-01T00:00:00.000Z",
    high: "3",
    before: "1",
    phase: "work",
    recentReset: null,
  };
  const data = JSON.stringify({
    record,
    entries: [
      { id: "1", status: { id: "1", state: "terminal" } },
      { id: "2", status: null },
      {
        id: "3",
        status: { id: "3", state: "ready", count: 1, hash: "a".repeat(64), parts: ["4"] },
      },
    ],
  });
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE metadata (id INTEGER PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE channels (id TEXT PRIMARY KEY, data TEXT NOT NULL);",
  );
  db.prepare("INSERT INTO metadata VALUES (1, ?)").run("DLS1:bot");
  db.prepare("INSERT INTO channels VALUES ('10', ?)").run(data);
  db.close();
  return { path, data };
});

const normalizedDatabase = Effect.gen(function* () {
  const { path } = yield* legacyDatabase;
  yield* openChannelRecord("10", since, horizon).pipe(
    Effect.provide(ProgressStore.layer(path, false)),
  );
  return path;
});

it.effect(
  "reads legacy databases without migration in dry-run, then migrates every entry on first write",
  () =>
    Effect.gen(function* () {
      const { path } = yield* legacyDatabase;
      const original = readFileSync(path);
      const old = yield* Effect.gen(function* () {
        yield* ownedStore;
        const journal = yield* readJournal("10");
        expect(yield* readJournal("10")).toBe(journal);
        return journal;
      }).pipe(Effect.provide(ProgressStore.layer(path, true)));
      expect(old?.entries.size).toBe(3);
      expect(readFileSync(path)).toEqual(original);
      const changed = yield* Effect.gen(function* () {
        yield* ownedStore;
        return yield* journalStatus(old!, { id: "2", state: "pending" });
      }).pipe(Effect.provide(ProgressStore.layer(path, false)));
      expect(changed.entries.get("1")).toEqual(old?.entries.get("1"));
      expect(changed.entries.get("3")).toEqual(old?.entries.get("3"));
      const db = new DatabaseSync(path);
      expect(db.prepare("SELECT data FROM metadata").get()?.["data"]).toBe("DLS2:bot");
      expect(db.prepare("SELECT count(*) AS count FROM journal_entries").get()?.["count"]).toBe(3);
      const head = db.prepare("SELECT data FROM channels").get()?.["data"];
      db.close();
      const next = yield* Effect.gen(function* () {
        const loaded = yield* readJournal("10");
        expect(loaded).toEqual(changed);
        return yield* journalStatus(loaded!, { id: "2", state: "terminal" });
      }).pipe(Effect.provide(ProgressStore.layer(path, false)));
      const after = new DatabaseSync(path);
      expect(after.prepare("SELECT data FROM channels").get()?.["data"]).toBe(head);
      expect(after.prepare("SELECT count(*) AS count FROM journal_entries").get()?.["count"]).toBe(
        3,
      );
      after.close();
      expect(
        yield* readJournal("10").pipe(Effect.provide(ProgressStore.layer(path, true))),
      ).toEqual(next);
    }),
);

it.effect("rolls back head conversion and entry migration together when a row write fails", () =>
  Effect.gen(function* () {
    const { path, data } = yield* legacyDatabase;
    yield* Effect.gen(function* () {
      yield* ownedStore;
      const db = new DatabaseSync(path);
      db.exec(
        "CREATE TRIGGER reject_entry BEFORE INSERT ON journal_entries WHEN NEW.id = '2' BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
      );
      const old = yield* readJournal("10");
      expect(
        (yield* Effect.flip(journalStatus(old!, { id: "2", state: "terminal" }))).message,
      ).toContain("disk full");
      expect(yield* readJournal("10")).toEqual(old);
      expect(db.prepare("SELECT data FROM channels").get()?.["data"]).toBe(data);
      expect(db.prepare("SELECT count(*) AS count FROM journal_entries").get()?.["count"]).toBe(0);
      expect(db.prepare("SELECT count(*) AS count FROM journal_channels").get()?.["count"]).toBe(0);
      db.exec("DROP TRIGGER reject_entry");
      db.close();
      const next = yield* journalStatus(old!, { id: "2", state: "terminal" });
      expect(next.entries.get("2")?.state).toBe("terminal");
      yield* journalStatus(next, { id: "3", state: "terminal" });
      expect((yield* settleRecord(next)).entries.size).toBe(0);
    }).pipe(Effect.provide(ProgressStore.layer(path, false)));
    const restored = yield* readJournal("10").pipe(Effect.provide(ProgressStore.layer(path, true)));
    expect(restored?.entries.size).toBe(0);
    expect(restored?.record.floor).toBe("3");
  }),
);

it.effect(
  "validates normalized rows on reopening and invalidates cached journals after a raw replacement",
  () =>
    Effect.gen(function* () {
      const { path, data } = yield* legacyDatabase;
      yield* Effect.gen(function* () {
        const store = yield* ownedStore;
        const old = yield* openChannelRecord("10", since, horizon);
        yield* journalStatus(old, { id: "2", state: "pending" });
        yield* store.change("10", () => data);
        expect((yield* readJournal("10"))?.entries.get("2")).toBeUndefined();
        yield* journalPage(old, ["5"]);
        expect(yield* Effect.exit(journalPage(old, ["not-a-snowflake"]))).toMatchObject({
          _tag: "Failure",
        });
      }).pipe(Effect.provide(ProgressStore.layer(path, false)));
      const db = new DatabaseSync(path);
      db.prepare("UPDATE journal_entries SET data = ? WHERE id = '3'").run(
        '{"id":"wrong","state":"ready"}',
      );
      db.close();
      expect(
        yield* Effect.exit(readJournal("10").pipe(Effect.provide(ProgressStore.layer(path, true)))),
      ).toMatchObject({ _tag: "Failure" });
    }),
);

it.effect("rejects journal writes when a dry-run database is absent", () =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    expect(
      (yield* Effect.flip(
        openChannelRecord("10", since, horizon).pipe(
          Effect.provide(ProgressStore.layer(join(directory, "absent.sqlite"), true)),
        ),
      )).message,
    ).toContain("read-only");
  }),
);

it.effect("a hot status update touches only its entry and reuses validated state", () =>
  Effect.gen(function* () {
    const { path } = yield* legacyDatabase;
    yield* Effect.gen(function* () {
      const store = yield* ownedStore;
      const initial = yield* openChannelRecord("10", since, horizon);
      const db = new DatabaseSync(path);
      db.exec(
        "CREATE TABLE audit (operation TEXT); CREATE TRIGGER head_write AFTER UPDATE ON channels BEGIN INSERT INTO audit VALUES ('head'); END; CREATE TRIGGER entry_write AFTER UPDATE ON journal_entries BEGIN INSERT INTO audit VALUES ('entry'); END;",
      );
      const next = yield* journalStatus(initial, { id: "2", state: "pending" });
      expect(db.prepare("SELECT operation FROM audit").all()).toEqual([{ operation: "entry" }]);
      db.close();
      // A cached read needs neither disk decoding nor a backlog-sized reconstruction.
      expect(yield* store.loadJournal("10", unexpectedDecode)).toBe(next);
      expect(yield* store.loadJournal("99", unexpectedDecode)).toBeUndefined();
      expect(yield* readJournal("10")).toBe(next);
    }).pipe(Effect.provide(ProgressStore.layer(path, false)));
  }),
);

it.effect(
  "rejects malformed normalized heads instead of hiding their embedded entries or extra fields",
  () =>
    Effect.gen(function* () {
      const path = yield* normalizedDatabase;
      const db = new DatabaseSync(path);
      db.exec("UPDATE channels SET data = json_set(data, '$.unexpected', 1)");
      expect(
        (yield* Effect.flip(
          readJournal("10").pipe(Effect.provide(ProgressStore.layer(path, true))),
        )).message,
      ).toContain("unexpected");
      db.exec(
        "UPDATE channels SET data = json_set(json_remove(data, '$.unexpected'), '$.entries', json('[{}]'))",
      );
      expect(
        (yield* Effect.flip(
          readJournal("10").pipe(Effect.provide(ProgressStore.layer(path, true))),
        )).message,
      ).toContain("entries");
      db.close();
    }),
);

it.effect("the storage boundary rejects a non-text normalized entry ID even on a raw read", () =>
  Effect.gen(function* () {
    const path = yield* normalizedDatabase;
    const db = new DatabaseSync(path);
    db.exec("UPDATE journal_entries SET id = x'0102' WHERE id = '2'");
    db.close();
    const raw = ProgressStore.pipe(
      Effect.flatMap((store) => store.read("10")),
      Effect.provide(ProgressStore.layer(path, true)),
    );
    expect(yield* Effect.exit(raw)).toMatchObject({ _tag: "Failure" });
  }),
);
