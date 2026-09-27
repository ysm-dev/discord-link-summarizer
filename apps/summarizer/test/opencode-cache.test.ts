import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { OpenCode } from "../src/opencode-client.ts";
import { attempt, fakeOpenCode, session, withFake } from "./opencode-fake.ts";

it.effect(
  "publication reuses the cleanup listing once, then refreshes instead of retaining stale sessions",
  () =>
    Effect.gen(function* () {
      const fake = fakeOpenCode({
        pages: [[session("ses_b", "succeeded")], [session("ses_a", "failed")]],
      });
      const pages = () =>
        fake.requests.filter((request) => request.startsWith("GET /api/session?")).length;
      yield* withFake(
        Effect.gen(function* () {
          const client = yield* OpenCode;
          expect(yield* client.sweep(500, false)).toBe(0);
          expect(pages()).toBe(2);
          expect(yield* client.terminalSessions).toEqual(["ses_a", "ses_b"]);
          expect(pages()).toBe(2);
          expect(yield* client.terminalSessions).toEqual(["ses_a", "ses_b"]);
          expect(pages()).toBe(4);
          yield* client.sweep(500, false);
          yield* client.run(attempt, 1000, false);
          expect(yield* client.terminalSessions).toEqual(["ses_a", "ses_b"]);
          expect(pages()).toBe(8);
        }),
        fake,
      );
    }),
);
