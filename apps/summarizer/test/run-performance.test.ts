import { expect, it } from "./progress-fixture.ts";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { at, captureLogs, config, seedJournal, setup, waitForFault } from "./run-fixture.ts";
import { readJournal } from "../src/channel-record.ts";
import { workOn } from "../src/run-attempt.ts";
import { decodeConfig } from "../src/config.ts";
import { fakeApi } from "./discord-api-fixture.ts";

for (const parts of [1, 10])
  it.effect(`publishes ${parts} parts with only three thread-history reads`, () =>
    Effect.gen(function* () {
      const text = "x".repeat(2000 * parts);
      const { discord, invoke } = yield* setup({ text });
      const post = discord.addMessage("10", "https://example.test/parts", at - 100);
      expect(yield* invoke()).toBe(0);
      expect(
        discord.messages
          .get(post.id)
          ?.map((message) => message.content)
          .join(""),
      ).toBe(text);
      expect(
        discord.requests.filter(
          (request) =>
            request.method === "GET" && request.path.startsWith(`/channels/${post.id}/messages?`),
        ),
      ).toHaveLength(3);
    }),
  );

for (const firstReplyLost of [false, true])
  it.effect(
    `reconciles repeated identical parts after lost replies (first lost: ${firstReplyLost})`,
    () =>
      Effect.gen(function* () {
        const text = "x".repeat(4000);
        const { discord, invoke } = yield* setup({ text });
        const post = discord.addMessage("10", "https://example.test/repeated", at - 100);
        const path = `/channels/${post.id}/messages`;
        discord.faults.push({ method: "POST", path, status: 200 });
        discord.faults.push({ method: "POST", path, drop: firstReplyLost, after: true });
        discord.faults.push({ method: "POST", path, drop: true, after: true });
        expect(yield* invoke()).toBe(0);
        expect(discord.messages.get(post.id)?.map((message) => message.content)).toEqual([
          "x".repeat(2000),
          "x".repeat(2000),
        ]);
        expect(
          discord.requests.filter((request) => request.method === "POST" && request.path === path),
        ).toHaveLength(3);
      }),
  );

it.effect(
  "keeps completed archive passes across Runs, shares guild discovery, and admits work once catch-up completes",
  () =>
    Effect.gen(function* () {
      const { discord, invoke } = yield* setup(
        {},
        config + '  - id: "11"\n    label: Second\nrun_budget: 10 seconds\n',
      );
      discord.addChannel("11");
      for (let index = 0; index < 101; index++) {
        const source = discord.addMessage("10", "old noise", at - 10 * 86_400_000 + index);
        discord.addThread("10", source.id, "Other thread", "human", true, index);
      }
      const post = discord.addMessage("11", "https://example.test/pending", at - 100);
      discord.faults.push({
        method: "GET",
        path: "/channels/10/threads/archived/public",
        pause: 6000,
      });
      const fiber = yield* Effect.forkChild(invoke());
      yield* waitForFault(discord);
      yield* TestClock.adjust("6 seconds");
      expect(yield* Fiber.join(fiber)).toBe(0);
      expect(discord.threads.has(post.id)).toBe(false);
      expect((yield* readJournal("11"))?.record.archiveComplete).toBe(true);
      expect((yield* readJournal("10"))?.record.archiveBefore).toBeTruthy();
      expect(
        discord.requests.filter((request) => request.path === "/guilds/guild/threads/active"),
      ).toHaveLength(1);
      discord.requests.length = 0;
      expect(yield* invoke()).toBe(0);
      expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
      expect(
        discord.requests.filter((request) =>
          request.path.startsWith("/channels/11/threads/archived/public"),
        ),
      ).toHaveLength(0);
      expect(
        discord.requests.filter((request) =>
          request.path.startsWith("/channels/10/threads/archived/public"),
        ),
      ).toHaveLength(1);
      expect((yield* readJournal("11"))?.record.archiveComplete).toBe(false);
      expect((yield* readJournal("10"))?.record.archiveComplete).toBe(false);
      discord.requests.length = 0;
      expect(yield* invoke()).toBe(0);
      expect(
        discord.requests.filter((request) =>
          request.path.startsWith("/channels/11/threads/archived/public"),
        ),
      ).toHaveLength(1);
      expect((yield* readJournal("10"))?.record.archiveBefore).toBeNull();
      expect((yield* readJournal("10"))?.record.archiveComplete).toBe(false);
    }),
);

