import { Context, Deferred, Effect, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { OpenCodeError } from "./opencode-client.ts";

export interface PrivateServerOptions {
  readonly directory: string;
  /** Explicit absolute DB path. Shared paths do not isolate execution ownership. */
  readonly database: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly executable?: string;
}

export class OpenCodeServer extends Context.Service<
  OpenCodeServer,
  {
    readonly url: string;
    readonly password: string;
  }
>()(import.meta.url) {
  static layer(options: PrivateServerOptions) {
    return Layer.effect(
      OpenCodeServer,
      Effect.gen(function* () {
        const Announcement = Schema.Struct({ url: Schema.String });
        if (!options.directory.startsWith("/") || !options.database.startsWith("/")) {
          return yield* new OpenCodeError({
            reason: "OpenCode directory and DB must be absolute paths",
          });
        }
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const closed = yield* Deferred.make<void>();
        const password = yield* Effect.sync(() => crypto.randomUUID());
        const env = {
          ...options.environment,
          PATH: [
            options.environment["HOME"] ? `${options.environment["HOME"]}/.bun/bin` : "",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            options.environment["PATH"] ?? "/usr/bin:/bin",
          ]
            .filter(Boolean)
            .join(":"),
          PWD: options.directory,
          SHELL: "/bin/zsh",
          OPENCODE_DB: options.database,
          OPENCODE_PASSWORD: password,
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            plugins: ["-opencode-discord-noti", "-opencode-run-server"],
          }),
        };
        const stdin = Stream.unwrap(Deferred.await(closed).pipe(Effect.as(Stream.empty)));
        const process = yield* spawner
          .spawn(
            ChildProcess.make(
              options.executable ?? "opencode",
              ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
              {
                cwd: options.directory,
                env,
                stdin,
                stderr: "inherit",
                forceKillAfter: "2 seconds",
              },
            ),
          )
          .pipe(
            Effect.mapError(() => new OpenCodeError({ reason: "Cannot start OpenCode server" })),
          );
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(closed, undefined);
            yield* process.exitCode.pipe(
              Effect.timeoutOrElse({
                duration: "2 seconds",
                orElse: () => process.kill({ forceKillAfter: "2 seconds" }),
              }),
              Effect.ignore,
            );
          }),
        );
        const line = yield* process.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.runHead,
          Effect.mapError(
            () => new OpenCodeError({ reason: "OpenCode server did not announce a URL" }),
          ),
          Effect.timeoutOrElse({
            duration: "20 seconds",
            orElse: () =>
              Effect.fail(new OpenCodeError({ reason: "OpenCode server startup timed out" })),
          }),
        );
        if (Option.isNone(line))
          return yield* new OpenCodeError({ reason: "OpenCode server exited without a URL" });
        const announcement = yield* Schema.decodeEffect(Schema.fromJsonString(Announcement))(
          line.value,
        ).pipe(
          Effect.mapError(
            () => new OpenCodeError({ reason: "Invalid OpenCode server announcement" }),
          ),
        );
        const url = yield* Effect.try({
          try: () => new URL(announcement.url),
          catch: () => new OpenCodeError({ reason: "Invalid OpenCode server URL" }),
        });
        if (
          url.protocol !== "http:" ||
          url.hostname !== "127.0.0.1" ||
          !url.port ||
          url.username ||
          url.password ||
          url.pathname !== "/"
        ) {
          return yield* new OpenCodeError({
            reason: "OpenCode server announced a non-private URL",
          });
        }
        return OpenCodeServer.of({ url: url.origin, password });
      }),
    );
  }
}
