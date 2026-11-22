import { findTermMentions } from "../../care-note/keyword-highlights";
import { redactPhi } from "../../security/redact";
import type { EvidenceLedger } from "./record-context";
import { isGroundedQuote, wordCount } from "./text";

/**
 * Citation verification shared by every agent: a citation counts only if its note was read in this
 * run and its quote is a verbatim substring of that note's visible text. A note id is easy to guess;
 * a verbatim quote is not.
 */

export const MIN_QUOTE_WORDS = 2;

export type CitationRejection =
  | "UNCITED"
  | "UNKNOWN_NOTE"
  | "UNREAD_NOTE"
  | "UNGROUNDED_QUOTE"
  | "QUOTE_TOO_SHORT"
  | "NEGATION_CONFLICT"
  | "INSTRUCTION_TEXT"
  | "UNKNOWN_EVIDENCE";

/** A citation that passed verification, enriched for display. */
export type VerifiedCitation = {
  noteId: string;
  quote: string;
  title: string;
  encounterAt: string;
};

export type CitationCheck = { ok: true; citation: VerifiedCitation } | { ok: false; reason: CitationRejection };

/** Marker note id for an evidence id that did not resolve (see resolveEvidenceSubmission callers). */
export const UNKNOWN_EVIDENCE_PREFIX = "unknown-evidence:";

export function checkCitation(citation: { note_id: string; quote: string }, ledger: EvidenceLedger): CitationCheck {
  if (citation.note_id.startsWith(UNKNOWN_EVIDENCE_PREFIX)) {
    return { ok: false, reason: "UNKNOWN_EVIDENCE" };
  }
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
 * Evidence mode: turn a server-issued segment id into the citation it stands for. The quote is the
 * segment's exact text, so it verifies by construction; unknown ids return null (the caller reports
 * UNKNOWN_EVIDENCE). Ids are issued only for notes this run read, so an id cannot point elsewhere.
 */
export function resolveEvidence(evidenceId: number | string, ledger: EvidenceLedger): { note_id: string; quote: string } | null {
  const segment = ledger.evidence.get(typeof evidenceId === "number" ? evidenceId : Number.parseInt(evidenceId, 10));
  return segment ? { note_id: segment.noteId, quote: segment.text } : null;
}

/** Verify a list of citations: the valid ones (deduplicated) and the reasons the others failed. */
export function verifyCitations(
  citations: Array<{ note_id: string; quote: string }>,
  ledger: EvidenceLedger,
): { valid: VerifiedCitation[]; failures: Array<{ noteId: string; reason: CitationRejection }> } {
  const valid: VerifiedCitation[] = [];
  const failures: Array<{ noteId: string; reason: CitationRejection }> = [];
  for (const citation of citations) {
    const check = checkCitation(citation, ledger);
    if (!check.ok) {
      failures.push({ noteId: citation.note_id, reason: check.reason });
    } else if (!valid.some((item) => item.noteId === check.citation.noteId && item.quote === check.citation.quote)) {
      valid.push(check.citation);
    }
  }
  return { valid, failures };
}

/**
 * The statement affirms a lexicon phrase (e.g. "has chest pain") while every mention of that phrase
 * in its own quotes is negated ("denies chest pain"). Deterministic, conservative: if a quote does not
 * mention the phrase at all, no judgement is made.
 */
/**
 * Mentions the statement affirms, ignoring the last item of a negated list. The engine ends negation
 * scope at ", and" ("fever without hyperpyrexia, and nausea" affirms nausea), which also reads
 * "denies chest pain, shortness of breath, fever, and nausea" as affirming nausea. A mention whose
 * nearest preceding mention is negated and separated from it only by commas, "and" or "or" is
 * treated as part of that list. Found in the 2026-11-22 evaluation, where this rejected a correct
 * pertinent negative. The engine itself (and so the risk floor) is unchanged.
 */
function affirmedOutsideNegatedLists(text: string): ReturnType<typeof findTermMentions> {
  const mentions = findTermMentions(text).sort((left, right) => left.startOffset - right.startOffset);
  return mentions.filter((mention, index) => {
    if (mention.context !== "AFFIRMED") {
      return false;
    }
    const previous = mentions[index - 1];
    if (!previous || previous.context !== "NEGATED") {
      return true;
    }
    return !/^[\s,;]*(?:(?:and|or)[\s,]*)?$/i.test(text.slice(previous.endOffset, mention.startOffset));
  });
}

export function negationConflict(statement: string, quotes: string[]): string | null {
  const affirmed = affirmedOutsideNegatedLists(statement);
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
