import { Service } from "@opencode/client/service";
import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { OpenCode, OpenCodeError, Transfer } from "./opencode-client.ts";
import { boundedJson, maxTransferBytes, TransferSizeError } from "./transfer-http.ts";

const fail = (reason: string) => new OpenCodeError({ reason });
const Endpoint = Schema.Struct({
  url: Schema.String,
  auth: Schema.optionalKey(
    Schema.Struct({
      type: Schema.Literal("basic"),
      username: Schema.String,
      password: Schema.String,
    }),
  ),
});
const Info = Schema.Struct({
  id: Schema.String,
  outcome: Schema.Literals(["succeeded", "failed", "interrupted"]),
  time: Schema.Struct({ created: Schema.Finite, updated: Schema.Finite, idle: Schema.Finite }),
  location: Schema.Struct({ directory: Schema.String }),
  metadata: Schema.Struct({
    summarizer: Schema.Struct({
      channelID: Schema.String,
      messageID: Schema.String,
      runID: Schema.String,
    }),
  }),
});
const Export = Schema.Struct({ data: Transfer });
type Endpoint = typeof Endpoint.Type;
export type PublicationResult =
  | { readonly type: "published"; readonly id: string }
  | { readonly type: "deferred"; readonly id: string; readonly reason: string };

// Import reconstructs projectID, subpath and updated/viewed timestamps in the target.
// The remaining values and every settled message must be identical.
const immutableFields = [
  "id",
  "parentID",
  "title",
  "agent",
  "model",
  "metadata",
  "permissions",
  "cost",
  "tokens",
  "outcome",
] as const;
const canonical = (value: Schema.Json): string =>
  JSON.stringify(value, (_key, item: Schema.Json) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const identity = (info: Transfer["info"], time: typeof Info.Type.time) => ({
  ...Object.fromEntries(immutableFields.map((key) => [key, info[key] ?? null])),
  time: { created: time.created, idle: time.idle },
});

/** Discover only. A missing target or failed transfer leaves the private transcript available for a later Run. */
export class SessionPublication extends Context.Service<
  SessionPublication,
  {
    readonly publish: (id: string, deleteSessions: boolean) => Effect.Effect<PublicationResult>;
    readonly pending: (
      deleteSessions: boolean,
    ) => Effect.Effect<readonly PublicationResult[], OpenCodeError>;
  }
>()(import.meta.url) {
  static layer(directory: string, discover: typeof Service.discover = Service.discover) {
    return Layer.effect(
      SessionPublication,
      Effect.gen(function* () {
        const privateClient = yield* OpenCode;
        const http = yield* HttpClient.HttpClient;
        const checked = (transfer: Transfer, id: string) =>
          Schema.decodeUnknownEffect(Info)(transfer.info).pipe(
            Effect.mapError(() => fail(`Session ${id} has invalid terminal ownership or location`)),
            Effect.filterOrFail(
              (info) => info.id === id && info.location.directory === directory,
              () => fail(`Session ${id} has unexpected identity or location`),
            ),
          );
        const target = () =>
          Effect.tryPromise({
            try: () => discover(),
            catch: () => fail("Interactive OpenCode discovery failed"),
          }).pipe(
            Effect.timeoutOrElse({
              duration: "4 seconds",
              orElse: () => Effect.fail(fail("Interactive OpenCode discovery timed out")),
            }),
            Effect.flatMap((endpoint) =>
              endpoint
                ? Schema.decodeUnknownEffect(Endpoint)(endpoint).pipe(
                    Effect.mapError(() => fail("Invalid interactive OpenCode endpoint")),
                  )
                : Effect.fail(fail("Interactive OpenCode service unavailable")),
            ),
          );
        const request = (endpoint: Endpoint, id: string) =>
          http
            .get(`${endpoint.url}/api/experimental/session/${encodeURIComponent(id)}/export`, {
              urlParams: { sanitize: "false" },
              headers: Service.headers(endpoint),
            })
            .pipe(
              Effect.flatMap((response) =>
                response.status === 404
                  ? Effect.succeed(undefined)
                  : response.status === 200
                    ? boundedJson(response, Export).pipe(Effect.map((body) => body.data))
                    : Effect.fail(fail(`Interactive OpenCode export returned ${response.status}`)),
              ),
              Effect.timeout("15 seconds"),
              Effect.mapError((error) =>
                error instanceof OpenCodeError
                  ? error
                  : fail(
                      error instanceof TransferSizeError
                        ? error.reason
                        : `Cannot verify interactive OpenCode session ${id}`,
                    ),
              ),
            );
        const verify = Effect.fnUntraced(function* (
          endpoint: Endpoint,
          id: string,
          source: Transfer,
          sourceInfo: typeof Info.Type,
        ) {
          const existing = yield* request(endpoint, id);
          if (!existing) return false;
          const info = yield* checked(existing, id);
          if (
            canonical(identity(source.info, sourceInfo.time)) !==
              canonical(identity(existing.info, info.time)) ||
            canonical(source.messages) !== canonical(existing.messages)
          )
            return yield* fail(`Interactive OpenCode session ID collision: ${id}`);
          return true;
        });
        const transfer = Effect.fnUntraced(function* (id: string) {
          const source = yield* privateClient.exportSession(id);
          const sourceInfo = yield* checked(source, id);
          const endpoint = yield* target();
          if (yield* verify(endpoint, id, source, sourceInfo)) return undefined;
          const body = { ...source, location: { directory } };
          if (Buffer.byteLength(JSON.stringify(body)) > maxTransferBytes)
            return yield* fail(`OpenCode session ${id} exceeds import size limit`);
          const response = yield* HttpClientRequest.post(
            `${endpoint.url}/api/experimental/session/import`,
            {
              headers: Service.headers(endpoint),
            },
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
            http.execute,
            Effect.timeout("15 seconds"),
            Effect.catch(() =>
              verify(endpoint, id, source, sourceInfo).pipe(
                Effect.flatMap((same) =>
                  same
                    ? Effect.succeed(undefined)
                    : Effect.fail(fail(`Interactive OpenCode import deferred for ${id}`)),
                ),
              ),
            ),
          );
          if (response && response.status !== 200 && response.status !== 409)
            return yield* fail(`Interactive OpenCode import returned ${response.status}`);
          if (!(yield* verify(endpoint, id, source, sourceInfo)))
            return yield* fail(`Interactive OpenCode import not visible for ${id}`);
          return undefined;
        });
        const publish = (id: string, deleteSessions: boolean): Effect.Effect<PublicationResult> =>
          deleteSessions
            ? Effect.succeed({
                type: "deferred",
                id,
                reason: "Session retention and publication disabled",
              })
            : transfer(id).pipe(
                Effect.as({ type: "published", id } as const),
                Effect.catch((error) =>
                  Effect.succeed({ type: "deferred", id, reason: error.reason } as const),
                ),
              );
        const pending = Effect.fnUntraced(
          function* (deleteSessions: boolean) {
            if (deleteSessions) return [];
            const ids = yield* privateClient.terminalSessions;
            const results: PublicationResult[] = [];
            for (const id of ids) results.push(yield* publish(id, false));
            return results;
          },
          Effect.timeoutOrElse({
            duration: "60 seconds",
            orElse: () => Effect.fail(fail("OpenCode publication sweep timed out")),
          }),
        );
        return SessionPublication.of({ publish, pending });
      }),
    );
  }
}
