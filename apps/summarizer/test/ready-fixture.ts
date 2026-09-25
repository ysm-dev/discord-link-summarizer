import { createHash } from "node:crypto";
import type { DiscordMessage } from "../src/discord-schema.ts";

/** Spec-level length-delimited digest, used to seed externally authored journal fixtures. */
export const readyDigest = (parts: readonly string[]) => {
  return createHash("sha256")
    .update(parts.map((part) => `${Buffer.byteLength(part)}:${part}`).join(""))
    .digest("hex");
};

export const readyManifest = (id: string, parts: readonly DiscordMessage[]) => ({
  id,
  state: "ready" as const,
  count: parts.length,
  hash: readyDigest(parts.map((part) => part.content)),
  parts: parts.map((part) => part.id),
});
