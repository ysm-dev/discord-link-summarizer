import { Clock, Context, Effect, Layer, Option, Redacted, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  ActiveThreads,
  ArchivedThreads,
  DiscordChannel,
  DiscordErrorBody,
  DiscordMessage,
  DiscordRateLimitBody,
  DiscordThread,
  DiscordUser,
} from "./discord-schema.ts";

const api = "https://discord.com/api/v10";
const maxWaitMs = 30_000;
const messagePath = (channel: string) => `/channels/${encodeURIComponent(channel)}/messages`;

const responseKind = (
  status: number,
  code: number | undefined,
  hasName: boolean,
): DiscordFailure["kind"] => {
  if (code === 160004) return "thread-exists";
  if (code === 200000 || code === 200001) return hasName ? "name-rejected" : "invalid-response";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status >= 500) return "outage";
  return "invalid-response";
};

export class DiscordFailure extends Error {
  constructor(
    readonly kind:
      | "outage"
      | "unauthorized"
      | "forbidden"
      | "not-found"
      | "thread-exists"
      | "name-rejected"
      | "invalid-response",
    readonly status?: number,
  ) {
    super(`Discord ${kind}${status === undefined ? "" : ` (${status})`}`);
  }
}

export interface DiscordApi {
  readonly currentUser: Effect.Effect<
    { readonly user: DiscordUser; readonly date: Date },
    DiscordFailure
  >;
  readonly getChannel: (id: string) => Effect.Effect<DiscordChannel, DiscordFailure>;
  readonly getMessage: (
    channelId: string,
    messageId: string,
  ) => Effect.Effect<DiscordMessage, DiscordFailure>;
  readonly listMessages: (
    channelId: string,
    before?: string,
  ) => Effect.Effect<ReadonlyArray<DiscordMessage>, DiscordFailure>;
  readonly listThreadMessages: (
    threadId: string,
    before?: string,
  ) => Effect.Effect<ReadonlyArray<DiscordMessage>, DiscordFailure>;
  readonly startThread: (
    channelId: string,
    messageId: string,
    name: string,
  ) => Effect.Effect<DiscordThread, DiscordFailure>;
  readonly listActiveThreads: (
    guildId: string,
  ) => Effect.Effect<ReadonlyArray<DiscordThread>, DiscordFailure>;
  readonly listArchivedThreads: (
    channelId: string,
    before?: string,
  ) => Effect.Effect<Schema.Schema.Type<ReturnType<typeof ArchivedThreads>>, DiscordFailure>;
  readonly createMessage: (
    channelId: string,
    content: string,
  ) => Effect.Effect<DiscordMessage, DiscordFailure>;
  readonly editMessage: (
    channelId: string,
    messageId: string,
    content: string,
  ) => Effect.Effect<DiscordMessage, DiscordFailure>;
  readonly deleteMessage: (
    channelId: string,
    messageId: string,
  ) => Effect.Effect<void, DiscordFailure>;
  readonly modifyThread: (
    threadId: string,
    name: string,
    archived: boolean,
  ) => Effect.Effect<DiscordThread, DiscordFailure>;
}

/** Read the complete Summary Thread for publication reconciliation. */
export const allMessages = (client: Pick<DiscordApi, "listMessages">, channel: string) =>
  Effect.gen(function* () {
    const seen: DiscordMessage[] = [];
    for (;;) {
      const page = yield* client.listMessages(channel, seen.at(-1)?.id);
      seen.push(...page);
      if (page.length < 100) return seen;
    }
  });

export class Discord extends Context.Service<Discord, DiscordApi>()("Discord") {}

