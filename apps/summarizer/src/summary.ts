const linesOf = (text: string): readonly string[] =>
  Array.from(text.matchAll(/[^\n]*\n/gu), (match) => match[0]);
const fence = (line: string): boolean => /^\s*```/u.test(line);

const boundary = (text: string, limit: number, inside: boolean): number => {
  let blank = 0;
  let line = 0;
  let fenced = inside;
  let offset = 0;
  for (const item of linesOf(text.slice(0, limit))) {
    const next = offset + item.length;
    if (fence(item)) fenced = !fenced;
    if (!fenced) {
      line = next;
      if (item.trim() === "") blank = next;
    }
    offset = next;
  }
  return blank || line || limit;
};

/** Preserves every character, preferring blank lines, then line breaks outside fenced code. */
export const splitSummary = (summary: string, limit = 2000): readonly string[] => {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("Part limit must be a positive integer");
  if (!summary) return [];
  const parts: string[] = [];
  let remaining = summary;
  let inFence = false;
  while (remaining.length > limit) {
    let end = boundary(remaining, limit, inFence);
    if (/[\uD800-\uDBFF]/u.test(remaining.charAt(end - 1))) end--;
    if (end === 0) throw new Error("Part limit is too small for a Unicode character");
    const part = remaining.slice(0, end);
    parts.push(part);
    for (const lineText of linesOf(part)) {
      if (fence(lineText)) inFence = !inFence;
    }
    remaining = remaining.slice(end);
  }
  parts.push(remaining);
  return parts;
};
