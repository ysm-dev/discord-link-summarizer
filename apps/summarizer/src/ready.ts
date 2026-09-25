import { createHash } from "node:crypto";
import type { Status } from "./channel-record.ts";
import type { DiscordMessage } from "./discord-schema.ts";
import { isBotOutput } from "./attempt.ts";

const readyDigest = (parts: readonly string[]) => {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part)));
    hash.update(":");
    hash.update(part);
  }
  return hash.digest("hex");
};
export const readyManifest = (source: string, parts: readonly DiscordMessage[]) =>
  ({
    id: source,
    state: "ready" as const,
    count: parts.length,
    hash: readyDigest(parts.map((part) => part.content)),
    parts: parts.map((part) => part.id),
  }) satisfies Status;
/** Match explicit message identities, not note-shaped model text. */
export const verifyReady = (status: Status, messages: readonly DiscordMessage[], botId: string) => {
  const parts = status.parts?.map((partId) =>
    messages.find((message) => message.id === partId && isBotOutput(message, botId)),
  );
  return (
    status.state === "ready" &&
    parts !== undefined &&
    parts.length === status.count &&
    parts.every((part) => part !== undefined) &&
    parts.every((part, index) => index === 0 || BigInt(parts[index - 1]!.id) < BigInt(part.id)) &&
    status.hash === readyDigest(parts.map((part) => part.content))
  );
};
