import { describe, expect, it } from "vitest";
import {
  bootstrapInterval,
  caseMeanInterval,
  designEffect,
  holmAdjust,
  mcnemarExact,
  pairedComparison,
  passAtK,
  passHatK,
  signFlipPValue,
  studentTCdf,
  studentTQuantile,
  wilsonInterval,
} from "../evals/lib/stats";

function binom(n: number, k: number): number {
  let value = 1;
  for (let i = 1; i <= k; i += 1) {
    value = (value * (n - k + i)) / i;
  }
  return value;
}

describe("pass@k and pass^k", () => {
  it("matches the closed forms", () => {
    for (const [n, c, k] of [
      [5, 2, 1],
      [5, 2, 2],
      [10, 3, 5],
      [10, 7, 3],
      [20, 1, 10],
    ] as const) {
      expect(passAtK(n, c, k)).toBeCloseTo(1 - binom(n - c, k) / binom(n, k), 12);
      expect(passHatK(n, c, k)).toBeCloseTo(binom(c, k) / binom(n, k), 12);
    }
  });

  it("handles the boundaries", () => {
    expect(passAtK(5, 2, 1)).toBeCloseTo(0.4, 12);
    expect(passAtK(5, 2, 4)).toBe(1);
    expect(passAtK(5, 0, 3)).toBe(0);
    expect(passHatK(5, 5, 5)).toBe(1);
    expect(passHatK(5, 3, 4)).toBe(0);
    expect(passHatK(5, 3, 2)).toBeCloseTo(0.3, 12);
  });

  it("pass^k never exceeds pass@1, which never exceeds pass@k", () => {
    for (let c = 0; c <= 8; c += 1) {
      for (let k = 1; k <= 8; k += 1) {
        expect(passHatK(8, c, k)).toBeLessThanOrEqual(passAtK(8, c, 1) + 1e-12);
        expect(passAtK(8, c, 1)).toBeLessThanOrEqual(passAtK(8, c, k) + 1e-12);
      }
    }
  });

  it("rejects impossible inputs", () => {
    expect(() => passAtK(3, 4, 1)).toThrow(RangeError);
    expect(() => passAtK(3, 1, 4)).toThrow(RangeError);
  });
});

describe("Student t distribution", () => {
  it.each([
    [1, 12.706204736],
    [4, 2.776445105],
    [10, 2.228138852],
    [19, 2.093024054],
    [30, 2.042272456],
  ])("0.975 quantile with df=%i", (df, expected) => {
    expect(studentTQuantile(0.975, df)).toBeCloseTo(expected, 6);
  });

  it("0.8 quantile and CDF symmetry", () => {
    expect(studentTQuantile(0.8, 19)).toBeCloseTo(0.860951, 5);
    expect(studentTCdf(0, 7)).toBeCloseTo(0.5, 12);
    expect(studentTCdf(-1.3, 7) + studentTCdf(1.3, 7)).toBeCloseTo(1, 12);
  });
});

describe("intervals", () => {
  it("Wilson interval matches reference values", () => {
    const [low, high] = wilsonInterval(8, 10);
    expect(low).toBeCloseTo(0.4902, 4);
    expect(high).toBeCloseTo(0.9433, 4);
  });

  it("case-level t-interval", () => {
    const interval = caseMeanInterval([0.2, 0.4, 0.6, 0.8, 1]);
    expect(interval.estimate).toBeCloseTo(0.6, 12);
    // Sample variance = 0.4 / 4 = 0.1, so SE = sqrt(0.1 / 5).
    expect(interval.se).toBeCloseTo(Math.sqrt(0.1 / 5), 12);
    const t = studentTQuantile(0.975, 4);
    expect(interval.low).toBeCloseTo(Math.max(0, 0.6 - t * interval.se), 12);
    expect(interval.high).toBeCloseTo(Math.min(1, 0.6 + t * interval.se), 12);
  });

  it("bootstrap is reproducible for a seed and brackets the estimate", () => {
    const values = [0, 0.5, 1, 1, 0.5, 0, 1, 1, 0.75, 0.25];
    const first = bootstrapInterval(values, { seed: 3, resamples: 4_000 });
    const second = bootstrapInterval(values, { seed: 3, resamples: 4_000 });
    expect(first).toEqual(second);
    expect(first.low).toBeLessThan(first.estimate);
    expect(first.high).toBeGreaterThan(first.estimate);
  });

  it("reports a design effect above 1 when cases cluster", () => {
    // Cases either always pass or always fail: trials within a case add no information.
    expect(designEffect([1, 1, 0, 0, 1, 0], 5, 0.5)).toBeGreaterThan(4);
  });
});

describe("paired tests", () => {
  it("sign-flip permutation is exact for small n", () => {
    expect(signFlipPValue([1, 1, 1, 1, 1]).p).toBeCloseTo(2 / 32, 12);
    expect(signFlipPValue([0, 0, 0]).p).toBe(1);
    expect(signFlipPValue([1, -1]).p).toBe(1);
  });

  it("falls back to seeded Monte Carlo beyond 20 non-zero pairs", () => {
    const diffs = Array.from({ length: 24 }, (_, index) => (index % 3 === 0 ? -0.2 : 0.4));
    const result = signFlipPValue(diffs, { seed: 11, samples: 20_000 });
    expect(result.exact).toBe(false);
    expect(result.p).toBeLessThan(0.01);
  });

  it("paired comparison detects a consistent improvement", () => {
    const b = [0.2, 0.4, 0.6, 0.2, 0.4, 0.6, 0.2, 0.4, 0.6, 0.4];
    const a = b.map((value) => Math.min(1, value + 0.4));
    const result = pairedComparison(a, b, { seed: 5 });
    expect(result.meanDiff).toBeCloseTo(0.4, 12);
    expect(result.ci[0]).toBeGreaterThan(0);
    expect(result.permutationPValue).toBeCloseTo(2 / 1024, 12);
    expect(result.tPValue).toBeLessThan(0.001);
  });

  it("McNemar exact test", () => {
    const a = [true, true, true, true, true, true, false];
    const b = [false, false, false, false, false, false, false];
    const result = mcnemarExact(a, b);
    expect(result).toMatchObject({ aOnly: 6, bOnly: 0 });
    expect(result.p).toBeCloseTo(2 * 0.5 ** 6, 12);
  });

  it("Holm adjustment is monotone and capped at 1", () => {
    expect(holmAdjust([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
    expect(holmAdjust([0.5, 0.9])).toEqual([1, 1]);
  });
});
