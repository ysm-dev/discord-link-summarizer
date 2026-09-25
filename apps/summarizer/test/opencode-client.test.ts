import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { OpenCode, Transfer } from "../src/opencode-client.ts";
import { attempt, fakeOpenCode, session, withFake } from "./opencode-fake.ts";

const timedFailure = (fake: ReturnType<typeof fakeOpenCode>, until: string, seconds: number) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      Effect.flip(
        withFake(
          Effect.gen(function* () {
            return yield* (yield* OpenCode).run(attempt, 1000, false);
          }),
          fake,
        ),
      ),
    );
    while (!fake.requests.some((path) => path.includes(until))) yield* Effect.yieldNow;
    yield* TestClock.adjust(`${seconds} seconds`);
    return yield* Fiber.join(fiber);
  });
const malformed = (info: Schema.JsonObject) =>
  Schema.decodeUnknownSync(Transfer)({ info, messages: [] });

it.effect("validates publication metadata before updating a private session", () =>
  Effect.gen(function* () {
    const fake = fakeOpenCode();
    const program = Effect.gen(function* () {
      const client = yield* OpenCode;
      for (const [info, reason] of [
        [{ id: "ses_one", metadata: {} }, "Cannot mark invalid OpenCode session ses_one"],
        [
          {
            id: "ses_one",
            outcome: "succeeded",
            time: { idle: 3 },
            location: { directory: "/workspace" },
            metadata: {},
          },
          "Cannot mark unowned OpenCode session ses_one",
        ],
      ] as const) {
        expect((yield* Effect.flip(client.markPublished("ses_one", malformed(info)))).reason).toBe(
          reason,
        );
      }
    });
    yield* withFake(program, fake);
    expect(fake.requests).not.toContain("PATCH /api/session/ses_one");
  }),
);

it.effect(
  "authenticates, copies the agent model, waits for SSE, runs a command and reads final text",
  () =>
    Effect.gen(function* () {
      const fake = fakeOpenCode();
      const program = Effect.gen(function* () {
        const client = yield* OpenCode;
        expect(client.model).toEqual({ providerID: "provider", id: "model", variant: "max" });
        yield* client.commands(["summarize"]);
        expect(yield* client.run(attempt, 1000, false)).toEqual({
          sessionID: "ses_one",
          type: "succeeded",
          text: "안녕하세요",
        });
      });
      yield* withFake(program, fake);
      expect(fake.requests).toContain("GET /api/agent?location%5Bdirectory%5D=%2Fworkspace");
      expect(fake.requests).toContain("POST /api/session/ses_one/command");
      expect(fake.requests.indexOf("GET /api/event")).toBeLessThan(
        fake.requests.indexOf("POST /api/session/ses_one/command"),
      );
      expect(fake.bodies).toContain(
        JSON.stringify({
          title: "🔗 News · https://example.com",
          agent: "summarizer",
          model: { providerID: "provider", id: "model", variant: "max" },
          location: { directory: "/workspace" },
          metadata: { summarizer: { channelID: "channel", messageID: "message", runID: "run" } },
        }),
      );
      expect(fake.bodies).toContain(
        JSON.stringify({ name: "summarize", text: "https://example.com" }),
      );
    }),
);

it.effect("validates command names before creating a session", () =>
  Effect.gen(function* () {
    const fake = fakeOpenCode();
    const program = Effect.gen(function* () {
      return yield* Effect.flip((yield* OpenCode).commands(["summarize", "missing"]));
    });
    const error = yield* withFake(program, fake);
    expect(error.reason).toContain("missing");
    expect(fake.requests).toHaveLength(2);
  }),
);

it.effect("paginates the sweep and deletes only owned stale or requested finished sessions", () =>
  Effect.gen(function* () {
    const fake = fakeOpenCode({
      pages: [
        [
          session("ses_old"),
          session("ses_live", undefined, 900),
          session("ses_boundary", undefined, 500),
          { ...session("ses_other"), metadata: {} },
          { id: "ses_no_metadata", time: { created: 1, updated: 100 } },
        ],
        [session("ses_done", "succeeded")],
      ],
    });
    const program = Effect.gen(function* () {
      const client = yield* OpenCode;
      expect(yield* client.sweep(500, false)).toBe(1);
      expect(yield* client.sweep(500, true)).toBe(2);
    });
    yield* withFake(program, fake);
    expect(fake.requests.filter((path) => path.startsWith("DELETE"))).toEqual([
      "DELETE /api/session/ses_old",
      "DELETE /api/session/ses_old",
      "DELETE /api/session/ses_done",
    ]);
  }),
);

