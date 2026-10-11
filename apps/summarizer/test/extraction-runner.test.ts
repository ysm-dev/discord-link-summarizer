import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import { runExtraction } from "../src/extraction-runner.ts";

const spawned = vi.hoisted(() => ({
  calls: [] as { command: string; args: readonly string[]; options: SpawnOptions }[],
  child: undefined as object | undefined,
  throws: false,
}));
vi.mock("node:child_process", () => ({
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => {
    spawned.calls.push({ command, args, options });
    if (spawned.throws) throw new Error("spawn EINVAL /private/path");
    return spawned.child;
  },
}));

const PID = 4242;

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  constructor(readonly pid: number | undefined) {
    super();
  }
}

/** Fakes the detached process group: members leave on the signals they do not ignore. */
function processGroup(survives: ReadonlyArray<string> = []) {
  const group = { alive: true };
  const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target !== -PID || !group.alive) throw new Error("kill ESRCH");
    if (signal !== 0 && !survives.includes(String(signal))) group.alive = false;
    return true;
  });
  const signals = () => kill.mock.calls.filter(([, signal]) => signal !== 0);
  /** The group left on its first SIGTERM, which one probe confirmed. */
  const expectSigtermExit = () => {
    expect(group.alive).toBe(false);
    expect(kill.mock.calls).toEqual([
      [-PID, "SIGTERM"],
      [-PID, 0],
    ]);
  };
  return { group, kill, signals, expectSigtermExit };
}

const start = (
  kind: "page" | "youtube" = "page",
  url = "https://example.com/a",
  child = new FakeChild(PID),
) =>
  Effect.gen(function* () {
    spawned.child = child;
    const fiber = yield* Effect.forkChild(runExtraction(kind, url, "/trusted/translate"));
    while (child.listenerCount("close") === 0) yield* Effect.yieldNow;
    return { child, fiber };
  });

const exit = (child: FakeChild, group: { alive: boolean }, ...chunks: Buffer[]) => {
  for (const chunk of chunks) child.stdout.emit("data", chunk);
  group.alive = false;
  child.emit("close", 0, null);
};

afterEach(() => {
  vi.restoreAllMocks();
  spawned.calls.length = 0;
  spawned.throws = false;
});

it.effect("passes shell metacharacters as one argv to a detached Bun process group", () =>
  Effect.gen(function* () {
    const { group, kill } = processGroup();
    const url = "https://example.com/a;$(touch%20x)?a=%60id%60&b=>file";
    const { child, fiber } = yield* start("page", url);
    exit(child, group, Buffer.from("safe\u0000 out\u007fput\ttab\r\n"));
    expect(yield* Fiber.join(fiber)).toBe("safe output\ttab\n");
    expect(spawned.calls).toEqual([
      {
        command: "/Users/chris/.bun/bin/bun",
        args: ["/trusted/translate/scripts/url-to-markdown.ts", url],
        options: {
          cwd: "/trusted/translate",
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, DEBUG_YOUTUBE_SUBTITLES: "" },
        },
      },
    ]);
    expect(kill.mock.calls).toEqual([[-PID, "SIGTERM"]]);
  }),
);

it.effect("selects only the fixed YouTube script", () =>
  Effect.gen(function* () {
    const { group } = processGroup();
    const { child, fiber } = yield* start("youtube", "https://youtu.be/abc");
    exit(child, group, Buffer.from("captions"));
    expect(yield* Fiber.join(fiber)).toBe("captions");
    expect(spawned.calls[0]?.args).toEqual([
      "/trusted/translate/scripts/youtube-subtitles.ts",
      "https://youtu.be/abc",
    ]);
  }),
);

it.effect("returns large multi-chunk output intact for OpenCode's configured limits", () =>
  Effect.gen(function* () {
    const { group } = processGroup();
    const expected = "자막 captions\n".repeat(20_000);
    const bytes = Buffer.from(expected);
    for (const kind of ["page", "youtube"] as const) {
      group.alive = true;
      const { child, fiber } = yield* start(kind);
      exit(child, group, bytes.subarray(0, 200_001), bytes.subarray(200_001));
      expect(yield* Fiber.join(fiber)).toBe(expected);
    }
  }),
);

