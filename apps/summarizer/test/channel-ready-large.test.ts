import { expect, it } from "./progress-fixture.ts";
import { Effect } from "effect";
import { persistReady, readJournal } from "../src/channel-record.ts";
import { readyManifest, verifyReady } from "../src/ready.ts";
import { readyDigest } from "./ready-fixture.ts";
import { journaledLink, now, prepare } from "./channel-record-fixture.ts";
import { allMessages } from "../src/discord-client.ts";

const draft = Effect.gen(function* () {
  const { fake, api } = yield* prepare;
  const { source, journal } = yield* journaledLink(fake, now - 100);
  fake.addThread("10", source.id, "⏳ Working");
  return { fake, api, source, journal };
});

it.effect("stores large READY manifests atomically without Discord marker splitting", () =>
  Effect.gen(function* () {
    const { fake, api, source, journal } = yield* draft;
    const parts = Array.from({ length: 150 }, (_, i) =>
      fake.addMessage(source.id, `Summary ${i}`, now + i, "bot"),
    );
    const ready = yield* persistReady(api, "bot", journal, source.id, parts);
    expect(yield* allMessages(api, source.id)).toEqual(parts.toReversed());
    expect(ready.entries.get(source.id)).toEqual(readyManifest(source.id, parts));
    expect((yield* readJournal("10"))?.entries.get(source.id)).toEqual(
      ready.entries.get(source.id),
    );
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
    fake.messages.set(source.id, parts.slice(1));
    expect(
      (yield* Effect.flip(persistReady(api, "bot", journal, source.id, parts))).message,
    ).toContain("do not match");
  }),
);

it.effect("READY binds exact ordered bot message identities and a length-delimited digest", () =>
  Effect.gen(function* () {
    const { fake } = yield* prepare;
    const first = fake.addMessage("1", "a", now, "bot");
    const second = fake.addMessage("1", "bc", now + 1, "bot");
    const manifest = readyManifest("1", [first, second]);
    expect(manifest.hash).toBe("5310a58788781ab25d5ad7c3f85035824b4eb7bdfa394e0ac2186271472b5492");
    expect(readyDigest(["ab", "c"])).toBe(
      "430fb1b4ac43316eca81fab27a1930ab8eff8fef6a1dc7903dce44bbc2790dc5",
    );
    expect(verifyReady(manifest, [second, first], "bot")).toBe(true);
    expect(
      verifyReady(
        { ...manifest, parts: [second.id, first.id], hash: readyDigest(["bc", "a"]) },
        [first, second],
        "bot",
      ),
    ).toBe(false);
    expect(verifyReady({ ...manifest, state: "terminal" }, [first, second], "bot")).toBe(false);
    expect(
      verifyReady(
        { id: manifest.id, state: manifest.state, count: manifest.count, hash: manifest.hash },
        [first, second],
        "bot",
      ),
    ).toBe(false);
    expect(verifyReady({ ...manifest, count: 3 }, [first, second], "bot")).toBe(false);
    expect(verifyReady(manifest, [first], "bot")).toBe(false);
    expect(verifyReady(manifest, [{ ...first, author: { id: "human" } }, second], "bot")).toBe(
      false,
    );
    expect(verifyReady(manifest, [{ ...first, id: "999" }, second], "bot")).toBe(false);
    expect(verifyReady(manifest, [{ ...first, content: "changed" }, second], "bot")).toBe(false);
    expect(
      verifyReady(
        { ...manifest, parts: [first.id, first.id], hash: readyDigest(["a", "a"]) },
        [first, second],
        "bot",
      ),
    ).toBe(false);
  }),
);

it.effect("READY is written only after reading back every matching bot part", () =>
  Effect.gen(function* () {
    const { fake, api, source, journal } = yield* draft;
    const part = fake.addMessage(source.id, "Complete summary", now, "bot");
    fake.messages.set(source.id, [{ ...part, content: "Incomplete summary" }]);
    expect(
      (yield* Effect.flip(persistReady(api, "bot", journal, source.id, [part]))).message,
    ).toContain("do not match");
    expect((yield* readJournal("10"))?.entries.get(source.id)).toBeUndefined();
    fake.messages.set(source.id, [part]);
    expect(
      (yield* persistReady(api, "bot", journal, source.id, [part])).entries.get(source.id)?.state,
    ).toBe("ready");
  }),
);
