import { expect, it } from "@effect/vitest";
import { fromPartial } from "@total-typescript/shoehorn";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { SessionPublication } from "../src/session-publication.ts";
import { session } from "./opencode-fake.ts";
import { directory, endpoint, harness, source } from "./session-publication-fake.ts";

const publish = Effect.flatMap(SessionPublication, (service) => service.publish("ses_one", false));
const pending = Effect.flatMap(SessionPublication, (service) => service.pending(false));
const skipPending = Effect.flatMap(SessionPublication, (service) => service.pending(true));
const disabledPublish = Effect.flatMap(SessionPublication, (service) =>
  service.publish("ses_one", true),
);
it.effect(
  "publishes only owned terminal sessions across all pages, retaining private transcripts",
  () =>
    Effect.gen(function* () {
      const test = harness({
        pages: [
          [
            session("ses_live"),
            { ...session("ses_other", "succeeded"), metadata: {} },
            { id: "ses_unowned", time: { created: 1, updated: 2 }, outcome: "succeeded" },
          ],
          [session("ses_one", "succeeded")],
        ],
      });
      const results = yield* test.run(pending);
      expect(results).toEqual([{ type: "published", id: "ses_one" }]);
      expect(test.imports).toEqual([{ ...source, location: { directory } }]);
      expect(test.requests).toEqual([
        "GET /api/experimental/session/ses_one/export?sanitize=false",
        "POST /api/experimental/session/import",
        "GET /api/experimental/session/ses_one/export?sanitize=false",
      ]);
      expect(test.privateServer.requests).not.toContain("DELETE /api/session/ses_one");
    }),
);

it.effect("reconciles an already imported ID, a 409, and an import whose reply was lost", () =>
  Effect.gen(function* () {
    for (const target of [
      { existing: source },
      { importStatus: 409, race: source },
      { lostReply: true },
    ]) {
      const test = harness({ target });
      expect(yield* test.run(publish)).toEqual({ type: "published", id: "ses_one" });
      expect(test.imports).toHaveLength("existing" in target ? 0 : 1);
    }
  }),
);

it.effect("marks verified private imports durably and skips them on the next sweep", () =>
  Effect.gen(function* () {
    const annotated = {
      ...source,
      info: { ...source.info, metadata: { ...source.info.metadata, reviewer: { tag: "keep" } } },
    };
    const test = harness({ source: annotated });
    const program = Effect.gen(function* () {
      expect(yield* pending).toEqual([{ type: "published", id: "ses_one" }]);
      expect(yield* pending).toEqual([]);
    });
    yield* test.run(program);
    expect(test.imports).toEqual([{ ...annotated, location: { directory } }]);
    expect(test.discoveries).toBe(2);
    expect(test.privateServer.requests).toContain("PATCH /api/session/ses_one");
    expect(
      test.privateServer.bodies.some(
        (body) => body.includes('"reviewer":{"tag":"keep"}') && body.includes('"published":true'),
      ),
    ).toBe(true);
  }),
);

it.effect("reconciles a lost mark reply, retries a missing mark, and rejects an altered mark", () =>
  Effect.gen(function* () {
    const lost = harness({ target: { existing: source }, patchLostReply: true });
    expect(yield* lost.run(publish)).toEqual({ type: "published", id: "ses_one" });
    expect(yield* lost.run(pending)).toEqual([]);
    expect(lost.imports).toEqual([]);
    const missing = harness({ patchLostReply: true, patchNoCommit: true });
    expect(yield* missing.run(publish)).toEqual({
      type: "deferred",
      id: "ses_one",
      reason: "Cannot mark OpenCode session ses_one as published",
    });
    expect((yield* missing.run(pending)).map((result) => result.type)).toEqual(["deferred"]);
    expect(missing.imports).toHaveLength(1);
    const corrupt = harness({ patchLostReply: true, patchCorrupt: true });
    expect(yield* corrupt.run(publish)).toEqual({
      type: "deferred",
      id: "ses_one",
      reason: "Cannot mark OpenCode session ses_one as published",
    });
  }),
);

