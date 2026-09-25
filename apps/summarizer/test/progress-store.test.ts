import { expect, it, vi } from "@effect/vitest";
import { Effect } from "effect";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProgressStore } from "../src/progress-store.ts";
import {
  journalPage,
  journalStatus,
  openChannelRecord,
  readJournal,
  settleRecord,
  updateRecord,
} from "../src/channel-record.ts";
import { horizon, now, since } from "./channel-record-fixture.ts";
import { temporaryDirectory } from "./progress-fixture.ts";
import { TestClock } from "effect/testing";

const seeded = Effect.gen(function* () {
  const store = yield* ProgressStore;
  yield* store.owner("bot");
  yield* store.change("10", () => "original");
  return store;
});

const ownedDatabase = Effect.gen(function* () {
  const directory = yield* temporaryDirectory;
  const path = join(directory, "progress.sqlite");
  yield* seeded.pipe(Effect.provide(ProgressStore.layer(path, false)));
  return path;
});

it.effect("existing dry-run connections reject writes at the SQLite boundary", () =>
  Effect.gen(function* () {
    const path = yield* ownedDatabase;
    // oxlint-disable-next-line typescript/unbound-method -- The native method is deliberately invoked with its database receiver via .call below.
    const original = DatabaseSync.prototype.prepare;
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    yield* Effect.addFinalizer(() => Effect.sync(() => prepare.mockRestore()));
    prepare.mockImplementation(function (this: DatabaseSync, sql: string) {
      expect(original.call(this, "PRAGMA synchronous").get()?.["synchronous"]).toBe(2);
      expect(() => this.exec("CREATE TABLE forbidden (id INTEGER)")).toThrow(/readonly/);
      return original.call(this, sql);
    });
    yield* ProgressStore.pipe(Effect.provide(ProgressStore.layer(path, true)));
    expect(prepare).toHaveBeenCalled();
  }),
);

it.effect("a dry-run does not claim an initialized but unused database", () =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const path = join(directory, "empty.sqlite");
    yield* ProgressStore.pipe(Effect.provide(ProgressStore.layer(path, false)));
    const before = readFileSync(path);
    yield* Effect.gen(function* () {
      yield* (yield* ProgressStore).owner("bot");
    }).pipe(Effect.provide(ProgressStore.layer(path, true)));
    expect(readFileSync(path)).toEqual(before);
  }),
);

it.effect("missing ownership tables and non-text database rows fail validation", () =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const path = join(directory, "invalid.sqlite");
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE channels (id TEXT PRIMARY KEY, data BLOB); INSERT INTO channels VALUES ('10', x'0102')",
    );
    expect(
      yield* Effect.exit(ProgressStore.pipe(Effect.provide(ProgressStore.layer(path, true)))),
    ).toMatchObject({ _tag: "Failure" });
    db.exec("CREATE TABLE metadata (id INTEGER, data TEXT)");
    db.close();
    expect(
      yield* Effect.exit(
        Effect.gen(function* () {
          return yield* (yield* ProgressStore).read("10");
        }).pipe(Effect.provide(ProgressStore.layer(path, true))),
      ),
    ).toMatchObject({ _tag: "Failure" });
  }),
);

it.effect(
  "persists an unfinished scan and READY through closing and reopening the real database",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const directory = yield* temporaryDirectory;
      const path = join(directory, "private", "progress.sqlite");
      const ready = {
        id: "1",
        state: "ready" as const,
        count: 1,
        hash: "a".repeat(64),
        parts: ["2"],
      };
      const stored = yield* Effect.gen(function* () {
        const store = yield* ProgressStore;
        yield* store.owner("bot");
        let journal = yield* openChannelRecord("10", since, horizon);
        journal = yield* journalPage(journal, ["1", "3"]);
        journal = yield* updateRecord(journal, {
          ...journal.record,
          phase: "scan",
          high: "4",
          before: "2",
          archiveBefore: "cursor",
          recentBefore: "4",
          recentFloor: "1",
          recentSince: journal.record.since,
          recentReset: "3",
        });
        return yield* journalStatus(journal, ready);
      }).pipe(Effect.provide(ProgressStore.layer(path, false)));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(directory, "private")).mode & 0o777).toBe(0o700);
      const recovered = yield* Effect.gen(function* () {
        yield* (yield* ProgressStore).owner("bot");
        return yield* readJournal("10");
      }).pipe(Effect.provide(ProgressStore.layer(path, false)));
      expect(recovered).toEqual(stored);
      const before = readFileSync(path);
      expect(
        yield* readJournal("10").pipe(Effect.provide(ProgressStore.layer(path, true))),
      ).toEqual(stored);
      expect(readFileSync(path)).toEqual(before);
    }),
);

it.effect("dry-run leaves a missing database and its parent directory absent", () =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const path = join(directory, "absent", "progress.sqlite");
    yield* Effect.gen(function* () {
      const store = yield* ProgressStore;
      yield* store.owner("bot");
      expect(yield* readJournal("10")).toBeUndefined();
      expect((yield* Effect.flip(store.change("10", () => "no"))).message).toContain("read-only");
    }).pipe(Effect.provide(ProgressStore.layer(path, true)));
    expect(existsSync(join(directory, "absent"))).toBe(false);
  }),
);

