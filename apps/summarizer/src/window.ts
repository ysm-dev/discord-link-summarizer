import { DateTime, Duration } from "effect";

/** Inclusive lower bound: a Link Post at Since or at the Horizon boundary counts. */
export const normalLowerBound = (
  since: DateTime.Utc,
  now: DateTime.Utc,
  horizon: Duration.Duration,
): number =>
  Math.max(DateTime.toEpochMillis(since), DateTime.toEpochMillis(now) - Duration.toMillis(horizon));

/** Only an empty normal-window history triggers the archived-thread catch-up probe. */
export const shouldProbeArchive = (hasBotThreadInNormalWindow: boolean): boolean =>
  !hasBotThreadInNormalWindow;

/** A known channel scans back to its newest previously handled Link Post, never before Since. */
export const catchUpLowerBound = (
  since: DateTime.Utc,
  normalBound: number,
  newestBotThreadPost: DateTime.Utc | undefined,
): number =>
  newestBotThreadPost
    ? Math.min(
        normalBound,
        Math.max(DateTime.toEpochMillis(since), DateTime.toEpochMillis(newestBotThreadPost)),
      )
    : normalBound;

export const withinWindow = (post: DateTime.Utc, lowerBound: number): boolean =>
  DateTime.toEpochMillis(post) >= lowerBound;
