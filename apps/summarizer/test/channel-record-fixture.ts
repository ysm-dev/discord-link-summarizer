import { DateTime, Duration, Effect, Redacted } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { makeDiscord, type DiscordApi } from "../src/discord-client.ts";
import {
  journalPage,
  journalStatus,
  openChannelRecord,
  type Journal,
} from "../src/channel-record.ts";
import { beginScan, scanPages, settleRecord } from "../src/channel-discovery.ts";
import { FakeDiscord } from "./discord-fake.ts";

export const now = Date.parse("2026-09-25T12:00:00Z");
export const since = DateTime.makeUnsafe(now - 10 * 86400000);
export const horizon = Duration.days(7);
export const prepare = Effect.gen(function* () {
  yield* TestClock.setTime(now);
  const fake = new FakeDiscord();
  fake.addChannel("10");
  fake.addChannel("20");
  const api = yield* makeDiscord(Redacted.make("secret")).pipe(Effect.provide(fake.layer));
  return { fake, api };
});
export const open = (api: DiscordApi) =>
  openChannelRecord(api, "20", "10", since, horizon, "bot", false);
export const journaledLink = (fake: FakeDiscord, api: DiscordApi, at: number) =>
  Effect.gen(function* () {
    const source = fake.addMessage("10", "https://one.test", at);
    const journal: Journal = yield* journalPage(api, "bot", (yield* open(api)).journal!, "manual", [
      source.id,
    ]);
    return { source, journal };
  });
export const removeEntriesContaining = (fake: FakeDiscord, thread: string, fragment: string) => {
  fake.messages.set(
    thread,
    (fake.messages.get(thread) ?? []).filter((m) => !m.content.includes(fragment)),
  );
};
export const hundredLinks = (fake: FakeDiscord) =>
  Array.from(
    { length: 100 },
    (_, index) => fake.addMessage("10", `https://example.test/${index}`, now - 1000 + index).id,
  );
export const twoLinks = (fake: FakeDiscord) => [
  fake.addMessage("10", "https://one.test", now - 100),
  fake.addMessage("10", "https://two.test", now - 50),
];
export const loseJournalReply = (fake: FakeDiscord, thread: string, after: boolean) => {
  fake.faults.push({ method: "POST", path: `/channels/${thread}/messages`, drop: true, after });
};
export const settledDone = Effect.gen(function* () {
  const { fake, api } = yield* prepare;
  const post = fake.addMessage("10", "https://one.test", now - 100);
  fake.addThread("10", post.id, "Done", "bot", true);
  let journal: Journal = yield* scanPages(
    api,
    "20",
    "bot",
    yield* beginScan(api, "20", (yield* open(api)).journal!),
    1,
  );
  journal = yield* journalStatus(api, "20", "bot", journal, { id: post.id, state: "terminal" });
  journal = yield* settleRecord(api, "20", journal);
  return { fake, api, post, journal };
});