/** One serialized HTTP lane preserves the bucket and global deadlines under concurrent Runs. */
const makeDiscord = (
  token: Redacted.Redacted,
): Effect.Effect<DiscordApi, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const lane = yield* Semaphore.make(1);
    const buckets = new Map<string, number>();
    const routes = new Map<string, string>();

    const rate = (
      response: HttpClientResponse.HttpClientResponse,
      route: string,
      path: string,
      started: number,
    ) =>
      Effect.gen(function* () {
        const bucket = response.headers["x-ratelimit-bucket"];
        const key = bucket === undefined ? route : `${bucket}:${path.split("/")[2]}`;
        routes.set(route, key);
        const reset = Number(response.headers["x-ratelimit-reset-after"]);
        const received = yield* Clock.currentTimeMillis;
        if (response.headers["x-ratelimit-remaining"] === "0" && Number.isFinite(reset)) {
          buckets.set(key, received + reset * 1000);
        }
        if (response.status !== 429) return false;
        const rateBody = yield* HttpClientResponse.schemaBodyJson(DiscordRateLimitBody())(
          response,
        ).pipe(Effect.option);
        const seconds = Option.isSome(rateBody)
          ? rateBody.value.retry_after
          : Number(response.headers["retry-after"]);
        if (
          !Number.isFinite(seconds) ||
          seconds <= 0 ||
          received + seconds * 1000 - started > maxWaitMs
        ) {
          return yield* Effect.fail(new DiscordFailure("outage", 429));
        }
        const deadline = received + seconds * 1000;
        // The one HTTP lane waits through this deadline even for a global 429.
        buckets.set(key, deadline);
        return true;
      });

    const requestFor = (method: typeof HttpClientRequest.get, path: string, body?: object) => {
      const request = method(`${api}${path}`).pipe(
        HttpClientRequest.setHeaders({
          authorization: `Bot ${Redacted.value(token)}`,
          "user-agent": "DiscordBot (https://github.com/ysm-dev/discord-link-summarizer, 1.0)",
        }),
      );
      // The only bodies passed here are composed of strings, booleans, numbers and literal arrays.
      return body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, body);
    };

    const send = (method: typeof HttpClientRequest.get, path: string, body?: object) =>
      lane.withPermit(
        Effect.gen(function* () {
          const started = yield* Clock.currentTimeMillis;
          const request = requestFor(method, path, body);
          const route = `${request.method} ${path.split("?")[0]}`;
          for (;;) {
            const now = yield* Clock.currentTimeMillis;
            const until = buckets.get(routes.get(route) ?? route) ?? 0;
            if (until - started > maxWaitMs)
              return yield* Effect.fail(new DiscordFailure("outage"));
            yield* Effect.sleep(Math.max(0, until - now));
            // POST transport failures may have committed on Discord. Never blindly replay them.
            const response = yield* client
              .execute(request)
              .pipe(Effect.mapError(() => new DiscordFailure("outage")));
            if (!(yield* rate(response, route, path, started))) return response;
            // A 429 explicitly says the write was not accepted; replaying this response is safe.
          }
        }),
      );

    const checked = (method: typeof HttpClientRequest.get, path: string, body?: object) =>
      Effect.gen(function* () {
        const response = yield* send(method, path, body);
        if (response.status < 300) return response;
        const details = yield* HttpClientResponse.schemaBodyJson(DiscordErrorBody())(response).pipe(
          Effect.option,
        );
        return yield* Effect.fail(
          new DiscordFailure(
            responseKind(
              response.status,
              Option.getOrUndefined(details)?.code,
              body !== undefined && "name" in body,
            ),
            response.status,
          ),
        );
      });

    const decode = <S extends Schema.Constraint>(
      schema: S,
      response: HttpClientResponse.HttpClientResponse,
    ) =>
      HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError(() => new DiscordFailure("invalid-response", response.status)),
      );
    const read = <S extends Schema.Constraint>(schema: S, path: string) =>
      checked(HttpClientRequest.get, path).pipe(
        Effect.flatMap((response) => decode(schema, response)),
      );
    const write = <S extends Schema.Constraint>(
      schema: S,
      method: typeof HttpClientRequest.post,
      path: string,
      body: object,
    ) => checked(method, path, body).pipe(Effect.flatMap((response) => decode(schema, response)));
    const listMessages = (channel: string, before?: string) =>
      read(
        Schema.Array(DiscordMessage()),
        `${messagePath(channel)}?limit=100${before === undefined ? "" : `&before=${encodeURIComponent(before)}`}`,
      );

    return {
      currentUser: Effect.gen(function* () {
        const response = yield* checked(HttpClientRequest.get, "/users/@me");
        const user = yield* decode(DiscordUser(), response);
        const header = response.headers["date"];
        const date = new Date(String(header));
        if (Number.isNaN(date.getTime()))
          return yield* Effect.fail(new DiscordFailure("invalid-response", response.status));
        return { user, date };
      }),
      getChannel: (id) => read(DiscordChannel(), `/channels/${encodeURIComponent(id)}`),
      getMessage: (channelId, messageId) =>
        read(DiscordMessage(), `${messagePath(channelId)}/${encodeURIComponent(messageId)}`),
      listMessages,
      listThreadMessages: listMessages,
      startThread: (channelId, messageId, name) =>
        write(
          DiscordThread(),
          HttpClientRequest.post,
          `${messagePath(channelId)}/${encodeURIComponent(messageId)}/threads`,
          { name, auto_archive_duration: 10080 },
        ),
      listActiveThreads: (guildId) =>
        read(ActiveThreads(), `/guilds/${encodeURIComponent(guildId)}/threads/active`).pipe(
          Effect.map((result) => result.threads),
        ),
      listArchivedThreads: (channelId, before) =>
        read(
          ArchivedThreads(),
          `/channels/${encodeURIComponent(channelId)}/threads/archived/public?limit=100${before === undefined ? "" : `&before=${encodeURIComponent(before)}`}`,
        ),
      createMessage: (channelId, content) =>
        write(DiscordMessage(), HttpClientRequest.post, messagePath(channelId), {
          content,
          flags: 4,
          allowed_mentions: { parse: [] },
        }),
      editMessage: (channelId, messageId, content) =>
        write(
          DiscordMessage(),
          HttpClientRequest.patch,
          `${messagePath(channelId)}/${encodeURIComponent(messageId)}`,
          { content, flags: 4, allowed_mentions: { parse: [] } },
        ),
      deleteMessage: (channelId, messageId) =>
        checked(
          HttpClientRequest.delete,
          `${messagePath(channelId)}/${encodeURIComponent(messageId)}`,
        ).pipe(
          Effect.catchIf(
            (error) => error.kind === "not-found",
            () => Effect.void,
          ),
          Effect.asVoid,
        ),
      modifyThread: (threadId, name, archived) =>
        write(
          DiscordThread(),
          HttpClientRequest.patch,
          `/channels/${encodeURIComponent(threadId)}`,
          {
            name,
            archived,
          },
        ),
    } satisfies DiscordApi;
  });

export const DiscordLive = (token: Redacted.Redacted) => Layer.effect(Discord, makeDiscord(token));
