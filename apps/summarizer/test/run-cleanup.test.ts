import { expect, it } from "./progress-fixture.ts";
import { Effect } from "effect";
import { ProgressStore } from "../src/progress-store.ts";
import { readJournal } from "../src/channel-record.ts";
import { at, setup } from "./run-fixture.ts";

it.effect("a failed local post-commit write recovers without another model call", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    const store = yield* ProgressStore;
    const failing = {
      ...store,
      change: (channel: string, f: (stored: string | undefined) => string) =>
        store.change(channel, (stored) => {
          const next = f(stored);
          if (discord.threads.get(post.id)?.thread_metadata.archived) throw new Error("disk full");
          return next;
        }),
    };
    expect(
      (yield* Effect.flip(invoke().pipe(Effect.provideService(ProgressStore, failing)))).message,
    ).toContain("disk full");
    expect((yield* readJournal("10"))?.entries.get(post.id)?.state).toBe("ready");
    expect(yield* invoke()).toBe(0);
    expect((yield* readJournal("10"))?.entries.size).toBe(0);
    expect(openCode.requests.filter((request) => request === "POST /api/session")).toHaveLength(1);
    expect(discord.messages.get(post.id)?.filter((m) => m.content === "안녕하세요")).toHaveLength(
      1,
    );
  }),
);

it.effect("corrupt local progress aborts before Discord writes or OpenCode startup", () =>
  Effect.gen(function* () {
    const { discord, invoke, getStarted } = yield* setup();
    discord.addMessage("10", "https://example.test/a", at - 1000);
    const store = yield* ProgressStore;
    yield* store.change("10", () => "broken");
    expect(yield* Effect.exit(invoke())).toMatchObject({ _tag: "Failure" });
    expect(discord.requests.every((r) => r.method === "GET")).toBe(true);
    expect(getStarted()).toBe(0);
  }),
);
