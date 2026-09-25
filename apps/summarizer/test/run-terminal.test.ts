import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { persistReady } from "../src/channel-record.ts";
import { decodeConfig } from "../src/config.ts";
import { DiscordFailure } from "../src/discord-client.ts";
import { fakeApi } from "./discord-api-fixture.ts";
import {
  at,
  captureLogs,
  config,
  failureSetup,
  rejectRename,
  seedJournal,
  setup,
  stalledWork,
} from "./run-fixture.ts";
import { session } from "./opencode-fake.ts";
import { endpoint, harness, source } from "./session-publication-fake.ts";

const retainedConfig = config.replace("delete_sessions: true", "delete_sessions: false");
const olderRun = (exports: Readonly<Record<string, object>>, target?: HttpClient.HttpClient) =>
  setup(
    { pages: [[session("ses_old", "succeeded")]], exports },
    retainedConfig,
    async () => endpoint,
    target,
  );

it.effect("rejects a missing configured command before starting any Attempt", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup({}, config + "command: unavailable\n");
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    expect(yield* Effect.flip(invoke())).toMatchObject({
      reason: "Unknown OpenCode command: unavailable",
    });
    expect(discord.threads.get(post.id)).toBeUndefined();
    expect(openCode.requests).not.toContain("POST /api/session");
  }),
);

for (const { name, content, extra } of [
  { name: "Title", content: "Already complete", extra: undefined },
  { name: "⚠️ Title", content: "⚠️ 요약 실패 (3/3): 오류 (empty)", extra: undefined },
  {
    name: "⚠️ Title",
    content: "⚠️ 요약 실패 (3/3): 실패",
    extra: "⏸️ 요약 중단 (1/3): 재시도 횟수에 포함되지 않음",
  },
])
  it.effect(
    `verifies an already-committed ${name} thread with ${extra ? "mixed" : "simple"} notes`,
    () =>
      Effect.gen(function* () {
        const { discord, invoke, openCode } = yield* setup();
        const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
        yield* seedJournal(discord, post);
        discord.addThread("10", post.id, name, "bot", true);
        discord.addMessage(post.id, content, at, "bot");
        if (extra) discord.addMessage(post.id, extra, at + 1, "bot");
        expect(yield* invoke()).toBe(0);
        expect(discord.messages.get(post.id)?.map((m) => m.content)).toEqual(
          extra ? [content, extra] : [content],
        );
        expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(
          0,
        );
      }),
  );

it.effect("counts an interrupted model execution as a Link-specific failure", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup({ event: "interrupted", outcome: "interrupted" });
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.name).toBe("⏳ 요약");
    expect(discord.messages.get(post.id)?.[0]?.content).toContain("(interrupted)");
  }),
);

it.effect("counts a content error containing an infrastructure keyword as a Link failure", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* failureSetup("content.provider.auth");
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    expect(yield* invoke()).toBe(0);
    expect(discord.messages.get(post.id)?.[0]?.content).toContain(
      "요약 실패 (1/3): 요약 실패 (content.provider.auth)",
    );
  }),
);

it.effect("does not count a provider outage and stops before the next Link", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* failureSetup(
      "provider.auth",
      config + "concurrency: 1\n",
    );
    const first = discord.addMessage("10", "https://example.test/a", at - 2000);
    const second = discord.addMessage("10", "https://example.test/b", at - 1000);
    const error = yield* Effect.flip(invoke());
    expect(String(error)).toContain("provider.auth");
    expect(discord.messages.get(first.id)?.[0]?.content).toContain("요약 중단");
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(1);
    expect(discord.messages.get(second.id)).toBeUndefined();
  }),
);

it.effect("rejects a second forbidden rename instead of looping on fallback", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const post = discord.addMessage("10", "Blocked https://example.test/a", at - 1000);
    rejectRename(discord, post.id);
    rejectRename(discord, post.id);
    expect(yield* Effect.flip(invoke())).toMatchObject({ kind: "name-rejected" });
    expect(discord.threads.get(post.id)?.name).toContain("⏳");
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(false);
  }),
);

