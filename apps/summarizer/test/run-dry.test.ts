import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  journalPage,
  journalStatus,
  openChannelRecord,
  snowflakeAt,
  updateRecord,
} from "../src/channel-record.ts";
import { decodeConfig } from "../src/config.ts";
import { beginScan } from "../src/channel-discovery.ts";
import { fakeApi } from "./discord-api-fixture.ts";
import { at, captureLogs, config, seedJournal, setup, waitForFault } from "./run-fixture.ts";

const day = 86_400_000;

it.effect("dry-run includes unadopted old In-progress work across archived pages", () =>
  Effect.gen(function* () {
    const { discord, invoke, getStarted } = yield* setup();
    const old = discord.addMessage("10", "https://example.test/archived", at - 9 * day);
    discord.addThread("10", old.id, "⏳ Old", "bot", true, 0);
    for (let index = 1; index <= 100; index++) {
      const noise = discord.addMessage("10", `plain ${index}`, at - 9 * day + index);
      discord.addThread("10", noise.id, "⏳ Noise", "bot", true, index * 1000);
    }
    const foreign = discord.addMessage("10", "https://example.test/foreign", at - 9 * day);
    discord.addThread("10", foreign.id, "⏳ Foreign", "human", true);
    discord.addChannel("11");
    const elsewhere = discord.addMessage("11", "https://example.test/elsewhere", at - 9 * day);
    discord.addThread("11", elsewhere.id, "⏳ Elsewhere", "bot");
    const finished = discord.addMessage("10", "https://example.test/finished", at - 9 * day);
    discord.addThread("10", finished.id, "Done", "bot", true);
    const deleted = discord.addMessage("10", "https://example.test/deleted", at - 9 * day);
    discord.addThread("10", deleted.id, "⏳ Deleted", "bot", true);
    discord.messages.set(
      "10",
      discord.messages.get("10")!.filter((message) => message.id !== deleted.id),
    );
    const nextPage = "/channels/10/threads/archived/public?limit=100&before=";
    discord.faults.push({
      method: "GET",
      path: nextPage + encodeURIComponent(new Date(1000).toISOString()),
      status: 200,
      body: { threads: [discord.threads.get(old.id)!], has_more: false },
    });
    discord.faults.push({ method: "GET", path: nextPage, status: 403 });
    const { logs, layer } = captureLogs();
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Pending 0, In progress 1, Given up 0");
    expect(logs.join(" ")).not.toContain("(partial)");
    expect(discord.threads.get(old.id)?.name).toBe("⏳ Old");
    expect(getStarted()).toBe(0);
  }),
);

it.effect("dry-run fails closed when archived pagination loses its cursor", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    discord.faults.push({
      method: "GET",
      path: "/channels/10/threads/archived/public",
      status: 200,
      body: { threads: [], has_more: true },
    });
    expect((yield* Effect.flip(invoke(true))).message).toContain("pagination lacks a cursor");
  }),
);

for (const listing of ["active", "archived", "empty", "direct"] as const)
  it.effect(`dry-run labels a deadline spent checking ${listing} threads`, () =>
    Effect.gen(function* () {
      const { discord, invoke } = yield* setup();
      const source =
        listing === "empty" || listing === "direct"
          ? undefined
          : discord.addMessage("10", "https://example.test/old", at - 9 * day);
      if (source) discord.addThread("10", source.id, "⏳ Old", "bot", listing === "archived");
      let delayed: string | undefined;
      if (listing === "direct") {
        discord.addMessage("10", "https://example.test/first", at - 200);
        const newest = discord.addMessage("10", "https://example.test/second", at - 100);
        delayed = `/channels/10/messages/${newest.id}`;
      }
      discord.faults.push({
        method: "GET",
        path:
          delayed ??
          (listing === "archived"
            ? "/channels/10/threads/archived/public"
            : "/guilds/guild/threads/active"),
        pause: 30 * 60_000,
      });
      const { logs, layer } = captureLogs();
      const fiber = yield* Effect.forkChild(invoke(true).pipe(Effect.provide(layer)));
      yield* waitForFault(discord);
      yield* TestClock.adjust("30 minutes");
      expect(yield* Fiber.join(fiber)).toBe(0);
      expect(logs.join(" ")).toContain(
        `Pending ${listing === "direct" ? 2 : 0}, In progress 0, Given up 0 (partial)`,
      );
      if (source) expect(discord.threads.get(source.id)?.name).toBe("⏳ Old");
    }),
  );