it.effect("rejects a lost marker reply when private identity or marker cannot be confirmed", () =>
  Effect.gen(function* () {
    const metadata = {
      ...source.info.metadata,
      summarizer: { ...source.info.metadata.summarizer, published: true },
    };
    const confirmed = { ...source.info, metadata };
    for (const confirmInfo of [
      { ...confirmed, id: "ses_other" },
      { ...confirmed, location: { directory: "/other" } },
      { ...confirmed, outcome: "failed" },
      { ...confirmed, time: { ...confirmed.time, idle: 4 } },
      { ...confirmed, time: { created: 1 } },
      { ...confirmed, location: {} },
      { ...confirmed, metadata: { ...metadata, reviewer: "unexpected" } },
      {},
    ]) {
      const test = harness({ patchLostReply: true, confirmInfo, target: { existing: source } });
      expect(yield* test.run(publish)).toEqual({
        type: "deferred",
        id: "ses_one",
        reason: "Cannot mark OpenCode session ses_one as published",
      });
      expect(test.imports).toEqual([]);
    }
    const missingEnvelope = harness({
      patchLostReply: true,
      confirmBody: {},
      target: { existing: source },
    });
    expect(yield* missingEnvelope.run(publish)).toEqual({
      type: "deferred",
      id: "ses_one",
      reason: "Cannot mark OpenCode session ses_one as published",
    });
  }),
);

it.effect(
  "publishes oldest first and verifies a source mark without tolerating target metadata drift",
  () =>
    Effect.gen(function* () {
      const older = {
        ...source,
        info: { ...source.info, id: "ses_z_old", time: { ...source.info.time, created: 0 } },
      };
      const test = harness({
        pages: [
          [
            session("ses_one", "succeeded"),
            { ...session("ses_z_old", "succeeded"), time: { created: 0, updated: 1 } },
          ],
        ],
        sources: { ses_one: source, ses_z_old: older },
      });
      expect(yield* test.run(pending)).toEqual([
        { type: "published", id: "ses_z_old" },
        { type: "published", id: "ses_one" },
      ]);
      expect(test.imports).toHaveLength(2);
      const sameAge = harness({
        pages: [[session("ses_z", "succeeded"), session("ses_a", "succeeded")]],
        sources: {
          ses_z: { ...source, info: { ...source.info, id: "ses_z" } },
          ses_a: { ...source, info: { ...source.info, id: "ses_a" } },
        },
      });
      expect((yield* sameAge.run(pending)).map((result) => result.id)).toEqual(["ses_a", "ses_z"]);
      const marked = {
        ...source,
        info: {
          ...source.info,
          metadata: { summarizer: { ...source.info.metadata.summarizer, published: true } },
        },
      };
      const retry = harness({ source: marked, target: { existing: source } });
      expect(yield* retry.run(publish)).toEqual({ type: "published", id: "ses_one" });
      expect(retry.imports).toEqual([]);
      const restored = harness({ source: marked });
      expect(yield* restored.run(publish)).toEqual({ type: "published", id: "ses_one" });
      expect(restored.imports).toEqual([{ ...source, location: { directory } }]);
      for (const metadata of [
        { ...source.info.metadata, arbitrary: { changed: true } },
        { summarizer: { ...source.info.metadata.summarizer, published: true } },
      ]) {
        const collision = harness({
          target: { existing: { ...source, info: { ...source.info, metadata } } },
        });
        expect((yield* collision.run(publish)).type).toBe("deferred");
        expect(collision.privateServer.requests).not.toContain("PATCH /api/session/ses_one");
      }
    }),
);

it.effect(
  "defers a wrong-ID collision, stopped target, malformed or unfinished source, and failed import",
  () =>
    Effect.gen(function* () {
      for (const scenario of [
        { target: { existing: { ...source, messages: [] } } },
        { unavailable: true },
        { source: { ...source, info: { ...source.info, time: { created: 1, updated: 3 } } } },
        { source: { ...source, info: { ...source.info, metadata: {} } } },
        { target: { importStatus: 503 } },
        {
          target: {
            importStatus: 409,
            race: { ...source, info: { ...source.info, title: "other" } },
          },
        },
      ]) {
        const test = harness(scenario);
        const result = yield* test.run(publish);
        expect(result.type).toBe("deferred");
        expect(test.privateServer.requests).not.toContain("DELETE /api/session/ses_one");
      }
    }),
);

it.effect(
  "disables publication in delete mode and bounds hanging target and oversized export",
  () =>
    Effect.gen(function* () {
      const disabled = harness();
      expect(yield* disabled.run(skipPending)).toEqual([]);
      expect(disabled.requests).toEqual([]);
      const huge = harness({
        source: { ...source, messages: [{ text: "x".repeat(2 * 1024 * 1024) }] },
      });
      expect(yield* huge.run(publish)).toEqual({
        type: "deferred",
        id: "ses_one",
        reason: "OpenCode transfer exceeds size limit",
      });
      expect(huge.requests).toEqual([]);
      const disabledSingle = harness();
      expect(yield* disabledSingle.run(disabledPublish)).toEqual({
        type: "deferred",
        id: "ses_one",
        reason: "Session retention and publication disabled",
      });
      expect(disabledSingle.privateServer.requests).toEqual([
        "GET /api/agent?location%5Bdirectory%5D=%2Fworkspace",
      ]);
    }),
);