it.effect("dry-run verifies existing ownership and refuses writes without changing the file", () =>
  Effect.gen(function* () {
    const path = yield* ownedDatabase;
    chmodSync(path, 0o640);
    const before = readFileSync(path);
    yield* Effect.gen(function* () {
      const store = yield* ProgressStore;
      yield* store.owner("bot");
      expect((yield* Effect.flip(store.owner("other"))).message).toContain(
        "different bot or version",
      );
      expect((yield* Effect.flip(store.change("10", () => "changed"))).message).toContain(
        "read-only",
      );
      expect(yield* store.read("10")).toBe("original");
    }).pipe(Effect.provide(ProgressStore.layer(path, true)));
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  }),
);

it.effect(
  "a failed transaction rolls back and releases its write lock for subsequent commits",
  () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const path = join(directory, "progress.sqlite");
      yield* Effect.gen(function* () {
        const store = yield* seeded;
        expect(
          (yield* Effect.flip(
            store.change("10", () => {
              throw new Error("disk write failure");
            }),
          )).message,
        ).toContain("disk write failure");
        expect(yield* store.read("10")).toBe("original");
        expect(yield* store.change("10", (old) => `${old}/committed`)).toBe("original/committed");
      }).pipe(Effect.provide(ProgressStore.layer(path, false)));
      expect(
        yield* Effect.gen(function* () {
          return yield* (yield* ProgressStore).read("10");
        }).pipe(Effect.provide(ProgressStore.layer(path, true))),
      ).toBe("original/committed");
    }),
);

it.effect("settlement survives restart with both the new floor and empty queue", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(now);
    const directory = yield* temporaryDirectory;
    const path = join(directory, "progress.sqlite");
    yield* Effect.gen(function* () {
      yield* (yield* ProgressStore).owner("bot");
      let journal = yield* journalPage(yield* openChannelRecord("10", since, horizon), ["1"]);
      journal = yield* updateRecord(journal, {
        ...journal.record,
        high: "1",
        before: "1",
        phase: "work",
      });
      yield* journalStatus(journal, { id: "1", state: "terminal" });
      yield* settleRecord(journal);
    }).pipe(Effect.provide(ProgressStore.layer(path, false)));
    const loaded = yield* readJournal("10").pipe(Effect.provide(ProgressStore.layer(path, true)));
    expect(loaded?.record.floor).toBe("1");
    expect(loaded?.record.phase).toBe("idle");
    expect(loaded?.entries.size).toBe(0);
  }),
);

it.effect("corrupt, unrelated and unowned databases fail closed", () =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    for (const text of ["not sqlite", ""]) {
      const path = join(directory, `invalid-${text.length}.sqlite`);
      writeFileSync(path, text);
      expect(
        yield* Effect.exit(ProgressStore.pipe(Effect.provide(ProgressStore.layer(path, false)))),
      ).toMatchObject({ _tag: "Failure" });
    }
    const path = join(directory, "unowned.sqlite");
    yield* Effect.gen(function* () {
      yield* (yield* ProgressStore).change("10", () => "orphan");
    }).pipe(Effect.provide(ProgressStore.layer(path, false)));
    expect(
      (yield* Effect.flip(
        Effect.gen(function* () {
          yield* (yield* ProgressStore).owner("bot");
        }).pipe(Effect.provide(ProgressStore.layer(path, true))),
      )).message,
    ).toContain("Missing progress database owner");
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE channels");
    db.close();
    expect(
      yield* Effect.exit(ProgressStore.pipe(Effect.provide(ProgressStore.layer(path, false)))),
    ).toMatchObject({ _tag: "Failure" });
  }),
);

it.effect("filesystem failures are typed storage errors", () =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory;
    const parent = join(directory, "file");
    writeFileSync(parent, "not a directory");
    expect(
      yield* Effect.flip(
        ProgressStore.pipe(Effect.provide(ProgressStore.layer(join(parent, "db"), false))),
      ),
    ).toMatchObject({ _tag: "StoreError" });
  }),
);

it.effect(
  "closes the connection after success and schema failure, and repairs existing file permissions",
  () =>
    Effect.gen(function* () {
      const path = yield* ownedDatabase;
      chmodSync(path, 0o644);
      const close = vi.spyOn(DatabaseSync.prototype, "close");
      yield* Effect.addFinalizer(() => Effect.sync(() => close.mockRestore()));
      yield* ProgressStore.pipe(Effect.provide(ProgressStore.layer(path, false)));
      expect(close).toHaveBeenCalledTimes(1);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      writeFileSync(path, "corrupt");
      expect(
        yield* Effect.exit(ProgressStore.pipe(Effect.provide(ProgressStore.layer(path, true)))),
      ).toMatchObject({ _tag: "Failure" });
      expect(close).toHaveBeenCalledTimes(2);
    }),
);
