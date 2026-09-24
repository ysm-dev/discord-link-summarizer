import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, PlatformError, Sink, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeServer } from "../src/opencode-server.ts";

const fakeHandle = (
  stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  exitCode = Effect.succeed(ChildProcessSpawner.ExitCode(0)),
  kill: ChildProcessSpawner.ChildProcessHandle["kill"] = () => Effect.void,
) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode,
    isRunning: Effect.succeed(true),
    kill,
    stdin: Sink.drain,
    stdout,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

const fakeLayer = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  OpenCodeServer.layer({ directory: "/workspace", database: "/db", environment: {} }).pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );

it.effect("starts a private child and closes its stdin lifeline at scope release", () =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "summarizer-opencode-"));
    const executable = join(dir, "fake-opencode");
    const output = join(dir, "observed");
    writeFileSync(
      executable,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"url":"http://127.0.0.1:4567"}\'\nprintf \'%s|%s|%s|%s\' "$OPENCODE_DB" "$PWD" "$SHELL" "$OPENCODE_CONFIG_CONTENT" > "$OBSERVED"\ncat >/dev/null\nprintf \'|closed\' >> "$OBSERVED"\n',
    );
    chmodSync(executable, 0o700);
    try {
      const layer = OpenCodeServer.layer({
        directory: dir,
        database: join(dir, "private.db"),
        executable,
        environment: {
          HOME: dir,
          PATH: "/usr/bin:/bin",
          OBSERVED: output,
          OPENCODE_PASSWORD: "inherited",
        },
      });
      const test = Effect.gen(function* () {
        const server = yield* OpenCodeServer;
        expect(server.url).toBe("http://127.0.0.1:4567");
        expect(server.password).not.toBe("inherited");
      });
      yield* test.pipe(Effect.provide(layer.pipe(Layer.provide(BunServices.layer))));
      const observed = readFileSync(output, "utf8");
      expect(observed).toContain(`${join(dir, "private.db")}|${dir}|/bin/zsh|`);
      expect(observed).toContain('"plugins":["-opencode-discord-noti","-opencode-run-server"]');
      expect(observed).toContain("|closed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }),
);

it.effect("rejects non-absolute paths before spawning", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      OpenCodeServer.pipe(
        Effect.provide(
          OpenCodeServer.layer({ directory: "relative", database: "/db", environment: {} }).pipe(
            Layer.provide(BunServices.layer),
          ),
        ),
      ),
    );
    expect(error.reason).toContain("absolute");
  }),
);

it.effect("rejects missing, malformed, and non-private startup announcements", () =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "summarizer-opencode-failure-"));
    const executable = join(dir, "fake-opencode");
    try {
      for (const [announcement, reason] of [
        ["", "without a URL"],
        ["not-json", "Invalid OpenCode server announcement"],
        ['{"url":7}', "Invalid OpenCode server announcement"],
        ['{"url":"not-a-url"}', "Invalid OpenCode server URL"],
        ['{"url":"http://example.com:4567"}', "non-private URL"],
        ['{"url":"https://127.0.0.1:4567"}', "non-private URL"],
        ['{"url":"http://127.0.0.1"}', "non-private URL"],
        ['{"url":"http://user:pass@127.0.0.1:4567"}', "non-private URL"],
        ['{"url":"http://127.0.0.1:4567/path"}', "non-private URL"],
      ]) {
        writeFileSync(
          executable,
          announcement === ""
            ? "#!/bin/sh\nexit 0\n"
            : `#!/bin/sh\nprintf '%s\\n' '${announcement}'\n`,
        );
        chmodSync(executable, 0o700);
        const layer = OpenCodeServer.layer({
          directory: dir,
          database: join(dir, "db"),
          executable,
          environment: {},
        });
        const error = yield* Effect.flip(
          OpenCodeServer.pipe(Effect.provide(layer.pipe(Layer.provide(BunServices.layer)))),
        );
        expect(error.reason).toContain(reason);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }),
);

it.effect("fails visibly when spawning fails or stdout fails", () =>
  Effect.gen(function* () {
    const error = PlatformError.badArgument({ module: "process", method: "spawn" });
    for (const broken of ["spawn", "stdout"]) {
      const spawner = ChildProcessSpawner.make(() =>
        broken === "spawn" ? Effect.fail(error) : Effect.succeed(fakeHandle(Stream.fail(error))),
      );
      const failure = yield* Effect.flip(OpenCodeServer.pipe(Effect.provide(fakeLayer(spawner))));
      expect(failure.reason).toContain(broken === "spawn" ? "Cannot start" : "did not announce");
    }
  }),
);

