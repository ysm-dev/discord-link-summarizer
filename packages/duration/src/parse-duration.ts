import type { Result } from "./result.ts";

const MILLISECONDS_PER_UNIT = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
} as const;

type Unit = keyof typeof MILLISECONDS_PER_UNIT;

const isDigit = (character: string): boolean => character >= "0" && character <= "9";

const isUnit = (candidate: string): candidate is Unit =>
  Object.hasOwn(MILLISECONDS_PER_UNIT, candidate);

/**
 * Parses a duration such as `"90m"` into milliseconds.
 *
 * Takes `unknown` because callers pass untrusted input: CLI arguments, parsed
 * JSON, environment variables. The value is narrowed here, at the boundary, and
 * everything downstream receives a `number`.
 */
// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrows untrusted CLI/JSON/env input to string before anything downstream sees it
export const parseDuration = (input: unknown): Result<number, string> => {
  if (typeof input !== "string") {
    return { ok: false, error: "duration must be a string" };
  }

  const text = input.trim();

  let boundary = 0;
  while (isDigit(text.charAt(boundary))) {
    boundary += 1;
  }

  if (boundary === 0) {
    return { ok: false, error: "duration must start with a number" };
  }

  const unit = text.slice(boundary);

  if (!isUnit(unit)) {
    return { ok: false, error: `duration has an unknown unit: "${unit}"` };
  }

  return { ok: true, value: Number(text.slice(0, boundary)) * MILLISECONDS_PER_UNIT[unit] };
};
