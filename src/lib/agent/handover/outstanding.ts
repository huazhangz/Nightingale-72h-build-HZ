import { segmentSentences } from "../shared/text";

/**
 * Deterministic detector for actions a note documents as still outstanding: a result that is
 * pending, a test or review that has been requested or scheduled, a referral awaiting a reply.
 *
 * Why: in the 2026-11 Gemini challenge run (docs/EVALUATION.md §7.6) both handover-v4 failures
 * were a pending result ("histology is pending", "Repeat CT in six months has been requested")
 * summarised correctly but never proposed as a follow-up. The model was not wrong about the facts;
 * it skipped an optional tool call. A check that names the sentence turns an easy-to-skip step into
 * a specific question the model answers once (handover-v6).
 *
 * The detector only decides *whether to ask*. It never creates a follow-up itself: the model still
 * decides, and a clinician still confirms every proposal.
 */

/** Phrases that say something is not done yet. */
const OUTSTANDING = [
  /\b(?:is|are|remains?|still)\s+(?:pending|awaited|outstanding)\b/i,
  /\b(?:results?|histology|cultures?|swabs?|bloods?|biopsy|report)\s+(?:pending|awaited|to follow)\b/i,
  /\bpending\s+(?:results?|histology|culture|review|referral|report|biopsy)\b/i,
  /\bawaiting\s+(?:the\s+|an?\s+)?(?:\p{L}+\s+){0,2}(?:results?|histology|culture|report|review|reply|response|appointment|scan|biopsy|bloods?)\b/iu,
  /\bnot\s+yet\s+(?:back|resulted|reported|available|received)\b/i,
  /\b(?:has|have)\s+been\s+(?:requested|ordered|booked|arranged|scheduled)\b/i,
  /\b(?:requested|ordered|booked|arranged|scheduled)\s+for\s+(?:next|tomorrow|\d)/i,
  /\brepeat\s+[\p{L}\d-]+(?:\s+[\p{L}\d-]+)?\s+in\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b/iu,
];
// Deliberately absent: routine "review in a month" / "recheck in two weeks". They are already part of
// the plan, and on the 50 evaluation cases they fired on 2 of 6 records where a follow-up proposal
// is a misuse (adv-superseded-bp, ch-safety-net-regression) and on no record that needs one.

/** Phrases that close the loop or deny there is anything outstanding. */
const NOT_OUTSTANDING = [
  /\bno\s+(?:\p{L}+\s+){0,3}(?:pending|outstanding|awaited)\b/iu,
  /\bnothing\s+(?:is\s+)?(?:pending|outstanding)\b/i,
  /\b(?:results?|histology|report)\s+(?:is\s+|are\s+|was\s+|were\s+)?(?:back|received|reviewed|normal|unremarkable)\b/i,
  /\b(?:declined|cancelled|canceled)\b/i,
];

const GENERIC = new Set([
  "result", "results", "pending", "awaited", "awaiting", "outstanding", "requested", "ordered", "booked",
  "arranged", "scheduled", "repeat", "review", "today", "sent", "taken", "has", "have", "been", "the", "and",
  "chase", "follow", "with", "for", "next", "months", "weeks", "days", "six", "two", "three", "check",
  "in", "on", "of", "to", "at", "is", "be", "an", "up", "or", "no", "by", "as", "it", "we",
]);

/** Content words of a sentence or task, minus the words every pending-action sentence shares. */
export function specificTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      // Two-letter tokens stay: CT, US, BP and Hb are exactly the words that name the action.
      .filter((token) => token.length >= 2 && !GENERIC.has(token)),
  );
}

/** True when a task text (open action or proposal) is about the same thing as the sentence. */
export function coversSentence(taskText: string, sentence: string): boolean {
  const task = specificTokens(taskText);
  return [...specificTokens(sentence)].some((token) => task.has(token));
}

export type OutstandingMention = { noteId: string; sentence: string };

export function outstandingSentences(text: string): string[] {
  return segmentSentences(text).filter(
    (sentence) => OUTSTANDING.some((pattern) => pattern.test(sentence)) && !NOT_OUTSTANDING.some((pattern) => pattern.test(sentence)),
  );
}

export function outstandingMentions(notes: Iterable<{ noteId: string; body: string | null }>): OutstandingMention[] {
  const mentions: OutstandingMention[] = [];
  for (const note of notes) {
    if (!note.body) continue;
    for (const sentence of outstandingSentences(note.body)) {
      mentions.push({ noteId: note.noteId, sentence });
    }
  }
  return mentions;
}
