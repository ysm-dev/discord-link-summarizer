import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ExtractionKind } from "./extraction-url.ts";

const BUN = "/Users/chris/.bun/bin/bun";
const LIMIT = 200_000;
const TIMEOUT = 180_000;
// oxlint-disable-next-line eslint/no-control-regex -- Strip terminal control bytes from untrusted page text.
const outputControls = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

const scripts: Record<ExtractionKind, string> = {
  page: "url-to-markdown.ts",
  youtube: "youtube-subtitles.ts",
};

export async function runExtraction(
  kind: ExtractionKind,
  url: string,
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  // Only fixed trusted executables and script paths; the URL is ONE argv item, never shell source.
  const child = spawn(BUN, [resolve(directory, "scripts", scripts[kind]), url], {
    cwd: directory,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEBUG_YOUTUBE_SUBTITLES: "" },
  });
  return new Promise((resolveOutput, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let reason: string | undefined;
    let force: NodeJS.Timeout | undefined;
    let finished = false;

    const terminate = (cause: string) => {
      if (reason) return;
      reason = cause;
      // Bun's extraction scripts can launch Chrome: terminate the whole process group.
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        force = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }, 1500);
      } else {
        child.kill("SIGTERM");
      }
    };
    const timeout = setTimeout(() => terminate("Extraction timed out"), TIMEOUT);
    const abort = () => terminate("Extraction interrupted");
    signal.addEventListener("abort", abort);
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > LIMIT) terminate("Extraction output exceeded limit");
      else chunks.push(chunk);
    });
    child.stderr.resume();
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(force);
      signal.removeEventListener("abort", abort);
      if (reason || error) reject(new Error(reason ?? error));
      else resolveOutput(Buffer.concat(chunks).toString("utf8").replace(outputControls, ""));
    };
    child.once("error", () => finish("Extraction could not start"));
    child.once("close", (code) => finish(code === 0 ? undefined : "Extraction failed"));
  });
}
