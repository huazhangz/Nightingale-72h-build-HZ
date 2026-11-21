import { findTermMentions } from "../../care-note/keyword-highlights";
import { clinicalFloorRank } from "../../care-note/risk-tone";
import type { ClinicalTimelineEntry } from "../shared/record-context";
import { maxLevel, riskRank, type RiskLevel } from "./levels";

/**
 * Deterministic risk floor. The agent can raise a patient above it but never below it, and when no
 * model is available the floor IS the assessment. Only affirmed mentions count (negated, historical
 * and hypothetical mentions are excluded by the same context rules as the highlight engine), and
 * only notes close to the latest encounter count, so a resolved red flag does not pin a patient high
 * forever.
 *
 * Tier choices are deliberately conservative where the clinical meaning is unambiguous and silent
 * where it is not (allergy history, for example, raises no floor).
 */

export const FLOOR_WINDOW_DAYS = 7;

export const FLOOR_RULES: Record<string, { level: RiskLevel; label: string }> = {
  "vital:spo2<90": { level: "CRITICAL", label: "SpO2 below 90%" },
  "vital:bp>180/110": { level: "CRITICAL", label: "Blood pressure above 180/110" },
  "term:anaphylaxis": { level: "CRITICAL", label: "Anaphylaxis" },
  "term:severe respiratory distress": { level: "CRITICAL", label: "Severe respiratory distress" },
  "term:chest pain": { level: "HIGH", label: "Chest pain" },
  "term:shortness of breath": { level: "HIGH", label: "Shortness of breath" },
  "term:hyperpyrexia": { level: "HIGH", label: "Hyperpyrexia" },
  "term:fever": { level: "MEDIUM", label: "Fever" },
};

export type FloorReason = {
  rule: string;
  label: string;
  level: RiskLevel;
  noteId: string;
  title: string;
  encounterAt: string;
  excerpt: string;
  source: "rule-engine" | "clinician-highlight";
};

export type RiskFloor = { level: RiskLevel | null; reasons: FloorReason[] };

export function computeRiskFloor(timeline: ClinicalTimelineEntry[]): RiskFloor {
  const withBody = timeline.filter((entry) => typeof entry.body === "string");
  if (withBody.length === 0) {
    return { level: null, reasons: [] };
  }
  const latest = Math.max(...withBody.map((entry) => new Date(entry.encounterAt).getTime()));
  const windowStart = latest - FLOOR_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const reasons: FloorReason[] = [];

  for (const entry of withBody) {
    if (new Date(entry.encounterAt).getTime() < windowStart) {
      continue;
    }
    const seen = new Set<string>();
    for (const mention of findTermMentions(entry.body!)) {
      const rule = FLOOR_RULES[mention.termKey];
      if (!rule || mention.context !== "AFFIRMED" || seen.has(mention.termKey)) {
        continue;
      }
      seen.add(mention.termKey);
      reasons.push({
        rule: mention.termKey,
        label: rule.label,
        level: rule.level,
        noteId: entry.id,
        title: entry.title,
        encounterAt: entry.encounterAt,
        excerpt: mention.excerpt,
        source: "rule-engine",
      });
    }
    for (const highlight of entry.highlights) {
      if (highlight.source === "HUMAN" && clinicalFloorRank(highlight.label) >= 100) {
        reasons.push({
          rule: "human:critical-highlight",
          label: "Clinician-marked critical finding",
          level: "HIGH",
          noteId: entry.id,
          title: entry.title,
          encounterAt: entry.encounterAt,
          excerpt: highlight.excerpt,
          source: "clinician-highlight",
        });
      }
    }
  }

  reasons.sort((left, right) => riskRank(right.level) - riskRank(left.level));
  return { level: reasons.length ? maxLevel(...reasons.map((reason) => reason.level)) : null, reasons };
}
