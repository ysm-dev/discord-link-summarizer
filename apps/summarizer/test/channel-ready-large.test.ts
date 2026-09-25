import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { journalStatus, persistReady } from "../src/channel-record.ts";
import { verifyReady } from "../src/ready.ts";
import { journaledLink, now, open, prepare } from "./channel-record-fixture.ts";
import { FakeDiscord } from "./discord-fake.ts";
import { readyManifest } from "./ready-fixture.ts";

const summaryParts = (fake: FakeDiscord, source: string) =>
  Array.from({ length: 100 }, (_, index) =>
    fake.addMessage(source, `Summary part ${index}`, now + index, "bot"),
  );
const setup = Effect.gen(function* () {
  const { fake, api } = yield* prepare;
  const { source, journal } = yield* journaledLink(fake, api, now - 100);
  fake.addThread("10", source.id, "⏳ Working");
  return { fake, api, source, journal, parts: summaryParts(fake, source.id) };
});

it.effect(
  "large READY manifests split before the final status and recover after a lost fragment reply",
  () =>
    Effect.gen(function* () {
      const { fake, api, source, journal, parts } = yield* setup;
      expect(JSON.stringify(readyManifest(source.id, parts)).length).toBeGreaterThan(2000);
      fake.faults.push({
        method: "POST",
        path: `/channels/${journal.parent}/messages`,
        drop: true,
        after: true,
      });
      const ready = yield* persistReady(api, "20", "bot", journal, source.id, parts);
      expect(ready.entries.get(source.id)?.parts).toEqual(parts.map((part) => part.id));
      const stored = fake.messages.get(journal.parent)!;
      expect(
        stored.filter((message) => message.content.startsWith("DLS1 parts ")).length,
      ).toBeGreaterThan(1);
      expect(stored.every((message) => message.content.length <= 2000)).toBe(true);
      const recovered = (yield* open(api)).journal!.entries.get(source.id)!;
      expect(verifyReady(recovered, parts, "bot")).toBe(true);
      fake.addMessage(
        journal.parent,
        stored.find((m) => m.content.startsWith("DLS1 parts "))!.content,
        now + 300,
        "bot",
      );
      expect((yield* open(api)).journal!.entries.get(source.id)).toEqual(recovered);
      expect(
        (yield* persistReady(api, "20", "bot", ready, source.id, parts)).entries.get(source.id),
      ).toEqual(recovered);
    }),
);

it.effect(
  "invalid split READY metadata and fragments are rejected before a status is trusted",
  () =>
    Effect.gen(function* () {
      const { fake, api, source, journal, parts } = yield* setup;
      const manifest = readyManifest(source.id, parts);
      const baseline = [...fake.messages.get(journal.parent)!];
      const compact = {
        id: source.id,
        state: "ready",
        count: manifest.count,
        hash: manifest.hash,
        first: parts[0]!.id,
        chunks: 1,
      };
      for (const invalid of [
        { ...compact, state: "terminal" },
        { ...compact, parts: [parts[0]!.id] },
        { ...compact, first: undefined },
        { ...compact, chunks: 0 },
        { ...compact, chunks: 1.5 },
      ]) {
        fake.messages.set(journal.parent, baseline);
        fake.addMessage(journal.parent, `DLS1 status ${JSON.stringify(invalid)}`, now, "bot");
        expect((yield* Effect.flip(open(api))).message).toContain("Malformed READY manifest");
      }
      for (const ids of [[], [parts[0]!.id]]) {
        for (const index of [-1, 1.5, 0]) {
          if (ids.length && index === 0) continue;
          fake.messages.set(journal.parent, baseline);
          fake.addMessage(
            journal.parent,
            `DLS1 parts ${JSON.stringify({ id: source.id, hash: manifest.hash, first: parts[0]!.id, index, ids })}`,
            now,
            "bot",
          );
          expect((yield* Effect.flip(open(api))).message).toContain("Malformed READY parts");
        }
      }
      fake.messages.set(journal.parent, baseline);
      fake.addMessage(
        journal.parent,
        `DLS1 parts ${JSON.stringify({ id: "not-a-snowflake", hash: manifest.hash, first: parts[0]!.id, index: 0, ids: [parts[0]!.id] })}`,
        now,
        "bot",
      );
      expect((yield* Effect.flip(open(api))).message).toContain("Malformed parts marker");
    }),
);

