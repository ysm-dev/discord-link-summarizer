import { expect, it } from "@effect/vitest";
import { BunHttpClient, BunServices } from "@effect/platform-bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Layer } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient } from "effect/unstable/http";
import { decodeCli } from "../src/config.ts";
import { invoke } from "../src/invocation.ts";
import { MachineLockError, withMachineLock } from "../src/machine-lock.ts";
import { FakeDiscord } from "./discord-fake.ts";
import { captureLogs, config, setup } from "./run-fixture.ts";

const skipped: typeof withMachineLock = () => Effect.succeed("already-running");
const unlocked: typeof withMachineLock = (run) => run;
const broken: typeof withMachineLock = () =>
  Effect.fail(new MachineLockError({ message: "lock unavailable" }));

it.effect("rejects invalid invocation before starting a Run", () =>
  Effect.gen(function* () {
    const result = yield* Effect.flip(decodeCli(["--invalid"], "/tmp"));
    expect(result.message).toContain("Invalid CLI argument");
  }),
);

it.effect("rejects bad CLI and environment without filesystem or network access", () =>
  Effect.gen(function* () {
    expect(yield* invoke(["--invalid"], {}, "/tmp")).toBe(1);
    expect(yield* invoke([], {}, "/tmp")).toBe(1);
  }).pipe(Effect.provide([BunServices.layer, BunHttpClient.layer])),
);

it.effect("decodes config before the lock and reports contention and lock errors", () =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "summarizer-invoke-"));
    const file = join(dir, "config.yml");
    const env = { DISCORD_BOT_TOKEN: "secret", OPENCODE_DB: "/db" };
    try {
      writeFileSync(file, "invalid: config\n");
      expect(
        yield* invoke(["--config", file], env, dir, () => Effect.succeed("already-running")),
      ).toBe(1);
      writeFileSync(
        file,
        "opencode:\n  directory: /workspace\n  agent: summarizer\nsince: 2026-09-01T00:00:00Z\nchannels: []\n",
      );
      expect(yield* invoke(["--config", file], env, dir, skipped)).toBe(0);
      const { logs, layer } = captureLogs();
      expect(yield* invoke(["--config", file], env, dir, skipped).pipe(Effect.provide(layer))).toBe(
        0,
      );
      expect(logs.join(" ")).toContain("Another Run holds the machine lock; skipping tick");
      expect(
        yield* invoke(["--config", file], env, dir, (_run, path) =>
          Effect.sync(() => {
            expect(path).toBe(join(dir, ".local/state/discord-link-summarizer/run.lock"));
            return "already-running" as const;
          }),
        ),
      ).toBe(0);
      expect(yield* invoke(["--config", file], env, dir, broken)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide([BunServices.layer, BunHttpClient.layer])),
);

it.effect(
  "passes defined invocation environment to the private server and returns skipped-channel status",
  () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "summarizer-environment-"));
      const file = join(dir, "config.yml");
      const { discord, services, getEnvironment } = yield* setup();
      const { logs, layer } = captureLogs();
      discord.faults.push({ method: "GET", path: "/channels/10", status: 403 });
      try {
        writeFileSync(file, config);
        const env = {
          DISCORD_BOT_TOKEN: "secret",
          OPENCODE_DB: "/db",
          CUSTOM: "kept",
          OMIT: undefined,
        };
        expect(
          yield* invoke(["--config", file], env, dir, unlocked).pipe(
            Effect.provide(Layer.merge(services, layer)),
          ),
        ).toBe(1);
        expect(logs.join(" ")).not.toContain("Another Run holds the machine lock");
        expect(getEnvironment()["CUSTOM"]).toBe("kept");
        expect("OMIT" in getEnvironment()).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(BunServices.layer)),
);

it.effect("returns the Run's successful exit code through an acquired lock", () =>
  Effect.gen(function* () {
    const dir = mkdtempSync(join(tmpdir(), "summarizer-run-invoke-"));
    const file = join(dir, "config.yml");
    const discord = new FakeDiscord();
    const at = Date.parse("2026-09-25T12:00:00Z");
    yield* TestClock.setTime(at);
    const http = HttpClient.make((request, url) =>
      discord.client
        .execute(request)
        .pipe(
          Effect.tap(() =>
            url.pathname === "/api/v10/users/@me" ? TestClock.adjust("2 millis") : Effect.void,
          ),
        ),
    );
    try {
      writeFileSync(
        file,
        "opencode:\n  directory: /workspace\n  agent: summarizer\nsince: 2026-09-01T00:00:00Z\nrun_budget: 1 millis\nchannels: []\n",
      );
      expect(
        yield* invoke(
          ["--config", file],
          { DISCORD_BOT_TOKEN: "secret", OPENCODE_DB: "/db" },
          dir,
          unlocked,
        ).pipe(Effect.provide(Layer.succeed(HttpClient.HttpClient, http))),
      ).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(BunServices.layer)),
);