it.effect("reports terminal outcomes, abnormal finishes, and missing assistant text", () =>
  Effect.gen(function* () {
    for (const [scenario, expected] of [
      [
        { outcome: "failed", event: "failed", errorType: "provider.auth" },
        { type: "failed", reason: "provider.auth" },
      ],
      [
        { outcome: "failed", event: "failed" },
        { type: "failed", reason: "execution-failed" },
      ],
      [{ outcome: "interrupted", event: "interrupted" }, { type: "interrupted" }],
      [{ text: "" }, { type: "failed", reason: "empty" }],
      [{ text: "   " }, { type: "failed", reason: "empty" }],
      [
        { outcome: "failed", event: "interrupted", errorType: "poison" },
        { type: "failed", reason: "execution-failed" },
      ],
      [{ finish: "length" }, { type: "failed", reason: "length" }],
      [{ finish: "missing" }, { type: "failed", reason: "missing-finish" }],
      [{ messageMissing: true }, { type: "failed", reason: "missing-finish" }],
    ] as const) {
      const fake = fakeOpenCode(scenario);
      const result = yield* withFake(
        Effect.gen(function* () {
          return yield* (yield* OpenCode).run(attempt, 1000, false);
        }),
        fake,
      );
      expect(result).toEqual({ ...expected, sessionID: "ses_one" });
    }
  }),
);

it.effect("bounds and interrupts a stuck command, then optionally deletes its session", () =>
  Effect.gen(function* () {
    for (const config of [{ hangCommand: true }, { noEvent: true }]) {
      const fake = fakeOpenCode(config);
      const program = Effect.gen(function* () {
        const fiber = yield* Effect.forkChild((yield* OpenCode).run(attempt, 1000, true));
        while (!fake.requests.some((path) => path.endsWith("/command"))) yield* Effect.yieldNow;
        yield* TestClock.adjust("2 seconds");
        expect(yield* Fiber.join(fiber)).toEqual({
          sessionID: "ses_one",
          type: "failed",
          reason: "timeout",
        });
      });
      yield* withFake(program, fake);
      expect(fake.requests).toContain("POST /api/session/ses_one/interrupt?resume=false");
      expect(fake.requests).toContain("DELETE /api/session/ses_one");
    }
  }),
);

it.effect("waits for a terminal execution event after Started", () =>
  Effect.gen(function* () {
    const fake = fakeOpenCode({ holdTerminal: true });
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild((yield* OpenCode).run(attempt, 1000, false));
      while (!fake.requests.includes("POST /api/session/ses_one/command")) yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(fake.requests).not.toContain("GET /api/session/ses_one");
      yield* Effect.sync(fake.finish);
      expect(yield* Fiber.join(fiber)).toEqual({
        sessionID: "ses_one",
        type: "succeeded",
        text: "안녕하세요",
      });
    });
    yield* withFake(program, fake);
  }),
);

it.effect("interrupts an attempt canceled by its parent", () =>
  Effect.gen(function* () {
    const fake = fakeOpenCode({ hangCommand: true });
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild((yield* OpenCode).run(attempt, 1000, false));
      while (!fake.requests.some((path) => path.endsWith("/command"))) yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
    });
    yield* withFake(program, fake);
    expect(fake.requests).toContain("POST /api/session/ses_one/interrupt?resume=false");
  }),
);

it.effect("fails closed on HTTP errors, SSE loss, or a nonterminal session", () =>
  Effect.gen(function* () {
    for (const config of [
      { fault: "commands" },
      { fault: "create" },
      { fault: "event" },
      { fault: "command" },
      { fault: "session" },
      { fault: "message" },
      { outcome: "none" },
      { closeEvent: true },
    ] as const) {
      const fake = fakeOpenCode(config);
      const program = Effect.gen(function* () {
        const client = yield* OpenCode;
        return config.fault === "commands"
          ? yield* client.commands(["summarize"])
          : yield* client.run(attempt, 1000, false);
      });
      const error = yield* Effect.flip(withFake(program, fake));
      expect(error.reason).toBeTruthy();
      if (config.fault === "command" || config.fault === "event" || "closeEvent" in config)
        expect(fake.requests).toContain("POST /api/session/ses_one/interrupt?resume=false");
    }
  }),
);

it.effect("bounds an SSE feed that never acknowledges subscription", () =>
  Effect.gen(function* () {
    const fake = fakeOpenCode({ noConnected: true });
    expect((yield* timedFailure(fake, "/api/event", 11)).reason).toBe(
      "OpenCode SSE connection timed out",
    );
    expect(fake.requests).not.toContain("POST /api/session/ses_one/command");
  }),
);

