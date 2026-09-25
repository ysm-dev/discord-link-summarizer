import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { openChannelRecord, type Journal } from "../src/channel-record.ts";
import { decodeConfig, type Settings } from "../src/config.ts";
import { DiscordFailure, type DiscordApi } from "../src/discord-client.ts";
import { OpenCodeError, type OpenCodeResult } from "../src/opencode-client.ts";
import { workOn } from "../src/run-attempt.ts";
import { fakeApi } from "./discord-api-fixture.ts";
import { at, config, seedJournal, setup, stalledWork } from "./run-fixture.ts";

const perform = (
  api: DiscordApi,
  settings: Settings,
  journal: Journal,
  id: string,
  outcome: Effect.Effect<OpenCodeResult, OpenCodeError>,
) =>
  workOn(
    api,
    { run: () => outcome },
    { publish: () => Effect.succeed({ type: "published" as const, id: "ses_one" }) },
    "20",
    "bot",
    settings,
    journal,
    { id, channel: settings.channels[0]! },
    "run",
  );

it.effect("never adopts a foreign-owned Summary Thread", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    discord.addThread("10", post.id, "⏳ Discussion", "human");
    expect(yield* invoke()).toBe(0);
    expect(discord.threads.get(post.id)?.name).toBe("⏳ Discussion");
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(0);
    const api = yield* fakeApi(discord);
    const settings = yield* decodeConfig(config, "/home/test");
    const journal = (yield* openChannelRecord(
      api,
      "20",
      "10",
      settings.since,
      settings.horizon,
      "bot",
      true,
    )).journal!;
    expect(BigInt(journal.record.floor)).toBeGreaterThanOrEqual(BigInt(post.id));
  }),
);

for (const [state, missing] of [
  ["done", "name"],
  ["done", "thread_metadata"],
  ["given-up", "name"],
  ["given-up", "thread_metadata"],
] as const)
  it.effect(`rejects a ${state} thread whose ${missing} is missing from readback`, () =>
    Effect.gen(function* () {
      const { discord } = yield* setup();
      const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
      discord.addThread("10", post.id, state === "done" ? "Title" : "⚠️ Title", "bot", true);
      const journal = yield* seedJournal(discord, post);
      discord.addMessage(
        post.id,
        state === "done" ? "Summary" : "⚠️ 요약 실패 (3/3): 실패",
        at,
        "bot",
      );
      const base = yield* fakeApi(discord);
      const api = {
        ...base,
        getChannel: (id: string) =>
          base
            .getChannel(id)
            .pipe(
              Effect.map((thread) =>
                id === post.id ? { ...thread, [missing]: undefined } : thread,
              ),
            ),
      };
      const settings = yield* decodeConfig(config, "/home/test");
      expect((yield* Effect.flip(stalledWork(api, settings, journal, post.id))).message).toContain(
        "Invalid Summary Thread",
      );
    }),
  );

it.effect("does not reconcile a lost note reply against an unrelated bot message", () =>
  Effect.gen(function* () {
    const { discord } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    const journal = yield* seedJournal(discord, post);
    const base = yield* fakeApi(discord);
    const api = {
      ...base,
      createMessage: (channel: string, content: string) =>
        channel === post.id
          ? Effect.sync(() => discord.addMessage(channel, "unrelated bot reply", at, "bot")).pipe(
              Effect.flatMap(() => Effect.fail(new DiscordFailure("outage", 503))),
            )
          : base.createMessage(channel, content),
    };
    const settings = yield* decodeConfig(config, "/home/test");
    const result = perform(
      api,
      settings,
      journal,
      post.id,
      Effect.fail(new OpenCodeError({ reason: "should not run" })),
    );
    expect(yield* Effect.flip(result)).toMatchObject({ kind: "outage" });
    expect(discord.messages.get(post.id)?.map((message) => message.content)).toEqual([
      "unrelated bot reply",
    ]);
  }),
);

it.effect("propagates a forbidden source read during terminal verification", () =>
  Effect.gen(function* () {
    const { discord } = yield* setup();
    const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
    discord.addThread("10", post.id, "Title", "bot", true);
    discord.addMessage(post.id, "Summary", at, "bot");
    const journal = yield* seedJournal(discord, post);
    const linked = discord.messages.get("10")!.find((message) => message.id === post.id)!;
    discord.faults.push({ method: "GET", path: `/channels/10/messages/${post.id}`, body: linked });
    discord.faults.push({ method: "GET", path: `/channels/10/messages/${post.id}`, status: 403 });
    const api = yield* fakeApi(discord);
    const settings = yield* decodeConfig(config, "/home/test");
    expect(yield* Effect.flip(stalledWork(api, settings, journal, post.id))).toMatchObject({
      kind: "forbidden",
    });
  }),
);

it.effect("a lost rename reply requires the expected archived thread and title", () =>
  Effect.gen(function* () {
    for (const [changed, rejectPrimary] of [
      [{ thread_metadata: { archived: false } }, false],
      [{ name: "Other" }, false],
      [{ name: "요약" }, false],
      [{ thread_metadata: undefined }, false],
      [{ name: "Other" }, true],
    ] as const) {
      const { discord } = yield* setup();
      const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
      discord.addThread("10", post.id, "⏳ Title", "bot");
      const journal = yield* seedJournal(discord, post);
      const base = yield* fakeApi(discord);
      let renamed = false;
      const api = {
        ...base,
        modifyThread: (id: string, name: string, archived: boolean) =>
          rejectPrimary && name === "Title"
            ? Effect.fail(new DiscordFailure("name-rejected", 400))
            : base.modifyThread(id, name, archived).pipe(
                Effect.flatMap(() => {
                  renamed = true;
                  return Effect.fail(new DiscordFailure("outage", 503));
                }),
              ),
        getChannel: (id: string) =>
          base
            .getChannel(id)
            .pipe(
              Effect.map((thread) =>
                id === post.id && renamed ? { ...thread, ...changed } : thread,
              ),
            ),
      };
      const settings = yield* decodeConfig(config, "/home/test");
      const result = perform(
        api,
        settings,
        journal,
        post.id,
        Effect.succeed({ type: "succeeded", text: "Summary", sessionID: "ses_one" }),
      );
      expect(yield* Effect.flip(result)).toMatchObject({ kind: "outage" });
      expect(renamed).toBe(true);
    }
  }),
);
