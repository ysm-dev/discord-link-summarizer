import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Redacted } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { Discord, type DiscordApi, DiscordFailure, DiscordLive } from "../src/discord-client.ts";
import { FakeDiscord } from "./discord-fake.ts";
import { fakeApi } from "./discord-api-fixture.ts";

const at = Date.parse("2026-09-25T00:00:00Z");
const setup = Effect.gen(function* () {
  const fake = new FakeDiscord();
  fake.addChannel("news");
  const api = yield* fakeApi(fake);
  return { fake, api };
});

const waitForChannel = (api: DiscordApi, fake: FakeDiscord, initial: 0 | 1) =>
  Effect.gen(function* () {
    const count = fake.requests.length;
    const pending = yield* Effect.forkChild(api.getChannel("news"));
    yield* TestClock.adjust("999 millis");
    expect(fake.requests).toHaveLength(count + initial);
    yield* TestClock.adjust("1 millis");
    expect((yield* Fiber.join(pending)).id).toBe("news");
    expect(fake.requests).toHaveLength(count + initial + 1);
  });

const rateLimit = (fake: FakeDiscord, headers: Record<string, string>, body?: object) => {
  fake.faults.push({
    method: "GET",
    path: "/channels/news",
    status: 429,
    headers,
    ...(body === undefined ? {} : { body }),
  });
};

it.effect("decodes bot clock, channels, messages and cursor pages", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const { fake, api } = yield* setup;
    const first = fake.addMessage("news", "first", at - 2000);
    const second = fake.addMessage("news", "second", at - 1000);
    expect((yield* api.currentUser).user.id).toBe("bot");
    expect(fake.requests[0]?.headers["authorization"]).toBe("Bot secret");
    expect(fake.requests[0]?.headers["user-agent"]).toMatch(/^DiscordBot \(/);
    expect((yield* api.currentUser).date.toISOString()).toBe(new Date(at).toISOString());
    expect((yield* api.getChannel("news")).guild_id).toBe("guild");
    expect((yield* api.listMessages("news")).map((msg) => msg.id)).toEqual([second.id, first.id]);
    expect((yield* api.listMessages("news", second.id)).map((msg) => msg.id)).toEqual([first.id]);
    expect(fake.requests.at(-1)?.path).toContain("limit=100&before=");
  }),
);

it.effect("starts one thread per parent and lists active and archived threads", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const { fake, api } = yield* setup;
    const parent = fake.addMessage("news", "link", at);
    const thread = yield* api.startThread("news", parent.id, "⏳ title");
    expect(thread.owner_id).toBe("bot");
    expect(fake.requests.at(-1)?.body).toEqual({ name: "⏳ title", auto_archive_duration: 10080 });
    expect((yield* api.listMessages("news"))[0]?.thread?.name).toBe("⏳ title");
    expect((yield* api.listActiveThreads("guild")).map((item) => item.id)).toEqual([parent.id]);
    expect((yield* Effect.flip(api.startThread("news", parent.id, "again"))).kind).toBe(
      "thread-exists",
    );
    const archived = yield* api.modifyThread(thread.id, "title", true);
    expect(archived.thread_metadata.archived).toBe(true);
    expect(fake.requests.at(-1)?.body).toEqual({ name: "title", archived: true });
    expect(yield* api.listActiveThreads("guild")).toEqual([]);
    expect((yield* api.listArchivedThreads("news")).threads.map((item) => item.id)).toEqual([
      thread.id,
    ]);
    expect(fake.requests.at(-1)?.path).toBe("/channels/news/threads/archived/public?limit=100");
    expect((yield* api.listArchivedThreads("news", new Date(at).toISOString())).threads).toEqual(
      [],
    );
  }),
);

it.effect("paginates archived threads by archive timestamp and messages by ID", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const { fake, api } = yield* setup;
    for (let index = 0; index < 101; index++) {
      const message = fake.addMessage("news", `link ${index}`, at + index);
      fake.addThread("news", message.id, `title ${index}`, "bot", true, at + index);
    }
    const first = yield* api.listArchivedThreads("news");
    expect(first.threads).toHaveLength(100);
    expect(first.has_more).toBe(true);
    const last = yield* api.listArchivedThreads(
      "news",
      first.threads.at(-1)?.thread_metadata.archive_timestamp,
    );
    expect(last.threads).toHaveLength(1);
    expect(last.has_more).toBe(false);
    const page = yield* api.listMessages("news");
    expect(page).toHaveLength(100);
    expect(yield* api.listMessages("news", page.at(-1)?.id)).toHaveLength(1);
  }),
);

