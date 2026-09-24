import { DateTime, Duration } from "effect";

export type Note =
  | { readonly kind: "started"; readonly number: number; readonly maximum: number }
  | {
      readonly kind: "failed";
      readonly number: number;
      readonly maximum: number;
      readonly reason: string;
    }
  | { readonly kind: "interrupted"; readonly number: number; readonly maximum: number };

export interface ThreadMessage {
  readonly id: string;
  readonly content: string;
  readonly author: { readonly id: string };
}

export interface TimedNote {
  readonly note: Note;
  readonly at: DateTime.Utc;
}

export const formatNote = (note: Note): string => {
  const count = `(${note.number}/${note.maximum})`;
  if (note.kind === "started") return `⏳ 요약 중 ${count}`;
  if (note.kind === "failed") return `⚠️ 요약 실패 ${count}: ${note.reason}`;
  return `⏸️ 요약 중단 ${count}: 재시도 횟수에 포함되지 않음`;
};

export const parseNote = (content: string): Note | undefined => {
  const match =
    /^(⏳ 요약 중|⚠️ 요약 실패|⏸️ 요약 중단) \(([^/()]+)\/([^/()]+)\)(?:: (.*))?$/u.exec(content);
  if (!match) return undefined;
  const number = Number(match[2]);
  const maximum = Number(match[3]);
  if (
    !Number.isSafeInteger(number) ||
    !Number.isSafeInteger(maximum) ||
    number < 1 ||
    number > maximum ||
    String(number) !== match[2] ||
    String(maximum) !== match[3]
  )
    return undefined;
  if (match[1] === "⏳ 요약 중" && match[4] === undefined)
    return { kind: "started", number, maximum };
  if (match[1] === "⚠️ 요약 실패" && match[4])
    return { kind: "failed", number, maximum, reason: match[4] };
  if (match[1] === "⏸️ 요약 중단" && match[4] === "재시도 횟수에 포함되지 않음") {
    return { kind: "interrupted", number, maximum };
  }
  return undefined;
};

/** Only bot messages outside all note formats are Summary parts. */
export const summaryParts = (
  messages: readonly ThreadMessage[],
  botId: string,
): readonly ThreadMessage[] =>
  messages.filter((message) => message.author.id === botId && !parseNote(message.content));

export type AttemptStatus = {
  readonly counted: number;
  readonly live: boolean;
  readonly due: boolean;
  readonly giveUp: boolean;
};

/** A started note is stale at exactly timeout + 2 minutes. A crashed failure's time is its note's timestamp, not the time it was discovered. */
export const attemptStatus = (
  notes: readonly TimedNote[],
  now: DateTime.Utc,
  timeout: Duration.Duration,
  retryWaits: readonly Duration.Duration[],
): AttemptStatus => {
  const staleAfter = Duration.toMillis(timeout) + Duration.toMillis(Duration.minutes(2));
  const nowMs = DateTime.toEpochMillis(now);
  const counted = notes.filter(
    ({ note, at }) =>
      note.kind === "failed" ||
      (note.kind === "started" && nowMs - DateTime.toEpochMillis(at) >= staleAfter),
  );
  const live = notes.some(
    ({ note, at }) => note.kind === "started" && nowMs - DateTime.toEpochMillis(at) < staleAfter,
  );
  const maximum = retryWaits.length + 1;
  const giveUp = counted.length >= maximum;
  const latestFailureAt = Math.max(...counted.map(({ at }) => DateTime.toEpochMillis(at)));
  return {
    counted: counted.length,
    live,
    giveUp,
    due:
      !live &&
      !giveUp &&
      (counted.length === 0 ||
        nowMs >= latestFailureAt + Duration.toMillis(retryWaits[counted.length - 1]!)),
  };
};
