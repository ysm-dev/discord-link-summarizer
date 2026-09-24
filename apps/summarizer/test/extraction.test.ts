import { afterEach, expect, it, vi } from "vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ToolEditor, Info } from "@opencode/plugin/promise/tool";
import { Effect } from "effect";
import plugin from "../src/extraction-plugin.ts";
import * as runner from "../src/extraction-runner.ts";
import { extractionUrl } from "../src/extraction-url.ts";

afterEach(() => vi.restoreAllMocks());

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
});

it("validates model input shape, URL syntax and length before extraction", () => {
  for (const input of [
    null,
    "x",
    "https://example.com",
    ["https://example.com"],
    {},
    { url: 3 },
    { url: "https://example.com", command: "id" },
  ]) {
    expect(() => extractionUrl(input, "page")).toThrow("Expected one URL string");
  }
  expect(() => extractionUrl({ url: `https://example.com/${"a".repeat(4096)}` }, "page")).toThrow(
    "Expected an http(s) URL",
  );
  expect(() => extractionUrl({ url: "https://%" }, "page")).toThrow("Invalid URL");
  expect(extractionUrl({ url: `https://example.com/${"a".repeat(4076)}` }, "page")).toHaveLength(
    4096,
  );
});

it("keeps shell metacharacters as URL data and limits captions to YouTube", () => {
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
  expect(() => extractionUrl({ url: "https://youtube.com.evil.example/" }, "youtube")).toThrow(
    "Expected a YouTube URL",
  );
});

it("registers two direct V2 tools and validates input before running them", async () => {
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
  expect(tools.map((tool) => tool.options)).toEqual([
    { namespace: "summarizer", permission: "summarizer_extract_page", codemode: false },
    { namespace: "summarizer", permission: "summarizer_extract_youtube", codemode: false },
  ]);
  expect(tools.map((tool) => tool.description)).toEqual([
    "Run the trusted scripts/url-to-markdown.ts on a public URL",
    "Run the trusted scripts/youtube-subtitles.ts on a YouTube URL",
  ]);
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
  const extract = vi
    .spyOn(runner, "runExtraction")
    .mockImplementation(() => Effect.succeed("markdown"));
  const signal = new AbortController().signal;
  await expect(
    tools[0]!.execute({ url: "https://example.com" }, fromPartial({ signal })),
  ).resolves.toEqual({ content: "markdown" });
  expect(extract).toHaveBeenCalledWith("page", "https://example.com", "/trusted/translate");
  await expect(
    tools[1]!.execute({ url: "https://youtu.be/abc" }, fromPartial({ signal })),
  ).resolves.toEqual({ content: "markdown" });
  expect(extract).toHaveBeenCalledWith("youtube", "https://youtu.be/abc", "/trusted/translate");
  await expect(
    tools[1]!.execute({ url: "https://example.com" }, fromPartial({ signal })),
  ).rejects.toThrow("Expected a YouTube URL");
  expect(extract).toHaveBeenCalledTimes(2);
  extract.mockImplementationOnce(() => Effect.never);
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    tools[0]!.execute({ url: "https://example.com" }, fromPartial({ signal: aborted.signal })),
  ).rejects.toBeDefined();
});