it.effect("creates safe messages, edits and deletes without duplicating deletion", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const { fake, api } = yield* setup;
    const message = yield* api.createMessage("news", "@everyone https://example.com");
    expect(fake.requests.at(-1)?.body).toEqual({
      content: "@everyone https://example.com",
      flags: 4,
      allowed_mentions: { parse: [] },
    });
    expect((yield* api.editMessage("news", message.id, "updated")).content).toBe("updated");
    expect(fake.requests.at(-1)?.body).toEqual({
      content: "updated",
      flags: 4,
      allowed_mentions: { parse: [] },
    });
    expect((yield* api.listThreadMessages("news"))[0]?.content).toBe("updated");
    yield* api.deleteMessage("news", message.id);
    yield* api.deleteMessage("news", message.id);
    expect(yield* api.listMessages("news")).toEqual([]);
    fake.faults.push({ method: "DELETE", path: "/channels/news/messages/", status: 403 });
    expect((yield* Effect.flip(api.deleteMessage("news", message.id))).kind).toBe("forbidden");
  }),
);

it.effect("classifies authorization, permissions, missing resources and rejected names", () =>
  Effect.gen(function* () {
    const { fake, api } = yield* setup;
    fake.faults.push({ method: "GET", path: "/users/@me", status: 401 });
    expect((yield* Effect.flip(api.currentUser)).kind).toBe("unauthorized");
    fake.faults.push({ method: "GET", path: "/channels/news", status: 403 });
    expect((yield* Effect.flip(api.getChannel("news"))).kind).toBe("forbidden");
    expect((yield* Effect.flip(api.getChannel("missing"))).kind).toBe("not-found");
    fake.faults.push({
      method: "POST",
      path: "/channels/news/messages/p/threads",
      status: 400,
      code: 200000,
    });
    expect((yield* Effect.flip(api.startThread("news", "p", "blocked"))).kind).toBe(
      "name-rejected",
    );
    fake.faults.push({
      method: "POST",
      path: "/channels/news/messages",
      status: 403,
      code: 200000,
    });
    expect((yield* Effect.flip(api.createMessage("news", "blocked content"))).kind).toBe(
      "invalid-response",
    );
    fake.faults.push({
      method: "POST",
      path: "/channels/news/messages/p/threads",
      status: 403,
      code: 200001,
    });
    expect((yield* Effect.flip(api.startThread("news", "p", "blocked"))).kind).toBe(
      "name-rejected",
    );
    fake.faults.push({ method: "GET", path: "/channels/news", status: 500 });
    expect((yield* Effect.flip(api.getChannel("news"))).kind).toBe("outage");
    fake.faults.push({ method: "GET", path: "/channels/news", status: 400 });
    expect((yield* Effect.flip(api.getChannel("news"))).kind).toBe("invalid-response");
    fake.faults.push({ method: "GET", path: "/channels/news", status: 403, body: { code: "bad" } });
    expect((yield* Effect.flip(api.getChannel("news"))).kind).toBe("forbidden");
    fake.faults.push({
      method: "GET",
      path: "/channels/news",
      status: 300,
      body: { id: "news", guild_id: "guild", type: 0 },
    });
    expect((yield* Effect.flip(api.getChannel("news"))).status).toBe(300);
  }),
);

it.effect("never repeats an uncertain POST, but read failures are outages", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const { fake, api } = yield* setup;
    fake.faults.push({ method: "POST", path: "/channels/news/messages", drop: true, after: true });
    const outage = yield* Effect.flip(api.createMessage("news", "one"));
    expect(outage.kind).toBe("outage");
    expect(outage.message).toBe("Discord outage");
    expect((yield* api.listMessages("news")).map((msg) => msg.content)).toEqual(["one"]);
    expect(fake.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    fake.faults.push({ method: "GET", path: "/channels/news", drop: true });
    expect((yield* Effect.flip(api.getChannel("news"))).kind).toBe("outage");
  }),
);

it.effect("leaves a committed thread intact when its create reply is lost", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const { fake, api } = yield* setup;
    const parent = fake.addMessage("news", "a link", at);
    fake.faults.push({
      method: "POST",
      path: `/channels/news/messages/${parent.id}/threads`,
      drop: true,
      after: true,
    });
    expect((yield* Effect.flip(api.startThread("news", parent.id, "⏳ 요약"))).kind).toBe("outage");
    expect(fake.threads.get(parent.id)?.name).toBe("⏳ 요약");
    expect((yield* Effect.flip(api.startThread("news", parent.id, "⏳ 요약"))).kind).toBe(
      "thread-exists",
    );
    expect(fake.requests.filter((request) => request.method === "POST")).toHaveLength(2);
  }),
);

