import { redactPhi } from "../../security/redact";
import { negationConflict, verifyCitations } from "../shared/citations";
import { looksLikeInjectedInstruction } from "../shared/injection";
import type { EvidenceLedger } from "../shared/record-context";
import type { RiskFloor } from "./floor";
import { maxLevel, REVIEW_FOR_LEVEL, riskRank, tightenReview, type RiskLevel } from "./levels";
import type { RiskDriver, RiskResult, RiskSubmission } from "./schema";

/**
 * Deterministic post-processing of the model's assessment:
 *   1. Drivers keep only verified citations (read in this run, verbatim quote); drivers left with
 *      none are dropped, as are "raises" drivers contradicting their own negated quote and drivers
 *      carrying instruction-like text.
 *   2. Final level = max(model level, rule floor): the floor can raise, never lower.
 *   3. The review window is never looser than the final level allows.
 *   4. A level above LOW with no surviving driver is kept (over-triage is the safe direction) but
 *      flagged as unsupported so the UI can say so.
 */
export function applyRiskGuardrails(input: {
  submission: RiskSubmission;
  ledger: EvidenceLedger;
  floor: RiskFloor;
}): RiskResult {
  const rejectedDrivers: Array<{ factor: string; reason: string }> = [];
  const drivers: RiskDriver[] = [];
  for (const driver of input.submission.drivers) {
    const factor = redactPhi(driver.factor.trim());
    if (looksLikeInjectedInstruction(driver.factor)) {
      rejectedDrivers.push({ factor: factor.slice(0, 120), reason: "INSTRUCTION_TEXT" });
      continue;
    }
    const { valid, failures } = verifyCitations(driver.citations, input.ledger);
    if (valid.length === 0) {
      rejectedDrivers.push({ factor: factor.slice(0, 120), reason: failures[0]?.reason ?? "UNCITED" });
      continue;
    }
    if (driver.direction === "raises" && negationConflict(driver.factor, valid.map((citation) => citation.quote))) {
      rejectedDrivers.push({ factor: factor.slice(0, 120), reason: "NEGATION_CONFLICT" });
      continue;
    }
    drivers.push({ factor, direction: driver.direction, citations: valid });
  }

  const modelLevel = input.submission.level;
  const level = maxLevel(modelLevel, input.floor.level);
  const review = tightenReview(level, input.submission.review);
  const summaryRejected = looksLikeInjectedInstruction(input.submission.summary);
  const summary = summaryRejected ? "" : redactPhi(input.submission.summary.trim());

  return {
    method: "agent",
    level,
    review,
    summary,
    confidence: input.submission.confidence,
    drivers,
    floorReasons: input.floor.reasons,
    report: {
      modelLevel,
      floorLevel: input.floor.level,
      floorApplied: riskRank(input.floor.level) > riskRank(modelLevel),
      reviewTightened: review !== input.submission.review,
      rejectedDrivers,
      unsupportedLevel: riskRank(modelLevel) > 0 && drivers.length === 0,
      summaryRejected,
    },
  };
}

/** Assessment from the rule floor alone: used when no model is configured or the model run failed. */
export function ruleBasedAssessment(floor: RiskFloor, reason: "no_model" | "model_failed"): RiskResult {
  const level: RiskLevel = floor.level ?? "LOW";
  const strongest = floor.reasons[0];
  const summary = strongest
    ? `Rule-based assessment: "${redactPhi(strongest.excerpt)}" (${strongest.label}) in "${redactPhi(strongest.title)}".`
    : "Rule-based assessment: no rule-flagged finding in the most recent notes.";
  return {
    method: "rules",
    level,
    review: REVIEW_FOR_LEVEL[level],
    summary,
    confidence: null,
    drivers: floor.reasons.slice(0, 6).map((item) => ({
      factor: `${item.label} (${item.source === "rule-engine" ? "rule engine" : "clinician highlight"})`,
      direction: "raises" as const,
      citations: [{ noteId: item.noteId, quote: redactPhi(item.excerpt), title: item.title, encounterAt: item.encounterAt }],
    })),
    floorReasons: floor.reasons,
    report: {
      modelLevel: null,
      floorLevel: floor.level,
      floorApplied: floor.level !== null,
      reviewTightened: false,
      rejectedDrivers: reason === "model_failed" ? [{ factor: "(model run failed)", reason: "MODEL_FAILED" }] : [],
      unsupportedLevel: false,
      summaryRejected: false,
    },
  };
}
