import { expect, it } from "@effect/vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import { Effect, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
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

const directory = "/workspace";
const source = {
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

const endpoint = {
  url: "http://127.0.0.1:4444",
  auth: { type: "basic" as const, username: "opencode", password: "target-password" },
};
const publish = Effect.flatMap(SessionPublication, (service) => service.publish("ses_one", false));
const pending = Effect.flatMap(SessionPublication, (service) => service.pending(false));
const skipPending = Effect.flatMap(SessionPublication, (service) => service.pending(true));
const disabledPublish = Effect.flatMap(SessionPublication, (service) =>
  service.publish("ses_one", true),
);
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

const harness = (
  config: {
    readonly pages?: ReadonlyArray<ReadonlyArray<object>>;
    readonly source?: object;
    readonly target?: TargetOptions;
    readonly unavailable?: boolean;
    readonly discoveryFailure?: boolean;
    readonly discoveryHang?: boolean;
    readonly discoveryEndpoint?: typeof endpoint;
    readonly hangExport?: boolean;
    readonly slowList?: boolean;
  } = {},
) => {
  const privateServer = fakeOpenCode({
    pages: config.pages ?? [[session("ses_one", "succeeded")]],
    exports: { ses_one: config.source ?? source },
    hangExport: config.hangExport,
    slowList: config.slowList,
  });
  const requests: string[] = [];
  const imports: object[] = [];
  let existing = config.target?.existing;
  const imported = Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({
        info: Transfer.fields.info,
        messages: Transfer.fields.messages,
        location: Schema.Struct({ directory: Schema.String }),
      }),
    ),
  );
  const targetGet = (request: HttpClientRequest.HttpClientRequest) =>
    HttpClientResponse.fromWeb(
      request,
      config.target?.exportStatus
        ? new Response(null, { status: config.target.exportStatus })
        : existing
          ? Response.json({ data: config.target?.exportBody ?? existing })
          : new Response(null, { status: 404 }),
    );
  const targetPost = (request: HttpClientRequest.HttpClientRequest) => {
    if (!(request.body instanceof HttpBody.Uint8Array) || !request.body.text)
      throw new Error("Missing import");
    const body = imported(request.body.text);
    imports.push(body);
    if (config.target?.race) existing = config.target.race;
    else if (
      !config.target?.noCommit &&
      (!config.target?.importStatus ||
        config.target.importStatus === 200 ||
        config.target.importStatus === 201)
    )
      existing = {
        messages: body.messages,
        info: { ...body.info, location: { directory }, time: { created: 1, updated: 4, idle: 3 } },
      };
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
    return request.method === "GET" ? Effect.succeed(targetGet(request)) : targetPost(request);
  });
  const privateLayer = OpenCode.layer({
    url: "http://127.0.0.1:4321",
    password: "secret",
    directory,
    agent: "summarizer",
  }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)));
  const discover = async () => {
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
  return { run, requests, imports, privateServer };
};

it.effect(
  "publishes only owned terminal sessions across all pages, retaining private transcripts",
  () =>
    Effect.gen(function* () {
      const test = harness({
        pages: [
          [
            session("ses_live"),
            { ...session("ses_other", "succeeded"), metadata: {} },
            { id: "ses_unowned", time: { created: 1, updated: 2 }, outcome: "succeeded" },
          ],
          [session("ses_one", "succeeded")],
        ],
      });
      const results = yield* test.run(pending);
      expect(results).toEqual([{ type: "published", id: "ses_one" }]);
      expect(test.imports).toEqual([{ ...source, location: { directory } }]);
      expect(test.requests).toEqual([
        "GET /api/experimental/session/ses_one/export?sanitize=false",
        "POST /api/experimental/session/import",
        "GET /api/experimental/session/ses_one/export?sanitize=false",
      ]);
      expect(test.privateServer.requests).not.toContain("DELETE /api/session/ses_one");
    }),
);

it.effect("reconciles an already imported ID, a 409, and an import whose reply was lost", () =>
  Effect.gen(function* () {
    for (const target of [
      { existing: source },
      { importStatus: 409, race: source },
      { lostReply: true },
    ]) {
      const test = harness({ target });
      expect(yield* test.run(publish)).toEqual({ type: "published", id: "ses_one" });
      expect(test.imports).toHaveLength("existing" in target ? 0 : 1);
    }
  }),
);

it.effect(
  "defers a wrong-ID collision, stopped target, malformed or unfinished source, and failed import",
  () =>
    Effect.gen(function* () {
      for (const scenario of [
        { target: { existing: { ...source, messages: [] } } },
        { unavailable: true },
        { source: { ...source, info: { ...source.info, time: { created: 1, updated: 3 } } } },
        { source: { ...source, info: { ...source.info, metadata: {} } } },
        { target: { importStatus: 503 } },
        {
          target: {
            importStatus: 409,
            race: { ...source, info: { ...source.info, title: "other" } },
          },
        },
      ]) {
        const test = harness(scenario);
        const result = yield* test.run(publish);
        expect(result.type).toBe("deferred");
        expect(test.privateServer.requests).not.toContain("DELETE /api/session/ses_one");
      }
    }),
);