it.effect(
  "commits the summary and durable terminal status before waiting for transcript publication",
  () =>
    Effect.gen(function* () {
      const { discord } = yield* setup();
      const post = discord.addMessage("10", "https://example.test/publication", at - 100);
      const journal = yield* seedJournal(discord, post);
      const api = yield* fakeApi(discord);
      const settings = yield* decodeConfig(config, "/home/test");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        workOn(
          api,
          {
            run: () =>
              Effect.succeed({ type: "succeeded", text: "Complete summary", sessionID: "session" }),
          },
          {
            publish: (id) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ type: "published", id } as const),
              ),
          },
          "bot",
          settings,
          journal,
          { id: post.id, channel: settings.channels[0]! },
          "run",
        ),
      );
      yield* Deferred.await(entered);
      expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
      expect(discord.messages.get(post.id)?.map((message) => message.content)).toEqual([
        "Complete summary",
      ]);
      expect((yield* readJournal("10"))?.entries.get(post.id)?.state).toBe("terminal");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
    }),
);

it.effect("retains archive completion when server maintenance consumes the admission budget", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup(
      { slowList: true },
      config + "run_budget: 10 seconds\n",
    );
    const post = discord.addMessage("10", "https://example.test/next-run", at - 100);
    const fiber = yield* Effect.forkChild(invoke());
    yield* TestClock.adjust("12 seconds");
    expect(yield* Fiber.join(fiber)).toBe(0);
    expect(openCode.requests).not.toContain("POST /api/session");
    expect(discord.threads.has(post.id)).toBe(false);
    expect((yield* readJournal("10"))?.record.archiveComplete).toBe(true);
  }),
);

for (const [author, type] of [
  ["human", 0],
  ["bot", 21],
] as const)
  it.effect(
    `an uncertain part is reconciled only against ordinary bot output (${author}/${type})`,
    () =>
      Effect.gen(function* () {
        const { discord } = yield* setup();
        const post = discord.addMessage("10", "https://example.test/ambiguous", at - 100);
        const journal = yield* seedJournal(discord, post);
        const api = yield* fakeApi(discord);
        const path = `/channels/${post.id}/messages`;
        discord.faults.push({ method: "POST", path, status: 200 });
        discord.faults.push({ method: "POST", path, drop: true, after: true });
        const settings = yield* decodeConfig(config, "/home/test");
        yield* workOn(
          {
            ...api,
            createMessage: (thread, content) =>
              api
                .createMessage(thread, content)
                .pipe(
                  Effect.tapError(() =>
                    Effect.sync(() => discord.addMessage(thread, content, at, author, type)),
                  ),
                ),
          },
          {
            run: () =>
              Effect.succeed({ type: "succeeded", text: "Same text", sessionID: "session" }),
          },
          { publish: (id) => Effect.succeed({ type: "published", id }) },
          "bot",
          settings,
          journal,
          { id: post.id, channel: settings.channels[0]! },
          "run",
        );
        expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
        expect(
          discord.messages.get(post.id)?.filter((message) => message.content === "Same text"),
        ).toHaveLength(2);
        expect(
          discord.requests.filter((request) => request.method === "POST" && request.path === path),
        ).toHaveLength(2);
      }),
  );

it.effect(
  "retains knowledge of old bot notes when model text matches one and the part reply is lost",
  () =>
    Effect.gen(function* () {
      const text = "⚠️ 요약 실패 (1/3): original failure";
      const { discord, invoke } = yield* setup({ text });
      const post = discord.addMessage("10", "https://example.test/note-shaped", at - 7_200_000);
      discord.addThread("10", post.id, "⏳ Retry");
      discord.addMessage(post.id, text, at - 3_600_000, "bot");
      const path = `/channels/${post.id}/messages`;
      discord.faults.push({ method: "POST", path, status: 200 });
      discord.faults.push({ method: "POST", path, drop: true, after: true });
      expect(yield* invoke()).toBe(0);
      expect(discord.messages.get(post.id)?.map((message) => message.content)).toEqual([text]);
      expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
    }),
);

it.effect("emits the documented phase labels for one completed Run", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    discord.addMessage("10", "https://example.test/metrics", at - 100);
    const { logs, layer } = captureLogs();
    expect(yield* invoke().pipe(Effect.provide(layer))).toBe(0);
    const phases = logs
      .filter((line) => line.startsWith("performance phase="))
      .map((line) => line.split(" ")[1]!)
      .toSorted((a, b) => a.localeCompare(b));
    expect(phases).toEqual(
      [
        "archive-discovery",
        "discovery",
        "discord-publication",
        "model",
        "transcript-maintenance",
        "transcript-publication",
      ]
        .map((phase) => `phase=${phase}`)
        .toSorted(),
    );
  }),
);
