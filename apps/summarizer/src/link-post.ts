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

const firstLink = (content: string): string | undefined => {
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
  // Reserve the longest lifecycle prefix. UTF-16 length is a conservative Discord character budget.
  const limit = 100 - "⚠️ ".length;
  if (title.length <= limit) return title;
  let shortened = "";
  for (const { segment } of new Intl.Segmenter().segment(title)) {
    if (shortened.length + segment.length > limit - 1) break;
    shortened += segment;
  }
  return shortened + "…";
};

export type LinkPostState = "someone-else" | "pending" | "in-progress" | "given-up" | "done";

export const linkPostState = (thread: Thread | undefined, botId: string): LinkPostState => {
  if (!thread) return "pending";
  if (thread.owner_id !== botId) return "someone-else";
  if (thread.name.startsWith("⏳ ")) return "in-progress";
  return thread.name.startsWith("⚠️ ") ? "given-up" : "done";
};
