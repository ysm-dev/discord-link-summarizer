import { spawn, type ChildProcessByStdio } from "node:child_process";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { Clock, Effect } from "effect";
import type { ExtractionKind } from "./extraction-url.ts";

// OpenCode runs plugins on its own `effect` instance, so this file uses only stable `effect`
// exports and Node built-ins; Effect platform packages are version-locked to another `effect`.
const BUN = "/Users/chris/.bun/bin/bun";
const TIMEOUT = 180_000;
const FORCE_KILL_AFTER = 1_500;
const KILL_GRACE = 1_000;
const POLL = 10;
// oxlint-disable-next-line eslint/no-control-regex -- Strip terminal control bytes from untrusted page text.
const outputControls = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

class ExtractionFailure extends Error {
  readonly ["_tag"] = "ExtractionFailure";
}

type Child = ChildProcessByStdio<null, Readable, null>;

const scripts: Record<ExtractionKind, string> = {
  page: "url-to-markdown.ts",
  youtube: "youtube-subtitles.ts",
};

/** The detached child leads its own process group; signal `0` only probes for a live member. */
const signalGroup = (pid: number, signal: NodeJS.Signals | 0) => {
  try {
    process.kill(-pid, signal);
  } catch {
    return false;
  }
  return true;
};

/** Polls until no group member remains; false when the deadline passes first. */
const awaitGroupExit = (pid: number, millis: number) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + millis;
    while (signalGroup(pid, 0)) {
      if ((yield* Clock.currentTimeMillis) >= deadline) return false;
      yield* Effect.sleep(POLL);
    }
    return true;
  });

/** Ends every process the script started: SIGTERM, a bounded wait, then SIGKILL. */
const terminate = (child: Child) =>
  Effect.gen(function* () {
    const pid = child.pid;
    if (pid === undefined || !signalGroup(pid, "SIGTERM")) return;
    if (yield* awaitGroupExit(pid, FORCE_KILL_AFTER)) return;
    signalGroup(pid, "SIGKILL");
    yield* awaitGroupExit(pid, KILL_GRACE);
  });

const output = (child: Child) =>
  Effect.callback<string, ExtractionFailure>((resume) => {
    const chunks: Buffer[] = [];
    const failed = () => resume(Effect.fail(new ExtractionFailure("Extraction failed")));
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stdout.once("error", failed);
    child.once("error", failed);
    child.once("close", (code) => {
      if (code !== 0) return failed();
      return resume(
        Effect.succeed(Buffer.concat(chunks).toString("utf8").replace(outputControls, "")),
      );
    });
  });

export function runExtraction(kind: ExtractionKind, url: string, directory: string) {
  return Effect.acquireUseRelease(
    Effect.try({
      try: (): Child =>
        spawn(BUN, [resolve(directory, "scripts", scripts[kind]), url], {
          cwd: directory,
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, DEBUG_YOUTUBE_SUBTITLES: "" },
        }),
      catch: () => new ExtractionFailure("Extraction failed"),
    }),
    output,
    terminate,
  ).pipe(
    Effect.timeoutOrElse({
      duration: TIMEOUT,
      orElse: () => Effect.fail(new ExtractionFailure("Extraction timed out")),
    }),
  );
}