it.effect(
  "disables publication in delete mode and bounds hanging target and oversized export",
  () =>
    Effect.gen(function* () {
      const disabled = harness();
      expect(yield* disabled.run(skipPending)).toEqual([]);
      expect(disabled.requests).toEqual([]);
      const huge = harness({
        source: { ...source, messages: [{ text: "x".repeat(2 * 1024 * 1024) }] },
      });
      expect(yield* huge.run(publish)).toEqual({
        type: "deferred",
        id: "ses_one",
        reason: "OpenCode transfer exceeds size limit",
      });
      expect(huge.requests).toEqual([]);
      const disabledSingle = harness();
      expect(yield* disabledSingle.run(disabledPublish)).toEqual({
        type: "deferred",
        id: "ses_one",
        reason: "Session retention and publication disabled",
      });
      expect(disabledSingle.privateServer.requests).toEqual([
        "GET /api/agent?location%5Bdirectory%5D=%2Fworkspace",
      ]);
    }),
);

it.effect(
  "rejects mismatched location, identity, outcome and message content without importing",
  () =>
    Effect.gen(function* () {
      for (const existing of [
        { ...source, info: { ...source.info, location: { directory: "/elsewhere" } } },
        { ...source, info: { ...source.info, id: "ses_wrong" } },
        { ...source, info: { ...source.info, outcome: "failed" } },
        {
          ...source,
          info: {
            ...source.info,
            metadata: { summarizer: { channelID: "other", messageID: "message", runID: "run" } },
          },
        },
        { ...source, messages: [{ ...source.messages[0], text: "tampered" }] },
        { ...source, info: { ...source.info, time: { created: 1, updated: 4, idle: 5 } } },
      ]) {
        const test = harness({ target: { existing } });
        const result = yield* test.run(publish);
        expect(result).toEqual({
          type: "deferred",
          id: "ses_one",
          reason:
            existing.info.id === "ses_wrong" || existing.info.location.directory === "/elsewhere"
              ? "Session ses_one has unexpected identity or location"
              : "Interactive OpenCode session ID collision: ses_one",
        });
        expect(test.imports).toEqual([]);
      }
    }),
);

it.effect(
  "defers malformed target, unsupported export route, target disappearance and absent import visibility",
  () =>
    Effect.gen(function* () {
      for (const [target, reason] of [
        [
          { existing: source, exportBody: { info: null } },
          "Cannot verify interactive OpenCode session ses_one",
        ],
        [
          { existing: source, exportBody: {} },
          "Cannot verify interactive OpenCode session ses_one",
        ],
        [
          {
            existing: source,
            exportBody: { ...source, messages: [{ text: "x".repeat(2 * 1024 * 1024) }] },
          },
          "OpenCode transfer exceeds size limit",
        ],
        [{ exportStatus: 503 }, "Interactive OpenCode export returned 503"],
        [
          { exportStatus: 404, noCommit: true },
          "Interactive OpenCode import not visible for ses_one",
        ],
        [{ importStatus: 409 }, "Interactive OpenCode import not visible for ses_one"],
        [{ lostReply: true, noCommit: true }, "Interactive OpenCode import deferred for ses_one"],
        [{ importStatus: 201 }, "Interactive OpenCode import returned 201"],
        [
          { existing: { ...source, info: { ...source.info, metadata: {} } } },
          "Session ses_one has invalid terminal ownership or location",
        ],
        [{ importStatus: 503, race: source }, "Interactive OpenCode import returned 503"],
      ] as const) {
        const test = harness({ target });
        expect(yield* test.run(publish)).toEqual({ type: "deferred", id: "ses_one", reason });
      }
    }),
);

it.effect(
  "handles discovery failures and invalid private export without disclosing their contents",
  () =>
    Effect.gen(function* () {
      for (const [config, reason] of [
        [{ discoveryFailure: true }, "Interactive OpenCode discovery failed"],
        [{ unavailable: true }, "Interactive OpenCode service unavailable"],
        [
          { discoveryEndpoint: fromPartial<typeof endpoint>({ auth: endpoint.auth }) },
          "Invalid interactive OpenCode endpoint",
        ],
        [
          {
            discoveryEndpoint: fromPartial<typeof endpoint>({
              url: endpoint.url,
              auth: fromPartial<typeof endpoint.auth>({ type: "basic" }),
            }),
          },
          "Invalid interactive OpenCode endpoint",
        ],
        [
          { source: { ...source, info: { ...source.info, id: "ses_other" } } },
          "Session ses_one has unexpected identity or location",
        ],
        [
          { source: { ...source, info: { ...source.info, location: { directory: "/other" } } } },
          "Session ses_one has unexpected identity or location",
        ],
        [
          { source: { ...source, info: { ...source.info, location: {} } } },
          "Session ses_one has invalid terminal ownership or location",
        ],
        [
          { source: { ...source, info: { ...source.info, time: {} } } },
          "Session ses_one has invalid terminal ownership or location",
        ],
        [
          {
            source: {
              ...source,
              info: {
                ...source.info,
                metadata: { summarizer: { channelID: "channel", messageID: "message" } },
              },
            },
          },
          "Session ses_one has invalid terminal ownership or location",
        ],
        [
          { source: { ...source, messages: "not an array" } },
          "Cannot export OpenCode session ses_one",
        ],
      ] as const) {
        const test = harness(config);
        const result = yield* test.run(publish);
        expect(result).toEqual({ type: "deferred", id: "ses_one", reason });
        expect(test.imports).toEqual([]);
      }
    }),
);

