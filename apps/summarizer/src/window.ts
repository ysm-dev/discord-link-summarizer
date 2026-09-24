import { DateTime, Duration } from "effect";

/** Inclusive lower bound: a Link Post at Since or at the Horizon boundary counts. */
export const normalLowerBound = (
  since: DateTime.Utc,
  now: DateTime.Utc,
  horizon: Duration.Duration,
): number =>
  Math.max(DateTime.toEpochMillis(since), DateTime.toEpochMillis(now) - Duration.toMillis(horizon));

export const withinWindow = (post: DateTime.Utc, lowerBound: number): boolean =>
  DateTime.toEpochMillis(post) >= lowerBound;
