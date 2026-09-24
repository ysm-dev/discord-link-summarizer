import { expect, it } from "@effect/vitest";
import { splitSummary } from "../src/summary.ts";

it("splits without losing characters, preferring paragraphs, lines, then hard cuts", () => {
  for (const text of [
    "",
    "short",
    "abc\n\ndef\nghi",
    "a".repeat(4500),
    "a".repeat(1980) + "\n\n" + "b".repeat(1980) + "\n\n" + "c".repeat(510),
    "first\n```ts\n" + "x".repeat(60) + "\n```\nend",
    "hello😀world".repeat(300),
  ]) {
    const parts = splitSummary(text);
    expect(parts.join("")).toBe(text);
    expect(parts.every((part) => part.length <= 2000 && part.length > 0)).toBe(true);
  }
  const paragraphs = "a".repeat(1980) + "\n\n" + "b".repeat(1980) + "\n\n" + "c".repeat(510);
  expect(splitSummary(paragraphs)).toEqual([
    "a".repeat(1980) + "\n\n",
    "b".repeat(1980) + "\n\n",
    "c".repeat(510),
  ]);
  expect(splitSummary("abc\ndef\nghi", 7)).toEqual(["abc\n", "def\nghi"]);
  expect(splitSummary("abc\n\ndef\nghi", 9)).toEqual(["abc\n\n", "def\nghi"]);
  expect(splitSummary("abc\n \ndef\nghi", 10)).toEqual(["abc\n \n", "def\nghi"]);
  expect(splitSummary("123456789", 4)).toEqual(["1234", "5678", "9"]);
  expect(splitSummary("abc😀def", 4)).toEqual(["abc", "😀de", "f"]);
  expect(() => splitSummary("😀", 1)).toThrow("too small");
  const fenced = "intro\n```ts\n" + "x".repeat(50) + "\n```\nend";
  expect(splitSummary(fenced, 60)[0]).toBe("intro\n");
  expect(splitSummary("intro\nnot a fence ```\nlast line", 28)[0]).toBe("intro\nnot a fence ```\n");
  expect(splitSummary("head\n  ```ts\n" + "x".repeat(30) + "\n```\ntail", 36)[0]).toBe("head\n");
  expect(splitSummary("head\n```ts\n" + "x".repeat(60) + "\n```\nend", 25)).toEqual([
    "head\n",
    "```ts\n" + "x".repeat(19),
    "x".repeat(25),
    "x".repeat(16) + "\n```\nend",
  ]);
  const multilineFence = "head\n```ts\n" + "x".repeat(28) + "\n" + "y".repeat(28) + "\n```\nend";
  expect(splitSummary(multilineFence, 20)[2]?.length).toBe(20);
  expect(splitSummary("```\n" + "x".repeat(70) + "\n```", 40).join("")).toBe(
    "```\n" + "x".repeat(70) + "\n```",
  );
  expect(() => splitSummary("abc", 0)).toThrow("Part limit must be a positive integer");
  expect(() => splitSummary("abc", 1.5)).toThrow("Part limit");
});