it.effect("accepts the exact response byte limit but rejects one byte beyond it", () =>
  Effect.gen(function* () {
    const base = { ...source, messages: [{ ...source.messages[0], text: "" }] };
    const size = 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify({ data: base }));
    for (const [extra, reason, targetRequests] of [
      [0, "OpenCode session ses_one exceeds import size limit", 1],
      [1, "OpenCode transfer exceeds size limit", 0],
    ] as const) {
      const test = harness({
        source: {
          ...source,
          messages: [{ ...source.messages[0], text: "x".repeat(size + extra) }],
        },
      });
      expect(yield* test.run(publish)).toEqual({ type: "deferred", id: "ses_one", reason });
      expect(test.requests).toHaveLength(targetRequests);
    }
    const outboundSize =
      2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify({ ...base, location: { directory } }));
    const exact = harness({
      source: { ...base, messages: [{ ...source.messages[0], text: "x".repeat(outboundSize) }] },
    });
    expect(yield* exact.run(publish)).toEqual({ type: "published", id: "ses_one" });
    expect(exact.imports).toHaveLength(1);
  }),
);

it.effect(
  "publishes failed and interrupted terminal transcripts and ignores property insertion order",
  () =>
    Effect.gen(function* () {
      for (const outcome of ["failed", "interrupted"] as const) {
        const finished = { ...source, info: { ...source.info, outcome } };
        const test = harness({ source: finished });
        expect(yield* test.run(publish)).toEqual({ type: "published", id: "ses_one" });
      }
      const reordered = {
        ...source,
        info: {
          ...source.info,
          metadata: { summarizer: { runID: "run", messageID: "message", channelID: "channel" } },
        },
        messages: source.messages.map((message) =>
          Object.fromEntries(Object.entries(message).toReversed()),
        ),
      };
      const test = harness({ target: { existing: reordered } });
      expect(yield* test.run(publish)).toEqual({ type: "published", id: "ses_one" });
      expect(test.imports).toEqual([]);
    }),
);

it.effect("rejects a target that changed a message array into an object", () =>
  Effect.gen(function* () {
    const test = harness({
      target: {
        existing: {
          ...source,
          messages: [
            source.messages[0],
            { ...source.messages[1], content: { 0: { type: "text", text: "summary" } } },
          ],
        },
      },
    });
    expect(yield* test.run(publish)).toEqual({
      type: "deferred",
      id: "ses_one",
      reason: "Interactive OpenCode session ID collision: ses_one",
    });
  }),
);

it.effect("bounds discovery and target requests with an Effect clock", () =>
  Effect.gen(function* () {
    for (const [config, reason] of [
      [{ discoveryHang: true }, "Interactive OpenCode discovery timed out"],
      [{ target: { hang: true } }, "Cannot verify interactive OpenCode session ses_one"],
      [{ hangExport: true }, "Cannot export OpenCode session ses_one"],
    ] as const) {
      const test = harness(config);
      const fiber = yield* Effect.forkChild(test.run(publish));
      yield* TestClock.adjust("20 seconds");
      expect(yield* Fiber.join(fiber)).toEqual({ type: "deferred", id: "ses_one", reason });
    }
  }),
);

it.effect("bounds a paginated source listing even when the private server stalls", () =>
  Effect.gen(function* () {
    const test = harness({ slowList: true, pages: [[], [], []] });
    const fiber = yield* Effect.forkChild(Effect.flip(test.run(pending)));
    yield* TestClock.adjust("31 seconds");
    expect((yield* Fiber.join(fiber)).reason).toBe("OpenCode session listing timed out");
  }),
);

it.effect("bounds the complete retry sweep when many publication attempts stall", () =>
  Effect.gen(function* () {
    const test = harness({
      pages: [Array.from({ length: 20 }, () => session("ses_one", "succeeded"))],
      discoveryHang: true,
    });
    const fiber = yield* Effect.forkChild(Effect.flip(test.run(pending)));
    yield* TestClock.adjust("61 seconds");
    expect((yield* Fiber.join(fiber)).reason).toBe("OpenCode publication sweep timed out");
  }),
);
