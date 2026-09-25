import { Clock, Effect, Layer, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { DiscordChannel, DiscordMessage, DiscordThread } from "../src/discord-schema.ts";

type Fault = {
  method: string;
  path: string;
  status?: number;
  code?: number;
  body?: object;
  headers?: Record<string, string>;
  drop?: boolean;
  after?: boolean;
  noDate?: boolean;
  pause?: number;
};

const pauseFor = (fault?: Fault) => (fault?.pause ? Effect.sleep(fault.pause) : Effect.void);

/** Mutable HTTP-edge fixture: concurrent thread creation is arbitrated by the server, not the client. */
export class FakeDiscord {
  readonly bot = { id: "bot" };
  readonly channels = new Map<string, DiscordChannel>();
  readonly messages = new Map<string, DiscordMessage[]>();
  readonly threads = new Map<string, DiscordThread>();
  readonly faults: Fault[] = [];
  readonly requests: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: Schema.Json | undefined;
  }[] = [];
  private sequence = 0n;

  addChannel(id: string, guild_id = "guild", type = 0) {
    this.channels.set(id, { id, guild_id, type });
  }

  addMessage(channel: string, content: string, at: number, author = "person", type = 0) {
    const message: DiscordMessage = {
      id: this.nextId(at),
      channel_id: channel,
      author: { id: author },
      content,
      type,
      timestamp: new Date(at).toISOString(),
    };
    this.messages.set(channel, [...(this.messages.get(channel) ?? []), message]);
    return message;
  }

  addThread(
    channel: string,
    message: string,
    name: string,
    owner = this.bot.id,
    archived = false,
    at = 0,
  ) {
    const thread: DiscordThread = {
      id: message,
      parent_id: channel,
      owner_id: owner,
      name,
      thread_metadata: { archived, archive_timestamp: new Date(at).toISOString() },
    };
    this.threads.set(message, thread);
    const list = this.messages.get(channel) ?? [];
    this.messages.set(
      channel,
      list.map((item) => (item.id === message ? { ...item, thread } : item)),
    );
    return thread;
  }

  private nextId(at: number) {
    this.sequence++;
    return (((BigInt(at) - 1420070400000n) << 22n) + this.sequence).toString();
  }

  readonly client = HttpClient.make((request, url) =>
    Effect.gen(
      function* (this: FakeDiscord) {
        const path = url.pathname.replace(/^\/api\/v10/, "") + url.search;
        const text = request.body instanceof HttpBody.Uint8Array ? request.body.text : undefined;
        const body =
          text === undefined
            ? undefined
            : Schema.decodeSync(Schema.fromJsonString(Schema.Json))(text);
        const recorded = { method: request.method, path, headers: request.headers, body };
        this.requests.push(recorded);
        const index = this.faults.findIndex(
          (fault) => fault.method === request.method && path.startsWith(fault.path),
        );
        const fault = index < 0 ? undefined : this.faults.splice(index, 1)[0];
        yield* pauseFor(fault);
        if (fault?.drop && !fault.after)
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          });
        const now = yield* Clock.currentTimeMillis;
        const reply = (status: number, result?: object) =>
          HttpClientResponse.fromWeb(
            request,
            new Response(result === undefined ? null : JSON.stringify(result), {
              status,
              headers: {
                ...(fault?.noDate ? {} : { date: new Date(now).toUTCString() }),
                ...fault?.headers,
              },
            }),
          );
        if (fault?.status !== undefined && fault.status !== 200)
          return reply(
            fault.status,
            fault.body ??
              (fault.status === 204
                ? undefined
                : {
                    code: fault.code ?? 0,
                    retry_after: Number(fault.headers?.["retry-after"] ?? 0.01),
                    global: fault.headers?.["x-ratelimit-global"] === "true",
                  }),
          );
        const parts = url.pathname.replace(/^\/api\/v10\//, "").split("/");
        const result = this.route(request.method, parts, url, body, now);
        if (fault?.drop && fault.after)
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          });
        return reply(result.status, fault?.body ?? result.body);
      }.bind(this),
    ),
  );

  readonly layer = Layer.succeed(HttpClient.HttpClient, this.client);

  private route(
    method: string,
    parts: string[],
    url: URL,
    body: Schema.Json | undefined,
    now: number,
  ): { status: number; body?: object } {
    if (method === "GET" && parts[0] === "users") return { status: 200, body: this.bot };
    if (parts[0] === "guilds" && parts[2] === "threads" && parts[3] === "active") {
      return {
        status: 200,
        body: {
          threads: [...this.threads.values()].filter(
            (thread) =>
              !thread.thread_metadata.archived &&
              this.channels.get(thread.parent_id)?.guild_id === parts[1],
          ),
        },
      };
    }
    if (parts[0] !== "channels") return { status: 404, body: { code: 10003 } };
    const id = parts[1] ?? "";
    if (method === "GET" && parts.length === 2) return this.routeChannel(id);
    if (parts[2] === "threads" && parts[3] === "archived") {
      const before = url.searchParams.get("before");
      const threads = [...this.threads.values()]
        .filter(
          (thread) =>
            thread.parent_id === id &&
            thread.thread_metadata.archived &&
            (before === null || (thread.thread_metadata.archive_timestamp ?? "") < before),
        )
        .toSorted((a, b) =>
          (b.thread_metadata.archive_timestamp ?? "").localeCompare(
            a.thread_metadata.archive_timestamp ?? "",
          ),
        );
      return {
        status: 200,
        body: { threads: threads.slice(0, 100), has_more: threads.length > 100 },
      };
    }
    if (parts[2] === "messages") return this.routeMessage(method, parts, url, body, now);
    if (method === "PATCH" && parts.length === 2) {
      const thread = this.threads.get(id);
      if (thread === undefined) return { status: 404, body: { code: 10003 } };
      const data = Schema.decodeUnknownSync(
        Schema.Struct({ name: Schema.String, archived: Schema.Boolean }),
      )(body);
      const updated: DiscordThread = {
        ...thread,
        name: data.name,
        thread_metadata: {
          archived: data.archived,
          archive_timestamp: new Date(now).toISOString(),
        },
      };
      this.threads.set(id, updated);
      this.messages.set(
        thread.parent_id,
        (this.messages.get(thread.parent_id) ?? []).map((message) =>
          message.id === id ? { ...message, thread: updated } : message,
        ),
      );
      return { status: 200, body: updated };
    }
    return { status: 404, body: { code: 10003 } };
  }

  private routeChannel(id: string): { status: number; body?: object } {
    const channel = this.channels.get(id);
    if (channel) return { status: 200, body: channel };
    const thread = this.threads.get(id);
    if (thread)
      return {
        status: 200,
        body: { ...thread, guild_id: this.channels.get(thread.parent_id)?.guild_id, type: 11 },
      };
    return { status: 404, body: { code: 10003 } };
  }

  private routeSingleMessage(id: string, messageId: string): { status: number; body?: object } {
    const item = this.messages.get(id)?.find((message) => message.id === messageId);
    if (item) return { status: 200, body: item };
    return { status: 404, body: { code: 10008 } };
  }

  private routePostMessage(id: string, body: Schema.Json | undefined, now: number) {
    if (this.threads.get(id)?.thread_metadata.archived)
      return { status: 403, body: { code: 50083 } };
    const data = Schema.decodeUnknownSync(Schema.Struct({ content: Schema.String }))(body);
    return { status: 200, body: this.addMessage(id, data.content, now, this.bot.id) };
  }

  private routeMessage(
    method: string,
    parts: string[],
    url: URL,
    body: Schema.Json | undefined,
    now: number,
  ): { status: number; body?: object } {
    const id = parts[1] ?? "";
    const list = this.messages.get(id) ?? [];
    if (method === "GET") {
      if (parts[3]) return this.routeSingleMessage(id, parts[3]);
      const before = url.searchParams.get("before");
      return {
        status: 200,
        body: list
          .filter((msg) => before === null || BigInt(msg.id) < BigInt(before))
          .toSorted((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1))
          .slice(0, Number(url.searchParams.get("limit") ?? 50)),
      };
    }
    if (parts[4] === "threads" && method === "POST")
      return this.routeStartThread(id, parts[3] ?? "", list, body, now);
    if (method === "POST") return this.routePostMessage(id, body, now);
    if (method === "DELETE") {
      if (!list.some((item) => item.id === parts[3])) return { status: 404, body: { code: 10008 } };
      this.messages.set(
        id,
        list.filter((item) => item.id !== parts[3]),
      );
      return { status: 204 };
    }
    if (method === "PATCH") {
      const data = Schema.decodeUnknownSync(Schema.Struct({ content: Schema.String }))(body);
      const message = list.find((item) => item.id === parts[3]);
      if (message === undefined) return { status: 404, body: { code: 10008 } };
      const updated = {
        ...message,
        content: data.content,
        edited_timestamp: new Date(now).toISOString(),
      };
      this.messages.set(
        id,
        list.map((item) => (item.id === updated.id ? updated : item)),
      );
      return { status: 200, body: updated };
    }
    return { status: 404, body: { code: 10003 } };
  }

  private routeStartThread(
    channel: string,
    message: string,
    list: ReadonlyArray<DiscordMessage>,
    body: Schema.Json | undefined,
    now: number,
  ) {
    if (this.threads.has(message)) return { status: 400, body: { code: 160004 } };
    if (!list.some((item) => item.id === message)) return { status: 404, body: { code: 10008 } };
    const name = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(body).name;
    return { status: 201, body: this.addThread(channel, message, name, this.bot.id, false, now) };
  }
}
