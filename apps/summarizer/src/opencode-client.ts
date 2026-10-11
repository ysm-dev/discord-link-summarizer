import { Context, Data, Deferred, Effect, Layer, Schedule, Schema, Stream } from "effect";
import { Sse } from "effect/unstable/encoding";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

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

export type OpenCodeResult =
  | { readonly type: "succeeded"; readonly text: string }
  | { readonly type: "failed"; readonly reason: string }
  | { readonly type: "interrupted" };

const canonicalJson = (value: Schema.Json): string =>
  JSON.stringify(value, (_key, item: Schema.Json) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b)))
      : item,
  );

const fail = (reason: string) => new OpenCodeError({ reason });

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
        }),
      ),
    }),
  ),
});
/** A location-bound v2 client. Construct once per private server; supply a scoped HTTP client. */
export class OpenCode extends Context.Service<
  OpenCode,
  {
    readonly model: OpenCodeModel;
    readonly commands: (names: ReadonlyArray<string>) => Effect.Effect<void, OpenCodeError>;
    /** Waits for each plugin to become active. OpenCode only logs a plugin that fails to load. */
    readonly plugins: (ids: ReadonlyArray<string>) => Effect.Effect<void, OpenCodeError>;
    /** Deletes the session on every exit. The command timeout begins after creation and SSE readiness;
     * callers needing a whole-Attempt deadline must interrupt the run effect at that deadline (not abandon its fiber). */
    readonly run: (
      attempt: OpenCodeAttempt,
      timeout: number,
    ) => Effect.Effect<OpenCodeResult, OpenCodeError>;
    readonly sweep: (olderThan: number) => Effect.Effect<number, OpenCodeError>;
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
        const Plugins = Schema.Struct({
          data: Schema.Array(
            Schema.Struct({
              id: Schema.optional(Schema.String),
              source: Schema.JsonObject,
              state: Schema.JsonObject,
            }),
          ),
        });
        const SessionResponse = Schema.Struct({ data: Session });
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
        // A new private server answers before its location has finished loading.
        const untilReady = <A>(effect: Effect.Effect<A, OpenCodeError>, timedOut: string) =>
          effect.pipe(
            Effect.retry({ times: 10, schedule: Schedule.spaced("1 second") }),
            Effect.timeoutOrElse({
              duration: "20 seconds",
              orElse: () => Effect.fail(fail(timedOut)),
            }),
          );
        const model = yield* untilReady(
          Effect.gen(function* () {
            const list = yield* agents();
            const selected = list.data.find((item) => item.name === options.agent);
            if (selected?.model) return selected.model;
            return yield* fail(`Agent ${options.agent} has no explicit model`);
          }),
          "OpenCode agent readiness timed out",
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
        // Plugins appear only after loading; a failed plugin has no ID, so report every failure.
        const plugins = (ids: ReadonlyArray<string>) =>
          untilReady(
            Effect.gen(function* () {
              const list = yield* http.get(`${options.url}/api/plugin`, { urlParams: query }).pipe(
                Effect.flatMap(HttpClientResponse.schemaBodyJson(Plugins)),
                Effect.mapError(() => fail("OpenCode plugin registry unavailable")),
              );
              const inactive = ids.find(
                (id) =>
                  !list.data.some((item) => item.id === id && item.state["status"] === "active"),
              );
              if (inactive === undefined) return undefined;
              const failed = list.data
                .filter((item) => item.state["status"] === "failed")
                .map((item) => canonicalJson({ ...item.source, ...item.state }));
              return yield* fail(
                `OpenCode plugin ${inactive} is not active; failed plugins: [${failed.join(", ")}]`,
              );
            }),
            "OpenCode plugin readiness timed out",
          );
        const remove = (id: string) =>
          http.del(`${options.url}/api/session/${encodeURIComponent(id)}`).pipe(
            Effect.catchIf(
              (error) =>
                HttpClientError.isHttpClientError(error) &&
                error.reason instanceof HttpClientError.StatusCodeError &&
                error.reason.response.status === 404,
              () => Effect.void,
            ),
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
        ): Effect.fn.Return<OpenCodeResult, OpenCodeError> {
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
        ): Effect.fn.Return<OpenCodeResult, OpenCodeError> {
          const session = yield* outcome(id);
          if (session.data.outcome === "succeeded") return yield* finalText(id);
          if (session.data.outcome === "interrupted") return { type: "interrupted" };
          if (session.data.outcome === "failed")
            return { type: "failed", reason: eventError ?? "execution-failed" };
          return yield* fail("OpenCode event stream ended without a terminal outcome");
        });

        const run = Effect.fnUntraced(function* (attempt: OpenCodeAttempt, timeout: number) {
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
          const created = yield* Effect.acquireRelease(
            HttpClientRequest.post(`${options.url}/api/session`).pipe(
              HttpClientRequest.bodyJsonUnsafe(body),
              http.execute,
              Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionResponse)),
              Effect.timeout("15 seconds"),
              Effect.mapError(() => fail("Cannot create OpenCode session")),
            ),
            ({ data }) =>
              remove(data.id).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(`${error.reason}; cleanup will retry next Run`),
                ),
              ),
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
            if (terminal === "timeout") return { type: "failed", reason: "timeout" } as const;
            return yield* result(id, terminal);
          }).pipe(
            Effect.scoped,
            Effect.onError(() => interrupt(id).pipe(Effect.ignore)),
          );
        }, Effect.scoped);

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
        const sweep = Effect.fnUntraced(function* (olderThan: number) {
          let removed = 0;
          yield* list((session) =>
            session.metadata?.summarizer && (session.outcome || session.time.updated < olderThan)
              ? remove(session.id).pipe(Effect.tap(() => Effect.sync(() => removed++)))
              : Effect.void,
          );
          return removed;
        });
        return OpenCode.of({
          model,
          commands,
          plugins,
          run,
          sweep,
        });
      }),
    );
  }
}
