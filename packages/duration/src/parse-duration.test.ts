import { describe, expect, it } from "vitest";
import { parseDuration } from "./parse-duration.ts";

describe("parseDuration", () => {
  it.each([
    ["1ms", 1],
    ["1s", 1_000],
    ["1m", 60_000],
    ["1h", 3_600_000],
  ])("converts %s to %i milliseconds", (input, expected) => {
    expect(parseDuration(input)).toEqual({ ok: true, value: expected });
  });

  it("parses a multi-digit value", () => {
    expect(parseDuration("90m")).toEqual({ ok: true, value: 5_400_000 });
  });

  it("parses a multi-character unit after a multi-digit value", () => {
    expect(parseDuration("100ms")).toEqual({ ok: true, value: 100 });
  });

  it("accepts zero", () => {
    expect(parseDuration("0s")).toEqual({ ok: true, value: 0 });
  });

  it("accepts the highest digit", () => {
    expect(parseDuration("9s")).toEqual({ ok: true, value: 9_000 });
  });

  it("ignores surrounding whitespace", () => {
    expect(parseDuration("  15m  ")).toEqual({ ok: true, value: 900_000 });
  });

  it("rejects a value that is not a string", () => {
    expect(parseDuration(90)).toEqual({ ok: false, error: "duration must be a string" });
  });

  it("rejects an empty string", () => {
    expect(parseDuration("")).toEqual({
      ok: false,
      error: "duration must start with a number",
    });
  });

  it("rejects a value with no leading number", () => {
    expect(parseDuration("m")).toEqual({
      ok: false,
      error: "duration must start with a number",
    });
  });

  it("rejects a number with no unit", () => {
    expect(parseDuration("90")).toEqual({
      ok: false,
      error: 'duration has an unknown unit: ""',
    });
  });

  it("rejects an unknown unit", () => {
    expect(parseDuration("90y")).toEqual({
      ok: false,
      error: 'duration has an unknown unit: "y"',
    });
  });

  it("does not treat inherited object properties as units", () => {
    expect(parseDuration("90toString")).toEqual({
      ok: false,
      error: 'duration has an unknown unit: "toString"',
    });
  });
});
