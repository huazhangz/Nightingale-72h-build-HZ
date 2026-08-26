export const RECENCY_TAU_DAYS = 14;
export const RECENCY_FORMULA = "Score = exp(-ageDays / 14)";

export function ageInDays(at: Date, nowMs = Date.now()): number {
  return Math.max(0, (nowMs - at.getTime()) / 86_400_000);
}

/** Time-decay freshness score in 0–100, prioritizing recent encounters. */
export function recencyScore(latestEncounterAt: Date | null, nowMs = Date.now()): number {
  if (!latestEncounterAt) {
    return 0;
  }
  return Math.round(100 * Math.exp(-ageInDays(latestEncounterAt, nowMs) / RECENCY_TAU_DAYS));
}
