import { Effect, Layer, Redacted } from "effect";
import { Discord, DiscordLive } from "../src/discord-client.ts";
import type { FakeDiscord } from "./discord-fake.ts";

export const fakeApi = (fake: FakeDiscord) =>
  Discord.pipe(
    Effect.provide(DiscordLive(Redacted.make("secret")).pipe(Layer.provide(fake.layer))),
  );
