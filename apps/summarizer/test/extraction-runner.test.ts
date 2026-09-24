import { expect, it } from "@effect/vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import { Effect, Fiber, Layer, Stream } from "effect";
import type * as PlatformError from "effect/PlatformError";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { runExtraction } from "../src/extraction-runner.ts";

function fakeProcess(output: readonly Uint8Array[], code = 0, stalled = false, broken = false) {
  let command: ChildProcess.Command | undefined;
  let releases = 0;
  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((input) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          command = input;
          return ChildProcessSpawner.makeHandle(
            fromPartial({
              stdout: stalled ? Stream.never : Stream.fromIterable(output),
              exitCode: stalled
                ? Effect.never
                : broken
                  ? Effect.fail(
                      fromPartial<PlatformError.PlatformError>({
                        message: "private URL and stderr",
                      }),
                    )
                  : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
            }),
          );
        }),
        () =>
          Effect.sync(() => {
            releases++;
          }),
      ),
    ),
  );
  return {
    layer,
    get command() {
      return command;
    },
    get releases() {
      return releases;
    },
  };
}

it.effect("passes shell metacharacters as one argv to a detached, scoped Bun process", () =>
  Effect.gen(function* () {
    const fake = fakeProcess([Buffer.from("safe\u0000 output")]);
    const url = "https://example.com/a;$(touch%20x)?a=%60id%60&b=>file";
    const text = yield* runExtraction("page", url, "/trusted/translate").pipe(
      Effect.provide(fake.layer),
    );
    expect(text).toBe("safe output");
    expect(fake.command).toEqual(
      ChildProcess.make(
        "/Users/chris/.bun/bin/bun",
        ["/trusted/translate/scripts/url-to-markdown.ts", url],
        {
          cwd: "/trusted/translate",
          shell: false,
          detached: true,
          stdin: "ignore",
          stderr: "ignore",
          env: { ...process.env, DEBUG_YOUTUBE_SUBTITLES: "" },
          forceKillAfter: "1500 millis",
        },
      ),
    );
    expect(fake.releases).toBe(1);
  }),
);

it.effect("selects only the fixed YouTube script", () =>
  Effect.gen(function* () {
    const fake = fakeProcess([Buffer.from("captions")]);
    const text = yield* runExtraction("youtube", "https://youtu.be/abc", "/trusted/translate").pipe(
      Effect.provide(fake.layer),
    );
    expect(text).toBe("captions");
    expect(fake.command?.["_tag"]).toBe("StandardCommand");
    if (fake.command?.["_tag"] === "StandardCommand")
      expect(fake.command.args).toEqual([
        "/trusted/translate/scripts/youtube-subtitles.ts",
        "https://youtu.be/abc",
      ]);
    expect(fake.releases).toBe(1);
  }),
);

it.effect("accepts the exact byte limit and fails closed above it", () =>
  Effect.gen(function* () {
    const good = fakeProcess([Buffer.alloc(200_000, "a")]);
    const text = yield* runExtraction("page", "https://example.com", "/trusted/translate").pipe(
      Effect.provide(good.layer),
    );
    expect(text).toHaveLength(200_000);
    expect(good.releases).toBe(1);
    const bad = fakeProcess([Buffer.alloc(200_001)]);
    const error = yield* Effect.flip(
      runExtraction("page", "https://example.com", "/trusted/translate").pipe(
        Effect.provide(bad.layer),
      ),
    );
    expect(error.message).toBe("Extraction output exceeded limit");
    expect(error["_tag"]).toBe("ExtractionFailure");
    expect(bad.releases).toBe(1);
  }),
);

it.effect("sanitizes failure text and closes the process scope", () =>
  Effect.gen(function* () {
    const fake = fakeProcess([], 1);
    const error = yield* Effect.flip(
      runExtraction("page", "https://example.com/secret", "/trusted/translate").pipe(
        Effect.provide(fake.layer),
      ),
    );
    expect(error.message).toBe("Extraction failed");
    expect(fake.releases).toBe(1);
    const broken = fakeProcess([], 0, false, true);
    const hidden = yield* Effect.flip(
      runExtraction("page", "https://example.com/secret", "/trusted/translate").pipe(
        Effect.provide(broken.layer),
      ),
    );
    expect(hidden.message).toBe("Extraction failed");
    expect(broken.releases).toBe(1);
  }),
);

it.effect("times out an unresponsive child and finalizes its process group", () =>
  Effect.gen(function* () {
    const fake = fakeProcess([], 0, true);
    const fiber = yield* Effect.forkChild(
      Effect.flip(
        runExtraction("page", "https://example.com", "/trusted/translate").pipe(
          Effect.provide(fake.layer),
        ),
      ),
    );
    yield* TestClock.adjust(180_000);
    const error = yield* Fiber.join(fiber);
    expect(error.message).toBe("Extraction timed out");
    expect(fake.releases).toBe(1);
  }),
);

it.effect("interruption finalizes the process group before returning", () =>
  Effect.gen(function* () {
    const fake = fakeProcess([], 0, true);
    const fiber = yield* Effect.forkChild(
      runExtraction("page", "https://example.com", "/trusted/translate").pipe(
        Effect.provide(fake.layer),
      ),
    );
    yield* Effect.yieldNow;
    expect(fake.command).toBeDefined();
    yield* Fiber.interrupt(fiber);
    expect(fake.releases).toBe(1);
  }),
);
