import { mulberry32 } from "../../src/lib/agent/core/random";

/**
 * Statistics for agent evaluation. Pure functions, no dependencies.
 *
 * Unit of analysis: the CASE. Repeated samples of one case are correlated (same prompt, same record),
 * so uncertainty is computed across cases (cluster-level), never by pooling trials as if they were
 * independent. The naive pooled interval is reported only to show the design effect.
 *
 * References: Chen et al. 2021 (unbiased pass@k); Yao et al. 2024 (pass^k, tau-bench);
 * Miller 2024, "Adding Error Bars to Evals" (clustered standard errors, paired differences, power).
 */

// ---------------------------------------------------------------- pass@k / pass^k

/** Unbiased estimator of P(at least one of k samples passes) from n samples with c passes. */
export function passAtK(n: number, c: number, k: number): number {
  assertCounts(n, c, k);
  if (n - c < k) {
    return 1;
  }
  // 1 - C(n-c, k) / C(n, k), as a numerically stable product.
  let ratio = 1;
  for (let i = n - c + 1; i <= n; i += 1) {
    ratio *= 1 - k / i;
  }
  return 1 - ratio;
}

/** Unbiased estimator of P(all k samples pass): C(c, k) / C(n, k). Measures reliability. */
export function passHatK(n: number, c: number, k: number): number {
  assertCounts(n, c, k);
  if (c < k) {
    return 0;
  }
  let value = 1;
  for (let i = 0; i < k; i += 1) {
    value *= (c - i) / (n - i);
  }
  return value;
}

function assertCounts(n: number, c: number, k: number): void {
  if (!Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k) || n < 1 || c < 0 || c > n || k < 1) {
    throw new RangeError(`invalid counts n=${n} c=${c} k=${k}`);
  }
  if (k > n) {
    throw new RangeError(`k=${k} exceeds samples n=${n}`);
  }
}

// ---------------------------------------------------------------- descriptive

export function mean(values: number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample standard deviation (n - 1). */
export function sampleSd(values: number[]): number {
  if (values.length < 2) {
    return Number.NaN;
  }
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

// ---------------------------------------------------------------- distributions

function logGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9).
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const shifted = x - 1;
  let sum = coefficients[0]!;
  for (let i = 1; i < coefficients.length; i += 1) {
    sum += coefficients[i]! / (shifted + i);
  }
  const t = shifted + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Continued fraction for the regularised incomplete beta function (modified Lentz). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  d = Math.abs(d) < tiny ? tiny : d;
  d = 1 / d;
  let result = d;
  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + numerator * d;
    d = Math.abs(d) < tiny ? tiny : d;
    c = 1 + numerator / c;
    c = Math.abs(c) < tiny ? tiny : c;
    d = 1 / d;
    result *= d * c;
    numerator = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + numerator * d;
    d = Math.abs(d) < tiny ? tiny : d;
    c = 1 + numerator / c;
    c = Math.abs(c) < tiny ? tiny : c;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < 1e-14) {
      break;
    }
  }
  return result;
}

/** Regularised incomplete beta I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) {
    return 0;
  }
  if (x >= 1) {
    return 1;
  }
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(x, a, b)) / a;
  }
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/** Student-t CDF with `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const tail = 0.5 * incompleteBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Student-t quantile by bisection on the CDF (monotone, so robust). */
export function studentTQuantile(p: number, df: number): number {
  if (p <= 0 || p >= 1) {
    throw new RangeError("p must be in (0, 1)");
  }
  if (p === 0.5) {
    return 0;
  }
  let low = -1e4;
  let high = 1e4;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (studentTCdf(mid, df) < p) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return (low + high) / 2;
}

export const Z_975 = 1.959963984540054;

