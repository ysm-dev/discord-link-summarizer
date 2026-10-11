import { Effect, Layer } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { OpenCode } from "../src/opencode-client.ts";

const options = {
  url: "http://127.0.0.1:4321",
  password: "secret",
  directory: "/workspace",
  agent: "summarizer",
};
export const attempt = {
  channelID: "channel",
  messageID: "message",
  runID: "run",
  label: "News",
  link: "https://example.com",
  command: "summarize",
};
export const session = (id = "ses_one", outcome?: string, updated = 100) => ({
  id,
  time: { created: 1, updated },
  ...(outcome ? { outcome } : {}),
  metadata: { summarizer: { channelID: "channel", messageID: "message", runID: "run" } },
});

interface FakeOptions {
  readonly acceptPrivatePassword?: boolean;
  readonly fault?:
    | "agent"
    | "commands"
    | "plugins"
    | "create"
    | "event"
    | "command"
    | "session"
    | "message"
    | "list"
    | "delete"
    | "interrupt";
  readonly deleteFailures?: number;
  readonly deleteMissing?: boolean;
  readonly deleteLostReply?: boolean;
  readonly hangDelete?: boolean;
  readonly createDelay?: number;
  readonly agentModel?: boolean;
  readonly noAgent?: boolean;
  readonly hangAgent?: boolean;
  /** Plugin list reads that return no plugins, as a freshly started server does. */
  readonly pluginsLoading?: number;
  readonly hangPlugins?: boolean;
  readonly hangCreate?: boolean;
  readonly hangCommand?: boolean;
  readonly holdTerminal?: boolean;
  readonly slowList?: boolean | undefined;
  readonly noConnected?: boolean;
  readonly closeEvent?: boolean;
  readonly noEvent?: boolean;
  readonly invalidEvent?: object;
  readonly event?: "succeeded" | "failed" | "interrupted";
  readonly errorType?: string;
  readonly outcome?: "succeeded" | "failed" | "interrupted" | "none";
  readonly finish?: string;
  readonly text?: string;
  readonly messageMissing?: boolean;
  readonly pages?: ReadonlyArray<ReadonlyArray<object>>;
  readonly loop?: boolean;
  readonly payloads?: Partial<Record<NonNullable<FakeOptions["fault"]>, object>>;
}

const hung = (config: FakeOptions, method: string, path: string) =>
  (config.hangCreate && method === "POST" && path === "/api/session") ||
  (config.hangAgent && path === "/api/agent") ||
  (config.hangPlugins && path === "/api/plugin");

class FakeServer {
  readonly requests: string[] = [];
  readonly bodies: string[] = [];
  readonly retained = new Map<string, object>();
  get sessionsCreated() {
    return this.requests.filter((request) => request === "POST /api/session").length;
  }
  get commandsStarted() {
    return this.requests.filter(
      (request) => request.startsWith("POST ") && request.endsWith("/command"),
    ).length;
  }
  private readonly controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private created = 0;
  private latestCommand = "ses_one";
  private pluginReads = 0;
  private deleteFailures: number;
  private readonly pages: object[][];
  constructor(private readonly config: FakeOptions) {
    this.deleteFailures = config.deleteFailures ?? 0;
    this.pages = config.pages?.map((page) => [...page]) ?? [[]];
    for (const item of this.pages.flat())
      if ("id" in item && typeof item.id === "string") this.retained.set(item.id, item);
  }

  private answer(
    request: HttpClientRequest.HttpClientRequest,
    key: NonNullable<FakeOptions["fault"]>,
    data: object,
  ) {
    return HttpClientResponse.fromWeb(
      request,
      Response.json(this.config.fault === key ? {} : (this.config.payloads?.[key] ?? data), {
        status: this.config.fault === key ? (key === "command" ? 404 : 503) : 200,
      }),
    );
  }

