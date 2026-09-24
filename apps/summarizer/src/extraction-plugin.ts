import { Plugin } from "@opencode/plugin";
import { runExtraction } from "./extraction-runner.ts";
import { extractionUrl } from "./extraction-url.ts";

export default Plugin.define({
  id: "summarizer-extraction",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "summarizer", description: "Read public links for summaries" });
      for (const kind of ["page", "youtube"] as const) {
        editor.add({
          name: `extract_${kind}`,
          description:
            kind === "page"
              ? "Run the trusted scripts/url-to-markdown.ts on a public URL"
              : "Run the trusted scripts/youtube-subtitles.ts on a YouTube URL",
          input: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
            additionalProperties: false,
          },
          options: {
            namespace: "summarizer",
            permission: `summarizer_extract_${kind}`,
            codemode: false,
          },
          execute: async (input, context) => ({
            content: await runExtraction(
              kind,
              extractionUrl(input, kind),
              ctx.location.directory,
              context.signal,
            ),
          }),
        });
      }
    });
  },
});
