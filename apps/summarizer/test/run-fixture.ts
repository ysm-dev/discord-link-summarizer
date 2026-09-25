import { Service } from "@opencode/client/service";
import { Effect, Layer, Logger, Redacted, Sink, Stream } from "effect";
import { TestClock } from "effect/testing";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { decodeConfig, type Settings } from "../src/config.ts";
import { journalPage, openChannelRecord, type Journal } from "../src/channel-record.ts";
import type { DiscordApi } from "../src/discord-client.ts";
import { workOn } from "../src/run-attempt.ts";
import { run } from "../src/run.ts";
import { fakeApi } from "./discord-api-fixture.ts";
import { FakeDiscord } from "./discord-fake.ts";
import { fakeOpenCode } from "./opencode-fake.ts";

export const config = `
opencode:
  directory: /workspace
  agent: summarizer
state_channel_id: "20"
since: 2026-09-01T00:00:00Z
delete_sessions: true
channels:
  - id: "10"
    label: News
`;
export const at = Date.parse("2026-09-25T12:00:00Z");
export const sinceDaysAgo = (days: number) =>
  config.replace("2026-09-01T00:00:00Z", new Date(at - days * 86_400_000).toISOString());

export const setup = (
  options: Parameters<typeof fakeOpenCode>[0] = {},
  yaml = config,
  discoverService: typeof Service.discover = Service.discover,
  targetHttp?: HttpClient.HttpClient,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(at);
    const discord = new FakeDiscord();
    discord.addChannel("10");
    discord.addChannel("20");
    const openCode = fakeOpenCode({ acceptPrivatePassword: true, ...options });
    const http = HttpClient.make((request, url) =>
      url.hostname === "discord.com"
        ? discord.client.execute(request)
        : url.port === "4444" && targetHttp
          ? targetHttp.execute(request)
          : openCode.http.execute(request),
    );
    let started = 0;
    let serverEnvironment: Readonly<Record<string, string | undefined>> = {};
    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(true),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: Stream.make(new TextEncoder().encode('{"url":"http://127.0.0.1:4321"}\n')),
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        if (ChildProcess.isStandardCommand(command)) serverEnvironment = command.options.env ?? {};
        started++;
        return handle;
      }),
    );
    const settings = yield* decodeConfig(yaml, "/home/test");
    const services = Layer.merge(
      Layer.succeed(HttpClient.HttpClient, http),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const invoke = (dryRun = false) =>
      run(settings, dryRun, Redacted.make("secret"), "/db", {}, discoverService).pipe(
        Effect.provide(services),
      );
    const invokeWith = (text: string, dryRun = false) =>
      decodeConfig(text, "/home/test").pipe(
        Effect.flatMap((changed) =>
          run(changed, dryRun, Redacted.make("secret"), "/db", {}, discoverService),
        ),
        Effect.provide(services),
      );
    return {
      discord,
      openCode,
      invoke,
      invokeWith,
      services,
      getStarted: () => started,
      getEnvironment: () => serverEnvironment,
    };
  });

export const failureSetup = (errorType: string, yaml = config) =>
  setup({ event: "failed", outcome: "failed", errorType }, yaml);

export const rejectRename = (discord: FakeDiscord, id: string) =>
  discord.faults.push({ method: "PATCH", path: `/channels/${id}`, status: 400, code: 200000 });

export const openRecord = (discord: FakeDiscord) =>
  Effect.gen(function* () {
    const api = yield* fakeApi(discord);
    const settings = yield* decodeConfig(config, "/home/test");
    const journal = (yield* openChannelRecord(
      api,
      "20",
      "10",
      settings.since,
      settings.horizon,
      "bot",
      false,
    )).journal!;
    return { api, journal };
  });

export const seedJournal = (discord: FakeDiscord, post: { id: string }) =>
  Effect.gen(function* () {
    const { api, journal } = yield* openRecord(discord);
    return yield* journalPage(api, "bot", journal, "fixture", [post.id]);
  });

export const waitForFault = (discord: FakeDiscord, remaining = 0) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 200 && discord.faults.length !== remaining; turn++)
      yield* Effect.yieldNow;
    if (discord.faults.length !== remaining) return yield* Effect.die("Discord fault not reached");
    return void 0;
  });

export const stalledWork = (api: DiscordApi, settings: Settings, journal: Journal, id: string) =>
  workOn(
    api,
    { run: () => Effect.never },
    { publish: () => Effect.never },
    "20",
    "bot",
    settings,
    journal,
    { id, channel: settings.channels[0]! },
    "run",
  );

export const captureLogs = () => {
  const logs: string[] = [];
  const layer = Logger.layer([
    Logger.make((event) => {
      logs.push(String(event.message));
    }),
  ]);
  return { logs, layer };
};