it.effect("dry-run distinguishes an unfinished floor from a settled recent floor", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const old = discord.addMessage("10", "https://example.test/old", at - 9 * day);
    const journal = yield* seedJournal(discord, old);
    const api = yield* fakeApi(discord);
    yield* updateRecord(api, "20", journal, {
      ...journal.record,
      floor: (BigInt(old.id) - 1n).toString(),
    });
    const { logs, layer } = captureLogs();
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain(
      `effective start ${new Date(at - 9 * day).toISOString()} catch-up; Pending 1`,
    );

    const recent = yield* setup();
    const recentApi = yield* fakeApi(recent.discord);
    const settings = yield* decodeConfig(config, "/home/test");
    const empty = (yield* openChannelRecord(
      recentApi,
      "20",
      "10",
      settings.since,
      settings.horizon,
      "bot",
      false,
    )).journal!;
    const recentFloor = (BigInt(snowflakeAt(at - day)) - 1n).toString();
    yield* updateRecord(recentApi, "20", empty, { ...empty.record, floor: recentFloor });
    const report = captureLogs();
    expect(yield* recent.invoke(true).pipe(Effect.provide(report.layer))).toBe(0);
    expect(report.logs.join(" ")).toContain(
      `effective start ${new Date(at - 7 * day).toISOString()} current; Pending 0`,
    );
  }),
);

it.effect("dry-run labels exact Since and Horizon floors and an unfinished scan", () =>
  Effect.gen(function* () {
    const since = new Date(at - 9 * day).toISOString();
    const yaml = config.replace("2026-09-01T00:00:00Z", since);
    for (const [floorAt, label] of [
      [at - 9 * day, "catch-up"],
      [at - 7 * day, "current"],
    ] as const) {
      const { discord, invoke } = yield* setup({}, yaml);
      const api = yield* fakeApi(discord);
      const settings = yield* decodeConfig(yaml, "/home/test");
      const journal = (yield* openChannelRecord(
        api,
        "20",
        "10",
        settings.since,
        settings.horizon,
        "bot",
        false,
      )).journal!;
      const floor = (BigInt(snowflakeAt(floorAt)) - 1n).toString();
      yield* updateRecord(api, "20", journal, { ...journal.record, floor });
      const report = captureLogs();
      expect(yield* invoke(true).pipe(Effect.provide(report.layer))).toBe(0);
      expect(report.logs.join(" ")).toContain(
        `effective start ${new Date(floorAt).toISOString()} ${label}`,
      );
    }
    const { discord, invoke } = yield* setup();
    const api = yield* fakeApi(discord);
    discord.addMessage("10", "https://example.test/pending", at - 1000);
    const settings = yield* decodeConfig(config, "/home/test");
    const journal = (yield* openChannelRecord(
      api,
      "20",
      "10",
      settings.since,
      settings.horizon,
      "bot",
      false,
    )).journal!;
    yield* beginScan(api, "20", journal);
    const report = captureLogs();
    expect(yield* invoke(true).pipe(Effect.provide(report.layer))).toBe(0);
    expect(report.logs.join(" ")).toContain("Pending 1, In progress 0, Given up 0 (partial)");
  }),
);

