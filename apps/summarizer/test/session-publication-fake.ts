import { Effect, Layer, Schema } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { OpenCode, Transfer } from "../src/opencode-client.ts";
import { SessionPublication } from "../src/session-publication.ts";
import { fakeOpenCode, session } from "./opencode-fake.ts";

export const directory = "/workspace";
export const source = {
  info: {
    ...session(),
    title: "Summary",
    location: { directory },
    agent: "summarizer",
    model: { providerID: "provider", id: "model", variant: "max" },
    cost: 0.12,
    tokens: { input: 23, output: 40, reasoning: 2, cache: { read: 1, write: 0 } },
    time: { created: 1, updated: 3, idle: 3 },
    outcome: "succeeded",
  },
  messages: [
    { id: "msg_user", type: "user", text: "untrusted page content" },
    { id: "msg_assistant", type: "assistant", content: [{ type: "text", text: "summary" }] },
  ],
};

export const endpoint = {
  url: "http://127.0.0.1:4444",
  auth: { type: "basic" as const, username: "opencode", password: "target-password" },
};
type TargetOptions = {
  readonly existing?: object;
  readonly lostReply?: boolean;
  readonly importStatus?: number;
  readonly hang?: boolean;
  readonly exportBody?: object;
  readonly race?: object;
  readonly noCommit?: boolean;
  readonly exportStatus?: number;
};

export const harness = (
  config: {
    readonly pages?: ReadonlyArray<ReadonlyArray<object>>;
    readonly source?: object;
    readonly sources?: Readonly<Record<string, object>>;
    readonly target?: TargetOptions;
    readonly unavailable?: boolean;
    readonly discoveryFailure?: boolean;
    readonly discoveryHang?: boolean;
    readonly discoveryEndpoint?: typeof endpoint;
    readonly hangExport?: boolean;
    readonly slowList?: boolean;
    readonly patchStatus?: number;
    readonly patchLostReply?: boolean;
    readonly patchNoCommit?: boolean;
    readonly patchCorrupt?: boolean;
    readonly hangPatch?: boolean;
    readonly confirmInfo?: object;
    readonly confirmBody?: object;
  } = {},
) => {
  const privateServer = fakeOpenCode({
    pages: config.pages ?? [[session("ses_one", "succeeded")]],
    exports: config.sources ?? { ses_one: config.source ?? source },
    hangExport: config.hangExport,
    slowList: config.slowList,
    patchStatus: config.patchStatus,
    patchLostReply: config.patchLostReply,
    patchNoCommit: config.patchNoCommit,
    patchCorrupt: config.patchCorrupt,
    hangPatch: config.hangPatch,
    confirmInfo: config.confirmInfo,
    confirmBody: config.confirmBody,
  });
  const requests: string[] = [];
  const imports: object[] = [];
  let discoveries = 0;
  const existing = new Map<string, object>();
  if (config.target?.existing) existing.set("ses_one", config.target.existing);
  const imported = Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({
        info: Schema.JsonObject,
        messages: Transfer.fields.messages,
        location: Schema.Struct({ directory: Schema.String }),
      }),
    ),
  );
  const targetGet = (request: HttpClientRequest.HttpClientRequest, id: string) =>
    HttpClientResponse.fromWeb(
      request,
      config.target?.exportStatus
        ? new Response(null, { status: config.target.exportStatus })
        : existing.has(id)
          ? Response.json({ data: config.target?.exportBody ?? existing.get(id) })
          : new Response(null, { status: 404 }),
    );
  const targetPost = (request: HttpClientRequest.HttpClientRequest) => {
    if (!(request.body instanceof HttpBody.Uint8Array) || !request.body.text)
      throw new Error("Missing import");
    const body = imported(request.body.text);
    const info = Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.String, time: Schema.Struct({ created: Schema.Finite }) }),
    )(body.info);
    imports.push(body);
    if (config.target?.race) existing.set(info.id, config.target.race);
    else if (
      !config.target?.noCommit &&
      (!config.target?.importStatus ||
        config.target.importStatus === 200 ||
        config.target.importStatus === 201)
    )
      existing.set(info.id, {
        messages: body.messages,
        info: {
          ...body.info,
          location: { directory },
          time: {
            created: info.time.created,
            updated: 4,
            idle: 3,
          },
        },
      });
    if (config.target?.lostReply)
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        }),
      );
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(null, { status: config.target?.importStatus ?? 200 }),
      ),
    );
  };
  const http = HttpClient.make((request, url) => {
    if (url.port === "4321") return privateServer.http.execute(request);
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.headers["authorization"] !== `Basic ${btoa("opencode:target-password")}`)
      throw new Error("Wrong interactive authentication");
    if (config.target?.hang) return Effect.never;
    return request.method === "GET"
      ? Effect.succeed(targetGet(request, url.pathname.split("/")[4] ?? ""))
      : targetPost(request);
  });
  const privateLayer = OpenCode.layer({
    url: "http://127.0.0.1:4321",
    password: "secret",
    directory,
    agent: "summarizer",
  }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)));
  const discover = async () => {
    discoveries++;
    if (config.discoveryFailure) throw new Error("private service secret");
    if (config.discoveryHang) return new Promise<typeof endpoint>(() => undefined);
    return config.unavailable ? undefined : (config.discoveryEndpoint ?? endpoint);
  };
  const layer = SessionPublication.layer(directory, discover).pipe(
    Layer.provideMerge(privateLayer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  const run = <A, E>(program: Effect.Effect<A, E, SessionPublication>) =>
    program.pipe(Effect.provide(layer));
  return {
    run,
    requests,
    imports,
    privateServer,
    get discoveries() {
      return discoveries;
    },
  };
};
