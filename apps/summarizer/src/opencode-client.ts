import { Context, Data, Deferred, Effect, Layer, Schedule, Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { boundedJson, TransferSizeError } from "./transfer-http.ts";

export type OpenCodeModel = {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string | undefined;
};
export class OpenCodeError extends Data.Error<{ readonly reason: string }> {}

export interface OpenCodeOptions {
  readonly url: string;
  readonly password: string;
  readonly directory: string;
  readonly agent: string;
}

export interface OpenCodeAttempt {
  readonly channelID: string;
  readonly messageID: string;
  readonly runID: string;
  readonly label: string;
  readonly link: string;
  readonly command: string;
}

type OpenCodeOutcome =
  | { readonly type: "succeeded"; readonly text: string }
  | { readonly type: "failed"; readonly reason: string }
  | { readonly type: "interrupted" };
export type OpenCodeResult = OpenCodeOutcome & { readonly sessionID: string };

export const canonicalJson = (value: Schema.Json): string =>
  JSON.stringify(value, (_key, item: Schema.Json) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b)))
      : item,
  );

export const Transfer = Schema.Struct({
  info: Schema.JsonObject,
  messages: Schema.Array(Schema.JsonObject),
});
export type Transfer = typeof Transfer.Type;

const fail = (reason: string) => new OpenCodeError({ reason });

/** A location-bound v2 client. Construct once per private server; supply a scoped HTTP client. */
export class OpenCode extends Context.Service<
  OpenCode,
  {
    readonly model: OpenCodeModel;
    readonly commands: (names: ReadonlyArray<string>) => Effect.Effect<void, OpenCodeError>;
    /** Returns the created session ID for direct publication. The command timeout begins after creation and SSE readiness;
     * callers needing a whole-Attempt deadline must interrupt the run effect at that deadline (not abandon its fiber). */
    readonly run: (
      attempt: OpenCodeAttempt,
      timeout: number,
      deleteSession: boolean,
    ) => Effect.Effect<OpenCodeResult, OpenCodeError>;
    readonly sweep: (
      olderThan: number,
      deleteFinished: boolean,
    ) => Effect.Effect<number, OpenCodeError>;
    readonly terminalSessions: Effect.Effect<readonly string[], OpenCodeError>;
    readonly exportSession: (id: string) => Effect.Effect<Transfer, OpenCodeError>;
    readonly markPublished: (id: string, source: Transfer) => Effect.Effect<void, OpenCodeError>;
  }
