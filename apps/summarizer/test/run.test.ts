import { expect, it } from "./progress-fixture.ts";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { openChannelRecord, persistReady } from "../src/channel-record.ts";
import { ProgressStore } from "../src/progress-store.ts";
import { decodeConfig } from "../src/config.ts";
import { fakeApi } from "./discord-api-fixture.ts";
import { at, config, failureSetup, rejectRename, seedJournal, setup } from "./run-fixture.ts";

it.effect("performs a complete Run and a repeat Run from Discord state", () =>
  Effect.gen(function* () {
    const { discord, invoke, getStarted, openCode } = yield* setup();
    const post = discord.addMessage("10", "Example title https://example.test/a", at - 1000);
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.name).toBe("Example title");
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
    expect(discord.messages.get(post.id)?.map((message) => message.content)).toEqual([
      "안녕하세요",
    ]);
    const created = openCode.bodies.find((body) => body.includes('"metadata":{"summarizer"'))!;
    expect(JSON.parse(created)).toMatchObject({
      title: "🔗 News · https://example.test/a",
      agent: "summarizer",
      model: { providerID: "provider", id: "model", variant: "max" },
      location: { directory: "/workspace" },
      metadata: { summarizer: { channelID: "10", messageID: post.id } },
    });
    expect(
      openCode.bodies.some((body) =>
        body.includes('"name":"summarize","text":"https://example.test/a"'),
      ),
    ).toBe(true);
    expect(yield* invoke()).toBe(0);
    expect(discord.messages.get(post.id)).toHaveLength(1);
    expect(getStarted()).toBe(2);
  }),
);

it.effect("reconciles lost note, part and commit replies without touching a human reply", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup({ text: "⏳ 요약 중 (1/3)" });
    const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
    discord.addThread("10", post.id, "⏳ Title");
    discord.addMessage(post.id, "human reply", at - 500);
    discord.faults.push({
      method: "POST",
      path: `/channels/${post.id}/messages`,
      drop: true,
      after: true,
    });
    discord.faults.push({
      method: "POST",
      path: `/channels/${post.id}/messages`,
      drop: true,
      after: true,
    });
    discord.faults.push({ method: "PATCH", path: `/channels/${post.id}`, drop: true, after: true });
    expect(yield* invoke()).toBe(0);
    expect(discord.messages.get(post.id)?.map((message) => message.content)).toEqual([
      "human reply",
      "⏳ 요약 중 (1/3)",
    ]);
    expect(yield* invoke()).toBe(0);
    expect(discord.messages.get(post.id)).toHaveLength(2);
  }),
);

it.effect("commits a seeded READY draft after a crash without another session", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
    const api = yield* fakeApi(discord);
    const journal = yield* seedJournal(discord, post);
    discord.addThread("10", post.id, "⏳ Title", "bot", true);
    discord.addMessage(post.id, "⏳ 요약 중 (3/3)", at, "bot");
    const human = discord.addMessage(post.id, "Keep this reply", at, "human");
    const part = discord.addMessage(post.id, "summary", at + 1, "bot");
    yield* persistReady(api, "bot", journal, post.id, [part]);
    expect(yield* invoke()).toBe(0);
    expect(discord.messages.get(post.id)?.map((message) => message.content)).toEqual([
      "Keep this reply",
      "summary",
    ]);
    expect(discord.messages.get(post.id)?.[0]?.id).toBe(human.id);
    expect(discord.threads.get(post.id)?.name).toBe("Title");
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(0);
  }),
);

it.effect("falls back when Discord rejects a thread name", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const post = discord.addMessage("10", "Blocked https://example.test/a", at - 1000);
    discord.faults.push({
      method: "POST",
      path: `/channels/10/messages/${post.id}/threads`,
      status: 400,
      code: 200000,
    });
    rejectRename(discord, post.id);
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.name).toBe("요약");
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("reconciles a lost fallback rename reply against the committed thread", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const post = discord.addMessage("10", "Blocked https://example.test/a", at - 1000);
    expect(discord.threads.has(post.id)).toBe(false);
    rejectRename(discord, post.id);
    discord.faults.push({ method: "PATCH", path: `/channels/${post.id}`, drop: true, after: true });
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.name).toBe("요약");
    expect(yield* invoke()).toBe(0);
    expect(discord.messages.get(post.id)?.map((m) => m.content)).toEqual(["안녕하세요"]);
  }),
);