/** Wilson score interval for a binomial proportion (used only for the naive pooled comparison). */
export function wilsonInterval(successes: number, n: number, z = Z_975): [number, number] {
  if (n === 0) {
    return [Number.NaN, Number.NaN];
  }
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** Exact two-sided binomial test p-value for k successes in n trials at p = 0.5 (used by McNemar). */
function binomialTwoSidedHalf(k: number, n: number): number {
  if (n === 0) {
    return 1;
  }
  const smaller = Math.min(k, n - k);
  let cumulative = 0;
  for (let i = 0; i <= smaller; i += 1) {
    cumulative += Math.exp(logGamma(n + 1) - logGamma(i + 1) - logGamma(n - i + 1) - n * Math.LN2);
  }
  return Math.min(1, 2 * cumulative);
}

// ---------------------------------------------------------------- intervals over cases

export type Interval = { estimate: number; low: number; high: number };

/** Mean of per-case values with a t-interval across cases (clipped to [0, 1] for rates). */
export function caseMeanInterval(perCase: number[], options: { clip?: boolean } = {}): Interval & { se: number } {
  const estimate = mean(perCase);
  const se = sampleSd(perCase) / Math.sqrt(perCase.length);
  if (perCase.length < 2 || !Number.isFinite(se)) {
    return { estimate, low: Number.NaN, high: Number.NaN, se: Number.NaN };
  }
  const t = studentTQuantile(0.975, perCase.length - 1);
  let low = estimate - t * se;
  let high = estimate + t * se;
  if (options.clip !== false) {
    low = Math.max(0, low);
    high = Math.min(1, high);
  }
  return { estimate, low, high, se };
}

/** Percentile cluster bootstrap: resample cases with replacement. Seeded for reproducibility. */
export function bootstrapInterval(
  perCase: number[],
  options: { resamples?: number; seed?: number; statistic?: (values: number[]) => number } = {},
): Interval {
  const statistic = options.statistic ?? mean;
  const resamples = options.resamples ?? 10_000;
  const random = mulberry32(options.seed ?? 20_261_121);
  const estimates: number[] = [];
  for (let b = 0; b < resamples; b += 1) {
    const sample: number[] = [];
    for (let i = 0; i < perCase.length; i += 1) {
      sample.push(perCase[Math.floor(random() * perCase.length)]!);
    }
    estimates.push(statistic(sample));
  }
  return { estimate: statistic(perCase), low: quantile(estimates, 0.025), high: quantile(estimates, 0.975) };
}

/**
 * Design effect: variance of the clustered estimate relative to the naive estimate that treats all
 * trials as independent. > 1 means pooling trials would overstate precision.
 */
export function designEffect(perCase: number[], trialsPerCase: number, pooledRate: number): number {
  const clusteredVar = sampleSd(perCase) ** 2 / perCase.length;
  const naiveVar = (pooledRate * (1 - pooledRate)) / (perCase.length * trialsPerCase);
  return naiveVar === 0 ? Number.NaN : clusteredVar / naiveVar;
}

// ---------------------------------------------------------------- paired comparison

export type PairedComparison = {
  meanDiff: number;
  sdDiff: number;
  n: number;
  /** Paired t-interval for the mean difference (A - B). */
  ci: [number, number];
  bootstrapCi: [number, number];
  tPValue: number;
  /** Exact (or Monte Carlo when > 20 non-zero pairs) sign-flip permutation p-value, two-sided. */
  permutationPValue: number;
  permutationExact: boolean;
  /** Minimum detectable effect at alpha 0.05, power 0.8, given the observed sd of differences. */
  mde: number;
};

export function signFlipPValue(diffs: number[], options: { seed?: number; samples?: number } = {}): { p: number; exact: boolean } {
  const nonZero = diffs.filter((value) => Math.abs(value) > 1e-12);
  if (nonZero.length === 0) {
    return { p: 1, exact: true };
  }
  const observed = Math.abs(nonZero.reduce((sum, value) => sum + value, 0));
  const tolerance = 1e-9;
  if (nonZero.length <= 20) {
    const total = 2 ** nonZero.length;
    let extreme = 0;
    for (let mask = 0; mask < total; mask += 1) {
      let sum = 0;
      for (let i = 0; i < nonZero.length; i += 1) {
        sum += mask & (1 << i) ? -nonZero[i]! : nonZero[i]!;
      }
      if (Math.abs(sum) >= observed - tolerance) {
        extreme += 1;
      }
    }
    return { p: extreme / total, exact: true };
  }
  const random = mulberry32(options.seed ?? 7);
  const samples = options.samples ?? 200_000;
  let extreme = 0;
  for (let s = 0; s < samples; s += 1) {
    let sum = 0;
    for (const value of nonZero) {
      sum += random() < 0.5 ? -value : value;
    }
    if (Math.abs(sum) >= observed - tolerance) {
      extreme += 1;
    }
  }
  return { p: (extreme + 1) / (samples + 1), exact: false };
}

/** Compare variant A with B on the same cases using per-case rates (paired by case). */
export function pairedComparison(a: number[], b: number[], options: { seed?: number } = {}): PairedComparison {
  if (a.length !== b.length || a.length < 2) {
    throw new RangeError("paired comparison needs equal-length samples with n >= 2");
  }
  const diffs = a.map((value, index) => value - b[index]!);
  const n = diffs.length;
  const meanDiff = mean(diffs);
  const sdDiff = sampleSd(diffs);
  const se = sdDiff / Math.sqrt(n);
  const tCrit = studentTQuantile(0.975, n - 1);
  const ci: [number, number] = se > 0 ? [meanDiff - tCrit * se, meanDiff + tCrit * se] : [meanDiff, meanDiff];
  const tStat = se > 0 ? meanDiff / se : meanDiff === 0 ? 0 : Number.POSITIVE_INFINITY;
  const tPValue = se > 0 ? 2 * (1 - studentTCdf(Math.abs(tStat), n - 1)) : meanDiff === 0 ? 1 : 0;
  const boot = bootstrapInterval(diffs, { seed: options.seed });
  const permutation = signFlipPValue(diffs, { seed: options.seed });
  const mde = (tCrit + studentTQuantile(0.8, n - 1)) * (Number.isFinite(sdDiff) ? sdDiff : 0) / Math.sqrt(n);
  return {
    meanDiff,
    sdDiff,
    n,
    ci,
    bootstrapCi: [boot.low, boot.high],
    tPValue,
    permutationPValue: permutation.p,
    permutationExact: permutation.exact,
    mde,
  };
}

/** McNemar exact test on paired binary outcomes (one sample per case per variant). */
export function mcnemarExact(a: boolean[], b: boolean[]): { aOnly: number; bOnly: number; p: number } {
  if (a.length !== b.length) {
    throw new RangeError("mcnemar needs paired outcomes");
  }
  let aOnly = 0;
  let bOnly = 0;
  a.forEach((value, index) => {
    if (value && !b[index]) {
      aOnly += 1;
    } else if (!value && b[index]) {
      bOnly += 1;
    }
  });
  return { aOnly, bOnly, p: binomialTwoSidedHalf(Math.min(aOnly, bOnly), aOnly + bOnly) };
}

/** Holm–Bonferroni step-down adjustment; returns adjusted p-values in the input order. */
export function holmAdjust(pValues: number[]): number[] {
  const order = pValues.map((p, index) => ({ p, index })).sort((left, right) => left.p - right.p);
  const adjusted = new Array<number>(pValues.length);
  let running = 0;
  order.forEach((entry, rank) => {
    running = Math.max(running, Math.min(1, (pValues.length - rank) * entry.p));
    adjusted[entry.index] = running;
  });
  return adjusted;
}