>()(import.meta.url) {
  static layer(options: OpenCodeOptions) {
    return Layer.effect(
      OpenCode,
      Effect.gen(function* () {
        const Model = Schema.Struct({
          providerID: Schema.String,
          id: Schema.String,
          variant: Schema.optional(Schema.String),
        });
        const AgentList = Schema.Struct({
          data: Schema.Array(Schema.Struct({ name: Schema.String, model: Schema.optional(Model) })),
        });
        const Commands = Schema.Struct({
          data: Schema.Array(Schema.Struct({ name: Schema.String })),
        });
        const Session = Schema.Struct({
          id: Schema.String,
          time: Schema.Struct({ created: Schema.Finite, updated: Schema.Finite }),
          outcome: Schema.optional(Schema.Literals(["succeeded", "failed", "interrupted"])),
          metadata: Schema.optional(
            Schema.Struct({
              summarizer: Schema.optional(
                Schema.Struct({
                  channelID: Schema.String,
                  messageID: Schema.String,
                  runID: Schema.String,
                  published: Schema.optional(Schema.Literal(true)),
                }),
              ),
            }),
          ),
        });
        const SessionResponse = Schema.Struct({ data: Session });
        const PublishedInfo = Schema.Struct({
          id: Schema.String,
          outcome: Schema.Literals(["succeeded", "failed", "interrupted"]),
          time: Schema.JsonObject,
          location: Schema.JsonObject,
          metadata: Schema.JsonObject,
        });
        const Sessions = Schema.Struct({
          data: Schema.Array(Session),
          cursor: Schema.Struct({ next: Schema.optional(Schema.NullOr(Schema.String)) }),
        });
        const Message = Schema.Struct({
          type: Schema.Literal("assistant"),
          finish: Schema.optional(Schema.String),
          content: Schema.Array(
            Schema.Union([
              Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
              Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String }),
              Schema.Struct({ type: Schema.Literal("tool") }),
            ]),
          ),
        });
        const Messages = Schema.Struct({ data: Schema.Array(Message) });
        const Event = Schema.Struct({
          type: Schema.String,
          data: Schema.Struct({
            sessionID: Schema.optional(Schema.String),
            error: Schema.optional(Schema.Struct({ type: Schema.String })),
          }),
        });
        const http = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest((request) =>
            HttpClientRequest.basicAuth(request, "opencode", options.password),
          ),
          HttpClient.filterStatusOk,
          HttpClient.transformResponse((response) => response.pipe(Effect.timeout("15 seconds"))),
        );
        const location = { directory: options.directory };
        const query = { "location[directory]": options.directory };
        const request = <A, I, R>(path: string, schema: Schema.Codec<A, I, R>) =>
          http.get(`${options.url}${path}`).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
            Effect.mapError(() => fail(`OpenCode request failed: ${path}`)),
          );
        const agents = () =>
          http.get(`${options.url}/api/agent`, { urlParams: query }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(AgentList)),
            Effect.mapError(() => fail("OpenCode agent registry unavailable")),
          );
        const model = yield* Effect.gen(function* () {
          const list = yield* agents();
          const selected = list.data.find((item) => item.name === options.agent);
          if (selected?.model) return selected.model;
          return yield* fail(`Agent ${options.agent} has no explicit model`);
        }).pipe(
          Effect.retry({ times: 10, schedule: Schedule.spaced("1 second") }),
          Effect.timeoutOrElse({
            duration: "20 seconds",
            orElse: () => Effect.fail(fail("OpenCode agent readiness timed out")),
          }),
        );

        const commands = Effect.fnUntraced(function* (names: ReadonlyArray<string>) {
          const list = yield* http.get(`${options.url}/api/command`, { urlParams: query }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Commands)),
            Effect.mapError(() => fail("OpenCode command registry unavailable")),
          );
          const missing = names.find((name) => !list.data.some((command) => command.name === name));
          if (missing !== undefined) return yield* fail(`Unknown OpenCode command: ${missing}`);
          return undefined;
        });
        const remove = (id: string) =>
          http.del(`${options.url}/api/session/${encodeURIComponent(id)}`).pipe(
            Effect.asVoid,
            Effect.mapError(() => fail(`Cannot delete OpenCode session ${id}`)),
          );
        const interrupt = (id: string) =>
          http
            .post(`${options.url}/api/session/${encodeURIComponent(id)}/interrupt`, {
              urlParams: { resume: "false" },
            })
            .pipe(
              Effect.asVoid,
              Effect.mapError(() => fail(`Cannot interrupt OpenCode session ${id}`)),
            );
        const outcome = (id: string) =>
          request(`/api/session/${encodeURIComponent(id)}`, SessionResponse);
        const finalText = Effect.fnUntraced(function* (
          id: string,
        ): Effect.fn.Return<OpenCodeOutcome, OpenCodeError> {
          const messages = yield* http
            .get(`${options.url}/api/session/${encodeURIComponent(id)}/message`, {
              urlParams: { type: "assistant", order: "desc", limit: "1" },
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(Messages)),
              Effect.mapError(() => fail("Cannot read assistant message")),
            );
          const message = messages.data[0];
          if (!message) return { type: "failed", reason: "missing-finish" };
          const text = message.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("");
          return message.finish === "stop" && text.trim()
            ? { type: "succeeded", text }
            : {
                type: "failed",
                reason: message.finish === "stop" ? "empty" : (message.finish ?? "missing-finish"),
              };
        });
        const result = Effect.fnUntraced(function* (
          id: string,
          eventError?: string,
        ): Effect.fn.Return<OpenCodeOutcome, OpenCodeError> {
          const session = yield* outcome(id);
          if (session.data.outcome === "succeeded") return yield* finalText(id);
          if (session.data.outcome === "interrupted") return { type: "interrupted" };
          if (session.data.outcome === "failed")
            return { type: "failed", reason: eventError ?? "execution-failed" };
          return yield* fail("OpenCode event stream ended without a terminal outcome");
        });

        const run = Effect.fnUntraced(function* (
          attempt: OpenCodeAttempt,
          timeout: number,
          deleteSession: boolean,
        ) {
          const body = {
            title: `🔗 ${attempt.label} · ${attempt.link}`,
            agent: options.agent,
            model,
            location,
            metadata: {
              summarizer: {
                channelID: attempt.channelID,
                messageID: attempt.messageID,
                runID: attempt.runID,
              },
            },
          };
          const created = yield* HttpClientRequest.post(`${options.url}/api/session`).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
            http.execute,
            Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionResponse)),
            Effect.mapError(() => fail("Cannot create OpenCode session")),
          );
          const id = created.data.id;
          return yield* Effect.gen(function* () {
            const ready = yield* Deferred.make<void, OpenCodeError>();
            const done = yield* Deferred.make<string | undefined, OpenCodeError>();
            const disconnect = Effect.fnUntraced(function* (error: OpenCodeError) {
              yield* Deferred.fail(ready, error);
              yield* Deferred.fail(done, error);
            });
            const subscriber = http.get(`${options.url}/api/event`).pipe(
              Effect.flatMap((response) =>
                response.stream.pipe(
                  Stream.decodeText,
                  Stream.pipeThroughChannel(Sse.decode()),
                  Stream.mapEffect((frame) =>
                    Schema.decodeEffect(Schema.fromJsonString(Event))(frame.data),
                  ),
                  Stream.runForEach((event) =>
                    Effect.gen(function* () {
                      if (event.type === "server.connected")
                        yield* Deferred.succeed(ready, undefined);
                      if (
                        event.data.sessionID === id &&
                        (event.type === "session.execution.succeeded" ||
                          event.type === "session.execution.failed" ||
                          event.type === "session.execution.interrupted")
                      ) {
                        yield* Deferred.succeed(
                          done,
                          event.type === "session.execution.failed"
                            ? event.data.error?.type
                            : undefined,
                        );
                      }
                    }),
                  ),
                ),
              ),
              Effect.mapError(() => fail("OpenCode SSE disconnected")),
              Effect.flatMap(() => Effect.fail(fail("OpenCode SSE closed"))),
              Effect.catch(disconnect),
            );
            yield* Effect.forkScoped(subscriber);
            yield* Deferred.await(ready).pipe(
              Effect.timeoutOrElse({
                duration: "10 seconds",
                orElse: () => Effect.fail(fail("OpenCode SSE connection timed out")),
              }),
            );
            const terminal = yield* Effect.gen(function* () {
              yield* HttpClientRequest.post(
                `${options.url}/api/session/${encodeURIComponent(id)}/command`,
              ).pipe(
                HttpClientRequest.bodyJsonUnsafe({ name: attempt.command, text: attempt.link }),
                http.execute,
                Effect.asVoid,
                Effect.mapError(() => fail(`OpenCode command failed: ${attempt.command}`)),
              );
              return yield* Deferred.await(done);
            }).pipe(
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () => interrupt(id).pipe(Effect.as("timeout")),
              }),
            );
            if (terminal === "timeout")
              return { sessionID: id, type: "failed", reason: "timeout" } as const;
            return { ...(yield* result(id, terminal)), sessionID: id };
          }).pipe(
            Effect.scoped,
            Effect.onError(() => interrupt(id).pipe(Effect.ignore)),
            Effect.ensuring(deleteSession ? remove(id).pipe(Effect.ignore) : Effect.void),
          );
        });

        const list = Effect.fnUntraced(function* (
          visit: (session: typeof Session.Type) => Effect.Effect<void, OpenCodeError>,
        ) {
          let cursor: string | undefined;
          const visited = new Set<string>();
          while (true) {
            const page = yield* http
              .get(`${options.url}/api/session`, {
                urlParams: {
                  directory: options.directory,
                  limit: "100",
                  ...(cursor ? { cursor } : {}),
                },
              })
              .pipe(
                Effect.flatMap(HttpClientResponse.schemaBodyJson(Sessions)),
                Effect.mapError(() => fail("Cannot list OpenCode sessions")),
              );
            for (const session of page.data) {
              yield* visit(session);
            }
            const next = page.cursor.next;
            if (!next) return undefined;
            if (visited.has(next)) return yield* fail("OpenCode session pagination loop");
            visited.add(next);
            cursor = next;
          }
        });
        const sweep = Effect.fnUntraced(function* (olderThan: number, deleteFinished: boolean) {
          let removed = 0;
          yield* list((session) =>
            session.metadata?.summarizer &&
            ((deleteFinished && session.outcome) ||
              (!session.outcome && session.time.updated < olderThan))
              ? remove(session.id).pipe(Effect.tap(() => Effect.sync(() => removed++)))
              : Effect.void,
          );
          return removed;
        });
        const terminalSessions = Effect.gen(function* () {
          const entries: Array<{ id: string; created: number }> = [];
          yield* list((session) =>
            session.metadata?.summarizer &&
            session.outcome &&
            !session.metadata.summarizer.published
              ? Effect.sync(() => {
                  entries.push({ id: session.id, created: session.time.created });
                })
              : Effect.void,
          );
          return entries
            .toSorted((a, b) => a.created - b.created || a.id.localeCompare(b.id))
            .map((item) => item.id);
        }).pipe(
          Effect.timeoutOrElse({
            duration: "30 seconds",
            orElse: () => Effect.fail(fail("OpenCode session listing timed out")),
          }),
        );
        const exportSession = (id: string) =>
          http
            .get(`${options.url}/api/experimental/session/${encodeURIComponent(id)}/export`, {
              urlParams: { sanitize: "false" },
            })
            .pipe(
              Effect.flatMap((response) =>
                boundedJson(response, Schema.Struct({ data: Transfer })),
              ),
              Effect.map((response) => response.data),
              Effect.timeout("15 seconds"),
              Effect.mapError((error) =>
                fail(
                  error instanceof TransferSizeError
                    ? error.reason
                    : `Cannot export OpenCode session ${id}`,
                ),
              ),
            );
        const markPublished = Effect.fnUntraced(function* (id: string, source: Transfer) {
          const info = yield* Schema.decodeUnknownEffect(PublishedInfo)(source.info).pipe(
            Effect.mapError(() => fail(`Cannot mark invalid OpenCode session ${id}`)),
          );
          const summarizer = yield* Schema.decodeUnknownEffect(Schema.JsonObject)(
            info.metadata["summarizer"],
          ).pipe(Effect.mapError(() => fail(`Cannot mark unowned OpenCode session ${id}`)));
          const metadata = { ...info.metadata, summarizer: { ...summarizer, published: true } };
          const markError = () => fail(`Cannot mark OpenCode session ${id} as published`);
          const confirm = () =>
            http.get(`${options.url}/api/session/${encodeURIComponent(id)}`).pipe(
              Effect.flatMap(
                HttpClientResponse.schemaBodyJson(Schema.Struct({ data: PublishedInfo })),
              ),
              Effect.filterOrFail(
                ({ data }) =>
                  data.id === id &&
                  data.location["directory"] === info.location["directory"] &&
                  data.outcome === info.outcome &&
                  data.time["idle"] === info.time["idle"] &&
                  canonicalJson(data.metadata) === canonicalJson(metadata),
                markError,
              ),
              Effect.asVoid,
            );
          yield* HttpClientRequest.patch(
            `${options.url}/api/session/${encodeURIComponent(id)}`,
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({ metadata }),
            http.execute,
            Effect.asVoid,
            Effect.catch(() => confirm()),
            Effect.mapError(markError),
          );
        });
        return OpenCode.of({
          model,
          commands,
          run,
          sweep,
          terminalSessions,
          exportSession,
          markPublished,
        });
      }),
    );
  }
}
