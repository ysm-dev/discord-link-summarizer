import { expect, it } from "@effect/vitest";
import { DateTime, Duration } from "effect";
import {
  attemptStatus,
  formatNote,
  parseNote,
  summaryParts,
  type Note,
  type TimedNote,
} from "../src/attempt.ts";
import { linkFromPost, linkPostState, threadTitle } from "../src/link-post.ts";
import { normalLowerBound } from "../src/window.ts";

const at = (minute: number): DateTime.Utc =>
  DateTime.makeUnsafe(1_700_000_000_000 + minute * 60000);
const started: Note = { kind: "started", number: 1, maximum: 3 };
const failed: Note = { kind: "failed", number: 1, maximum: 3, reason: "요약 없음 (empty)" };
const interrupted: Note = { kind: "interrupted", number: 1, maximum: 3 };
const note = (value: Note, minute: number): TimedNote => ({ note: value, at: at(minute) });
const message = (id: string, content: string, author: string) => ({
  id,
  content,
  author: { id: author },
});
const waits = [Duration.minutes(10), Duration.hours(1)];
const firstLink = (content: string) =>
  linkFromPost({ id: "1", type: 0, content, author: { id: "other" } }, "bot");

it("takes the first Discord-style URL only from qualifying Link Posts", () => {
  const post = {
    id: "1",
    type: 0,
    content: "Title <https://first.test/a> then https://second.test",
    author: { id: "other" },
  };
  expect(linkFromPost(post, "bot")).toBe("https://first.test/a");
  expect(linkFromPost({ ...post, type: 19 }, "bot")).toBe("https://first.test/a");
  expect(linkFromPost({ ...post, type: 18 }, "bot")).toBeUndefined();
  expect(linkFromPost({ ...post, author: { id: "bot" } }, "bot")).toBeUndefined();
  expect(linkFromPost({ ...post, content: "wachi: https://first.test" }, "bot")).toBeUndefined();
  expect(linkFromPost({ ...post, content: "no link" }, "bot")).toBeUndefined();
  expect(firstLink("(https://example.test/a(b))! and http://next.test")).toBe(
    "https://example.test/a(b)",
  );
  expect(firstLink("http://first.test and https://second.test")).toBe("http://first.test");
  expect(firstLink("https://example.test/path.,!?;:")).toBe("https://example.test/path");
  expect(firstLink("nothing")).toBeUndefined();
  expect(firstLink("https://site.test/path)) next")).toBe("https://site.test/path");
  expect(firstLink("https://site.test/a)b next")).toBe("https://site.test/a)b");
  expect(firstLink("http:// then https://valid.test/one]")).toBe("https://valid.test/one");
  expect(firstLink("http://% then https://valid.test/one")).toBe("https://valid.test/one");
  expect(firstLink("http://")).toBeUndefined();
  expect(firstLink("'https://quoted.test/path' `http://second.test`")).toBe(
    "https://quoted.test/path",
  );
});

it("derives thread title and ownership/state", () => {
  expect(threadTitle("⏳   A  title <https://site.test>\n now", "https://site.test")).toBe(
    "A title now",
  );
  expect(threadTitle("⚠️ https://site.test", "https://site.test")).toBe("요약");
  expect(threadTitle("https://site.test", "https://site.test")).toBe("요약");
  expect(threadTitle("Hello ⚠️ world https://site.test", "https://site.test")).toBe(
    "Hello ⚠️ world",
  );
  expect(threadTitle("⏳   hello https://site.test", "https://site.test")).toBe("hello");
  expect(threadTitle("a".repeat(100) + " https://site.test", "https://site.test")).toBe(
    "a".repeat(100),
  );
  expect(threadTitle("a".repeat(101) + " https://site.test", "https://site.test")).toBe(
    "a".repeat(99) + "…",
  );
  expect(linkPostState(undefined, "bot")).toBe("pending");
  expect(linkPostState({ id: "1", owner_id: "other", name: "⏳ title" }, "bot")).toBe(
    "someone-else",
  );
  expect(linkPostState({ id: "1", owner_id: "bot", name: "⏳ title" }, "bot")).toBe("in-progress");
  expect(linkPostState({ id: "1", owner_id: "bot", name: "⚠️ title" }, "bot")).toBe("given-up");
  expect(linkPostState({ id: "1", owner_id: "bot", name: "title" }, "bot")).toBe("done");
});

