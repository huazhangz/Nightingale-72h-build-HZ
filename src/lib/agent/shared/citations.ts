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
  | "INSTRUCTION_TEXT";

/** A citation that passed verification, enriched for display. */
export type VerifiedCitation = {
  noteId: string;
  quote: string;
  title: string;
  encounterAt: string;
};

export type CitationCheck = { ok: true; citation: VerifiedCitation } | { ok: false; reason: CitationRejection };

export function checkCitation(citation: { note_id: string; quote: string }, ledger: EvidenceLedger): CitationCheck {
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
