/** Text normalisation shared by the guardrails and the evaluation graders. */

const QUOTE_CHARS = /[‘’‚‛′‵]/g;
const DOUBLE_QUOTE_CHARS = /[“”„‟″‶]/g;
const DASHES = /[‐-―−]/g;

/**
 * Case-, whitespace- and typography-insensitive form used for substring checks. It never removes
 * words, so a normalised quote that is a substring of the normalised source really is verbatim.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(QUOTE_CHARS, "'")
    .replace(DOUBLE_QUOTE_CHARS, '"')
    .replace(DASHES, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip wrapping quotation marks and trailing punctuation a model tends to add around a quote. */
function trimQuote(text: string): string {
  return text.replace(/^[\s"'`«»]+|[\s"'`«».,;:!?]+$/g, "");
}

/** Split on ellipses: "a … b" means fragments a and b appear in order. */
export function quoteFragments(quote: string): string[] {
  return quote
    .split(/\s*(?:\.\.\.|…|\[\.\.\.\])\s*/)
    .map((fragment) => trimQuote(normalizeForMatch(fragment)))
    .filter((fragment) => fragment.length > 0);
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** True when every fragment of `quote` occurs in `source`, in order, after normalisation. */
export function isGroundedQuote(quote: string, source: string): boolean {
  const fragments = quoteFragments(quote);
  if (fragments.length === 0) {
    return false;
  }
  const haystack = normalizeForMatch(source);
  let from = 0;
  for (const fragment of fragments) {
    const at = haystack.indexOf(fragment, from);
    if (at < 0) {
      return false;
    }
    from = at + fragment.length;
  }
  return true;
}

export function containsNormalized(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizeForMatch(needle);
  return normalizedNeedle.length > 0 && normalizeForMatch(haystack).includes(normalizedNeedle);
}

/**
 * Split text into sentence-level evidence segments, each an exact substring of the input (trimmed):
 * line breaks always split; within a line, split after . ! ? when followed by whitespace and an
 * upper-case letter, digit, quote or bracket. Abbreviations may occasionally split a sentence in
 * two; that only makes segments shorter, never inexact.
 */
export function segmentSentences(text: string): string[] {
  const segments: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const part of line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[\u201c])/)) {
      const trimmed = part.trim();
      if (trimmed) {
        segments.push(trimmed);
      }
    }
  }
  return segments;
}
