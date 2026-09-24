import { Data, DateTime, Duration, Effect, Redacted, Schema } from "effect";
import * as Yaml from "effect/unstable/encoding/Yaml";

const nonEmpty = Schema.String.check(Schema.isMinLength(1));
const since = Schema.String.check(
  Schema.makeFilter((value) =>
    value.endsWith("Z") || value.at(-6) === "+" || value.at(-6) === "-"
      ? undefined
      : "since requires an explicit timezone offset",
  ),
).pipe(Schema.decodeTo(Schema.DateTimeUtcFromString));
const duration = Schema.DurationFromString.check(
  Schema.makeFilter((value) =>
    Duration.toMillis(value) > 0 && Number.isFinite(Duration.toMillis(value))
      ? undefined
      : "must be a positive finite duration",
  ),
);
const channelSchema = Schema.Struct({
  id: nonEmpty,
  label: nonEmpty,
  since: Schema.optionalKey(since),
  command: Schema.optionalKey(nonEmpty),
});
const configSchema = Schema.Struct({
  opencode: Schema.Struct({ directory: nonEmpty, agent: nonEmpty }),
  since,
  command: Schema.optionalKey(nonEmpty),
  horizon: Schema.optionalKey(duration),
  concurrency: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  summary_timeout: Schema.optionalKey(duration),
  run_budget: Schema.optionalKey(duration),
  retry_waits: Schema.optionalKey(Schema.Array(duration)),
  delete_sessions: Schema.optionalKey(Schema.Boolean),
  channels: Schema.Array(channelSchema),
});

interface ChannelSettings {
  readonly id: string;
  readonly label: string;
  readonly since: DateTime.Utc;
  readonly command: string;
}

export interface Settings {
  readonly opencode: { readonly directory: string; readonly agent: string };
  readonly since: DateTime.Utc;
  readonly command: string;
  readonly horizon: Duration.Duration;
  readonly concurrency: number;
  readonly summaryTimeout: Duration.Duration;
  readonly runBudget: Duration.Duration;
  readonly retryWaits: readonly Duration.Duration[];
  readonly maxAttempts: number;
  readonly deleteSessions: boolean;
  readonly channels: readonly ChannelSettings[];
}

export interface Environment {
  readonly token: Redacted.Redacted;
  readonly opencodeDb: string;
}

export interface CliOptions {
  readonly configPath: string;
  readonly dryRun: boolean;
}

const environmentSchema = Schema.Struct({ DISCORD_BOT_TOKEN: nonEmpty, OPENCODE_DB: nonEmpty });
export class ConfigError extends Data.TaggedError("ConfigError")<{ readonly message: string }> {}

const expandHome = (path: string, home: string): string =>
  path === "~" ? home : path.startsWith("~/") ? home + path.slice(1) : path;

/** Decodes the whole YAML document before any Run I/O; unknown keys at every depth are errors. */
export const decodeConfig = (text: string, home: string): Effect.Effect<Settings, ConfigError> =>
  Effect.gen(function* () {
    const yaml = yield* Effect.try({
      try: () => Yaml.parse(text),
      catch: () => new ConfigError({ message: "Invalid YAML configuration" }),
    });
    const config = yield* Schema.decodeUnknownEffect(configSchema, { onExcessProperty: "error" })(
      yaml,
    ).pipe(Effect.mapError((error) => new ConfigError({ message: String(error) })));
    if (new Set(config.channels.map((channel) => channel.id)).size !== config.channels.length) {
      return yield* new ConfigError({ message: "Duplicate channel ID" });
    }
    const command = config.command ?? "summarize";
    const retryWaits = config.retry_waits ?? [Duration.minutes(10), Duration.hours(1)];
    return {
      opencode: {
        directory: expandHome(config.opencode.directory, home),
        agent: config.opencode.agent,
      },
      since: config.since,
      command,
      horizon: config.horizon ?? Duration.days(7),
      concurrency: config.concurrency ?? 10,
      summaryTimeout: config.summary_timeout ?? Duration.minutes(10),
      runBudget: config.run_budget ?? Duration.minutes(20),
      retryWaits,
      maxAttempts: retryWaits.length + 1,
      deleteSessions: config.delete_sessions ?? false,
      channels: config.channels.map((channel) => ({
        id: channel.id,
        label: channel.label,
        since: channel.since ?? config.since,
        command: channel.command ?? command,
      })),
    };
  });

/** Accept only the two required environment variables; never expose the token in errors. */
// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: decode process environment before use
export const decodeEnvironment = (input: unknown): Effect.Effect<Environment, ConfigError> =>
  Schema.decodeUnknownEffect(environmentSchema)(input).pipe(
    Effect.mapError(
      () =>
        new ConfigError({
          message: "DISCORD_BOT_TOKEN and OPENCODE_DB must be set to non-empty strings",
        }),
    ),
    Effect.map((env) => ({
      token: Redacted.make(env.DISCORD_BOT_TOKEN),
      opencodeDb: env.OPENCODE_DB,
    })),
  );

/** Options are unambiguous: duplicates, missing values and unknown switches fail closed. */
// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: decode CLI argv before use
export const decodeCli = (input: unknown, home: string): Effect.Effect<CliOptions, ConfigError> =>
  Effect.gen(function* () {
    const args = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(input).pipe(
      Effect.mapError(() => new ConfigError({ message: "Invalid CLI arguments" })),
    );
    let configPath = `${home}/.config/discord-link-summarizer/config.yml`;
    let dryRun = false;
    let hasConfig = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      const value = args[index + 1];
      if (arg === "--dry-run" && !dryRun) dryRun = true;
      else if (arg === "--config" && !hasConfig && value && !value.startsWith("--")) {
        configPath = expandHome(value, home);
        index++;
        hasConfig = true;
      } else return yield* new ConfigError({ message: `Invalid CLI argument: ${arg}` });
    }
    return { configPath, dryRun };
  });