it.effect(
  "rejects mismatched location, identity, outcome and message content without importing",
  () =>
    Effect.gen(function* () {
      for (const existing of [
        { ...source, info: { ...source.info, location: { directory: "/elsewhere" } } },
        { ...source, info: { ...source.info, id: "ses_wrong" } },
        { ...source, info: { ...source.info, outcome: "failed" } },
        {
          ...source,
          info: {
            ...source.info,
            metadata: { summarizer: { channelID: "other", messageID: "message", runID: "run" } },
          },
        },
        { ...source, messages: [{ ...source.messages[0], text: "tampered" }] },
        { ...source, info: { ...source.info, time: { created: 1, updated: 4, idle: 5 } } },
      ]) {
        const test = harness({ target: { existing } });
        const result = yield* test.run(publish);
        expect(result).toEqual({
          type: "deferred",
          id: "ses_one",
          reason:
            existing.info.id === "ses_wrong" || existing.info.location.directory === "/elsewhere"
              ? "Session ses_one has unexpected identity or location"
              : "Interactive OpenCode session ID collision: ses_one",
        });
        expect(test.imports).toEqual([]);
      }
    }),
);

it.effect(
  "defers malformed target, unsupported export route, target disappearance and absent import visibility",
  () =>
    Effect.gen(function* () {
      for (const [target, reason] of [
        [
          { existing: source, exportBody: { info: null } },
          "Cannot verify interactive OpenCode session ses_one",
        ],
        [
          { existing: source, exportBody: {} },
          "Cannot verify interactive OpenCode session ses_one",
        ],
        [
          {
            existing: source,
            exportBody: { ...source, messages: [{ text: "x".repeat(2 * 1024 * 1024) }] },
          },
          "OpenCode transfer exceeds size limit",
        ],
        [{ exportStatus: 503 }, "Interactive OpenCode export returned 503"],
        [
          { exportStatus: 404, noCommit: true },
          "Interactive OpenCode import not visible for ses_one",
        ],
        [{ importStatus: 409 }, "Interactive OpenCode import not visible for ses_one"],
        [{ lostReply: true, noCommit: true }, "Interactive OpenCode import deferred for ses_one"],
        [{ importStatus: 201 }, "Interactive OpenCode import returned 201"],
        [
          { existing: { ...source, info: { ...source.info, metadata: {} } } },
          "Session ses_one has invalid terminal ownership or location",
        ],
        [{ importStatus: 503, race: source }, "Interactive OpenCode import returned 503"],
      ] as const) {
        const test = harness({ target });
        expect(yield* test.run(publish)).toEqual({ type: "deferred", id: "ses_one", reason });
      }
    }),
);

it.effect(
  "handles discovery failures and invalid private export without disclosing their contents",
  () =>
    Effect.gen(function* () {
      for (const [config, reason] of [
        [{ discoveryFailure: true }, "Interactive OpenCode discovery failed"],
        [{ unavailable: true }, "Interactive OpenCode service unavailable"],
        [
          { discoveryEndpoint: fromPartial<typeof endpoint>({ auth: endpoint.auth }) },
          "Invalid interactive OpenCode endpoint",
        ],
        [
          {
            discoveryEndpoint: fromPartial<typeof endpoint>({
              url: endpoint.url,
              auth: fromPartial<typeof endpoint.auth>({ type: "basic" }),
            }),
          },
          "Invalid interactive OpenCode endpoint",
        ],
        [
          { source: { ...source, info: { ...source.info, id: "ses_other" } } },
          "Session ses_one has unexpected identity or location",
        ],
        [
          { source: { ...source, info: { ...source.info, location: { directory: "/other" } } } },
          "Session ses_one has unexpected identity or location",
        ],
        [
          { source: { ...source, info: { ...source.info, location: {} } } },
          "Session ses_one has invalid terminal ownership or location",
        ],
        [
          { source: { ...source, info: { ...source.info, time: {} } } },
          "Session ses_one has invalid terminal ownership or location",
        ],
        [
          {
            source: {
              ...source,
              info: {
                ...source.info,
                metadata: { summarizer: { channelID: "channel", messageID: "message" } },
              },
            },
          },
          "Session ses_one has invalid terminal ownership or location",
        ],
        [
          { source: { ...source, messages: "not an array" } },
          "Cannot export OpenCode session ses_one",
        ],
      ] as const) {
        const test = harness(config);
        const result = yield* test.run(publish);
        expect(result).toEqual({ type: "deferred", id: "ses_one", reason });
        expect(test.imports).toEqual([]);
      }
    }),
);