it.effect("follows bucket and global 429 replies then stops at a bounded deadline", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const { fake, api } = yield* setup;
    rateLimit(fake, { "retry-after": "1", "x-ratelimit-global": "true" });
    yield* waitForChannel(api, fake, 1);
    rateLimit(fake, { "retry-after": "31" });
    expect((yield* Effect.flip(api.getChannel("news"))).kind).toBe("outage");
    rateLimit(fake, { "retry-after": "0" });
    expect((yield* Effect.flip(api.getChannel("news"))).status).toBe(429);
    rateLimit(fake, { "retry-after": "Infinity" }, {});
    expect((yield* Effect.flip(api.getChannel("news"))).status).toBe(429);
    rateLimit(fake, { "retry-after": "1" }, {});
    yield* waitForChannel(api, fake, 1);
    rateLimit(fake, {}, { retry_after: 1, global: true });
    yield* waitForChannel(api, fake, 1);
    rateLimit(fake, { "retry-after": "1" });
    yield* waitForChannel(api, fake, 1);
    rateLimit(fake, { "retry-after": "30" });
    const boundary = yield* Effect.forkChild(api.getChannel("news"));
    yield* TestClock.adjust("30 seconds");
    expect((yield* Fiber.join(boundary)).id).toBe("news");
  }),
);

it.effect("shares a bucket across routes within one channel, not across channels", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const { fake, api } = yield* setup;
    fake.addChannel("other");
    for (const [path, call] of [
      ["/channels/news/messages", api.listMessages("news")],
      ["/channels/other", api.getChannel("other")],
    ] as const) {
      fake.faults.push({
        method: "GET",
        path,
        status: 200,
        headers: {
          "x-ratelimit-bucket": "shared",
          "x-ratelimit-remaining": "1",
          "x-ratelimit-reset-after": "1",
        },
      });
      yield* call;
    }
    fake.faults.push({
      method: "GET",
      path: "/channels/news",
      status: 200,
      headers: {
        "x-ratelimit-bucket": "shared",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset-after": "1",
      },
    });
    yield* api.getChannel("news");
    const count = fake.requests.length;
    expect((yield* api.getChannel("other")).id).toBe("other");
    expect(fake.requests).toHaveLength(count + 1);
    const pending = yield* Effect.forkChild(api.listMessages("news"));
    yield* TestClock.adjust("999 millis");
    expect(fake.requests).toHaveLength(count + 1);
    yield* TestClock.adjust("1 millis");
    expect(yield* Fiber.join(pending)).toEqual([]);
    expect(fake.requests).toHaveLength(count + 2);
  }),
);

it.effect("keeps routes without Discord bucket IDs independent", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const { api, fake } = yield* setup;
    yield* api.listMessages("news");
    fake.faults.push({
      method: "GET",
      path: "/channels/news",
      status: 200,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "1" },
    });
    yield* api.getChannel("news");
    const count = fake.requests.length;
    expect(yield* api.listMessages("news")).toEqual([]);
    expect(fake.requests).toHaveLength(count + 1);
    yield* waitForChannel(api, fake, 0);
    fake.faults.push({
      method: "GET",
      path: "/channels/news",
      status: 200,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "Infinity" },
    });
    yield* api.getChannel("news");
    expect((yield* api.getChannel("news")).id).toBe("news");
  }),
);

it.effect("waits on exhausted route buckets and rejects invalid server replies", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const { fake, api } = yield* setup;
    fake.faults.push({
      method: "GET",
      path: "/channels/news",
      status: 200,
      headers: {
        "x-ratelimit-bucket": "bucket",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset-after": "1",
      },
    });
    expect((yield* api.getChannel("news")).id).toBe("news");
    yield* waitForChannel(api, fake, 0);
    fake.faults.push({ method: "GET", path: "/users/@me", status: 204 });
    expect((yield* Effect.flip(api.currentUser)).kind).toBe("invalid-response");
    for (const date of ["bad-date", ""]) {
      fake.faults.push({ method: "GET", path: "/users/@me", status: 200, headers: { date } });
      expect((yield* Effect.flip(api.currentUser)).kind).toBe("invalid-response");
    }
    fake.faults.push({ method: "GET", path: "/users/@me", status: 200, noDate: true });
    expect((yield* Effect.flip(api.currentUser)).kind).toBe("invalid-response");
    fake.faults.push({
      method: "GET",
      path: "/channels/news",
      status: 200,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "31" },
    });
    yield* api.getChannel("news");
    expect((yield* Effect.flip(api.getChannel("news"))).kind).toBe("outage");
    const error: DiscordFailure = yield* Effect.flip(api.getChannel("absent"));
    expect(error.message).toContain("404");
  }),
);

it.effect("provides the reusable Discord service layer", () =>
  Effect.gen(function* () {
    expect(Discord.key).toBe("Discord");
    const fake = new FakeDiscord();
    fake.addChannel("news");
    const channel = yield* Effect.gen(function* () {
      return yield* (yield* Discord).getChannel("news");
    }).pipe(Effect.provide(DiscordLive(Redacted.make("secret")).pipe(Layer.provide(fake.layer))));
    expect(channel.id).toBe("news");
  }),
);
