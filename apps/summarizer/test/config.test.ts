import { expect, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Redacted } from "effect";
import { decodeCli, decodeConfig, decodeEnvironment } from "../src/config.ts";

const minimal = `opencode:
  directory: ~/translate
  agent: summarizer
since: 2026-09-25T00:00:00+09:00
state_channel_id: '999'
channels:
  - id: '123'
    label: Feed
`;

it.effect("decodes defaults, channel overrides, timezone offsets and attempt cap", () =>
  Effect.gen(function* () {
    const defaults = yield* decodeConfig(minimal, "/Users/me");
    expect(defaults.opencode).toEqual({ directory: "/Users/me/translate", agent: "summarizer" });
    expect(defaults.stateChannelId).toBe("999");
    expect(DateTime.toEpochMillis(defaults.since)).toBe(Date.parse("2026-09-24T15:00:00Z"));
    expect(defaults.command).toBe("summarize");
    expect(Duration.toMillis(defaults.horizon)).toBe(7 * 86400000);
    expect(defaults.concurrency).toBe(10);
    expect(Duration.toMillis(defaults.summaryTimeout)).toBe(600000);
    expect(Duration.toMillis(defaults.runBudget)).toBe(1200000);
    expect(defaults.retryWaits.map(Duration.toMillis)).toEqual([600000, 3600000]);
    expect(defaults.maxAttempts).toBe(3);
    expect(defaults.deleteSessions).toBe(false);
    expect(defaults.channels).toEqual([
      { id: "123", label: "Feed", since: defaults.since, command: "summarize" },
    ]);

    const override = yield* decodeConfig(
      minimal
        .replace("~/translate", "/srv/translate")
        .replace(
          "channels:",
          `command: short\nhorizon: 2 days\nconcurrency: 2\nsummary_timeout: 5 minutes\nrun_budget: 1 hour\nretry_waits: []\ndelete_sessions: true\nchannels:`,
        )
        .replace(
          "    label: Feed",
          "    label: Feed\n    since: 2026-09-25T01:00:00Z\n    command: long",
        ),
      "/Users/me",
    );
    expect(override.opencode.directory).toBe("/srv/translate");
    expect(override.command).toBe("short");
    expect(Duration.toMillis(override.horizon)).toBe(172800000);
    expect(override.concurrency).toBe(2);
    expect(Duration.toMillis(override.summaryTimeout)).toBe(300000);
    expect(Duration.toMillis(override.runBudget)).toBe(3600000);
    expect(override.retryWaits).toEqual([]);
    expect(override.maxAttempts).toBe(1);
    expect(override.deleteSessions).toBe(true);
    expect(override.channels[0]?.command).toBe("long");
    expect(DateTime.toEpochMillis(override.channels[0]!.since)).toBe(
      Date.parse("2026-09-25T01:00:00Z"),
    );
  }),
);

