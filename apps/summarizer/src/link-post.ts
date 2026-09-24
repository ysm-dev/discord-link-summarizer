export interface Message {
  readonly id: string;
  readonly type: number;
  readonly content: string;
  readonly author: { readonly id: string };
}

export interface Thread {
  readonly id: string;
  readonly owner_id: string;
  readonly name: string;
}

/** Discord's default (0) and reply (19) messages; system messages and wachi alerts never count. */
export const linkFromPost = (message: Message, botId: string): string | undefined =>
  (message.type === 0 || message.type === 19) &&
  message.author.id !== botId &&
  !message.content.startsWith("wachi:")
    ? firstLink(message.content)
    : undefined;

export const firstLink = (content: string): string | undefined => {
  for (const match of content.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let link = match[0].replace(/[.,!?;:\]}]+$/u, "");
    // A balanced ')' belongs to a URL path; a sentence's closing ')' does not.
    while (link.endsWith(")") && link.split(")").length > link.split("(").length) {
      link = link.slice(0, -1);
    }
    if (URL.canParse(link)) return link;
  }
  return undefined;
};

export const threadTitle = (content: string, link: string): string => {
  const withoutLink = content.replace(`<${link}>`, "").replace(link, "");
  const title = withoutLink
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:⏳|⚠️)\s*/u, "");
  if (!title) return "요약";
  const characters = Array.from(new Intl.Segmenter().segment(title), (segment) => segment.segment);
  return characters.length > 100 ? characters.slice(0, 99).join("") + "…" : title;
};

export type LinkPostState = "someone-else" | "pending" | "in-progress" | "given-up" | "done";

export const linkPostState = (thread: Thread | undefined, botId: string): LinkPostState => {
  if (!thread) return "pending";
  if (thread.owner_id !== botId) return "someone-else";
  if (thread.name.startsWith("⏳ ")) return "in-progress";
  return thread.name.startsWith("⚠️ ") ? "given-up" : "done";
};
