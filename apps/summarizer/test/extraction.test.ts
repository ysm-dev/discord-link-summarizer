import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ToolEditor, Info } from "@opencode/plugin/promise/tool";
import plugin from "../src/extraction-plugin.ts";
import * as runner from "../src/extraction-runner.ts";
import { runExtraction } from "../src/extraction-runner.ts";
import { extractionUrl } from "../src/extraction-url.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn<typeof spawn>() }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

it.each([
  ["ftp://example.com", "page"],
  ["https://127.0.0.1/path", "page"],
  ["http://[::1]/", "page"],
  ["https://0x7f000001/", "page"],
  ["https://localhost/", "page"],
  ["https://foo.internal/", "page"],
  ["https://example.com:8080/", "page"],
  ["https://user:secret@example.com/", "page"],
  ["https://:secret@example.com/", "page"],
  ["https://example.com/\nsecond", "page"],
  ["https://example.com/", "youtube"],
] as const)("rejects unsafe URL %s for %s", (url, kind) => {
  expect(() => extractionUrl({ url }, kind)).toThrow(/Expected|Only/u);
  expect(spawn).not.toHaveBeenCalled();
});

it("rejects extra fields and excessive length at the model input boundary", () => {
  expect(() => extractionUrl({ url: "https://example.com", command: "id" }, "page")).toThrow(
    "Expected one URL string",
  );
  expect(() => extractionUrl({ url: 3 }, "page")).toThrow("Expected one URL string");
  expect(() => extractionUrl({ url: `https://example.com/${"a".repeat(4096)}` }, "page")).toThrow(
    "Expected an http(s) URL",
  );
  expect(() => extractionUrl({ url: "https://%" }, "page")).toThrow("Invalid URL");
  expect(() => extractionUrl(null, "page")).toThrow("Expected one URL string");
  expect(() => extractionUrl("https://example.com", "page")).toThrow("Expected one URL string");
  expect(() => extractionUrl("x", "page")).toThrow("Expected one URL string");
  expect(() => extractionUrl(["https://example.com"], "page")).toThrow("Expected one URL string");
  expect(() => extractionUrl({}, "page")).toThrow("Expected one URL string");
  expect(extractionUrl({ url: `https://example.com/${"a".repeat(4076)}` }, "page")).toHaveLength(
    4096,
  );
});

it("preserves shell metacharacters as URL data, but rejects them as shell syntax", () => {
  const url = "https://youtube.com/watch?v=abc;$(id)&x=%60whoami%60";
  expect(extractionUrl({ url }, "youtube")).toBe(url);
  expect(extractionUrl({ url: "https://youtu.be/abc" }, "youtube")).toBe("https://youtu.be/abc");
  expect(extractionUrl({ url: "https://www.youtube-nocookie.com/embed/abc" }, "youtube")).toBe(
    "https://www.youtube-nocookie.com/embed/abc",
  );
  expect(extractionUrl({ url: "http://example.com/path" }, "page")).toBe("http://example.com/path");
  expect(extractionUrl({ url: "https://foo.internal.evil/" }, "page")).toBe(
    "https://foo.internal.evil/",
  );
  expect(() => extractionUrl({ url: "xhttps://example.com" }, "page")).toThrow(
    "Expected an http(s) URL",
  );
  expect(() =>
    extractionUrl({ url: "https://youtube.com.evil.example/watch?v=abc" }, "youtube"),
  ).toThrow("Expected a YouTube URL");
});

function fakeChild(pid = 12345) {
  // Never allow a mutated process-group signal to reach the test runner.
  vi.spyOn(process, "kill").mockImplementation(() => true);
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn<() => boolean>(() => true),
  });
  vi.mocked(spawn).mockReturnValue(fromPartial(child));
  return child;
}

