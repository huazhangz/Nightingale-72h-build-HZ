import { ageInDays } from "./recency";
import { entryHasUnresolvedActions } from "./unresolved";
import { riskTone } from "./risk-tone";

export const DECAY_AGE_DAYS = 30;

export function isLowRiskOnly(labels: Array<string | null | undefined>): boolean {
  return labels.every((label) => riskTone(label) === "low");
}

export function isArchivedHistoricalNote(input: {
  encounterAt: Date;
  highlightLabels: Array<string | null | undefined>;
  hasUnresolvedActions: boolean;
  nowMs?: number;
}): boolean {
  if (input.hasUnresolvedActions) {
    return false;
  }
  if (ageInDays(input.encounterAt, input.nowMs) < DECAY_AGE_DAYS) {
    return false;
  }
  return isLowRiskOnly(input.highlightLabels);
}

export function archiveFlagsForEntry(input: {
  encounterAt: Date;
  body: string;
  comments?: Array<{ body: string }>;
  highlights?: Array<{ excerpt: string; label: string | null }>;
  nowMs?: number;
}): { archived: boolean; decayed: boolean } {
  const archived = isArchivedHistoricalNote({
    encounterAt: input.encounterAt,
    highlightLabels: (input.highlights ?? []).map((highlight) => highlight.label),
    hasUnresolvedActions: entryHasUnresolvedActions(input),
    nowMs: input.nowMs,
  });
  return { archived, decayed: archived };
}