it("roundtrips Korean Attempt notes and classifies Summary parts", () => {
  for (const value of [started, failed, interrupted])
    expect(parseNote(formatNote(value))).toEqual(value);
  for (const text of [
    "unrelated",
    "⏳ 요약 중 (0/3)",
    "prefix ⏳ 요약 중 (1/3)",
    "⏳ 요약 중 (1/3) suffix",
    "⏳ 요약 중 (1x/3)",
    "⏳ 요약 중 (01/3)",
    "⏳ 요약 중 (1/03)",
    "⏳ 요약 중 (NaN/3)",
    "⏳ 요약 중 (1/NaN)",
    "⏳ 요약 중 (9007199254740992/9007199254740992)",
    "⏳ 요약 중 (1/9007199254740992)",
    "⏳ 요약 중 (99999999999999999999/3)",
    "⏳ 요약 중 (1/99999999999999999999)",
    "⏳ 요약 중 (4/3)",
    "⏳ 요약 중 (99999999999999999999/99999999999999999999)",
    "⏳ 요약 중 (1/3): extra",
    "⚠️ 요약 실패 (1/3)",
    "⚠️ 요약 실패 (1/3): ",
    "⏸️ 요약 중단 (1/3): wrong",
    "⏳ 요약 중 (1/3): 재시도 횟수에 포함되지 않음",
  ]) {
    expect(parseNote(text)).toBeUndefined();
  }
  expect(parseNote("⏳ 요약 중 (3/3)")).toEqual({ kind: "started", number: 3, maximum: 3 });
  expect(parseNote("⏳ 요약 중 (10/12)")).toEqual({
    kind: "started",
    number: 10,
    maximum: 12,
  });
  expect(parseNote("⚠️ 요약 실패 (1/3): 재시도 횟수에 포함되지 않음")).toEqual({
    kind: "failed",
    number: 1,
    maximum: 3,
    reason: "재시도 횟수에 포함되지 않음",
  });
  expect(
    summaryParts(
      [
        message("1", formatNote(started), "bot"),
        message("2", "text", "bot"),
        message("3", "other", "human"),
      ],
      "bot",
    ),
  ).toEqual([message("2", "text", "bot")]);
});

it("uses exact stale/retry boundaries and the failure note's timestamp", () => {
  expect(attemptStatus([], at(0), Duration.minutes(10), waits)).toEqual({
    counted: 0,
    live: false,
    due: true,
    giveUp: false,
  });
  expect(attemptStatus([note(started, 0)], at(11), Duration.minutes(10), waits)).toEqual({
    counted: 0,
    live: true,
    due: false,
    giveUp: false,
  });
  // At exactly 12 minutes the started note is stale; its retry is due from minute 0 + 10, already past.
  expect(attemptStatus([note(started, 0)], at(12), Duration.minutes(10), waits)).toEqual({
    counted: 1,
    live: false,
    due: true,
    giveUp: false,
  });
  expect(attemptStatus([note(interrupted, 0)], at(100), Duration.minutes(10), waits)).toEqual({
    counted: 0,
    live: false,
    due: true,
    giveUp: false,
  });
  expect(attemptStatus([note(interrupted, 0)], at(1), Duration.minutes(10), waits).live).toBe(
    false,
  );
  expect(
    attemptStatus([note(failed, 5), note(interrupted, 8)], at(14), Duration.minutes(10), waits).due,
  ).toBe(false);
  expect(
    attemptStatus([note(failed, 5), note(interrupted, 8)], at(15), Duration.minutes(10), waits).due,
  ).toBe(true);
  expect(
    attemptStatus(
      [note(failed, 5), note({ ...failed, number: 2 }, 20)],
      at(79),
      Duration.minutes(10),
      waits,
    ).due,
  ).toBe(false);
  expect(
    attemptStatus(
      [note(failed, 5), note({ ...failed, number: 2 }, 20)],
      at(80),
      Duration.minutes(10),
      waits,
    ).due,
  ).toBe(true);
  expect(
    attemptStatus(
      [note(failed, 5), note({ ...failed, number: 2 }, 20), note({ ...failed, number: 3 }, 81)],
      at(81),
      Duration.minutes(10),
      waits,
    ),
  ).toEqual({ counted: 3, live: false, due: false, giveUp: true });
  expect(
    attemptStatus([note(started, 11), note(failed, 5)], at(12), Duration.minutes(10), waits).live,
  ).toBe(true);
  expect(
    attemptStatus(
      [note(failed, 20), note({ ...failed, number: 2 }, 5)],
      at(29),
      Duration.minutes(10),
      waits,
    ).due,
  ).toBe(false);
});

it("caps new channels at Horizon and includes exact boundaries", () => {
  expect(normalLowerBound(at(0), at(100), Duration.minutes(10))).toBe(
    DateTime.toEpochMillis(at(90)),
  );
  expect(normalLowerBound(at(95), at(100), Duration.minutes(10))).toBe(
    DateTime.toEpochMillis(at(95)),
  );
});
