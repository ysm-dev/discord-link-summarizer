import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { ProgressStore } from "../src/progress-store.ts";
import { expect, it } from "./progress-fixture.ts";
import { at, captureLogs, config, setup, waitFor, waitForFault } from "./run-fixture.ts";

for (const phase of ["head", "page"])
  it.effect(`watch stops discovery when the ${phase} response reaches the exact Run budget`, () =>
    Effect.gen(function* () {
      const { discord, invoke, openCode } = yield* setup(
        {},
        config + '  - id: "20"\n    label: Second\nrun_budget: 16 seconds\n',
      );
      const { logs, layer } = captureLogs();
      const fiber = yield* Effect.forkChild(invoke(false, true).pipe(Effect.provide(layer)));
      yield* waitFor(() => logs.some((line) => line.includes("Watching for new Link Posts")));
      const first = discord.addMessage("10", "https://example.test/first", at + 1);
      const second = discord.addMessage("20", "https://example.test/second", at + 2);
      discord.requests.length = 0;
      discord.faults.push({
        method: "GET",
        path:
          phase === "head"
            ? "/channels/10/messages?limit=100"
            : "/channels/10/messages?limit=100&before=",
        pause: 11_000,
      });
      yield* TestClock.adjust("5 seconds");
      yield* waitForFault(discord);
      yield* TestClock.adjust("11 seconds");
      expect(yield* Fiber.join(fiber)).toBe(0);
      expect(discord.threads.size).toBe(0);
      expect(
        discord.requests.filter(({ path }) => path.startsWith("/channels/10/messages?")),
      ).toHaveLength(phase === "head" ? 1 : 2);
      expect(openCode.sessionsCreated).toBe(0);
      expect(discord.requests.some(({ path }) => path.startsWith("/channels/20/messages?"))).toBe(
        false,
      );
      expect(yield* invoke()).toBe(0);
      for (const source of [first, second])
        expect(discord.threads.get(source.id)?.thread_metadata.archived).toBe(true);
    }),
  );

it.effect("watch fails closed if its durable Channel Record disappears", () =>
  Effect.gen(function* () {
    const { invoke, discord } = yield* setup({}, config + "run_budget: 16 seconds\n");
    const store = yield* ProgressStore;
    let lost = false;
    const interrupted = {
      ...store,
      loadJournal: (...args: Parameters<typeof store.loadJournal>) =>
        lost ? Effect.succeed(undefined) : store.loadJournal(...args),
    };
    const { logs, layer } = captureLogs();
    const fiber = yield* Effect.forkChild(
      invoke(false, true).pipe(
        Effect.provideService(ProgressStore, interrupted),
        Effect.provide(layer),
        Effect.result,
      ),
    );
    yield* waitFor(() => logs.some((line) => line.includes("Watching for new Link Posts")));
    lost = true;
    discord.addMessage("10", "https://example.test/lost", at + 1);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "Failure",
      failure: { message: "Missing Channel Record during polling" },
    });
    expect(discord.threads.size).toBe(0);
  }),
);

it.effect("watch exits immediately when no configured channel is readable", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup();
    discord.faults.push({ method: "GET", path: "/channels/10", status: 403 });
    expect(yield* invoke(false, true)).toBe(1);
  }),
);

it.effect("watch uses a failure response's timestamp if its edit timestamp is absent", () =>
  Effect.gen(function* () {
    const { discord, invoke, openCode } = yield* setup(
      { holdTerminal: true, event: "failed", outcome: "failed", errorType: "content" },
      config + "run_budget: 16 seconds\nretry_waits: [12 seconds, 1 hour]\n",
    );
    const source = discord.addMessage("10", "https://example.test/no-edited-at", at - 1);
    const fiber = yield* Effect.forkChild(invoke(false, true));
    yield* waitFor(() => openCode.requests.includes("POST /api/session/ses_one/command"));
    const note = discord.messages.get(source.id)![0]!;
    discord.faults.push({
      method: "PATCH",
      path: `/channels/${source.id}/messages/${note.id}`,
      body: { ...note, edited_timestamp: null },
    });
    openCode.finish();
    yield* waitForFault(discord);
    yield* TestClock.adjust("11999 millis");
    expect(openCode.sessionsCreated).toBe(1);
    yield* TestClock.adjust(1);
    yield* waitFor(
      () =>
        openCode.requests.filter((request) => request === "POST /api/session/ses_one/command")
          .length === 2,
    );
    openCode.finish();
    yield* TestClock.adjust("4 seconds");
    expect(yield* Fiber.join(fiber)).toBe(0);
  }),
);

it.effect("an unresolved thread claim waits for the next poll instead of spinning", () =>
  Effect.gen(function* () {
    const { discord, invoke } = yield* setup({}, config + "run_budget: 6 seconds\n");
    const source = discord.addMessage("10", "https://example.test/claim", at - 1);
    discord.faults.push({
      method: "POST",
      path: `/channels/10/messages/${source.id}/threads`,
      status: 400,
      code: 160004,
    });
    const fiber = yield* Effect.forkChild(invoke(false, true));
    yield* waitForFault(discord);
    yield* TestClock.adjust("4999 millis");
    expect(discord.threads.has(source.id)).toBe(false);
    expect(discord.requests.filter(({ method }) => method === "POST")).toHaveLength(1);
    yield* TestClock.adjust(1);
    yield* waitFor(() => discord.threads.get(source.id)?.thread_metadata.archived === true);
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toBe(0);
  }),
);
