import { Schema } from "effect";

export const DiscordUser = () => Schema.Struct({ id: Schema.String });
export const DiscordThread = () =>
  Schema.Struct({
    id: Schema.String,
    parent_id: Schema.String,
    owner_id: Schema.String,
    name: Schema.String,
    thread_metadata: Schema.Struct({
      archived: Schema.Boolean,
      archive_timestamp: Schema.optional(Schema.String),
    }),
  });
export const DiscordChannel = () =>
  Schema.Struct({
    id: Schema.String,
    type: Schema.Finite,
    guild_id: Schema.optional(Schema.String),
    parent_id: Schema.optional(Schema.String),
    owner_id: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    thread_metadata: Schema.optional(Schema.Struct({ archived: Schema.Boolean })),
  });
export const DiscordMessage = () =>
  Schema.Struct({
    id: Schema.String,
    channel_id: Schema.String,
    author: DiscordUser(),
    content: Schema.String,
    type: Schema.Finite,
    timestamp: Schema.String,
    edited_timestamp: Schema.optional(Schema.NullOr(Schema.String)),
    thread: Schema.optional(DiscordThread()),
  });
export const ActiveThreads = () => Schema.Struct({ threads: Schema.Array(DiscordThread()) });
export const ArchivedThreads = () =>
  Schema.Struct({
    threads: Schema.Array(DiscordThread()),
    has_more: Schema.Boolean,
  });
export const DiscordErrorBody = () => Schema.Struct({ code: Schema.optional(Schema.Finite) });
export const DiscordRateLimitBody = () =>
  Schema.Struct({
    retry_after: Schema.Finite,
  });

export type DiscordUser = Schema.Schema.Type<ReturnType<typeof DiscordUser>>;
export type DiscordChannel = Schema.Schema.Type<ReturnType<typeof DiscordChannel>>;
export type DiscordThread = Schema.Schema.Type<ReturnType<typeof DiscordThread>>;
export type DiscordMessage = Schema.Schema.Type<ReturnType<typeof DiscordMessage>>;
