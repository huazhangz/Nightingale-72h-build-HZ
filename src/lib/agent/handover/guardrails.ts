import { findTermMentions } from "../../care-note/keyword-highlights";
import { clinicalFloorRank } from "../../care-note/risk-tone";
import { redactPhi } from "../../security/redact";
import type { ClinicalTimelineEntry, EvidenceLedger } from "./context";
import {
  SEVERITY_RANK,
  type Category,
  type GuardrailReport,
  type HandoverSubmission,
  type ItemFlag,
  type RejectionReason,
  type Severity,
  type SummaryItem,
  type VerifiedCitation,
} from "./schema";
import { containsNormalized, isGroundedQuote, normalizeForMatch, wordCount } from "./text";

/**
 * Deterministic post-output validation. Nothing here depends on the prompt: the model can be
 * prompt-injected or simply wrong, and these checks still hold.
 *
 *   1. Every citation must point at a note this run actually read, and its quote must be a verbatim
 *      substring of that note (body or visible comments). Items left with no valid citation are rejected.
 *   2. A statement that asserts a red-flag phrase which its own quotes only ever negate is rejected.
 *   3. Critical findings cannot be downgraded: every visible critical-floor highlight must appear as a
 *      critical item — the model's item is raised if it chose a lower severity, and a guardrail item is
 *      injected if the model left it out.
 *   4. Statements are re-redacted before they leave the server.
 */

export const MIN_QUOTE_WORDS = 2;

/** A finding the safety floor protects (critical-tier highlight visible to the actor). */
export type CriticalFinding = {
  findingId: string;
  noteId: string;
  excerpt: string;
  label: string | null;
  source: string;
  title: string;
  encounterAt: string;
};

/** Critical-floor findings in the actor's view. Notes whose body the actor cannot see are excluded. */
export function criticalFindingsFor(timeline: ClinicalTimelineEntry[]): CriticalFinding[] {
  const findings: CriticalFinding[] = [];
  for (const entry of timeline) {
    if (entry.body === undefined) {
      continue;
    }
    for (const highlight of entry.highlights) {
      if (clinicalFloorRank(highlight.label) >= 100) {
        findings.push({
          findingId: highlight.id,
          noteId: entry.id,
          excerpt: highlight.excerpt,
          label: highlight.label,
          source: highlight.source,
          title: entry.title,
          encounterAt: entry.encounterAt,
        });
      }
    }
  }
  return findings;
}

type CitationCheck = { ok: true; citation: VerifiedCitation } | { ok: false; reason: RejectionReason };

function checkCitation(citation: { note_id: string; quote: string }, ledger: EvidenceLedger): CitationCheck {
  const note = ledger.readNotes.get(citation.note_id);
  if (!note) {
    return { ok: false, reason: ledger.surfacedNoteIds.has(citation.note_id) ? "UNREAD_NOTE" : "UNKNOWN_NOTE" };
  }
  const source = ledger.sourceText(citation.note_id);
  if (source === null) {
    return { ok: false, reason: "UNREAD_NOTE" };
  }
  if (wordCount(citation.quote) < MIN_QUOTE_WORDS) {
    return { ok: false, reason: "QUOTE_TOO_SHORT" };
  }
  if (!isGroundedQuote(citation.quote, source)) {
    return { ok: false, reason: "UNGROUNDED_QUOTE" };
  }
  return {
    ok: true,
    citation: {
      noteId: note.noteId,
      quote: redactPhi(citation.quote.trim()),
      title: note.title,
      encounterAt: note.encounterAt,
    },
  };
}

/**
 * The statement affirms a lexicon phrase (e.g. "has chest pain") while every mention of that phrase
 * in its own quotes is negated ("denies chest pain"). Deterministic, conservative: if a quote does not
 * mention the phrase at all, no judgement is made.
 */
export function negationConflict(statement: string, quotes: string[]): string | null {
  const affirmed = findTermMentions(statement).filter((mention) => mention.context === "AFFIRMED");
  for (const mention of affirmed) {
    const quoteMentions = quotes.flatMap((quote) =>
      findTermMentions(quote).filter((item) => item.termKey === mention.termKey),
    );
    if (quoteMentions.length > 0 && quoteMentions.every((item) => item.context === "NEGATED")) {
      return mention.excerpt.toLowerCase();
    }
  }
  return null;
}

