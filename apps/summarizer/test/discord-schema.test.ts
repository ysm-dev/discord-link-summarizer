import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  ActiveThreads,
  ArchivedThreads,
  DiscordChannel,
  DiscordErrorBody,
  DiscordMessage,
  DiscordRateLimitBody,
  DiscordThread,
  DiscordUser,
} from "../src/discord-schema.ts";

const thread = {
  id: "thread",
  parent_id: "news",
  owner_id: "bot",
  name: "⏳ 요약",
  thread_metadata: { archived: false, archive_timestamp: "2026-09-25T00:00:00Z" },
};

const decode = (schema: Schema.ConstraintDecoder<object>, value: object) =>
  Schema.decodeSync(schema)(value);

it("decodes exactly the used Discord wire fields and rejects missing required fields", () => {
  expect(decode(DiscordUser(), { id: "bot", username: "ignored" })).toEqual({ id: "bot" });
  expect(() => decode(DiscordUser(), {})).toThrow(/id/);
  expect(
    decode(DiscordChannel(), { id: "news", type: 5, guild_id: "guild", name: "ignored" }),
  ).toEqual({ id: "news", type: 5, guild_id: "guild", name: "ignored" });
  expect(() => decode(DiscordChannel(), { id: "news", type: "text" })).toThrow(/type/);
  expect(decode(DiscordChannel(), { ...thread, type: 11 })).toMatchObject({
    thread_metadata: { archived: false },
  });
  expect(() => decode(DiscordChannel(), { ...thread, type: 11, thread_metadata: {} })).toThrow(
    /archived/,
  );
  expect(decode(DiscordThread(), { ...thread, member_count: 3 })).toEqual(thread);
  expect(() => decode(DiscordThread(), { ...thread, owner_id: undefined })).toThrow(/owner_id/);
  expect(() => decode(DiscordThread(), { ...thread, thread_metadata: {} })).toThrow(/archived/);
  const message = {
    id: "post",
    channel_id: "news",
    author: { id: "person" },
    content: "link",
    type: 0,
    timestamp: "2026-09-25T00:00:00Z",
    thread,
  };
  expect(decode(DiscordMessage(), { ...message, pinned: true })).toEqual(message);
  expect(() => decode(DiscordMessage(), { ...message, content: undefined })).toThrow(/content/);
  expect(decode(ActiveThreads(), { threads: [thread], members: [] })).toEqual({
    threads: [thread],
  });
  expect(() => decode(ActiveThreads(), { threads: "wrong" })).toThrow(/threads/);
  expect(decode(ArchivedThreads(), { threads: [thread], has_more: false })).toEqual({
    threads: [thread],
    has_more: false,
  });
  expect(() => decode(ArchivedThreads(), { threads: [], has_more: "false" })).toThrow(/has_more/);
  expect(decode(DiscordErrorBody(), { code: 160004, message: "ignored" })).toEqual({
    code: 160004,
  });
  expect(() => decode(DiscordErrorBody(), { code: "160004" })).toThrow(/code/);
  expect(decode(DiscordRateLimitBody(), { retry_after: 0.5, global: true })).toEqual({
    retry_after: 0.5,
  });
  expect(() => decode(DiscordRateLimitBody(), { retry_after: "0.5" })).toThrow(/retry_after/);
});