it.effect("bounds a silent server's startup wait", () =>
  Effect.gen(function* () {
    const spawned = yield* Deferred.make<void>();
    const spawner = ChildProcessSpawner.make(() =>
      Deferred.succeed(spawned, undefined).pipe(Effect.as(fakeHandle(Stream.never))),
    );
    const fiber = yield* Effect.forkChild(
      Effect.flip(OpenCodeServer.pipe(Effect.provide(fakeLayer(spawner)))),
    );
    yield* Deferred.await(spawned);
    yield* TestClock.adjust("21 seconds");
    const failure = yield* Fiber.join(fiber);
    expect(failure.reason).toBe("OpenCode server startup timed out");
  }),
);

it.live("force-kills a child that ignores the stdin lifeline", () =>
  Effect.gen(function* () {
    let killed = false;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        fakeHandle(
          Stream.make(new TextEncoder().encode('{"url":"http://127.0.0.1:4567"}\n')),
          Effect.never,
          (options) =>
            Effect.sync(() => {
              expect(options).toEqual({ forceKillAfter: "2 seconds" });
              killed = true;
            }),
        ),
      ),
    );
    yield* OpenCodeServer.pipe(Effect.provide(fakeLayer(spawner)));
    expect(killed).toBe(true);
  }),
);

it.effect("pins executable flags, isolated environment and password for the private child", () =>
  Effect.gen(function* () {
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        expect(ChildProcess.isStandardCommand(command)).toBe(true);
        if (ChildProcess.isStandardCommand(command)) {
          expect(command.command).toBe("opencode");
          expect(command.args).toEqual([
            "serve",
            "--stdio",
            "--hostname",
            "127.0.0.1",
            "--port",
            "0",
          ]);
          expect(command.options.cwd).toBe("/workspace");
          expect(command.options.env).toMatchObject({
            PWD: "/workspace",
            SHELL: "/bin/zsh",
            OPENCODE_DB: "/db",
            OPENCODE_CONFIG_CONTENT:
              '{"plugins":["-opencode-discord-noti","-opencode-run-server"]}',
          });
          expect(command.options.env?.["OPENCODE_PASSWORD"]).toBe(
            command.options.env?.["OPENCODE_SERVER_PASSWORD"],
          );
          expect(command.options.env?.["OPENCODE_PASSWORD"]).not.toBe("inherited");
          expect(command.options.env?.["OPENCODE_PASSWORD"]).toMatch(/^[a-f0-9-]{36}$/);
          expect(command.options.env?.["PATH"]).toBe(
            "/home/test/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/custom/bin",
          );
          expect(command.options.forceKillAfter).toBe("2 seconds");
          expect(Stream.isStream(command.options.stdin)).toBe(true);
        }
        return fakeHandle(
          Stream.make(new TextEncoder().encode('{"url":"http://127.0.0.1:4567"}\n')),
        );
      }),
    );
    const layer = OpenCodeServer.layer({
      directory: "/workspace",
      database: "/db",
      environment: { HOME: "/home/test", PATH: "/custom/bin", OPENCODE_PASSWORD: "inherited" },
    }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));
    yield* OpenCodeServer.pipe(Effect.provide(layer));
  }),
);

it.effect("requires an absolute database and retains a valid PATH without HOME", () =>
  Effect.gen(function* () {
    const bad = OpenCodeServer.layer({
      directory: "/workspace",
      database: "relative.db",
      environment: {},
    });
    const error = yield* Effect.flip(
      OpenCodeServer.pipe(Effect.provide(bad.pipe(Layer.provide(BunServices.layer)))),
    );
    expect(error.reason).toContain("absolute");
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (ChildProcess.isStandardCommand(command)) {
          expect(command.options.env?.["PATH"]).toBe(
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          );
        }
        return fakeHandle(
          Stream.make(new TextEncoder().encode('{"url":"http://127.0.0.1:4567"}\n')),
        );
      }),
    );
    yield* OpenCodeServer.pipe(Effect.provide(fakeLayer(spawner)));
  }),
);
