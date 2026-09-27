import { Effect } from "effect";
import { expect, it } from "./progress-fixture.ts";
import { at, setup } from "./run-fixture.ts";

for (const count of [1, 101])
  it.effect(`rescans ${count} completed Link Posts without per-thread requests`, () =>
    Effect.gen(function* () {
      const { discord, invoke } = yield* setup();
      for (let index = 0; index < count; index++)
        discord.addMessage("10", `https://example.test/${index}`, at - count + index);
      expect(yield* invoke()).toBe(0);
      const messages = structuredClone(discord.messages);
      const threads = structuredClone(discord.threads);
      discord.requests.length = 0;

      expect(yield* invoke()).toBe(0);
      expect(
        discord.requests.filter(
          ({ method, path }) => method === "GET" && threads.has(path.slice("/channels/".length)),
        ),
      ).toHaveLength(0);
      expect(discord.messages).toEqual(messages);
      expect(discord.threads).toEqual(threads);
    }),
  );

it.effect("an omitted thread field is reconciled without repeating a completed Summary", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const source = discord.addMessage("10", "https://example.test/omitted", at - 100);
    expect(yield* invoke()).toBe(0);
    discord.messages.set("10", [source]);
    const summary = structuredClone(discord.messages.get(source.id));
    discord.requests.length = 0;

    expect(yield* invoke()).toBe(0);
    expect(discord.requests.filter(({ path }) => path === `/channels/${source.id}`)).toHaveLength(
      1,
    );
    expect(discord.messages.get(source.id)).toEqual(summary);
  }),
);