function covers(item: { statement: string; citations: VerifiedCitation[] }, finding: CriticalFinding): boolean {
  return item.citations.some(
    (citation) =>
      citation.noteId === finding.noteId &&
      (containsNormalized(citation.quote, finding.excerpt) || containsNormalized(item.statement, finding.excerpt)),
  );
}

const CATEGORY_ORDER: Category[] = [
  "critical_finding",
  "active_problem",
  "pending_action",
  "medication_allergy",
  "plan",
  "patient_concern",
  "context",
];

export function applyGuardrails(input: {
  submission: HandoverSubmission;
  ledger: EvidenceLedger;
  criticalFindings: CriticalFinding[];
}): { items: SummaryItem[]; report: GuardrailReport } {
  const report: GuardrailReport = {
    modelItemCount: input.submission.items.length,
    acceptedCount: 0,
    rejected: [],
    droppedCitations: [],
    severityUpgrades: [],
    injectedCritical: [],
    requiredCriticalCount: input.criticalFindings.length,
    phiRedactions: 0,
  };

  const accepted: SummaryItem[] = [];
  input.submission.items.forEach((item, index) => {
    const valid: VerifiedCitation[] = [];
    const failures: RejectionReason[] = [];
    for (const citation of item.citations) {
      const check = checkCitation(citation, input.ledger);
      if (check.ok) {
        if (!valid.some((existing) => existing.noteId === check.citation.noteId && existing.quote === check.citation.quote)) {
          valid.push(check.citation);
        }
      } else {
        failures.push(check.reason);
        report.droppedCitations.push({ index, noteId: citation.note_id, reason: check.reason });
      }
    }
    const preview = redactPhi(item.statement).slice(0, 160);
    if (valid.length === 0) {
      report.rejected.push({ index, statement: preview, reason: failures[0] ?? "UNCITED" });
      // Citations of a rejected item are reported once, as the rejection.
      report.droppedCitations = report.droppedCitations.filter((dropped) => dropped.index !== index);
      return;
    }
    const conflict = negationConflict(item.statement, valid.map((citation) => citation.quote));
    if (conflict) {
      report.rejected.push({ index, statement: preview, reason: "NEGATION_CONFLICT", detail: conflict });
      return;
    }
    const flags: ItemFlag[] = [];
    const statement = redactPhi(item.statement.trim());
    if (statement !== item.statement.trim()) {
      flags.push("PHI_REDACTED");
      report.phiRedactions += 1;
    }
    accepted.push({
      id: `S${accepted.length + 1}`,
      category: item.category,
      severity: item.severity,
      statement,
      citations: valid,
      origin: "model",
      flags,
    });
  });
  report.acceptedCount = accepted.length;

  // Safety floor: critical findings are never omitted or downgraded.
  const items = [...accepted];
  for (const finding of input.criticalFindings) {
    const covering = items.filter((item) => covers(item, finding));
    if (covering.some((item) => item.severity === "critical")) {
      continue;
    }
    const target = covering[0];
    if (target) {
      report.severityUpgrades.push({ itemId: target.id, from: target.severity, findingId: finding.findingId });
      target.modelSeverity = target.severity;
      target.severity = "critical";
      target.flags.push("SEVERITY_UPGRADED");
      continue;
    }
    const itemId = `G${report.injectedCritical.length + 1}`;
    const excerpt = redactPhi(finding.excerpt);
    items.push({
      id: itemId,
      category: "critical_finding",
      severity: "critical",
      statement: `Flagged by the clinical safety rules: "${excerpt}" (${finding.label ?? "critical"}). Review this note.`,
      citations: [{ noteId: finding.noteId, quote: excerpt, title: finding.title, encounterAt: finding.encounterAt }],
      origin: "guardrail",
      flags: [],
    });
    report.injectedCritical.push({ itemId, findingId: finding.findingId, noteId: finding.noteId, excerpt });
  }

  items.sort(
    (left, right) =>
      SEVERITY_RANK[right.severity as Severity] - SEVERITY_RANK[left.severity as Severity] ||
      CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category),
  );
  return { items, report };
}

/** Stable key for a finding's text, used by graders to match findings across runs. */
export function findingKey(finding: Pick<CriticalFinding, "noteId" | "excerpt">): string {
  return `${finding.noteId}:${normalizeForMatch(finding.excerpt)}`;
}