it.effect("accepts the exact response byte limit but rejects one byte beyond it", () =>
  Effect.gen(function* () {
    const base = { ...source, messages: [{ ...source.messages[0], text: "" }] };
    const size = 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify({ data: base }));
    for (const [extra, reason, targetRequests] of [
      [0, "OpenCode session ses_one exceeds import size limit", 1],
      [1, "OpenCode transfer exceeds size limit", 0],
    ] as const) {
      const test = harness({
        source: {
          ...source,
          messages: [{ ...source.messages[0], text: "x".repeat(size + extra) }],
        },
      });
      expect(yield* test.run(publish)).toEqual({ type: "deferred", id: "ses_one", reason });
      expect(test.requests).toHaveLength(targetRequests);
    }
    const outboundSize =
      2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify({ ...base, location: { directory } }));
    const exact = harness({
      source: { ...base, messages: [{ ...source.messages[0], text: "x".repeat(outboundSize) }] },
    });
    expect(yield* exact.run(publish)).toEqual({ type: "published", id: "ses_one" });
    expect(exact.imports).toHaveLength(1);
  }),
);

it.effect(
  "publishes failed and interrupted terminal transcripts and ignores property insertion order",
  () =>
    Effect.gen(function* () {
      for (const outcome of ["failed", "interrupted"] as const) {
        const finished = { ...source, info: { ...source.info, outcome } };
        const test = harness({ source: finished });
        expect(yield* test.run(publish)).toEqual({ type: "published", id: "ses_one" });
      }
      const reordered = {
        ...source,
        info: {
          ...source.info,
          metadata: { summarizer: { runID: "run", messageID: "message", channelID: "channel" } },
        },
        messages: source.messages.map((message) =>
          Object.fromEntries(Object.entries(message).toReversed()),
        ),
      };
      const test = harness({ target: { existing: reordered } });
      expect(yield* test.run(publish)).toEqual({ type: "published", id: "ses_one" });
      expect(test.imports).toEqual([]);
    }),
);

it.effect("rejects a target that changed a message array into an object", () =>
  Effect.gen(function* () {
    const test = harness({
      target: {
        existing: {
          ...source,
          messages: [
            source.messages[0],
            { ...source.messages[1], content: { 0: { type: "text", text: "summary" } } },
          ],
        },
      },
    });
    expect(yield* test.run(publish)).toEqual({
      type: "deferred",
      id: "ses_one",
      reason: "Interactive OpenCode session ID collision: ses_one",
    });
  }),
);

it.effect("bounds discovery and target requests with an Effect clock", () =>
  Effect.gen(function* () {
    for (const [config, reason] of [
      [{ discoveryHang: true }, "Interactive OpenCode discovery timed out"],
      [{ target: { hang: true } }, "Cannot verify interactive OpenCode session ses_one"],
      [{ hangExport: true }, "Cannot export OpenCode session ses_one"],
    ] as const) {
      const test = harness(config);
      const fiber = yield* Effect.forkChild(test.run(publish));
      yield* TestClock.adjust("20 seconds");
      expect(yield* Fiber.join(fiber)).toEqual({ type: "deferred", id: "ses_one", reason });
    }
  }),
);

it.effect("bounds a paginated source listing even when the private server stalls", () =>
  Effect.gen(function* () {
    const test = harness({ slowList: true, pages: [[], [], []] });
    const fiber = yield* Effect.forkChild(Effect.flip(test.run(pending)));
    yield* TestClock.adjust("31 seconds");
    expect((yield* Fiber.join(fiber)).reason).toBe("OpenCode session listing timed out");
  }),
);

it.effect("bounds a publication sweep across many slow transfers", () =>
  Effect.gen(function* () {
    const ids = Array.from({ length: 5 }, (_, index) => `ses_${index}`);
    const test = harness({
      pages: [ids.map((id, index) => session(id, "succeeded", index + 100))],
      sources: Object.fromEntries(
        ids.map((id, index) => [
          id,
          {
            ...source,
            info: { ...source.info, id, time: { ...source.info.time, created: index + 1 } },
          },
        ]),
      ),
      target: { hang: true },
    });
    const fiber = yield* Effect.forkChild(Effect.flip(test.run(pending)));
    yield* TestClock.adjust("61 seconds");
    expect((yield* Fiber.join(fiber)).reason).toBe("OpenCode publication sweep timed out");
  }),
);
