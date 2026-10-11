import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { OpenCode } from "../src/opencode-client.ts";
import { fakeOpenCode, withFake } from "./opencode-fake.ts";

const requireExtraction = Effect.gen(function* () {
  return yield* (yield* OpenCode).plugins(["summarizer-extraction"]);
});
const pluginReads = (fake: ReturnType<typeof fakeOpenCode>) =>
  fake.requests.filter((request) => request.startsWith("GET /api/plugin"));
const failure = (ref: string, id?: string) => ({
  ...(id ? { id } : {}),
  source: { type: "local", path: "/workspace/.opencode/plugins/summarizer-extraction" },
  features: { server: true },
  state: { status: "failed", error: "Plugin failed to load", ref },
});
const described = (ref: string) =>
  `{"error":"Plugin failed to load","path":"/workspace/.opencode/plugins/summarizer-extraction","ref":"${ref}","status":"failed","type":"local"}`;

it.effect("waits for a freshly started server to list the active plugin", () =>
  Effect.gen(function* () {
    const fake = fakeOpenCode({ pluginsLoading: 2 });
    const fiber = yield* Effect.forkChild(withFake(requireExtraction, fake));
    yield* TestClock.adjust("1 second");
    expect(pluginReads(fake)).toHaveLength(2);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(fiber);
    expect(pluginReads(fake)).toEqual(
      Array(3).fill("GET /api/plugin?location%5Bdirectory%5D=%2Fworkspace"),
    );
  }),
);

it.effect("reports every failed plugin when the required one never becomes active", () =>
  Effect.gen(function* () {
    const other = { id: "other", source: { type: "builtin" }, state: { status: "active" } };
    for (const [data, failed] of [
      [[], ""],
      [
        [failure("err_1"), other, failure("err_2", "summarizer-extraction")],
        `${described("err_1")}, ${described("err_2")}`,
      ],
    ] as const) {
      const fake = fakeOpenCode({ payloads: { plugins: { location: {}, data } } });
      const fiber = yield* Effect.forkChild(Effect.flip(withFake(requireExtraction, fake)));
      yield* TestClock.adjust("30 seconds");
      expect((yield* Fiber.join(fiber)).reason).toBe(
        `OpenCode plugin summarizer-extraction is not active; failed plugins: [${failed}]`,
      );
      expect(pluginReads(fake)).toHaveLength(11);
    }
  }),
);

it.effect("bounds an unavailable, malformed or hanging plugin registry", () =>
  Effect.gen(function* () {
    for (const [config, reason] of [
      [{ fault: "plugins" }, "OpenCode plugin registry unavailable"],
      [{ payloads: { plugins: { data: null } } }, "OpenCode plugin registry unavailable"],
      [
        { payloads: { plugins: { data: [{ id: 7, source: {}, state: {} }] } } },
        "OpenCode plugin registry unavailable",
      ],
      [
        { payloads: { plugins: { data: [{ source: {} }] } } },
        "OpenCode plugin registry unavailable",
      ],
      [{ hangPlugins: true }, "OpenCode plugin readiness timed out"],
    ] as const) {
      const fake = fakeOpenCode(config);
      const fiber = yield* Effect.forkChild(Effect.flip(withFake(requireExtraction, fake)));
      yield* TestClock.adjust("30 seconds");
      expect((yield* Fiber.join(fiber)).reason).toBe(reason);
    }
  }),
);
