import { parseDuration } from "@discord-link-summarizer/duration";

export type Invocation = {
  readonly code: number;
  readonly output: string;
};

/**
 * The whole CLI, as a pure function of its arguments.
 *
 * Nothing here touches `process`, so every branch is reachable from a plain
 * unit test. The untestable wiring lives in `index.ts`, which is the one file
 * excused from coverage in `quality-exceptions.json`.
 */
export const main = (args: readonly string[]): Invocation => {
  const input = args[0];

  if (input === undefined) {
    return { code: 2, output: "usage: duration <value>" };
  }

  const parsed = parseDuration(input);

  if (!parsed.ok) {
    return { code: 1, output: `error: ${parsed.error}` };
  }

  return { code: 0, output: String(parsed.value) };
};
