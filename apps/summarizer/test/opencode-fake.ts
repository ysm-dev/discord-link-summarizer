import { Effect, Layer } from "effect";
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
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
  readonly fault?:
    | "agent"
    | "commands"
    | "create"
    | "event"
    | "command"
    | "session"
    | "message"
    | "list"
    | "delete"
    | "interrupt";
  readonly agentModel?: boolean;
  readonly noAgent?: boolean;
  readonly hangAgent?: boolean;
  readonly hangCommand?: boolean;
  readonly slowList?: boolean | undefined;
  readonly hangExport?: boolean | undefined;
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
  readonly exports?: Readonly<Record<string, object>>;
}

class FakeServer {
  readonly requests: string[] = [];
  readonly bodies: string[] = [];
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  constructor(private readonly config: FakeOptions) {}

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
    this.controller?.enqueue(
      new TextEncoder().encode(`data: ${JSON.stringify({ type, data })}\n\n`),
    );
  }

  private event(request: HttpClientRequest.HttpClientRequest) {
    if (this.config.fault === "event") return this.answer(request, "event", {});
    return HttpClientResponse.fromWeb(
      request,
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            this.controller = controller;
            if (this.config.invalidEvent)
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(this.config.invalidEvent)}\n\n`),
              );
            this.emit(this.config.noConnected ? "server.warming" : "server.connected", {});
            if (this.config.closeEvent) controller.close();
          },
        }),
      ),
    );
  }

  private command(request: HttpClientRequest.HttpClientRequest) {
    if (this.config.fault === "command") return this.answer(request, "command", {});
    if (this.config.noEvent) this.emit("session.message.updated", { sessionID: "ses_one" });
    if (!this.config.closeEvent && !this.config.noEvent) {
      this.emit("session.execution.succeeded", { sessionID: "ses_other" });
      this.emit(`session.execution.${this.config.event ?? "succeeded"}`, {
        sessionID: "ses_one",
        ...(this.config.errorType ? { error: { type: this.config.errorType } } : {}),
      });
    }
    return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
  }

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
    if (request.method === "POST") return this.answer(request, "create", { data: session() });
    if (
      url.searchParams.get("directory") !== "/workspace" ||
      url.searchParams.get("limit") !== "100"
    )
      throw new Error("Wrong session pagination query");
    const index = url.searchParams.has("cursor")
      ? Number(url.searchParams.get("cursor")?.slice(4)) - 1
      : 0;
    return this.answer(request, "list", {
      data: this.config.pages?.[index] ?? [],
      cursor: {
        next: this.config.loop
          ? "page2"
          : this.config.pages?.[index + 1]
            ? `page${index + 2}`
            : null,
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

  private message(request: HttpClientRequest.HttpClientRequest, url: URL) {
    if (
      url.searchParams.get("type") !== "assistant" ||
      url.searchParams.get("order") !== "desc" ||
      url.searchParams.get("limit") !== "1"
    )
      throw new Error("Wrong assistant message query");
    return this.messages(request);
  }

  private export(request: HttpClientRequest.HttpClientRequest, url: URL) {
    if (url.searchParams.get("sanitize") !== "false") throw new Error("Export must be raw");
    const id = url.pathname.split("/")[4] ?? "";
    return HttpClientResponse.fromWeb(
      request,
      Response.json({ data: this.config.exports?.[id] ?? {} }),
    );
  }

  readonly http = HttpClient.make((request, url) => {
    this.requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.headers["authorization"] !== `Basic ${btoa("opencode:secret")}`)
      throw new Error("Unauthenticated OpenCode request");
    if (request.body instanceof HttpBody.Uint8Array && request.body.text)
      this.bodies.push(request.body.text);
    if (url.pathname === "/api/agent" && this.config.hangAgent) return Effect.never;
    if (url.pathname.endsWith("/command") && this.config.hangCommand) return Effect.never;
    if (url.pathname === "/api/session" && this.config.slowList && request.method === "GET")
      return Effect.sync(() => this.sessions(request, url)).pipe(Effect.delay("12 seconds"));
    if (url.pathname.startsWith("/api/experimental/session/") && this.config.hangExport)
      return Effect.never;
    return Effect.sync(() => {
      if (url.pathname === "/api/agent") return this.agent(request, url);
      if (url.pathname === "/api/command") {
        if (url.searchParams.get("location[directory]") !== "/workspace")
          throw new Error("Wrong command location");
        return this.answer(request, "commands", {
          data: [{ name: "summarize" }, { name: "other" }],
        });
      }
      if (url.pathname === "/api/session") return this.sessions(request, url);
      if (url.pathname === "/api/event") return this.event(request);
      if (url.pathname.startsWith("/api/experimental/session/")) return this.export(request, url);
      if (!url.pathname.startsWith("/api/session/ses_")) throw new Error("Wrong session endpoint");
      if (request.method === "DELETE")
        return this.config.fault === "delete"
          ? this.answer(request, "delete", {})
          : HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
      if (
        url.pathname !== "/api/session/ses_one" &&
        !url.pathname.startsWith("/api/session/ses_one/")
      )
        throw new Error("Wrong session endpoint");
      if (url.pathname.endsWith("/command")) return this.command(request);
      if (url.pathname.endsWith("/interrupt")) {
        if (url.searchParams.get("resume") !== "false")
          throw new Error("Interrupt attempted a resume");
        return this.answer(request, "interrupt", { interrupted: true });
      }
      if (url.pathname.endsWith("/message")) return this.message(request, url);
      return this.answer(request, "session", {
        data: session(
          "ses_one",
          this.config.outcome === "none" ? undefined : (this.config.outcome ?? "succeeded"),
        ),
      });
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
