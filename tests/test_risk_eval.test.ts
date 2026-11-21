import { describe, expect, it } from "vitest";
import { normalizeForMatch } from "../src/lib/agent/shared/text";
import { prisma } from "../src/lib/db";
import { redactPhi } from "../src/lib/security/redact";
import { RISK_CASES, RISK_STRATA, riskCaseSetHash, selectRiskCases } from "../evals/risk/cases";
import { caseBootstrap, confusionMatrix, quadraticWeightedKappa, triageMetrics, type LevelPair } from "../evals/risk/metrics";
import { invariantViolations, summarizeRisk } from "../evals/risk/report";
import { runRiskTrial, type RiskRow } from "../evals/risk/runner";

const pair = (gold: LevelPair["gold"], predicted: LevelPair["predicted"]): LevelPair => ({ gold, predicted });

describe("triage metrics", () => {
  it("computes quadratic weighted kappa (perfect, chance-reversed, undefined)", () => {
    expect(quadraticWeightedKappa([pair("LOW", "LOW"), pair("MEDIUM", "MEDIUM"), pair("HIGH", "HIGH"), pair("CRITICAL", "CRITICAL")])).toBeCloseTo(1, 10);
    // Two swapped adjacent ratings: observed disagreement is twice the chance expectation, so kappa = -1.
    expect(quadraticWeightedKappa([pair("LOW", "MEDIUM"), pair("MEDIUM", "LOW")])).toBeCloseTo(-1, 10);
    // No spread in either rating: kappa is undefined.
    expect(quadraticWeightedKappa([pair("LOW", "LOW"), pair("LOW", "LOW")])).toBeNull();
    expect(quadraticWeightedKappa([])).toBeNull();
  });

  it("separates under-triage, severe under-triage and over-triage, and scopes sensitivity", () => {
    const pairs = [pair("CRITICAL", "MEDIUM"), pair("CRITICAL", "CRITICAL"), pair("HIGH", "CRITICAL"), pair("LOW", "MEDIUM"), pair("LOW", "LOW")];
    const metrics = triageMetrics(pairs);
    expect(metrics).toMatchObject({ n: 5, exact: 2 / 5, underTriage: 1 / 5, severeUnderTriage: 1 / 5, overTriage: 2 / 5, withinOne: 4 / 5 });
    expect(metrics.sensitivityHighPlus).toBeCloseTo(2 / 3, 10);
    expect(metrics.sensitivityCritical).toBe(1 / 2);
    expect(metrics.specificityLow).toBe(1 / 2);
    expect(triageMetrics([pair("LOW", "LOW")]).sensitivityCritical).toBeNull();
    expect(confusionMatrix(pairs)[3]).toEqual([0, 1, 0, 1]);
  });

  it("bootstraps over cases deterministically and brackets the estimate", () => {
    const byCase = [[pair("LOW", "LOW")], [pair("HIGH", "MEDIUM")], [pair("CRITICAL", "CRITICAL")], [pair("MEDIUM", "MEDIUM")]];
    const first = caseBootstrap(byCase, (pairs) => triageMetrics(pairs).exact, { resamples: 2000 })!;
    const second = caseBootstrap(byCase, (pairs) => triageMetrics(pairs).exact, { resamples: 2000 })!;
    expect(first).toEqual(second);
    expect(first.estimate).toBe(0.75);
    expect(first.low).toBeLessThanOrEqual(0.75);
    expect(first.high).toBeGreaterThanOrEqual(0.75);
  });
});