it.effect("does not retry a rejected fallback title with the same title", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    rejectRename(discord, post.id);
    expect(yield* Effect.flip(invoke())).toMatchObject({ kind: "name-rejected" });
    expect(discord.threads.get(post.id)?.name).toBe("⏳ 요약");
    expect(
      discord.requests.filter((r) => r.method === "PATCH" && r.path === `/channels/${post.id}`),
    ).toHaveLength(1);
  }),
);

for (const { name, content, author, error } of [
  {
    name: "Title",
    content: "Only human replies",
    author: "human",
    error: "Unverified terminal Summary Thread",
  },
  {
    name: "⚠️ Title",
    content: "⏸️ 요약 중단 (1/3): 재시도 횟수에 포함되지 않음",
    author: "bot",
    error: "Unverified Given-up Summary Thread",
  },
])
  it.effect(`fails closed on an invalid ${name} thread`, () =>
    Effect.gen(function* () {
      const { discord, invoke } = yield* setup();
      const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
      yield* seedJournal(discord, post);
      discord.addThread("10", post.id, name, "bot", true);
      discord.addMessage(post.id, content, at, author);
      expect((yield* Effect.flip(invoke())).message).toContain(error);
    }),
  );

const tamperedReady = (name: string) =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
    const journal = yield* seedJournal(discord, post);
    const api = yield* fakeApi(discord);
    discord.addThread("10", post.id, name, "bot", true);
    const part = discord.addMessage(post.id, "summary", at, "bot");
    yield* persistReady(api, "20", "bot", journal, post.id, [part]);
    discord.messages.set(post.id, [{ ...part, content: "tampered" }]);
    return { discord, invoke, openCode, post };
  });

it.effect("refuses to commit an incomplete READY draft", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode, post } = yield* tamperedReady("⏳ Title");
    expect(yield* Effect.flip(invoke())).toMatchObject({
      _tag: "AttemptFailure",
      message: "READY parts mismatch",
    });
    expect(discord.threads.get(post.id)?.name).toBe("⏳ Title");
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(0);
  }),
);

it.effect("refuses an already-committed thread when its READY parts have changed", () =>
  Effect.gen(function* () {
    const { invoke, openCode } = yield* tamperedReady("Title");
    expect((yield* Effect.flip(invoke())).message).toContain("Unverified terminal Summary Thread");
    expect(openCode.requests).not.toContain("POST /api/session");
  }),
);

it.effect("preserves an unresolved Link when its source read is forbidden", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    yield* seedJournal(discord, post);
    discord.faults.push({ method: "GET", path: `/channels/10/messages/${post.id}`, status: 403 });
    expect(yield* Effect.flip(invoke())).toMatchObject({ kind: "forbidden" });
    expect(openCode.requests).not.toContain("POST /api/session");
  }),
);

it.effect("does not infer a competing thread from an unrelated thread-creation error", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    discord.faults.push({
      method: "POST",
      path: `/channels/10/messages/${post.id}/threads`,
      status: 403,
    });
    expect(yield* Effect.flip(invoke())).toMatchObject({ kind: "forbidden" });
    expect(openCode.requests).not.toContain("POST /api/session");
  }),
);

it.effect("refuses to fall back to another title after a permission failure", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const post = discord.addMessage("10", "Blocked https://example.test/a", at - 1000);
    discord.faults.push({ method: "PATCH", path: `/channels/${post.id}`, status: 403 });
    expect(yield* Effect.flip(invoke())).toMatchObject({ kind: "forbidden" });
    expect(
      discord.requests.filter((r) => r.method === "PATCH" && r.path === `/channels/${post.id}`),
    ).toHaveLength(1);
    expect(discord.threads.get(post.id)?.name).toBe("⏳ Blocked");
  }),
);

