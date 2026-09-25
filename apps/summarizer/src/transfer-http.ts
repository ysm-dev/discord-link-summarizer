import { Data, Effect, Schema, Stream } from "effect";
import { HttpClientResponse } from "effect/unstable/http";

export class TransferSizeError extends Data.Error<{ readonly reason: string }> {}

export const maxTransferBytes = 2 * 1024 * 1024;

/** Read before parsing: neither a lying Content-Length nor a streaming response can evade this bound. */
export const boundedJson = <A, I, R>(
  response: HttpClientResponse.HttpClientResponse,
  schema: Schema.Codec<A, I, R>,
) =>
  response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ parts: [] as Uint8Array[], bytes: 0 }),
      (state, part) =>
        state.bytes + part.byteLength > maxTransferBytes
          ? Effect.fail(new TransferSizeError({ reason: "OpenCode transfer exceeds size limit" }))
          : Effect.succeed({ parts: [...state.parts, part], bytes: state.bytes + part.byteLength }),
    ),
    Effect.flatMap(({ parts, bytes }) =>
      Schema.decodeEffect(Schema.fromJsonString(schema))(
        new TextDecoder().decode(Buffer.concat(parts, bytes)),
      ),
    ),
  );