it.effect("terminates group members the script leaves behind", () =>
  Effect.gen(function* () {
    const { expectSigtermExit } = processGroup();
    const { child, fiber } = yield* start();
    child.stdout.emit("data", Buffer.from("text"));
    child.emit("close", 0, null);
    expect(yield* Fiber.join(fiber)).toBe("text");
    expectSigtermExit();
  }),
);

it.effect("reports every process failure without its details", () =>
  Effect.gen(function* () {
    const { group } = processGroup();
    for (const fail of [
      (child: FakeChild) => child.emit("close", 1, null),
      (child: FakeChild) => child.emit("close", null, "SIGKILL"),
      (child: FakeChild) => child.stdout.emit("error", new Error("private stderr")),
      (child: FakeChild) => child.emit("error", new Error("spawn ENOENT /private/path")),
    ]) {
      group.alive = true;
      const { child, fiber } = yield* start();
      child.stdout.emit("data", Buffer.from("partial"));
      group.alive = false;
      fail(child);
      const error = yield* Effect.flip(Fiber.join(fiber));
      expect(error.message).toBe("Extraction failed");
      expect(error["_tag"]).toBe("ExtractionFailure");
    }
  }),
);

it.effect("signals nothing when the process never started", () =>
  Effect.gen(function* () {
    const { kill } = processGroup();
    const { child, fiber } = yield* start(
      "page",
      "https://example.com/a",
      new FakeChild(undefined),
    );
    child.emit("error", new Error("spawn ENOENT"));
    child.emit("close", -2, null);
    expect((yield* Effect.flip(Fiber.join(fiber))).message).toBe("Extraction failed");
    spawned.throws = true;
    const thrown = yield* Effect.flip(runExtraction("page", "https://e.com", "/trusted/translate"));
    expect(thrown.message).toBe("Extraction failed");
    expect(kill).not.toHaveBeenCalled();
  }),
);

it.effect("times out an unresponsive child and terminates its process group", () =>
  Effect.gen(function* () {
    const { kill, expectSigtermExit } = processGroup();
    const { fiber } = yield* start();
    yield* TestClock.adjust(179_999);
    expect(kill).not.toHaveBeenCalled();
    yield* TestClock.adjust(1);
    expect((yield* Effect.flip(Fiber.join(fiber))).message).toBe("Extraction timed out");
    expectSigtermExit();
  }),
);

it.effect("interruption terminates the process group before returning", () =>
  Effect.gen(function* () {
    const { expectSigtermExit } = processGroup();
    const { fiber } = yield* start();
    yield* Fiber.interrupt(fiber);
    expectSigtermExit();
  }),
);

it.effect("escalates to SIGKILL after 1.5 seconds when the group ignores SIGTERM", () =>
  Effect.gen(function* () {
    const { group, kill, signals } = processGroup(["SIGTERM"]);
    const { fiber } = yield* start();
    const interrupted = yield* Effect.forkChild(Fiber.interrupt(fiber));
    while (signals().length === 0) yield* Effect.yieldNow;
    yield* TestClock.adjust(1_499);
    expect(signals()).toEqual([[-PID, "SIGTERM"]]);
    yield* TestClock.adjust(1);
    yield* Fiber.join(interrupted);
    expect(signals()).toEqual([
      [-PID, "SIGTERM"],
      [-PID, "SIGKILL"],
    ]);
    expect(kill.mock.calls.at(-1)).toEqual([-PID, 0]);
    expect(group.alive).toBe(false);
  }),
);

it.effect("stops waiting one second after SIGKILL even if the group never exits", () =>
  Effect.gen(function* () {
    const { group, signals } = processGroup(["SIGTERM", "SIGKILL"]);
    const { fiber } = yield* start();
    let finished = false;
    const interrupted = yield* Effect.forkChild(
      Fiber.interrupt(fiber).pipe(Effect.ensuring(Effect.sync(() => (finished = true)))),
    );
    while (signals().length === 0) yield* Effect.yieldNow;
    yield* TestClock.adjust(1_500);
    expect(signals()).toEqual([
      [-PID, "SIGTERM"],
      [-PID, "SIGKILL"],
    ]);
    yield* TestClock.adjust(999);
    expect(finished).toBe(false);
    yield* TestClock.adjust(1);
    yield* Fiber.join(interrupted);
    expect(finished).toBe(true);
    expect(group.alive).toBe(true);
  }),
);