it.effect("refuses terminal threads whose parent, owner, archive or status changed", () =>
  Effect.gen(function* () {
    for (const [name, content, invalid] of [
      ["Title", "Summary", { parent_id: "11" }],
      ["Title", "Summary", { owner_id: "human" }],
      ["Title", "Summary", { thread_metadata: { archived: false } }],
      ["Title", "Summary", { name: "⏳ Title" }],
      ["Title", "Summary", { name: "⚠️ Title" }],
      ["⚠️ Title", "⚠️ 요약 실패 (3/3): 실패", { parent_id: "11" }],
      ["⚠️ Title", "⚠️ 요약 실패 (3/3): 실패", { owner_id: "human" }],
      ["⚠️ Title", "⚠️ 요약 실패 (3/3): 실패", { thread_metadata: { archived: false } }],
      ["⚠️ Title", "⚠️ 요약 실패 (3/3): 실패", { name: "Title" }],
    ] as const) {
      const { discord, invoke } = yield* setup();
      const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
      yield* seedJournal(discord, post);
      const thread = discord.addThread("10", post.id, name, "bot", true);
      discord.addMessage(post.id, content, at, "bot");
      discord.threads.set(post.id, { ...thread, ...invalid });
      expect((yield* Effect.flip(invoke())).message).toContain(
        "parent_id" in invalid || "owner_id" in invalid || "name" in invalid
          ? "Invalid Summary Thread"
          : name.startsWith("⚠️")
            ? "Unverified Given-up"
            : "Unverified terminal",
      );
    }
  }),
);

it.effect("retains a successful private session when interactive publication is unavailable", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup({}, retainedConfig);
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
    expect(openCode.requests).toContain("POST /api/session");
    expect(openCode.requests).not.toContain("DELETE /api/session/ses_one");
    expect(yield* invoke()).toBe(0);
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(1);
  }),
);

it.effect("retains an unfinished private session inside the timeout grace window", () =>
  Effect.gen(function* () {
    const { invoke, openCode } = yield* setup({
      pages: [[session("ses_live", undefined, at - 11 * 60_000)]],
    });
    expect(yield* invoke()).toBe(0);
    expect(openCode.requests).not.toContain("DELETE /api/session/ses_live");
  }),
);

it.effect("defers a malformed older terminal transcript without consuming Link Attempts", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* olderRun({ ses_old: {} });
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    const { logs, layer } = captureLogs();
    expect(yield* invoke().pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Publication deferred ses_old:");
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
    expect(openCode.requests).toContain(
      "GET /api/experimental/session/ses_old/export?sanitize=false",
    );
    expect(openCode.requests).toContain("POST /api/session");
  }),
);

it.effect("publishes an older terminal session and the current successful Attempt", () =>
  Effect.gen(function* () {
    const old = { ...source, info: { ...source.info, id: "ses_old" } };
    const target = harness();
    const { discord, invoke, openCode } = yield* olderRun(
      { ses_old: old, ses_one: source },
      target.http,
    );
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    const { logs, layer } = captureLogs();
    expect(yield* invoke().pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).not.toContain("Publication deferred");
    expect(
      target.requests.filter((r) => r === "POST /api/experimental/session/import"),
    ).toHaveLength(2);
    expect(openCode.requests).toContain("PATCH /api/session/ses_old");
    expect(openCode.requests).toContain("PATCH /api/session/ses_one");
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
    expect(yield* invoke()).toBe(0);
    expect(
      target.requests.filter((r) => r === "POST /api/experimental/session/import"),
    ).toHaveLength(2);
  }),
);

