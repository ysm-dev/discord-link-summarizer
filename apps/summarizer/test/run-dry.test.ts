import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { journalPage, journalStatus } from "../src/channel-record.ts";
import { fakeApi } from "./discord-api-fixture.ts";
import { at, captureLogs, seedJournal, setup } from "./run-fixture.ts";

it.effect("dry-run reports an uninitialized channel without looking up phantom journal IDs", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    discord.addMessage("10", "https://example.test/a", at - 1000);
    const { logs, layer } = captureLogs();
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain(
      `News: effective start ${new Date(at - 7 * 86_400_000).toISOString()} uninitialized; Pending 1, In progress 0, Given up 0`,
    );
    expect(logs.join(" ")).not.toContain("(partial)");
    expect(discord.requests.filter((r) => r.path.startsWith("/channels/10/messages/"))).toEqual([]);
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
    const writes = discord.requests.filter((request) => request.method !== "GET").length;
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain(
      `News: effective start ${new Date(at - 7 * 86_400_000).toISOString()} catch-up; Pending 2, In progress 1, Given up 2`,
    );
    expect(logs.join(" ")).not.toContain("(partial)");
    expect(discord.requests.filter((request) => request.method !== "GET")).toHaveLength(writes);
    expect(discord.threads.get(pending.id)).toBeUndefined();
    expect(getStarted()).toBe(0);
    discord.faults.push({ method: "GET", path: "/channels/10", status: 403 });
    expect(yield* invoke(true).pipe(Effect.provide(layer))).toBe(1);
    expect(logs.join(" ")).toContain("Unreadable watched channel News (10)");
    expect(discord.requests.filter((request) => request.method !== "GET")).toHaveLength(writes);
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
      const api = yield* fakeApi(discord);
      const journal = yield* seedJournal(discord, older);
      yield* journalPage(api, "bot", journal, "more", [newer.id]);
      discord.faults.push({
        method: "GET",
        path: `/channels/10/messages/${older.id}`,
        pause: minutes * 60_000,
      });
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
    }),
  );