  private emit(type: string, data: object) {
    for (const controller of this.controllers)
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, data })}\n\n`));
  }

  private event(request: HttpClientRequest.HttpClientRequest) {
    if (this.config.fault === "event") return this.answer(request, "event", {});
    let current: ReadableStreamDefaultController<Uint8Array>;
    return HttpClientResponse.fromWeb(
      request,
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            current = controller;
            this.controllers.add(controller);
            if (this.config.invalidEvent)
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(this.config.invalidEvent)}\n\n`),
              );
            this.emit(this.config.noConnected ? "server.warming" : "server.connected", {});
            if (this.config.closeEvent) {
              controller.close();
              this.controllers.delete(controller);
            }
          },
          cancel: () => {
            this.controllers.delete(current);
          },
        }),
      ),
    );
  }

  private command(request: HttpClientRequest.HttpClientRequest, id: string) {
    if (this.config.fault === "command") return this.answer(request, "command", {});
    this.latestCommand = id;
    if (this.config.noEvent) this.emit("session.message.updated", { sessionID: id });
    if (!this.config.closeEvent && !this.config.noEvent) {
      this.emit("session.execution.succeeded", { sessionID: "ses_other" });
      this.emit("session.execution.started", { sessionID: id });
      if (!this.config.holdTerminal) this.finish(id);
    }
    return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
  }

  readonly finish = (id = this.latestCommand) => {
    const current = this.retained.get(id);
    if (current)
      this.retained.set(id, {
        ...current,
        outcome: this.config.outcome === "none" ? undefined : (this.config.outcome ?? "succeeded"),
      });
    this.emit(`session.execution.${this.config.event ?? "succeeded"}`, {
      sessionID: id,
      ...(this.config.errorType ? { error: { type: this.config.errorType } } : {}),
    });
  };

  private messages(request: HttpClientRequest.HttpClientRequest) {
    const content = this.config.messageMissing
      ? []
      : [
          {
            type: "assistant",
            ...(this.config.finish === "missing" ? {} : { finish: this.config.finish ?? "stop" }),
            content: [
              { type: "text", text: this.config.text ?? "안녕" },
              { type: "reasoning", text: "do not publish" },
              { type: "tool" },
              { type: "text", text: this.config.text === undefined ? "하세요" : "" },
            ],
          },
        ];
    return this.answer(request, "message", { data: content });
  }

  private sessions(request: HttpClientRequest.HttpClientRequest, url: URL) {
    if (request.method === "POST") {
      const created = session(++this.created === 1 ? "ses_one" : `ses_${this.created}`);
      if (this.config.fault !== "create") {
        this.retained.set(created.id, created);
        this.pages[0]!.push(created);
      }
      return this.answer(request, "create", { data: created });
    }
    if (
      url.searchParams.get("directory") !== "/workspace" ||
      url.searchParams.get("limit") !== "100"
    )
      throw new Error("Wrong session pagination query");
    const index = url.searchParams.has("cursor")
      ? Number(url.searchParams.get("cursor")?.slice(4)) - 1
      : 0;
    return this.answer(request, "list", {
      data: (this.pages[index] ?? []).flatMap((item) =>
        "id" in item && typeof item.id === "string"
          ? this.retained.has(item.id)
            ? [this.retained.get(item.id)!]
            : []
          : [item],
      ),
      cursor: {
        next: this.config.loop ? "page2" : this.pages[index + 1] ? `page${index + 2}` : null,
      },
    });
  }

  private agent(request: HttpClientRequest.HttpClientRequest, url: URL) {
    if (url.searchParams.get("location[directory]") !== "/workspace")
      throw new Error("Wrong agent location");
    return this.answer(request, "agent", {
      data: this.config.noAgent
        ? []
        : [
            { name: "other", model: { providerID: "other", id: "wrong" } },
            {
              name: "summarizer",
              ...(this.config.agentModel === false
                ? {}
                : { model: { providerID: "provider", id: "model", variant: "max" } }),
            },
          ],
    });
  }

  private plugins(request: HttpClientRequest.HttpClientRequest, url: URL) {
    if (url.searchParams.get("location[directory]") !== "/workspace")
      throw new Error("Wrong plugin location");
    const loading = ++this.pluginReads <= (this.config.pluginsLoading ?? 0);
    const active = { features: { server: true }, state: { status: "active" } };
    return this.answer(request, "plugins", {
      location: { directory: "/workspace" },
      data: loading
        ? []
        : [
            { id: "opencode.config.policy", source: { type: "builtin" }, ...active },
            {
              id: "summarizer-extraction",
              source: { type: "local", path: "/workspace/.opencode/plugins/summarizer-extraction" },
              ...active,
            },
          ],
    });
  }

  private message(request: HttpClientRequest.HttpClientRequest, url: URL) {
    if (
      url.searchParams.get("type") !== "assistant" ||
      url.searchParams.get("order") !== "desc" ||
      url.searchParams.get("limit") !== "1"
    )
      throw new Error("Wrong assistant message query");
    return this.messages(request);
  }

  private remove(request: HttpClientRequest.HttpClientRequest, id: string) {
    if (this.config.hangDelete) return Effect.never;
    if (this.deleteFailures-- > 0 || this.config.fault === "delete")
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
      );
    const existed = this.retained.delete(id);
    if (this.config.deleteLostReply && existed)
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        }),
      );
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(null, { status: !existed || this.config.deleteMissing ? 404 : 204 }),
      ),
    );
  }

  private detail(request: HttpClientRequest.HttpClientRequest, id: string) {
    if (!this.retained.has(id))
      return HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }));
    return this.answer(request, "session", {
      data: {
        ...this.retained.get(id),
        id,
        outcome: this.config.outcome === "none" ? undefined : (this.config.outcome ?? "succeeded"),
        location: { directory: "/workspace" },
        time: { created: 1, updated: 100, idle: 3 },
        metadata: session(id).metadata,
      },
    });
  }

  readonly http = HttpClient.make((request, url) => {
    this.requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (
      !this.config.acceptPrivatePassword &&
      request.headers["authorization"] !== `Basic ${btoa("opencode:secret")}`
    )
      throw new Error("Unauthenticated OpenCode request");
    if (request.body instanceof HttpBody.Uint8Array && request.body.text)
      this.bodies.push(request.body.text);
    if (hung(this.config, request.method, url.pathname)) return Effect.never;
    if (url.pathname === "/api/session" && request.method === "POST" && this.config.createDelay)
      return Effect.sync(() => this.sessions(request, url)).pipe(
        Effect.delay(this.config.createDelay),
      );
    if (url.pathname.endsWith("/command") && this.config.hangCommand) return Effect.never;
    if (url.pathname === "/api/session" && this.config.slowList && request.method === "GET")
      return Effect.sync(() => this.sessions(request, url)).pipe(Effect.delay("12 seconds"));
    if (url.pathname.startsWith("/api/session/ses_") && request.method === "DELETE")
      return Effect.suspend(() => this.remove(request, url.pathname.split("/")[3] ?? ""));
    return Effect.sync(() => {
      if (url.pathname === "/api/agent") return this.agent(request, url);
      if (url.pathname === "/api/command") {
        if (url.searchParams.get("location[directory]") !== "/workspace")
          throw new Error("Wrong command location");
        return this.answer(request, "commands", {
          data: [{ name: "summarize" }, { name: "other" }],
        });
      }
      if (url.pathname === "/api/plugin") return this.plugins(request, url);
      if (url.pathname === "/api/session") return this.sessions(request, url);
      if (url.pathname === "/api/event") return this.event(request);
      if (!url.pathname.startsWith("/api/session/ses_")) throw new Error("Wrong session endpoint");
      const id = url.pathname.split("/")[3]!;
      if (url.pathname.endsWith("/command")) return this.command(request, id);
      if (url.pathname.endsWith("/interrupt")) {
        if (url.searchParams.get("resume") !== "false")
          throw new Error("Interrupt attempted a resume");
        return this.answer(request, "interrupt", { interrupted: true });
      }
      if (url.pathname.endsWith("/message")) return this.message(request, url);
      return this.detail(request, id);
    });
  });
}

export const fakeOpenCode = (config: FakeOptions = {}) => new FakeServer(config);

export const withFake = <A, E>(
  program: Effect.Effect<A, E, OpenCode>,
  fake: ReturnType<typeof fakeOpenCode>,
) =>
  program.pipe(
    Effect.provide(
      OpenCode.layer(options).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, fake.http))),
    ),
  );