it.effect(
  "dry-run counts the journaled boundary post and excludes terminal-only work from catch-up",
  () =>
    Effect.gen(function* () {
      const since = new Date(at - 9 * day).toISOString();
      const yaml = config.replace("2026-09-01T00:00:00Z", since);
      const { discord, invoke } = yield* setup({}, yaml);
      const boundary = discord.addMessage("10", "https://example.test/boundary", at - 9 * day);
      const terminal = discord.addMessage("10", "https://example.test/terminal", at - day);
      discord.addThread("10", terminal.id, "Done", "bot", true);
      const api = yield* fakeApi(discord);
      let journal = yield* seedJournal(discord, boundary);
      journal = yield* journalPage(api, "bot", journal, "terminal", [terminal.id]);
      journal = yield* journalStatus(api, "20", "bot", journal, {
        id: terminal.id,
        state: "terminal",
      });
      const report = captureLogs();
      expect(yield* invoke(true).pipe(Effect.provide(report.layer))).toBe(0);
      expect(report.logs.join(" ")).toContain("catch-up; Pending 1");

      const later = config.replace("2026-09-01T00:00:00Z", new Date(at - 2 * day).toISOString());
      // A raised Since removes old Pending from both the count and the catch-up label.
      const changed = yield* setup({}, later);
      const changedApi = yield* fakeApi(changed.discord);
      const before = changed.discord.addMessage("10", "https://example.test/before", at - 3 * day);
      const after = changed.discord.addMessage("10", "https://example.test/after", at - day);
      changed.discord.addThread("10", after.id, "Done", "bot", true);
      const priorConfig = yield* decodeConfig(config, "/home/test");
      let prior = (yield* openChannelRecord(
        changedApi,
        "20",
        "10",
        priorConfig.since,
        priorConfig.horizon,
        "bot",
        false,
      )).journal!;
      prior = yield* journalPage(changedApi, "bot", prior, "older", [before.id, after.id]);
      yield* journalStatus(changedApi, "20", "bot", prior, { id: after.id, state: "terminal" });
      const result = captureLogs();
      expect(yield* changed.invokeWith(later, true).pipe(Effect.provide(result.layer))).toBe(0);
      expect(result.logs.join(" ")).toContain(
        `effective start ${new Date(at - 2 * day).toISOString()} current; Pending 0`,
      );

      const due = changed.discord.addMessage("10", "https://example.test/due", at - day + 1);
      yield* journalPage(changedApi, "bot", prior, "due", [due.id]);
      result.logs.length = 0;
      expect(yield* changed.invokeWith(later, true).pipe(Effect.provide(result.layer))).toBe(0);
      expect(result.logs.join(" ")).toContain("catch-up; Pending 1");
    }),
);

it.effect("dry-run reports an uninitialized channel without looking up phantom journal IDs", () =>
  Effect.gen(function* () {
    const { discord, invoke, getStarted } = yield* setup();
    discord.addMessage("10", "https://example.test/a", at - 1000);
    const messages = structuredClone(discord.messages);
    const { logs, layer } = captureLogs();
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain(
      `News: effective start ${new Date(at - 7 * 86_400_000).toISOString()} uninitialized; Pending 1, In progress 0, Given up 0`,
    );
    expect(logs.join(" ")).not.toContain("(partial)");
    expect(discord.messages).toEqual(messages);
    expect(getStarted()).toBe(0);
    discord.messages.set("10", []);
    logs.length = 0;
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs).toEqual([
      `News: effective start ${new Date(at - 7 * 86_400_000).toISOString()} uninitialized; Pending 0, In progress 0, Given up 0`,
    ]);
  }),
);

it.effect("dry-run paginates at the exact Horizon boundary without skipping eligible posts", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const bound = at - 7 * 86_400_000;
    discord.addMessage("10", "https://example.test/older", bound - 1000);
    discord.addMessage("10", "https://example.test/first-boundary", bound);
    discord.addMessage("10", "https://example.test/second-boundary", bound);
    for (let index = 0; index < 99; index++)
      discord.addMessage("10", `https://example.test/recent/${index}`, bound + index + 1);
    const { logs, layer } = captureLogs();
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Pending 101, In progress 0, Given up 0");
    const pages = discord.requests.filter((request) =>
      request.path.startsWith("/channels/10/messages?"),
    );
    expect(pages).toHaveLength(2);
    expect(pages[1]?.path).toContain(`before=${discord.messages.get("10")![2]!.id}`);
    discord.messages.set("10", []);
    discord.requests.length = 0;
    logs.length = 0;
    discord.addMessage("10", "https://example.test/old", bound - 1);
    for (let index = 0; index < 99; index++)
      discord.addMessage("10", `https://example.test/recent/${index}`, bound + index + 1);
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Pending 99, In progress 0, Given up 0");
    expect(
      discord.requests.filter((request) => request.path.startsWith("/channels/10/messages?")),
    ).toHaveLength(1);
  }),
);