it.effect("skips a forbidden watched channel and exits nonzero", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    discord.addMessage("10", "https://example.test/a", at - 1000);
    discord.faults.push({ method: "GET", path: "/channels/10", status: 403 });
    expect(yield* invoke()).toBe(1);
    expect(discord.threads.size).toBe(0);
  }),
);

it.effect("bounds an unfinished model Attempt at the Summary timeout", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup({ holdTerminal: true });
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    const fiber = yield* Effect.forkChild(invoke());
    for (
      let index = 0;
      index < 100 && !openCode.requests.includes(`POST /api/session/ses_one/command`);
      index++
    )
      yield* Effect.yieldNow;
    expect(openCode.requests).toContain("POST /api/session/ses_one/command");
    yield* TestClock.adjust("10 minutes");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(discord.messages.get(post.id)?.[0]?.content).toContain("(timeout)");
    expect(openCode.requests).toContain("POST /api/session/ses_one/interrupt?resume=false");
  }),
);

it.effect("queues both channels by numeric source ID with one active slot", () =>
  Effect.gen(function* () {
    const yaml = config + '  - id: "11"\n    label: Other\nconcurrency: 1\n';
    const { discord, invoke, openCode } = yield* setup({}, yaml);
    discord.addChannel("11");
    const newer = discord.addMessage("10", "https://example.test/new", at - 1000);
    const older = discord.addMessage("11", "https://example.test/old", at - 2000);
    expect(yield* invoke()).toBe(0);
    const sessions = openCode.bodies.filter((body) => body.includes('"metadata":{"summarizer"'));
    const request = Schema.fromJsonString(
      Schema.Struct({
        metadata: Schema.Struct({ summarizer: Schema.Struct({ messageID: Schema.String }) }),
      }),
    );
    expect(
      sessions.map((body) => Schema.decodeSync(request)(body).metadata.summarizer.messageID),
    ).toEqual([older.id, newer.id]);
    expect(discord.threads.get(older.id)?.thread_metadata.archived).toBe(true);
    expect(discord.threads.get(newer.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("uses a failed note's edit time, not the start time, for retry", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/a", at - 60_000);
    discord.addThread("10", post.id, "⏳ 요약");
    const note = discord.addMessage(
      post.id,
      "⚠️ 요약 실패 (1/3): 오류 (empty)",
      at - 3_600_000,
      "bot",
    );
    discord.messages.set(post.id, [
      { ...note, edited_timestamp: new Date(at - 5 * 60_000).toISOString() },
    ]);
    expect(yield* invoke()).toBe(0);
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(0);
    yield* TestClock.adjust("5 minutes");
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("interrupts a reachable note after a failed part write and retries immediately", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    discord.faults.push({ method: "POST", path: `/channels/${post.id}/messages`, status: 200 });
    discord.faults.push({ method: "POST", path: `/channels/${post.id}/messages`, drop: true });
    expect(yield* Effect.flip(invoke())).toBeDefined();
    expect(discord.messages.get(post.id)?.[0]?.content).toContain("요약 중단");
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("preflights unsupported types and dry-runs without mutation or a private child", () =>
  Effect.gen(function* () {
    const { discord, invoke, getStarted } = yield* setup();
    discord.addMessage("10", "https://example.test/a", at - 1000);
    expect(yield* invoke(true)).toBe(0);
    expect(discord.threads.size).toBe(0);
    expect(getStarted()).toBe(0);
    discord.addChannel("10", "guild", 15);
    expect((yield* Effect.flip(invoke())).message).toContain("Unsupported Watched Channel");
    expect(discord.threads.size).toBe(0);
    discord.addChannel("10");
    discord.faults.push({ method: "GET", path: "/channels/10", status: 404 });
    expect(yield* invoke()).toBe(1);
    expect(discord.threads.size).toBe(0);
  }),
);

it.effect(
  "retries a Link failure from its edited failure time and gives up after the configured maximum",
  () =>
    Effect.gen(function* () {
      const { discord, invoke } = yield* failureSetup("content-filter");
      const post = discord.addMessage("10", "https://example.test/a", at - 1000);
      expect(yield* invoke()).toBe(0);
      expect(discord.messages.get(post.id)?.[0]?.content).toContain("(1/3)");
      yield* TestClock.adjust("9 minutes");
      expect(yield* invoke()).toBe(0);
      expect(discord.messages.get(post.id)).toHaveLength(1);
      yield* TestClock.adjust("1 minute");
      expect(yield* invoke()).toBe(0);
      expect(discord.messages.get(post.id)).toHaveLength(2);
      yield* TestClock.adjust("1 hour");
      expect(yield* invoke()).toBe(0);
      expect(discord.threads.get(post.id)?.name).toBe("⚠️ 요약");
      expect(discord.messages.get(post.id)).toHaveLength(3);
      const settings = yield* decodeConfig(config, "/home/test");
      const record = yield* openChannelRecord("10", settings.since, settings.horizon);
      expect(BigInt(record.record.floor)).toBeGreaterThanOrEqual(BigInt(post.id));
      expect(record.entries.has(post.id)).toBe(false);
    }),
);

it.effect("keeps human replies and posts model text with mentions disabled", () =>
  Effect.gen(function* () {
    const text = "@everyone\n<@123> https://example.test/a";
    const { discord, invoke } = yield* setup({ text });
    const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
    discord.addThread("10", post.id, "⏳ Title", "bot");
    const human = discord.addMessage(post.id, "Keep this", at - 500);
    const spoofed = discord.addMessage(post.id, "⚠️ 요약 실패 (3/3): human reply", at - 400);
    expect(yield* invoke()).toBe(0);
    expect(discord.messages.get(post.id)?.map((message) => message.content)).toEqual([
      "Keep this",
      "⚠️ 요약 실패 (3/3): human reply",
      text,
    ]);
    expect(discord.messages.get(post.id)?.[0]?.id).toBe(human.id);
    expect(discord.messages.get(post.id)?.[1]?.id).toBe(spoofed.id);
    const posts = discord.requests.filter(
      (request) => request.method === "POST" && request.path === `/channels/${post.id}/messages`,
    );
    expect(
      posts.every((request) =>
        JSON.stringify(request.body).includes('"allowed_mentions":{"parse":[]}'),
      ),
    ).toBe(true);
  }),
);

it.effect(
  "rejects an off-clock identity and skips forbidden channels after processing other channels",
  () =>
    Effect.gen(function* () {
      const { discord, invoke } = yield* setup();
      discord.faults.push({
        method: "GET",
        path: "/users/@me",
        headers: { date: new Date(at + 61_000).toUTCString() },
      });
      const error = yield* Effect.flip(invoke());
      expect(error).toHaveProperty("_tag", "RunFailure");
      expect(error.message).toContain("clock differs");
      expect(discord.requests.some((request) => request.method === "POST")).toBe(false);
      discord.faults.push({
        method: "GET",
        path: "/users/@me",
        headers: { date: new Date(at + 60_000).toUTCString() },
      });
      expect(yield* invoke(true)).toBe(0);
    }),
);

it.effect(
  "recovers an auto-archived leftover before the later Since, then leaves it terminal",
  () =>
    Effect.gen(function* () {
      const { discord, invoke, openCode } = yield* setup();
      const post = discord.addMessage("10", "Old https://example.test/old", at - 9 * 86_400_000);
      discord.addThread("10", post.id, "⏳ Old", "bot", true);
      discord.addMessage(
        post.id,
        "⏸️ 요약 중단 (1/3): 재시도 횟수에 포함되지 않음",
        at - 8 * 86_400_000,
        "bot",
      );
      expect(yield* invoke()).toBe(0);
      expect(discord.threads.get(post.id)?.name).toBe("Old");
      expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
      expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(
        1,
      );
      expect(yield* invoke()).toBe(0);
      expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(
        1,
      );
    }),
);

it.effect("does not duplicate a live Attempt and counts a stale crashed Attempt", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/old", at - 9 * 86_400_000);
    discord.addThread("10", post.id, "⏳ 요약", "bot", true);
    discord.addMessage(post.id, "⏳ 요약 중 (1/3)", at - 11 * 60_000, "bot");
    expect(yield* invoke()).toBe(0);
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(0);
    yield* TestClock.adjust("1 minute");
    expect(yield* invoke()).toBe(0);
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(1);
    expect(discord.threads.get(post.id)?.name).toBe("요약");
  }),
);

it.effect("recovers a deleted completed thread without erasing a newer parent", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/deleted", at - 1000);
    expect(yield* invoke()).toBe(0);
    discord.threads.delete(post.id);
    discord.messages.delete(post.id);
    discord.messages.set(
      "10",
      (discord.messages.get("10") ?? []).map((item) =>
        item.id === post.id ? { ...item, thread: undefined } : item,
      ),
    );
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(2);
  }),
);

it.effect("skips a deleted source while completing another Link", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const gone = discord.addMessage("10", "https://example.test/gone", at - 2000);
    const kept = discord.addMessage("10", "https://example.test/kept", at - 1000);
    discord.faults.push({
      method: "GET",
      path: `/channels/10/messages/${gone.id}`,
      status: 404,
      code: 10008,
    });
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(gone.id)).toBeUndefined();
    expect(discord.threads.get(kept.id)?.thread_metadata.archived).toBe(true);
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(1);
  }),
);

