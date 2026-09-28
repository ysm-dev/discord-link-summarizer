import { resolve } from "node:path";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ExtractionKind } from "./extraction-url.ts";

const BUN = "/Users/chris/.bun/bin/bun";
const TIMEOUT = 180_000;
// oxlint-disable-next-line eslint/no-control-regex -- Strip terminal control bytes from untrusted page text.
const outputControls = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

class ExtractionFailure extends Error {
  readonly ["_tag"] = "ExtractionFailure";
}

const scripts: Record<ExtractionKind, string> = {
  page: "url-to-markdown.ts",
  youtube: "youtube-subtitles.ts",
};

export function runExtraction(kind: ExtractionKind, url: string, directory: string) {
  const command = ChildProcess.make(BUN, [resolve(directory, "scripts", scripts[kind]), url], {
    cwd: directory,
    shell: false,
    detached: true,
    stdin: "ignore",
    stderr: "ignore",
    env: { ...process.env, DEBUG_YOUTUBE_SUBTITLES: "" },
    // Bun's spawner terminates the POSIX process group on scope release, then escalates.
    forceKillAfter: "1500 millis",
  });
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);
    const chunks: Buffer[] = [];
    // OpenCode applies the Location's tool_output limits to the returned result.
    yield* Stream.runForEach(child.stdout, (chunk) =>
      Effect.sync(() => {
        chunks.push(Buffer.from(chunk));
      }),
    );
    if ((yield* child.exitCode) !== 0)
      return yield* Effect.fail(new ExtractionFailure("Extraction failed"));
    return Buffer.concat(chunks).toString("utf8").replace(outputControls, "");
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      error instanceof ExtractionFailure ? error : new ExtractionFailure("Extraction failed"),
    ),
    Effect.timeoutOrElse({
      duration: TIMEOUT,
      orElse: () => Effect.fail(new ExtractionFailure("Extraction timed out")),
    }),
  );
}
