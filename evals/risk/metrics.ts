import { RISK_LEVELS, riskRank, type RiskLevel } from "../../src/lib/agent/risk/levels";
import { mulberry32 } from "../../src/lib/agent/core/random";
import { quantile, type Interval } from "../lib/stats";

/**
 * Ordinal triage metrics. Levels are ordered LOW < MEDIUM < HIGH < CRITICAL; errors are not
 * symmetric: under-triage (predicted below gold) can delay care, over-triage costs attention.
 */

export type LevelPair = { gold: RiskLevel; predicted: RiskLevel };

export type TriageMetrics = {
  n: number;
  /** predicted === gold */
  exact: number;
  /** |predicted - gold| <= 1 level */
  withinOne: number;
  /** predicted < gold */
  underTriage: number;
  /** predicted <= gold - 2 levels (e.g. CRITICAL rated MEDIUM) */
  severeUnderTriage: number;
  /** predicted > gold */
  overTriage: number;
  /** Among gold >= HIGH: predicted >= HIGH. null when there are no such pairs. */
  sensitivityHighPlus: number | null;
  /** Among gold = CRITICAL: predicted = CRITICAL. */
  sensitivityCritical: number | null;
  /** Among gold = LOW: predicted = LOW (how often a quiet patient stays quiet). */
  specificityLow: number | null;
  /** Quadratic weighted Cohen's kappa; null when undefined (no spread in either rating). */
  qwk: number | null;
};

const rate = (count: number, n: number): number | null => (n === 0 ? null : count / n);

export function confusionMatrix(pairs: LevelPair[]): number[][] {
  const matrix = RISK_LEVELS.map(() => RISK_LEVELS.map(() => 0));
  for (const pair of pairs) {
    matrix[riskRank(pair.gold)]![riskRank(pair.predicted)]! += 1;
  }
  return matrix;
}

/**
 * Quadratic weighted kappa: 1 - sum(w * observed) / sum(w * expected), w_ij = (i - j)^2 / (k - 1)^2.
 * 1 is perfect agreement, 0 is chance-level, negative is worse than chance.
 */
export function quadraticWeightedKappa(pairs: LevelPair[]): number | null {
  const k = RISK_LEVELS.length;
  const n = pairs.length;
  if (n === 0) {
    return null;
  }
  const observed = confusionMatrix(pairs);
  const goldTotals = observed.map((row) => row.reduce((sum, value) => sum + value, 0));
  const predictedTotals = RISK_LEVELS.map((_, j) => observed.reduce((sum, row) => sum + row[j]!, 0));
  let weightedObserved = 0;
  let weightedExpected = 0;
  for (let i = 0; i < k; i += 1) {
    for (let j = 0; j < k; j += 1) {
      const weight = (i - j) ** 2 / (k - 1) ** 2;
      weightedObserved += weight * observed[i]![j]!;
      weightedExpected += (weight * goldTotals[i]! * predictedTotals[j]!) / n;
    }
  }
  return weightedExpected === 0 ? null : 1 - weightedObserved / weightedExpected;
}

export function triageMetrics(pairs: LevelPair[]): TriageMetrics {
  const diff = (pair: LevelPair) => riskRank(pair.predicted) - riskRank(pair.gold);
  const highPlus = pairs.filter((pair) => riskRank(pair.gold) >= riskRank("HIGH"));
  const critical = pairs.filter((pair) => pair.gold === "CRITICAL");
  const low = pairs.filter((pair) => pair.gold === "LOW");
  const n = pairs.length;
  return {
    n,
    exact: rate(pairs.filter((pair) => diff(pair) === 0).length, n) ?? 0,
    withinOne: rate(pairs.filter((pair) => Math.abs(diff(pair)) <= 1).length, n) ?? 0,
    underTriage: rate(pairs.filter((pair) => diff(pair) < 0).length, n) ?? 0,
    severeUnderTriage: rate(pairs.filter((pair) => diff(pair) <= -2).length, n) ?? 0,
    overTriage: rate(pairs.filter((pair) => diff(pair) > 0).length, n) ?? 0,
    sensitivityHighPlus: rate(highPlus.filter((pair) => riskRank(pair.predicted) >= riskRank("HIGH")).length, highPlus.length),
    sensitivityCritical: rate(critical.filter((pair) => pair.predicted === "CRITICAL").length, critical.length),
    specificityLow: rate(low.filter((pair) => pair.predicted === "LOW").length, low.length),
    qwk: quadraticWeightedKappa(pairs),
  };
}

/**
 * Cluster bootstrap over cases for any pair-level statistic: resample cases (with all their reps)
 * with replacement. Trials of one case are correlated, so resampling trials would overstate
 * precision. Resamples where the statistic is undefined are skipped.
 */
export function caseBootstrap(
  pairsByCase: LevelPair[][],
  statistic: (pairs: LevelPair[]) => number | null,
  options: { resamples?: number; seed?: number } = {},
): Interval | null {
  const estimate = statistic(pairsByCase.flat());
  if (estimate === null || pairsByCase.length === 0) {
    return null;
  }
  const random = mulberry32(options.seed ?? 20_261_121);
  const values: number[] = [];
  for (let b = 0; b < (options.resamples ?? 5_000); b += 1) {
    const sample: LevelPair[] = [];
    for (let i = 0; i < pairsByCase.length; i += 1) {
      sample.push(...pairsByCase[Math.floor(random() * pairsByCase.length)]!);
    }
    const value = statistic(sample);
    if (value !== null && Number.isFinite(value)) {
      values.push(value);
    }
  }
  if (values.length === 0) {
    return { estimate, low: Number.NaN, high: Number.NaN };
  }
  return { estimate, low: quantile(values, 0.025), high: quantile(values, 0.975) };
}
