import { isIP } from "node:net";

export type ExtractionKind = "page" | "youtube";
// oxlint-disable-next-line eslint/no-control-regex -- Reject embedded control bytes in an untrusted URL.
const unsafeUrlCharacters = /[\u0000-\u0020\u007f]/u;

// Trust boundary: OpenCode tool input comes from model-generated JSON.
// oxlint-disable-next-line typescript/no-restricted-types -- Decode the untrusted model-generated tool arguments before use.
export function extractionUrl(input: unknown, kind: ExtractionKind): string {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !("url" in input) ||
    typeof input.url !== "string"
  ) {
    throw new Error("Expected one URL string");
  }
  const value = input.url;
  if (value.length > 4096 || unsafeUrlCharacters.test(value) || !/^https?:\/\//iu.test(value)) {
    throw new Error("Expected an http(s) URL without whitespace or controls");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid URL");
  }
  const host = url.hostname.toLowerCase();
  if (
    !host.includes(".") ||
    isIP(host) !== 0 ||
    /\.(?:local|localhost|internal|test|invalid)$/u.test(host) ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error("Only public http(s) hostnames on standard ports are supported");
  }
  if (
    kind === "youtube" &&
    !["youtube.com", "youtu.be", "youtube-nocookie.com"].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    )
  ) {
    throw new Error("Expected a YouTube URL");
  }
  return value;
}
