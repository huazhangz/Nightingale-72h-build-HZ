/** Patient-level acuity scale shared by the risk agent, the rule floor, the API and the UI. */

export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const REVIEW_WINDOWS = ["IMMEDIATE", "WITHIN_4H", "WITHIN_24H", "ROUTINE"] as const;
export type ReviewWindow = (typeof REVIEW_WINDOWS)[number];

export function riskRank(level: RiskLevel | null | undefined): number {
  return level ? RISK_LEVELS.indexOf(level) : -1;
}

export function maxLevel(...levels: Array<RiskLevel | null | undefined>): RiskLevel {
  return levels.reduce<RiskLevel>((best, level) => (riskRank(level) > riskRank(best) ? level! : best), "LOW");
}

/** The slowest acceptable review for each level. */
export const REVIEW_FOR_LEVEL: Record<RiskLevel, ReviewWindow> = {
  CRITICAL: "IMMEDIATE",
  HIGH: "WITHIN_4H",
  MEDIUM: "WITHIN_24H",
  LOW: "ROUTINE",
};

/** Urgency order: IMMEDIATE is the tightest. */
export function reviewRank(window: ReviewWindow): number {
  return REVIEW_WINDOWS.length - 1 - REVIEW_WINDOWS.indexOf(window);
}

/** A review window never looser than the level allows. */
export function tightenReview(level: RiskLevel, proposed: ReviewWindow | null | undefined): ReviewWindow {
  const required = REVIEW_FOR_LEVEL[level];
  if (!proposed) {
    return required;
  }
  return reviewRank(proposed) >= reviewRank(required) ? proposed : required;
}
