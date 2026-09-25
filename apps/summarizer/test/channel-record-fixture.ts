import { DateTime, Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import {
  journalPage,
  journalStatus,
  openChannelRecord,
  settleRecord,
} from "../src/channel-record.ts";
import { beginScan, scanPages } from "../src/channel-discovery.ts";
import { FakeDiscord } from "./discord-fake.ts";
import { fakeApi } from "./discord-api-fixture.ts";

export const now = Date.parse("2026-09-25T12:00:00Z");
export const since = DateTime.makeUnsafe(now - 10 * 86400000);
export const horizon = Duration.days(7);
export const prepare = Effect.gen(function* () {
  yield* TestClock.setTime(now);
  const fake = new FakeDiscord();
  fake.addChannel("10");
  fake.addChannel("20");
  return { fake, api: yield* fakeApi(fake) };
});
export const open = () => openChannelRecord("10", since, horizon);
export const journaledLink = (fake: FakeDiscord, at: number) =>
  Effect.gen(function* () {
    const source = fake.addMessage("10", "https://one.test", at);
    const journal = yield* journalPage(yield* open(), [source.id]);
    return { source, journal };
  });
export const settledDone = Effect.gen(function* () {
  const { fake, api } = yield* prepare;
  const post = fake.addMessage("10", "https://one.test", now - 100);
  fake.addThread("10", post.id, "Done", "bot", true);
  let journal = yield* scanPages(api, "bot", yield* beginScan(api, yield* open()), 1);
  journal = yield* journalStatus(journal, { id: post.id, state: "terminal" });
  journal = yield* settleRecord(journal);
  return { fake, api, post, journal };
});
