import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { at, seedJournal, setup } from "./run-fixture.ts";

const seededThread = (name: string, archived = false) =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const post = discord.addMessage("10", "Title https://example.test/a", at - 1000);
    yield* seedJournal(discord, post);
    const thread = discord.addThread("10", post.id, name, "bot", archived);
    return { discord, invoke, post, thread };
  });

for (const givenUp of [false, true])
  it.effect(
    `rechecks ${givenUp ? "Given-up" : "Done"} ownership and commit state after admission`,
    () =>
      Effect.gen(function* () {
        for (const invalid of [
          { parent_id: "11" },
          { owner_id: "human" },
          { thread_metadata: { archived: false } },
          { thread_metadata: undefined },
          { name: undefined },
          { name: givenUp ? "Title" : "⏳ Title" },
          { name: givenUp ? "Title" : "⚠️ Title" },
        ]) {
          const { discord, invoke, post, thread } = yield* seededThread(
            givenUp ? "⚠️ Title" : "Title",
            true,
          );
          discord.addMessage(post.id, givenUp ? "⚠️ 요약 실패 (3/3): 실패" : "Summary", at, "bot");
          for (const body of [thread, thread, { ...thread, ...invalid }])
            discord.faults.push({
              method: "GET",
              path: `/channels/${post.id}`,
              status: 200,
              body: { ...body, type: 11 },
            });
          expect((yield* Effect.flip(invoke())).message).toContain(
            givenUp ? "Unverified Given-up" : "Unverified terminal",
          );
          expect(discord.threads.get(post.id)?.name).toBe(givenUp ? "⚠️ Title" : "Title");
        }
      }),
  );

it.effect("a committed title with warning glyphs at the end is still Done", () =>
  Effect.gen(function* () {
    for (const suffix of ["⏳ ", "⚠️ "]) {
      const { discord, invoke, post, thread } = yield* seededThread("Title", true);
      discord.addMessage(post.id, "Summary", at, "bot");
      for (const body of [thread, thread, { ...thread, name: `Title ${suffix}` }])
        discord.faults.push({
          method: "GET",
          path: `/channels/${post.id}`,
          status: 200,
          body: { ...body, type: 11 },
        });
      expect(yield* invoke()).toBe(0);
      expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
    }
  }),
);

it.effect("a substituted or unreadable Summary Thread fails fresh admission", () =>
  Effect.gen(function* () {
    for (const forbidden of [false, true]) {
      const { discord, invoke, post, thread } = yield* seededThread("⏳ Title");
      discord.faults.push({
        method: "GET",
        path: `/channels/${post.id}`,
        status: 200,
        body: { ...thread, type: 11 },
      });
      discord.faults.push(
        forbidden
          ? { method: "GET", path: `/channels/${post.id}`, status: 403 }
          : {
              method: "GET",
              path: `/channels/${post.id}`,
              status: 200,
              body: { ...thread, type: 0 },
            },
      );
      const failure = yield* Effect.flip(invoke());
      if (forbidden) {
        expect(failure).toMatchObject({ kind: "forbidden" });
        expect(discord.messages.get(post.id)).toBeUndefined();
      } else expect(failure.message).toContain("Invalid Summary Thread");
    }
  }),
);
