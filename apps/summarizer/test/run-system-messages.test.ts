import { expect, it } from "./progress-fixture.ts";
import { Effect } from "effect";
import { persistReady } from "../src/channel-record.ts";
import { at, seedJournal, setup } from "./run-fixture.ts";
import { fakeApi } from "./discord-api-fixture.ts";

const startedThread = Effect.gen(function* () {
  const fixture = yield* setup();
  const { discord } = fixture;
  const post = discord.addMessage("10", "https://example.test/system-starter", at - 1000);
  const journal = yield* seedJournal(discord, post);
  discord.addThread("10", post.id, "⏳ Working", "bot");
  const starter = { ...discord.addMessage(post.id, "", at - 500, "bot"), type: 21 };
  discord.messages.set(post.id, [starter]);
  discord.faults.push({
    method: "DELETE",
    path: `/channels/${post.id}/messages/${starter.id}`,
    status: 403,
    code: 50021,
  });
  return { ...fixture, post, journal, starter };
});

it.effect(
  "publishes a summary without trying to delete Discord's bot-authored thread starter",
  () =>
    Effect.gen(function* () {
      const { discord, invoke, openCode, post, starter } = yield* startedThread;
      expect(yield* invoke()).toBe(0);
      expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
      expect(discord.messages.get(post.id)?.map((m) => m.content)).toEqual([
        starter.content,
        "안녕하세요",
      ]);
      expect(discord.faults).toHaveLength(1);
      expect(yield* invoke()).toBe(0);
      expect(openCode.requests.filter((r) => r === "POST /api/session")).toHaveLength(1);
      expect(discord.messages.get(post.id)?.filter((m) => m.id === starter.id)).toEqual([starter]);
    }),
);

it.effect(
  "READY recovery preserves system messages and human replies without another model call",
  () =>
    Effect.gen(function* () {
      const { discord, invoke, openCode, post, journal, starter } = yield* startedThread;
      const human = discord.addMessage(post.id, "Keep this reply", at, "human");
      const part = discord.addMessage(post.id, "Verified summary", at + 1, "bot");
      yield* persistReady(yield* fakeApi(discord), "bot", journal, post.id, [part]);
      expect(yield* invoke()).toBe(0);
      expect(discord.messages.get(post.id)?.map((m) => m.id)).toEqual([
        starter.id,
        human.id,
        part.id,
      ]);
      expect(discord.faults).toHaveLength(1);
      expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
      expect(openCode.requests.filter((r) => r === "POST /api/session")).toHaveLength(0);
    }),
);

it.effect("a thread starter alone cannot prove a Done thread contains a summary", () =>
  Effect.gen(function* () {
    const { discord, invoke, post } = yield* startedThread;
    discord.addThread("10", post.id, "Done", "bot", true);
    expect((yield* Effect.flip(invoke())).message).toContain("Unverified terminal Summary Thread");
  }),
);

it.effect("a system message cannot become a READY summary part", () =>
  Effect.gen(function* () {
    const { discord, post, journal, starter } = yield* startedThread;
    const error = yield* Effect.flip(
      persistReady(yield* fakeApi(discord), "bot", journal, post.id, [starter]),
    );
    expect(error.message).toContain("do not match READY manifest");
  }),
);
