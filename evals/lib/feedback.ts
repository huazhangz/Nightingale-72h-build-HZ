import { normalizeForMatch } from "../../src/lib/agent/shared/text";

/**
 * Turn clinician feedback on highlights into evaluation expectations. This is the bridge the
 * roadmap asks for ("use the existing PIN / AGREE / DISAGREE data as the eval set"): it runs on
 * HighlightFeedback rows exactly as stored, so production feedback can feed the same pipeline.
 *
 *   PIN / AGREE  -> the finding must be covered by a cited statement (coverage only; severity
 *                   expectations come from explicit clinical labels, not from feedback)
 *   DISAGREE     -> the finding should not be presented as critical (soft "over-triage" metric)
 *
 * With several reviewers on one highlight, the majority wins; ties count as no expectation.
 */

export type FeedbackRow = {
  highlightId: string;
  noteId: string;
  excerpt: string;
  label: string | null;
  verdict: "PIN" | "AGREE" | "DISAGREE" | "EDIT";
};

export type DerivedCover = {
  id: string;
  noteId: string;
  anyOf: string[];
  provenance: "feedback:PIN" | "feedback:AGREE";
};

export type DerivedNotCritical = { id: string; noteId: string; anyOf: string[]; provenance: "feedback:DISAGREE" };

export function deriveExpectationsFromFeedback(rows: FeedbackRow[]): {
  mustCover: DerivedCover[];
  notCritical: DerivedNotCritical[];
} {
  const groups = new Map<string, { noteId: string; excerpt: string; votes: FeedbackRow["verdict"][] }>();
  for (const row of rows) {
    const key = `${row.noteId}|${normalizeForMatch(row.excerpt)}`;
    const group = groups.get(key) ?? { noteId: row.noteId, excerpt: row.excerpt, votes: [] };
    group.votes.push(row.verdict);
    groups.set(key, group);
  }

  const mustCover: DerivedCover[] = [];
  const notCritical: DerivedNotCritical[] = [];
  for (const group of [...groups.values()].sort((left, right) => left.excerpt.localeCompare(right.excerpt))) {
    const positive = group.votes.filter((vote) => vote === "PIN" || vote === "AGREE" || vote === "EDIT").length;
    const negative = group.votes.filter((vote) => vote === "DISAGREE").length;
    const slug = normalizeForMatch(group.excerpt).replace(/[^a-z0-9]+/g, "-");
    if (positive > negative) {
      const pinned = group.votes.includes("PIN");
      mustCover.push({
        id: `fb-${slug}`,
        noteId: group.noteId,
        anyOf: [group.excerpt.toLowerCase()],
        provenance: pinned ? "feedback:PIN" : "feedback:AGREE",
      });
    } else if (negative > positive) {
      notCritical.push({
        id: `fb-not-critical-${slug}`,
        noteId: group.noteId,
        anyOf: [group.excerpt.toLowerCase()],
        provenance: "feedback:DISAGREE",
      });
    }
  }
  return { mustCover, notCritical };
}
