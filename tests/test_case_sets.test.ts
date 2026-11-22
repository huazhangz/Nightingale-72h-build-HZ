import { describe, expect, it } from "vitest";
import { normalizeForMatch } from "../src/lib/agent/shared/text";
import { redactPhi } from "../src/lib/security/redact";
import { caseSetHash, CHALLENGE_CASES, CORE_CASES, selectCases } from "../evals/cases";
import { RISK_CASES, RISK_CHALLENGE_CASES, riskCaseSetHash, selectRiskCases } from "../evals/risk/cases";

/**
 * The core sets are frozen: every published number refers to them. Changing a core case changes
 * its hash and fails here; that is deliberate. Add new cases to the challenge sets instead, or, if
 * a core case is genuinely wrong, fix it in a reviewed commit that updates the pinned hash and says
 * which reported results it invalidates.
 */
describe("evaluation case sets", () => {
  it("keeps the core sets frozen", () => {
    expect(CORE_CASES).toHaveLength(20);
    expect(caseSetHash(CORE_CASES)).toBe("f6a3adc3590b");
    expect(RISK_CASES).toHaveLength(28);
    expect(riskCaseSetHash(RISK_CASES)).toBe("4a43414eacab");
  });

  it("keeps challenge cases separate, uniquely named and selectable", () => {
    const handoverIds = [...CORE_CASES, ...CHALLENGE_CASES].map((item) => item.id);
    expect(new Set(handoverIds).size).toBe(handoverIds.length);
    expect(CHALLENGE_CASES.every((item) => item.tags[0] === "challenge")).toBe(true);
    expect(selectCases(undefined)).toBe(CORE_CASES);
    expect(selectCases("challenge")).toBe(CHALLENGE_CASES);
    expect(selectCases("all")).toHaveLength(CORE_CASES.length + CHALLENGE_CASES.length);

    const riskIds = [...RISK_CASES, ...RISK_CHALLENGE_CASES].map((item) => item.id);
    expect(new Set(riskIds).size).toBe(riskIds.length);
    expect(RISK_CHALLENGE_CASES.every((item) => item.stratum === "challenge")).toBe(true);
    expect(selectRiskCases()).toBe(RISK_CASES);
    expect(selectRiskCases("challenge")).toEqual(RISK_CHALLENGE_CASES);
  });

  it("has verbatim gold evidence in every risk challenge case", () => {
    for (const item of RISK_CHALLENGE_CASES) {
      const source = item.notes.find((spec) => spec.key === item.evidence.noteKey)!;
      expect(normalizeForMatch(redactPhi(source.body)), item.id).toContain(normalizeForMatch(item.evidence.quote));
      expect(item.evidence.quote.split(/\s+/).length, item.id).toBeGreaterThanOrEqual(5);
    }
  });
});