it.each([
  ["page", "url-to-markdown.ts"],
  ["youtube", "youtube-subtitles.ts"],
] as const)("runs only the fixed %s script with the URL as one argv", async (kind, script) => {
  const child = fakeChild();
  const url = "https://example.com/a;$(touch%20x)?a=%60id%60&b=>file";
  const result = runExtraction(
    kind,
    extractionUrl({ url }, "page"),
    "/trusted/translate",
    new AbortController().signal,
  );
  expect(spawn).toHaveBeenCalledWith(
    "/Users/chris/.bun/bin/bun",
    [`/trusted/translate/scripts/${script}`, url],
    expect.objectContaining({
      cwd: "/trusted/translate",
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env?.["DEBUG_YOUTUBE_SUBTITLES"]).toBe("");
  expect(child.stderr.readableFlowing).toBe(true);
  child.stdout.write("safe\u0000 output");
  child.emit("close", 0);
  await expect(result).resolves.toBe("safe output");
});

it("terminates the process group on abort and discards partial output", async () => {
  const child = fakeChild();
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  const controller = new AbortController();
  const result = runExtraction(
    "page",
    "https://example.com",
    "/trusted/translate",
    controller.signal,
  );
  child.stdout.write("partial");
  controller.abort();
  expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
  child.emit("close", null);
  await expect(result).rejects.toThrow("interrupted");
});

it("honors an already aborted signal and cannot replace its interruption reason", async () => {
  const child = fakeChild();
  vi.spyOn(process, "kill").mockImplementation(() => true);
  const controller = new AbortController();
  controller.abort();
  const result = runExtraction(
    "page",
    "https://example.com",
    "/trusted/translate",
    controller.signal,
  );
  child.stdout.write(Buffer.alloc(200_001));
  child.emit("close", null);
  await expect(result).rejects.toThrow("interrupted");
});

it("bounds output and terminates a noisy extraction", async () => {
  const child = fakeChild();
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  const result = runExtraction(
    "page",
    "https://example.com",
    "/trusted/translate",
    new AbortController().signal,
  );
  child.stdout.write(Buffer.alloc(200_001));
  expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
  child.emit("close", null);
  await expect(result).rejects.toThrow("exceeded limit");
});

it("accepts exactly the output byte limit", async () => {
  const child = fakeChild();
  const kill = vi.spyOn(process, "kill");
  const result = runExtraction(
    "page",
    "https://example.com",
    "/trusted/translate",
    new AbortController().signal,
  );
  child.stdout.write(Buffer.alloc(200_000, "a"));
  child.emit("close", 0);
  await expect(result).resolves.toHaveLength(200_000);
  expect(kill).not.toHaveBeenCalled();
});

it("enforces the deadline and escalates to SIGKILL", async () => {
  vi.useFakeTimers();
  const child = fakeChild();
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  const result = runExtraction(
    "page",
    "https://example.com",
    "/trusted/translate",
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(180_000);
  expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
  await vi.advanceTimersByTimeAsync(1500);
  expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");
  child.emit("close", null);
  await expect(result).rejects.toThrow("timed out");
});

it("clears abort and timeout callbacks when the child exits", async () => {
  vi.useFakeTimers();
  const child = fakeChild();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const kill = vi.spyOn(process, "kill");
  const result = runExtraction(
    "page",
    "https://example.com",
    "/trusted/translate",
    controller.signal,
  );
  child.emit("close", 0);
  child.emit("close", 0);
  await expect(result).resolves.toBe("");
  expect(remove).toHaveBeenCalledTimes(1);
  controller.abort();
  await vi.advanceTimersByTimeAsync(181_500);
  expect(kill).not.toHaveBeenCalled();
});

it("cancels escalation after an interrupted child exits", async () => {
  vi.useFakeTimers();
  const child = fakeChild();
  const kill = vi.spyOn(process, "kill");
  const controller = new AbortController();
  const result = runExtraction(
    "page",
    "https://example.com",
    "/trusted/translate",
    controller.signal,
  );
  controller.abort();
  child.emit("close", null);
  await expect(result).rejects.toThrow("interrupted");
  await vi.advanceTimersByTimeAsync(1500);
  expect(kill).toHaveBeenCalledTimes(1);
});

it("reports spawn and script failures without exposing stderr or the URL", async () => {
  const child = fakeChild();
  const result = runExtraction(
    "page",
    "https://example.com/secret",
    "/trusted/translate",
    new AbortController().signal,
  );
  child.stderr.write("sensitive provider message");
  child.emit("close", 1);
  await expect(result).rejects.toThrow(/^Extraction failed$/u);
});

it("reports a spawn error once, even if close follows", async () => {
  const child = fakeChild();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const result = runExtraction(
    "page",
    "https://example.com",
    "/trusted/translate",
    controller.signal,
  );
  child.emit("error", new Error("private error"));
  child.emit("close", 1);
  await expect(result).rejects.toThrow("Extraction could not start");
  expect(remove).toHaveBeenCalledTimes(1);
});

it("falls back to child.kill if the process group cannot be signaled", async () => {
  const child = fakeChild();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("no process group");
  });
  const controller = new AbortController();
  const result = runExtraction(
    "page",
    "https://example.com",
    "/trusted/translate",
    controller.signal,
  );
  controller.abort();
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  child.emit("close", null);
  await expect(result).rejects.toThrow("interrupted");
});

it("kills a child without a process group", async () => {
  const child = fakeChild(0);
  const kill = vi.spyOn(process, "kill");
  const controller = new AbortController();
  const result = runExtraction(
    "page",
    "https://example.com",
    "/trusted/translate",
    controller.signal,
  );
  controller.abort();
  expect(kill).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  child.emit("close", null);
  await expect(result).rejects.toThrow("interrupted");
});

it("falls back to child.kill if the forced process-group kill fails", async () => {
  vi.useFakeTimers();
  const child = fakeChild();
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
    if (signal === "SIGKILL") throw new Error("group gone");
    return true;
  });
  const controller = new AbortController();
  const result = runExtraction(
    "page",
    "https://example.com",
    "/trusted/translate",
    controller.signal,
  );
  controller.abort();
  await vi.advanceTimersByTimeAsync(1500);
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  child.emit("close", null);
  await expect(result).rejects.toThrow("interrupted");
});