it.effect("logs deferred publication of a valid old transcript and keeps summarizing", () =>
  Effect.gen(function* () {
    const target = harness();
    const { discord, invoke } = yield* olderRun(
      { ses_old: { ...source, info: { ...source.info, id: "ses_old" } } },
      target.http,
    );
    target.requests.length = 0;
    const { logs, layer } = captureLogs();
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    expect(yield* invoke().pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Publication deferred ses_one");
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("logs an unavailable publication sweep without blocking a Link", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup({}, retainedConfig, async () => undefined);
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    const { logs, layer } = captureLogs();
    expect(yield* invoke().pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain(
      "Publication deferred: Interactive OpenCode service unavailable",
    );
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("reconciles a lost fallback rename reply on a Given-up thread", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup(
      { event: "failed", outcome: "failed", errorType: "content-filter" },
      config + "retry_waits: []\n",
    );
    const post = discord.addMessage("10", "Blocked https://example.test/a", at - 1000);
    discord.faults.push({ method: "PATCH", path: `/channels/${post.id}/messages/`, status: 200 });
    discord.faults.push({
      method: "PATCH",
      path: `/channels/${post.id}`,
      status: 400,
      code: 200000,
    });
    discord.faults.push({ method: "PATCH", path: `/channels/${post.id}`, drop: true, after: true });
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.name).toBe("⚠️ 요약");
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
  }),
);

it.effect("does not reverse a terminal commit when its source disappears during verification", () =>
  Effect.gen(function* () {
    const { discord } = yield* setup();
    const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
    const journal = yield* seedJournal(discord, post);
    discord.addThread("10", post.id, "Title", "bot", true);
    discord.addMessage(post.id, "Finished", at, "bot");
    const base = yield* fakeApi(discord);
    let reads = 0;
    const api = {
      ...base,
      getMessage: (channel: string, id: string) =>
        channel === "10" && id === post.id && ++reads === 2
          ? Effect.fail(new DiscordFailure("not-found", 404))
          : base.getMessage(channel, id),
      getChannel: (id: string) =>
        id === post.id && reads >= 2
          ? Effect.fail(new DiscordFailure("not-found", 404))
          : base.getChannel(id),
    };
    const settings = yield* decodeConfig(config, "/home/test");
    const finished = yield* stalledWork(api, settings, journal, post.id);
    expect(finished.entries.get(post.id)?.state).toBe("terminal");
    expect(discord.messages.get(post.id)?.map((m) => m.content)).toEqual(["Finished"]);
  }),
);

it.effect("cleans only bot drafts and notes across a paginated thread history", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
    discord.addThread("10", post.id, "⏳ Title");
    discord.addMessage(post.id, "old bot draft", at - 999, "bot");
    discord.addMessage(post.id, "⏸️ 요약 중단 (1/3): 재시도 횟수에 포함되지 않음", at - 998, "bot");
    for (let index = 0; index < 100; index++)
      discord.addMessage(post.id, `human reply ${index}`, at - 900 + index, "human");
    expect(yield* invoke()).toBe(0);
    const messages = discord.messages.get(post.id)!;
    expect(messages).toHaveLength(101);
    expect(messages.filter((m) => m.author.id === "bot").map((m) => m.content)).toEqual([
      "안녕하세요",
    ]);
    expect(messages.filter((m) => m.author.id === "human")).toHaveLength(100);
    expect(discord.threads.get(post.id)?.name).toBe("Title");
  }),
);

it.effect("gives up an orphaned maximum-length Attempt history without another session", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
    discord.addThread("10", post.id, "⏳ Title", "bot", true);
    for (let index = 1; index <= 3; index++)
      discord.addMessage(post.id, `⚠️ 요약 실패 (${index}/3): 실패`, at - 500 + index, "bot");
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.name).toBe("⚠️ Title");
    expect(discord.messages.get(post.id)).toHaveLength(3);
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(0);
  }),
);

for (const { fault, claimed } of [
  { fault: { status: 400, code: 160004 }, claimed: false },
  { fault: { drop: true, after: true }, claimed: true },
])
  it.effect(`recovers a ${claimed ? "lost-reply" : "competing"} thread claim`, () =>
    Effect.gen(function* () {
      const { discord, invoke, openCode } = yield* setup();
      const post = discord.addMessage("10", "https://example.test/claim", at - 1000);
      discord.faults.push({
        method: "POST",
        path: `/channels/10/messages/${post.id}/threads`,
        ...fault,
      });
      expect(yield* invoke()).toBe(0);
      expect(discord.threads.has(post.id)).toBe(claimed);
      if (!claimed) {
        expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(
          0,
        );
        expect(yield* invoke()).toBe(0);
      }
      expect(discord.messages.get(post.id)?.map((m) => m.content)).toEqual(["안녕하세요"]);
      expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
    }),
  );