it.effect("does not let an edited completed post trigger a second summary", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
    expect(yield* invoke()).toBe(0);
    discord.messages.set(
      "10",
      (discord.messages.get("10") ?? []).map((item) =>
        item.id === post.id ? { ...item, content: "Changed https://example.test/b" } : item,
      ),
    );
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.name).toBe("Title");
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(1);
  }),
);

it.effect("preflights database ownership and bot-wide errors before writing", () =>
  Effect.gen(function* () {
    const { discord, invoke, getStarted } = yield* setup();
    discord.addMessage("10", "https://example.test/a", at - 1000);
    const store = yield* ProgressStore;
    expect(
      (yield* Effect.flip(
        invoke().pipe(
          Effect.provideService(ProgressStore, { ...store, owner: () => store.owner("other-bot") }),
        ),
      )).message,
    ).toContain("different bot");
    discord.faults.push({ method: "GET", path: "/channels/10", status: 401 });
    expect(yield* Effect.flip(invoke())).toBeDefined();
    expect(discord.threads.size).toBe(0);
    expect(getStarted()).toBe(0);
  }),
);

it.effect("continues readable channels after a forbidden watched channel", () =>
  Effect.gen(function* () {
    const yaml = config + '  - id: "11"\n    label: Unreadable\n';
    const { discord, invoke } = yield* setup({}, yaml);
    discord.addChannel("11");
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    discord.faults.push({ method: "GET", path: "/channels/11", status: 403 });
    expect(yield* invoke()).toBe(1);
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("dry-runs a recorded channel and leaves its journal unchanged", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode, getStarted } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    expect(yield* invoke()).toBe(0);
    const before = discord.requests.filter((request) => request.method !== "GET").length;
    expect(yield* invoke(true)).toBe(0);
    expect(discord.requests.filter((request) => request.method !== "GET")).toHaveLength(before);
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(1);
    expect(discord.threads.get(post.id)?.name).toBe("요약");
    expect(getStarted()).toBe(1);
  }),
);

