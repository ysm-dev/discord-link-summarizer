import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { at, captureLogs, seedJournal, setup } from "./run-fixture.ts";

it.effect("defers a failed checkpoint cleanup and completes it on the next Run", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    expect(yield* invoke()).toBe(0);
    const parent = (discord.messages.get("20") ?? [])[0]!.id;
    const leftover = discord.addMessage(parent, "DLS1 checkpoint {}", at - 500, "bot");
    discord.faults.push({
      method: "DELETE",
      path: `/channels/${parent}/messages/${leftover.id}`,
      status: 503,
    });
    discord.faults.push({
      method: "DELETE",
      path: `/channels/${parent}/messages/${leftover.id}`,
      status: 503,
    });
    const { logs, layer } = captureLogs();
    const outcome = yield* invoke().pipe(Effect.provide(layer));
    expect(logs.join(" ")).toContain("Journal cleanup deferred: Error: Discord outage (503)");
    expect(logs.filter((message) => message.includes("Journal cleanup deferred"))).toHaveLength(2);
    expect(outcome).toBe(0);
    expect(discord.messages.get(parent)?.some((m) => m.id === leftover.id)).toBe(true);
    expect(yield* invoke()).toBe(0);
    expect(discord.messages.get(parent)?.some((m) => m.id === leftover.id)).toBe(false);
    expect(discord.threads.get(post.id)?.name).toBe("요약");
  }),
);

it.effect("commits a Summary even if post-commit journal pruning fails", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    const post = discord.addMessage("10", "https://example.test/a", at - 1000);
    const journal = yield* seedJournal(discord, post);
    discord.faults.push({
      method: "DELETE",
      path: `/channels/${journal.parent}/messages`,
      status: 503,
    });
    const { logs, layer } = captureLogs();
    expect(yield* invoke().pipe(Effect.provide(layer))).toBe(0);
    expect(logs.join(" ")).toContain("Journal cleanup deferred: Error: Discord outage (503)");
    expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
    expect(
      discord.messages.get(journal.parent)?.some((m) => m.content.startsWith("DLS1 batch")),
    ).toBe(true);
    expect(yield* invoke()).toBe(0);
    expect(
      discord.messages.get(journal.parent)?.some((m) => m.content.startsWith("DLS1 batch")),
    ).toBe(false);
  }),
);
