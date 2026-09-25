const linesOf = (text: string): readonly string[] =>
  Array.from(text.matchAll(/[^\n]*\n/gu), (match) => match[0]);
const nextFence = (line: string, active: string | null): string | null => {
  const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
  if (!marker) return active;
  if (!active) return marker;
  return marker[0] === active[0] &&
    marker.length >= active.length &&
    /^\s*$/u.test(line.slice(line.indexOf(marker) + marker.length))
    ? null
    : active;
};

const boundary = (text: string, limit: number, inside: string | null): number => {
  let blank = 0;
  let line = 0;
  let fenced = inside;
  let offset = 0;
  for (const item of linesOf(text.slice(0, limit))) {
    const next = offset + item.length;
    fenced = nextFence(item, fenced);
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
  let inFence: string | null = null;
  while (remaining.length > limit) {
    let end = boundary(remaining, limit, inFence);
    if (/[\uD800-\uDBFF]/u.test(remaining.charAt(end - 1))) end--;
    if (end === 0) throw new Error("Part limit is too small for a Unicode character");
    const part = remaining.slice(0, end);
    parts.push(part);
    for (const lineText of linesOf(part)) {
      inFence = nextFence(lineText, inFence);
    }
    remaining = remaining.slice(end);
  }
  parts.push(remaining);
  return parts;
};