it.effect("dry-run counts a journaled old leftover alongside new Pending and Given-up work", () =>
  Effect.gen(function* () {
    const { discord, invoke, getStarted } = yield* setup();
    const old = discord.addMessage("10", "https://example.test/old", at - 9 * 86_400_000);
    const journal = yield* seedJournal(discord, old);
    discord.addThread("10", old.id, "⏳ Old", "bot", true);
    const oldPending = discord.addMessage(
      "10",
      "https://example.test/old-pending",
      at - 9 * 86_400_000,
    );
    const oldGiven = discord.addMessage(
      "10",
      "https://example.test/old-given",
      at - 9 * 86_400_000,
    );
    discord.addThread("10", oldGiven.id, "⚠️ Given", "bot", true);
    const api = yield* fakeApi(discord);
    yield* journalPage(api, "bot", journal, "older", [oldPending.id, oldGiven.id]);
    const pending = discord.addMessage("10", "https://example.test/pending", at - 2000);
    const given = discord.addMessage("10", "https://example.test/given", at - 1000);
    discord.addThread("10", given.id, "⚠️ Given", "bot", true);
    const foreign = discord.addMessage("10", "https://example.test/foreign", at - 500);
    discord.addThread("10", foreign.id, "⏳ Foreign", "human");
    const { logs, layer } = captureLogs();
    const messages = structuredClone(discord.messages);
    const threads = structuredClone(discord.threads);
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain(
      `News: effective start ${new Date(at - 7 * 86_400_000).toISOString()} catch-up; Pending 2, In progress 1, Given up 2`,
    );
    expect(logs.join(" ")).not.toContain("(partial)");
    expect(discord.messages).toEqual(messages);
    expect(discord.threads).toEqual(threads);
    expect(discord.threads.get(pending.id)).toBeUndefined();
    expect(getStarted()).toBe(0);
    discord.faults.push({ method: "GET", path: "/channels/10", status: 403 });
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(1);
    expect(logs.join(" ")).toContain("Unreadable watched channel News (10)");
    expect(discord.messages).toEqual(messages);
    expect(discord.threads).toEqual(threads);
    discord.faults.push({ method: "GET", path: `/channels/10/messages/${old.id}`, status: 403 });
    expect(yield* Effect.flip(invoke(true))).toMatchObject({ kind: "forbidden" });
  }),
);

it.effect("dry-run skips terminal and already-seen references and tolerates deleted sources", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const recent = discord.addMessage("10", "https://example.test/recent", at - 1000);
    const deleted = discord.addMessage("10", "https://example.test/deleted", at - 9 * 86_400_000);
    const terminal = discord.addMessage("10", "https://example.test/terminal", at - 9 * 86_400_000);
    const api = yield* fakeApi(discord);
    let journal = yield* seedJournal(discord, recent);
    journal = yield* journalPage(api, "bot", journal, "old", [deleted.id, terminal.id]);
    yield* journalStatus(api, "20", "bot", journal, { id: terminal.id, state: "terminal" });
    discord.messages.set(
      "10",
      (discord.messages.get("10") ?? []).filter((m) => m.id !== deleted.id),
    );
    const { logs, layer } = captureLogs();
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Pending 1, In progress 0, Given up 0");
    expect(logs.join(" ")).not.toContain("(partial)");
  }),
);

for (const [minutes, partial] of [
  [15, false],
  [30, true],
] as const)
  it.effect(`dry-run ${partial ? "labels" : "completes"} a ${minutes}-minute journal lookup`, () =>
    Effect.gen(function* () {
      const { discord, invoke } = yield* setup();
      const older = discord.addMessage("10", "https://example.test/older", at - 9 * 86_400_000);
      const newer = discord.addMessage("10", "https://example.test/newer", at - 8 * 86_400_000);
      discord.addMessage("10", "https://example.test/recent", at - 100);
      const api = yield* fakeApi(discord);
      const journal = yield* seedJournal(discord, older);
      yield* journalPage(api, "bot", journal, "more", [newer.id]);
      discord.faults.push({
        method: "GET",
        path: `/channels/10/messages/${older.id}`,
        pause: minutes * 60_000,
      });
      if (partial)
        discord.faults.push({
          method: "GET",
          path: `/channels/10/messages/${newer.id}`,
          status: 403,
        });
      if (partial)
        discord.faults.push({ method: "GET", path: "/guilds/guild/threads/active", status: 403 });
      const { logs, layer } = captureLogs();
      const fiber = yield* Effect.forkChild(invoke(true).pipe(Effect.provide(layer)));
      for (
        let index = 0;
        index < 200 &&
        !discord.requests.some((r) => r.path === `/channels/10/messages/${older.id}`);
        index++
      )
        yield* Effect.yieldNow;
      expect(discord.requests.some((r) => r.path === `/channels/10/messages/${older.id}`)).toBe(
        true,
      );
      yield* TestClock.adjust(`${minutes} minutes`);
      expect(yield* Fiber.join(fiber)).toBe(0);
      expect(logs.join(" ").includes("(partial)")).toBe(partial);
      expect(logs.join(" ")).toContain(`Pending ${partial ? 2 : 3}, In progress 0, Given up 0`);
    }),
  );