it.effect("rejects malformed event envelopes and error data", () =>
  Effect.gen(function* () {
    for (const event of [
      { type: 7, data: {} },
      { type: "server.connected", data: { error: 7 } },
      { type: "session.execution.failed", data: { sessionID: "ses_one", error: { type: 7 } } },
    ]) {
      const fake = fakeOpenCode({ invalidEvent: event });
      const program = Effect.gen(function* () {
        return yield* Effect.flip((yield* OpenCode).run(attempt, 1000, false));
      });
      const failure = yield* withFake(program, fake);
      expect(failure.reason).toBe("OpenCode SSE disconnected");
    }
  }),
);

it.effect("bounds agent readiness even when its HTTP request hangs", () =>
  Effect.gen(function* () {
    for (const config of [
      { hangAgent: true },
      { fault: "agent" },
      { agentModel: false },
      { noAgent: true },
    ] as const) {
      const fake = fakeOpenCode(config);
      const fiber = yield* Effect.forkChild(Effect.flip(withFake(OpenCode, fake)));
      yield* TestClock.adjust("30 seconds");
      const failure = yield* Fiber.join(fiber);
      expect(failure.reason).toBe(
        "hangAgent" in config
          ? "OpenCode agent readiness timed out"
          : "fault" in config
            ? "OpenCode agent registry unavailable"
            : "Agent summarizer has no explicit model",
      );
    }
  }),
);

it.effect("reports pagination loops, list and deletion failures", () =>
  Effect.gen(function* () {
    for (const config of [
      { loop: true },
      { fault: "list" },
      { fault: "delete", pages: [[session()]] },
    ] as const) {
      const fake = fakeOpenCode(config);
      const error = yield* Effect.flip(
        withFake(
          Effect.gen(function* () {
            return yield* (yield* OpenCode).sweep(500, false);
          }),
          fake,
        ),
      );
      expect(error.reason).toBeTruthy();
    }
  }),
);

it.effect("propagates interrupt failures without leaving a command running", () =>
  Effect.gen(function* () {
    const fake = fakeOpenCode({ fault: "interrupt", hangCommand: true });
    expect((yield* timedFailure(fake, "/command", 2)).reason).toBe(
      "Cannot interrupt OpenCode session ses_one",
    );
    expect(fake.requests).toContain("POST /api/session/ses_one/interrupt?resume=false");
  }),
);

it.effect("rejects malformed v2 API payloads at their trust boundaries", () =>
  Effect.gen(function* () {
    for (const [endpoint, payload, reason] of [
      ["agent", { data: null }, "OpenCode agent registry unavailable"],
      [
        "agent",
        { data: [{ name: "summarizer", model: { providerID: 7, id: "model" } }] },
        "OpenCode agent registry unavailable",
      ],
      [
        "agent",
        { data: [{ name: 7, model: { providerID: "p", id: "m" } }] },
        "OpenCode agent registry unavailable",
      ],
      ["commands", { data: null }, "OpenCode command registry unavailable"],
      ["commands", { data: [{ name: 7 }] }, "OpenCode command registry unavailable"],
      ["create", { data: null }, "Cannot create OpenCode session"],
      [
        "create",
        { data: { id: 7, time: { created: 1, updated: 1 } } },
        "Cannot create OpenCode session",
      ],
      ["create", { data: { id: "ses_one", time: null } }, "Cannot create OpenCode session"],
      [
        "create",
        { data: { id: "ses_one", time: { created: 1, updated: "not-a-number" } } },
        "Cannot create OpenCode session",
      ],
      ["session", { data: null }, "OpenCode request failed"],
      ["message", { data: null }, "Cannot read assistant message"],
      [
        "message",
        { data: [{ type: "assistant", content: [{ type: "text", text: 7 }] }] },
        "Cannot read assistant message",
      ],
      [
        "message",
        { data: [{ type: "assistant", content: [{ type: "reasoning", text: 7 }] }] },
        "Cannot read assistant message",
      ],
      ["list", { data: [], cursor: null }, "Cannot list OpenCode sessions"],
      ["list", { data: [], cursor: { next: 7 } }, "Cannot list OpenCode sessions"],
      [
        "list",
        {
          data: [
            {
              ...session(),
              metadata: { summarizer: { channelID: 7, messageID: "m", runID: "r" } },
            },
          ],
          cursor: {},
        },
        "Cannot list OpenCode sessions",
      ],
    ] as const) {
      const fake = fakeOpenCode({ payloads: { [endpoint]: payload } });
      const program = Effect.gen(function* () {
        const client = yield* OpenCode;
        if (endpoint === "agent") return client.model;
        if (endpoint === "commands") return yield* client.commands(["summarize"]);
        if (endpoint === "list") return yield* client.sweep(500, false);
        return yield* client.run(attempt, 1000, false);
      });
      const fiber = yield* Effect.forkChild(Effect.flip(withFake(program, fake)));
      if (endpoint === "agent") yield* TestClock.adjust("12 seconds");
      const failure = yield* Fiber.join(fiber);
      expect(failure.reason).toContain(reason);
    }
  }),
);