it.effect("a compact READY marker with one valid fragment hydrates its exact part", () =>
  Effect.gen(function* () {
    const { fake, api, source, journal, parts } = yield* setup;
    const manifest = readyManifest(source.id, parts.slice(0, 1));
    fake.addMessage(
      journal.parent,
      `DLS1 parts ${JSON.stringify({ id: source.id, hash: manifest.hash, first: parts[0]!.id, index: 0, ids: [parts[0]!.id] })}`,
      now,
      "bot",
    );
    fake.addMessage(
      journal.parent,
      `DLS1 status ${JSON.stringify({ id: source.id, state: "ready", count: 1, hash: manifest.hash, first: parts[0]!.id, chunks: 1 })}`,
      now + 1,
      "bot",
    );
    expect((yield* open(api)).journal!.entries.get(source.id)).toEqual(manifest);
  }),
);

it.effect("READY fragments at and just above 2,000 characters split at the exact boundary", () =>
  Effect.gen(function* () {
    const { fake, api, source, journal } = yield* setup;
    const first = "9".repeat(600);
    const hash = "a".repeat(64);
    const base = `DLS1 parts ${JSON.stringify({ id: source.id, hash, first, index: 0, ids: [first, ""] })}`;
    const second = "8".repeat(2000 - base.length);
    for (const extra of ["", "8"]) {
      const ids = [first, second + extra, "7".repeat(700)];
      const status = {
        id: source.id,
        state: "ready" as const,
        count: ids.length,
        hash,
        parts: ids,
      };
      const completed = yield* journalStatus(api, "20", "bot", journal, status);
      expect(completed.entries.get(source.id)).toEqual(status);
      const fragments = fake.messages
        .get(journal.parent)!
        .filter((m) => m.content.startsWith("DLS1 parts "));
      expect(fragments.length).toBe(extra ? 3 : 2);
      expect(fragments.every((m) => m.content.length <= 2000)).toBe(true);
      if (!extra) expect(fragments[0]!.content.length).toBe(2000);
      fake.messages.set(
        journal.parent,
        fake.messages
          .get(journal.parent)!
          .filter((m) => m.id === journal.parent || m.content.startsWith("DLS1 batch ")),
      );
    }
  }),
);

it.effect("an exactly 2,000-character status remains one marker", () =>
  Effect.gen(function* () {
    const { fake, api, source, journal } = yield* setup;
    const hash = "a".repeat(64);
    const base = `DLS1 status ${JSON.stringify({ id: source.id, state: "ready", count: 1, hash, parts: [""] })}`;
    const id = "9".repeat(2000 - base.length);
    const status = { id: source.id, state: "ready" as const, count: 1, hash, parts: [id] };
    const completed = yield* journalStatus(api, "20", "bot", journal, status);
    expect(completed.entries.get(source.id)).toEqual(status);
    expect(
      fake.messages
        .get(journal.parent)!
        .filter((m) => m.content.startsWith("DLS1 status "))
        .map((m) => m.content.length),
    ).toEqual([2000]);
    expect(
      fake.messages.get(journal.parent)!.some((m) => m.content.startsWith("DLS1 parts ")),
    ).toBe(false);
  }),
);

it.effect("oversized marker identifiers fail before Discord can reject their writes", () =>
  Effect.gen(function* () {
    const { api, source, journal } = yield* setup;
    const huge = "9".repeat(2001);
    expect(
      (yield* Effect.flip(
        journalStatus(api, "20", "bot", journal, {
          id: source.id,
          state: "ready",
          count: 1,
          hash: "a".repeat(64),
          parts: [huge],
        }),
      )).message,
    ).toContain("ID too long");
    expect(
      (yield* Effect.flip(
        journalStatus(
          api,
          "20",
          "bot",
          { ...journal, entries: new Map([[huge, undefined]]) },
          {
            id: huge,
            state: "terminal",
          },
        ),
      )).message,
    ).toContain("manifest too long");
  }),
);

it.effect("a missing or divergent fragment makes an existing READY fail closed", () =>
  Effect.gen(function* () {
    const { fake, api, source, journal, parts } = yield* setup;
    yield* persistReady(api, "20", "bot", journal, source.id, parts);
    const stored = fake.messages.get(journal.parent)!;
    const first = stored.find((message) => message.content.startsWith("DLS1 parts "))!;
    fake.messages.set(
      journal.parent,
      stored.filter((message) => message.id !== first.id),
    );
    expect((yield* Effect.flip(open(api))).message).toContain("Missing READY parts");
    fake.messages.set(journal.parent, stored);
    fake.addMessage(
      journal.parent,
      first.content.replace(`"ids":["${parts[0]!.id}"`, '"ids":["999"'),
      now + 200,
      "bot",
    );
    expect((yield* Effect.flip(open(api))).message).toContain("Divergent READY parts");
  }),
);