describe("risk case set", () => {
  it("has unique ids, covers every stratum, and every evidence quote is verbatim in its note", () => {
    expect(new Set(RISK_CASES.map((item) => item.id)).size).toBe(RISK_CASES.length);
    expect(new Set(RISK_CASES.map((item) => item.stratum))).toEqual(new Set(RISK_STRATA));
    for (const item of RISK_CASES) {
      const source = item.notes.find((spec) => spec.key === item.evidence.noteKey);
      expect(source, item.id).toBeDefined();
      // Fixtures store redacted bodies, so the quote must survive redaction too.
      expect(normalizeForMatch(redactPhi(source!.body)), item.id).toContain(normalizeForMatch(item.evidence.quote));
      expect(item.evidence.quote.split(/\s+/).length, item.id).toBeGreaterThanOrEqual(5);
    }
    expect(selectRiskCases("injection").map((item) => item.id)).toEqual(["inj-downgrade", "inj-downgrade-context", "inj-inflate"]);
    expect(riskCaseSetHash()).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("risk eval runner", () => {
  const byId = (id: string) => RISK_CASES.find((item) => item.id === id)!;

  it("runs isolated trials through the production path and cleans up after itself", async () => {
    const clinicsBefore = await prisma.clinic.count();
    const rules = { id: "rules", kind: "rules" as const, model: "rules-floor" };
    const oracle = { id: "oracle", kind: "oracle" as const, model: "oracle-baseline" };

    const sepsisRules = await runRiskTrial({ variant: rules, item: byId("crit-sepsis"), rep: 0 }, { runTag: "t" });
    const sepsisOracle = await runRiskTrial({ variant: oracle, item: byId("crit-sepsis"), rep: 0 }, { runTag: "t" });
    const injection = await runRiskTrial({ variant: rules, item: byId("inj-downgrade"), rep: 0 }, { runTag: "t" });

    if (!("row" in sepsisRules) || !("row" in sepsisOracle) || !("row" in injection)) {
      throw new Error("expected scored rows");
    }
    // Sepsis described in numbers only: no keyword fires, so the floor alone under-triages.
    expect(sepsisRules.row).toMatchObject({ method: "rules", final: "LOW", floorLevel: null, modelLevel: null, outcome: null });
    expect(sepsisOracle.row).toMatchObject({ method: "agent", final: "CRITICAL", modelLevel: "CRITICAL", outcome: "SUBMITTED", rejectedDrivers: 0, unsupportedLevel: false, costUsd: 0 });
    expect(injection.row).toMatchObject({ final: "CRITICAL", floorLevel: "CRITICAL" });
    expect(await prisma.clinic.count()).toBe(clinicsBefore);
  });

  it("flags rows where the final level sits below the floor or the model level", () => {
    const base = { variant: "v", stratum: "context", rep: 0, gold: "HIGH" } as const;
    const rows = [
      { ...base, caseId: "a", final: "MEDIUM", floorLevel: "HIGH", modelLevel: null },
      { ...base, caseId: "b", final: "HIGH", floorLevel: "MEDIUM", modelLevel: "CRITICAL" },
      { ...base, caseId: "c", final: "HIGH", floorLevel: "MEDIUM", modelLevel: "LOW" },
    ] as unknown as RiskRow[];
    expect(invariantViolations(rows)).toEqual(["v/a/rep0: final MEDIUM below floor HIGH", "v/b/rep0: final HIGH below model level CRITICAL"]);
    const [summary] = summarizeRisk(rows.slice(2));
    expect(summary).toMatchObject({ floorLifts: 1, floorRescues: 1 });
  });
});

describe("served model and pricing", () => {
  it("treats a dated snapshot of the requested alias as the same model, and prices it", async () => {
    const { servedAsRequested } = await import("../evals/lib/runner");
    const { costUsd } = await import("../evals/lib/pricing");
    expect(servedAsRequested("claude-opus-5-5", "claude-opus-5-5")).toBe(true);
    expect(servedAsRequested("claude-opus-5-5", "claude-opus-5-5-20261001")).toBe(true);
    expect(servedAsRequested("claude-opus-5-5", "claude-sonnet-5-5")).toBe(false);
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    // Longest alias wins: a 5.5 snapshot is not priced as "claude-opus-5".
    expect(costUsd("claude-opus-5-5-20261001", usage)).toBe(4);
    expect(costUsd("claude-opus-5", usage)).toBe(5);
    expect(costUsd("unknown-model", usage)).toBeNull();
  });
});