it.effect("does not backfill beyond the onboarding Horizon across message pages", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    for (let index = 0; index < 101; index++)
      discord.addMessage(
        "10",
        `https://example.test/ancient/${index}`,
        at - 8 * 86_400_000 + index,
      );
    const fresh = discord.addMessage("10", "https://example.test/fresh", at - 1000);
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.size).toBe(1);
    expect(discord.threads.get(fresh.id)?.thread_metadata.archived).toBe(true);
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(1);
  }),
);

it.effect("commits long paragraph-delimited text as complete ordered parts", () =>
  Effect.gen(function* () {
    const text = ["a".repeat(1498), "b".repeat(1498), "c".repeat(1498)].join("\n\n");
    const { discord, invoke } = yield* setup({ text });
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    expect(yield* invoke()).toBe(0);
    const parts = discord.messages.get(post.id)?.map((message) => message.content) ?? [];
    expect(parts).toHaveLength(3);
    expect(parts.join("")).toBe(text);
    expect(parts.every((part) => part.length <= 2000)).toBe(true);
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("excludes wachi alerts while processing adjacent user Links", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const alert = discord.addMessage(
      "10",
      "wachi: failure https://example.test/a",
      at - 2000,
      "wachi",
    );
    const post = discord.addMessage("10", "https://example.test/b", at - 1000);
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(alert.id)).toBeUndefined();
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
  }),
);