it("registers exactly two V2 structured tools under explicit permission actions", async () => {
  const tools: Info[] = [];
  const ctx = fromPartial<Parameters<typeof plugin.setup>[0]>({
    location: fromPartial({ directory: "/trusted/translate" }),
    tool: {
      transform: async (callback: (editor: ToolEditor) => void) => {
        callback(
          fromPartial<ToolEditor>({
            namespace: (value: { name: string; description: string }) =>
              expect(value).toEqual({
                name: "summarizer",
                description: "Read public links for summaries",
              }),
            add: (tool: Info) => {
              tools.push(tool);
            },
          }),
        );
        return fromPartial({ dispose: async () => {} });
      },
    },
  });
  await plugin.setup(ctx);
  expect(plugin.id).toBe("summarizer-extraction");
  expect(tools.map((tool) => tool.name)).toEqual(["extract_page", "extract_youtube"]);
  expect(tools.map((tool) => tool.options?.permission)).toEqual([
    "summarizer_extract_page",
    "summarizer_extract_youtube",
  ]);
  expect(tools.map((tool) => tool.options?.codemode)).toEqual([false, false]);
  expect(tools.map((tool) => tool.description)).toEqual([
    "Run the trusted scripts/url-to-markdown.ts on a public URL",
    "Run the trusted scripts/youtube-subtitles.ts on a YouTube URL",
  ]);
  expect(tools.map((tool) => tool.options?.namespace)).toEqual(["summarizer", "summarizer"]);
  expect(tools.map((tool) => tool.input)).toEqual([
    {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  ]);
  const extract = vi.spyOn(runner, "runExtraction").mockResolvedValue("markdown");
  const signal = new AbortController().signal;
  await expect(
    tools[0]!.execute({ url: "https://example.com" }, fromPartial({ signal })),
  ).resolves.toEqual({ content: "markdown" });
  expect(extract).toHaveBeenCalledWith("page", "https://example.com", "/trusted/translate", signal);
  await expect(
    tools[1]!.execute({ url: "https://youtu.be/abc" }, fromPartial({ signal })),
  ).resolves.toEqual({ content: "markdown" });
  expect(extract).toHaveBeenCalledWith(
    "youtube",
    "https://youtu.be/abc",
    "/trusted/translate",
    signal,
  );
  await expect(
    tools[1]!.execute({ url: "https://example.com" }, fromPartial({ signal })),
  ).rejects.toThrow("Expected a YouTube URL");
  expect(extract).toHaveBeenCalledTimes(2);
});