it.effect(
  "rejects invalid YAML, unknown keys, missing fields, duplicate IDs, non-positive settings and naive dates",
  () =>
    Effect.gen(function* () {
      for (const text of [
        "opencode: [unterminated",
        minimal.replace("  agent: summarizer", "  agent: summarizer\n  surprise: true"),
        minimal.replace("    label: Feed", "    label: Feed\n    typo: true"),
        minimal + "typo: true\n",
        minimal.replace("  agent: summarizer\n", ""),
        minimal.replace("since: 2026-09-25T00:00:00+09:00", "since: 2026-09-25T00:00:00"),
        minimal.replace("+09:00", "+99:00"),
        minimal.replace("channels:", "horizon: 0 minutes\nchannels:"),
        minimal.replace("channels:", "summary_timeout: -2 minutes\nchannels:"),
        minimal.replace("channels:", "retry_waits: [0 minutes]\nchannels:"),
        minimal.replace("channels:", "concurrency: 0\nchannels:"),
        minimal.replace("channels:", "concurrency: 1.5\nchannels:"),
        minimal.replace("state_channel_id: '999'\n", ""),
        minimal.replace("state_channel_id: '999'", "state_channel_id: '123'"),
        minimal.replace("state_channel_id: '999'", "state_channel_id: 'xyz'"),
        minimal.replace("state_channel_id: '999'", "state_channel_id: 'x999'"),
        minimal.replace("state_channel_id: '999'", "state_channel_id: '999x'"),
        minimal.replace("id: '123'", "id: 'abc'"),
        minimal + "  - id: '123'\n    label: Duplicate\n",
      ]) {
        expect(yield* Effect.exit(decodeConfig(text, "/Users/me"))).toMatchObject({
          _tag: "Failure",
        });
      }
      expect(
        (yield* Effect.flip(decodeConfig(minimal + "  - id: '123'\n    label: Dup\n", "/Users/me")))
          .message,
      ).toContain("Duplicate");
      expect(
        yield* Effect.flip(
          decodeConfig(
            minimal + "  - id: '456'\n    label: Other\n  - id: '123'\n    label: Dup\n",
            "/Users/me",
          ),
        ),
      ).toMatchObject({ _tag: "ConfigError", message: "Duplicate channel ID" });
      for (const text of [
        minimal.replace("state_channel_id: '999'", "state_channel_id: '123'"),
        minimal.replace("state_channel_id: '999'", "state_channel_id: '456'") +
          "  - id: '456'\n    label: Second\n",
      ]) {
        expect(yield* Effect.flip(decodeConfig(text, "/Users/me"))).toMatchObject({
          _tag: "ConfigError",
          message: "State channel must be distinct from Watched Channels",
        });
      }
      expect(
        (yield* Effect.flip(
          decodeConfig(
            minimal.replace("state_channel_id: '999'", "state_channel_id: 'x999'"),
            "/Users/me",
          ),
        )).message,
      ).toContain("decimal Snowflake");
      const multiple = yield* decodeConfig(
        minimal + "  - id: '456'\n    label: Second\n",
        "/Users/me",
      );
      expect(multiple.channels.map((channel) => channel.id)).toEqual(["123", "456"]);
      expect(
        DateTime.toEpochMillis(
          (yield* decodeConfig(minimal.replace("+09:00", "-09:00"), "/Users/me")).since,
        ),
      ).toBe(Date.parse("2026-09-25T09:00:00Z"));
      expect(
        (yield* Effect.flip(decodeConfig(minimal.replace("+09:00", ""), "/Users/me"))).message,
      ).toContain("explicit timezone offset");
      expect(
        (yield* Effect.flip(decodeConfig("opencode: [unterminated", "/Users/me"))).message,
      ).toBe("Invalid YAML configuration");
      expect(
        yield* Effect.flip(
          decodeConfig(minimal.replace("channels:", "HORIZON: true\nchannels:"), "/Users/me"),
        ),
      ).toMatchObject({ _tag: "ConfigError" });
      expect(
        (yield* Effect.flip(decodeConfig(minimal + "typo: true\n", "/Users/me"))).message,
      ).toContain("typo");
      expect(
        (yield* Effect.flip(
          decodeConfig(minimal.replace("channels:", "horizon: 0 minutes\nchannels:"), "/Users/me"),
        )).message,
      ).toContain("positive finite duration");
    }),
);

it.effect("decodes the environment without leaking token in errors or output", () =>
  Effect.gen(function* () {
    const env = yield* decodeEnvironment({ DISCORD_BOT_TOKEN: "sensitive", OPENCODE_DB: "/db" });
    expect(Redacted.value(env.token)).toBe("sensitive");
    expect(JSON.stringify(env.token)).not.toContain("sensitive");
    expect(env.opencodeDb).toBe("/db");
    for (const input of [
      { OPENCODE_DB: "/db" },
      { DISCORD_BOT_TOKEN: "", OPENCODE_DB: "/db" },
      null,
    ]) {
      const failure = yield* Effect.flip(decodeEnvironment(input));
      expect(failure).toMatchObject({
        _tag: "ConfigError",
        message: "DISCORD_BOT_TOKEN and OPENCODE_DB must be set to non-empty strings",
      });
    }
  }),
);

it.effect("decodes strict CLI options and expands home only at the start", () =>
  Effect.gen(function* () {
    expect(yield* decodeCli([], "/home/me")).toEqual({
      configPath: "/home/me/.config/discord-link-summarizer/config.yml",
      dryRun: false,
    });
    expect(yield* decodeCli(["--dry-run", "--config", "~/settings.yml"], "/home/me")).toEqual({
      configPath: "/home/me/settings.yml",
      dryRun: true,
    });
    expect(yield* decodeCli(["--config", "~"], "/home/me")).toEqual({
      configPath: "/home/me",
      dryRun: false,
    });
    expect(yield* decodeCli(["--config", "/tmp/~literal"], "/home/me")).toEqual({
      configPath: "/tmp/~literal",
      dryRun: false,
    });
    for (const args of [
      ["--wat"],
      ["--dry-run", "--dry-run"],
      ["--config"],
      ["--config", ""],
      ["--config", "--dry-run"],
      ["--config", "a", "--config", "b"],
      [4],
    ]) {
      expect(yield* Effect.exit(decodeCli(args, "/home/me"))).toMatchObject({ _tag: "Failure" });
    }
    expect((yield* Effect.flip(decodeCli([4], "/home/me"))).message).toBe("Invalid CLI arguments");
    expect(yield* Effect.flip(decodeCli(["--wat"], "/home/me"))).toMatchObject({
      _tag: "ConfigError",
      message: "Invalid CLI argument: --wat",
    });
    expect(yield* Effect.exit(decodeCli(["other", "a"], "/home/me"))).toMatchObject({
      _tag: "Failure",
    });
  }),
);
