import { expect, it } from "./progress-fixture.ts";
import { Effect, Schema } from "effect";
import { at, config, setup } from "./run-fixture.ts";
import { fakeApi } from "./discord-api-fixture.ts";

const nameError = {
  code: 50035,
  message: "Invalid Form Body",
  errors: {
    name: {
      _errors: [{ code: "BASE_TYPE_BAD_LENGTH", message: "Must be between 1 and 100 in length." }],
    },
  },
};

for (const [label, title] of [
  ["long ASCII", "a".repeat(100)],
  ["emoji", "👩‍💻".repeat(30)],
  ["combining characters", "e\u0301".repeat(60)],
] as const)
  for (const failed of [false, true])
    it.effect(`bounds complete ${failed ? "Given-up" : "Done"} thread names for ${label}`, () =>
      Effect.gen(function* () {
        const { discord, invoke } = yield* setup(
          failed ? { event: "failed", outcome: "failed" } : {},
          config + "retry_waits: []\n",
        );
        const post = discord.addMessage("10", `https://example.test\n\n${title}`, at - 1000);
        expect(yield* invoke()).toBe(0);
        const names = discord.requests
          .filter(
            (r) =>
              (r.method === "POST" && r.path.endsWith("/threads")) ||
              (r.method === "PATCH" && r.path === `/channels/${post.id}`),
          )
          .map(
            (r) => Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(r.body).name,
          );
        expect(names).toHaveLength(2);
        expect(names[0]?.startsWith("⏳ ")).toBe(true);
        expect(names[1]?.startsWith("⚠️ ")).toBe(failed);
        for (const name of names) expect(name.length).toBeLessThanOrEqual(100);
        expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
      }),
    );

for (const stage of ["creation", "completion"])
  it.effect(`falls back on Discord's real name validation error during ${stage}`, () =>
    Effect.gen(function* () {
      const { discord, invoke } = yield* setup();
      const post = discord.addMessage("10", "Valid title https://example.test", at - 1000);
      discord.faults.push({
        method: stage === "creation" ? "POST" : "PATCH",
        path:
          stage === "creation"
            ? `/channels/10/messages/${post.id}/threads`
            : `/channels/${post.id}`,
        status: 400,
        body: nameError,
      });
      expect(yield* invoke()).toBe(0);
      const names = discord.requests
        .filter(
          (r) =>
            r.method === (stage === "creation" ? "POST" : "PATCH") &&
            r.path ===
              (stage === "creation"
                ? `/channels/10/messages/${post.id}/threads`
                : `/channels/${post.id}`),
        )
        .map((r) => Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(r.body).name);
      expect(names).toEqual(
        stage === "creation" ? ["⏳ Valid title", "⏳ 요약"] : ["Valid title", "요약"],
      );
      expect(discord.threads.get(post.id)?.thread_metadata.archived).toBe(true);
    }),
  );

it.effect("does not misclassify unrelated invalid-form errors as rejected thread names", () =>
  Effect.gen(function* () {
    const { discord } = yield* setup();
    const api = yield* fakeApi(discord);
    for (const detail of [
      {},
      { errors: {} },
      { errors: { auto_archive_duration: { _errors: [] } } },
      { errors: { name: "malformed" } },
      { errors: { name: null } },
      { errors: { name: [] } },
      { code: 12345, errors: nameError.errors },
    ]) {
      discord.faults.push({
        method: "POST",
        path: "/channels/10/messages/p/threads",
        status: 400,
        body: { code: 50035, ...detail },
      });
      expect((yield* Effect.flip(api.startThread("10", "p", "title"))).kind).toBe(
        "invalid-response",
      );
    }
    discord.faults.push({
      method: "POST",
      path: "/channels/10/messages",
      status: 400,
      body: nameError,
    });
    expect((yield* Effect.flip(api.createMessage("10", "text"))).kind).toBe("invalid-response");
    discord.faults.push({
      method: "POST",
      path: "/channels/10/messages/p/threads",
      status: 500,
      body: nameError,
    });
    expect((yield* Effect.flip(api.startThread("10", "p", "title"))).kind).toBe("outage");
  }),
);
