/**
 * Deterministic clinical phrase engine — implements docs/CLINICAL_HIGHLIGHT_RULES.txt (v1.1).
 *
 * Pure, synchronous, dependency-free: safe to import from server code, the agent guardrails,
 * the evaluation graders, and tests. Same input always yields the same output.
 */

export type RiskLabel =
  | "HIGH"
  | "CRITICAL"
  | "MEDIUM"
  | "LOW"
  | "WARNING"
  | "INFO"
  | "UNRESOLVED_ACTION"
  | "PATIENT_INSIGHT";

/** How a mention is asserted in its sentence (ConText-style). */
export type MentionContext = "AFFIRMED" | "NEGATED" | "HISTORICAL" | "HYPOTHETICAL";

export type RiskPhraseHit = {
  startOffset: number;
  endOffset: number;
  excerpt: string;
  label: RiskLabel;
  /** AFFIRMED keeps the lexicon label; HISTORICAL / HYPOTHETICAL are demoted to INFO. */
  context: Exclude<MentionContext, "NEGATED">;
  /** Stable key of the lexicon entry or vital-sign rule that produced the hit. */
  termKey: string;
};

export type TermMention = {
  startOffset: number;
  endOffset: number;
  excerpt: string;
  termKey: string;
  baseLabel: RiskLabel;
  context: MentionContext;
};

/** Labels this engine writes as MODEL highlights (used to replace them on note edits). */
export const ENGINE_LABELS: readonly RiskLabel[] = ["HIGH", "CRITICAL", "MEDIUM", "LOW", "WARNING", "INFO"];

/** Lexicon. Matching is longest-phrase-first regardless of the order written here. */
export const LOCAL_RISK_TERMS: Array<{ phrase: string; label: RiskLabel }> = [
  { phrase: "severe respiratory distress", label: "CRITICAL" },
  { phrase: "shortness of breath", label: "CRITICAL" },
  { phrase: "chest pain", label: "CRITICAL" },
  { phrase: "anaphylaxis", label: "CRITICAL" },
  { phrase: "hyperpyrexia", label: "CRITICAL" },
  { phrase: "allergy", label: "HIGH" },
  { phrase: "fever", label: "HIGH" },
  { phrase: "dizziness", label: "MEDIUM" },
  { phrase: "nausea", label: "MEDIUM" },
  { phrase: "headache", label: "MEDIUM" },
  { phrase: "cough", label: "LOW" },
  { phrase: "fatigue", label: "LOW" },
];

/** Generic / low-signal tokens that create highlight fatigue (spec §3). */
export const GENERIC_LOW_TERMS = new Set(["cough", "fatigue", "headache"]);

/** Spec §2 negation triggers (with inflections of "deny"). */
export const NEGATION_TRIGGERS = ["negative for", "ruled out", "denies", "denied", "deny", "without", "no"];

/** Spec §2 historical triggers. */
export const HISTORICAL_TRIGGERS = ["family history of", "past history", "history of"];

/**
 * v1.1 extension: conditional / safety-net language. A red-flag phrase inside advice such as
 * "call if chest pain recurs" describes what to watch for, not a current finding.
 */
export const HYPOTHETICAL_TRIGGERS = [
  "red flags",
  "red flag",
  "warning symptoms",
  "warning signs",
  "safety-net",
  "safety net",
  "in case of",
  "unless",
  "would",
  "should",
  "if",
];

/** Words that end a trigger's scope inside a sentence (standard ConText terminators). */
const SCOPE_TERMINATORS = new Set([
  "but",
  "however",
  "although",
  "though",
  "yet",
  "except",
  "still",
  "which",
  "whereas",
]);

/** Coordinating tokens that do not count toward the 5-word window (lists such as "no X, Y, or Z"). */
const LIST_CONNECTORS = new Set(["or", "and", "nor", "/", "&"]);

/** Spec §2: a trigger must be within 1–5 counted words before the phrase. */
export const CONTEXT_WINDOW_WORDS = 5;

const SENTENCE_BOUNDARY = /[.!?;\n]/;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char);
}

function isWordishBoundary(body: string, start: number, end: number): boolean {
  return !isWordChar(body[start - 1]) && !isWordChar(body[end]);
}

function sentenceStart(body: string, offset: number): number {
  for (let index = offset - 1; index >= 0; index -= 1) {
    if (SENTENCE_BOUNDARY.test(body[index] ?? "")) {
      // A decimal point inside a number ("38.5") is not a sentence boundary.
      if (body[index] === "." && /\d/.test(body[index - 1] ?? "") && /\d/.test(body[index + 1] ?? "")) {
        continue;
      }
      return index + 1;
    }
  }
  return 0;
}

type Token = { text: string; start: number; end: number; skip: boolean };

function tokenize(text: string, base: number, skipSpans: Array<[number, number]>): Token[] {
  const tokens: Token[] = [];
  const pattern = /[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*|[/&]/g;
  for (const match of text.matchAll(pattern)) {
    const start = base + (match.index ?? 0);
    const end = start + match[0].length;
    const insideOtherMention = skipSpans.some(([spanStart, spanEnd]) => start >= spanStart && end <= spanEnd);
    const lowered = match[0].toLowerCase();
    tokens.push({ text: lowered, start, end, skip: insideOtherMention || LIST_CONNECTORS.has(lowered) });
  }
  return tokens;
}

const TRIGGER_WORDS = {
  NEGATED: NEGATION_TRIGGERS.map((trigger) => trigger.split(/\s+/)),
  HISTORICAL: HISTORICAL_TRIGGERS.map((trigger) => trigger.split(/\s+/)),
  HYPOTHETICAL: HYPOTHETICAL_TRIGGERS.map((trigger) => trigger.split(/\s+/)),
} as const;

/** Length (in tokens) of the trigger of `kind` that ends exactly at tokens[index], else 0. */
function triggerLengthEndingAt(tokens: Token[], index: number, kind: keyof typeof TRIGGER_WORDS): number {
  for (const words of TRIGGER_WORDS[kind]) {
    const first = index - words.length + 1;
    if (first < 0) {
      continue;
    }
    if (words.every((word, offset) => tokens[first + offset]?.text === word)) {
      return words.length;
    }
  }
  return 0;
}

/**
 * Classify how the span starting at `start` is asserted, scanning backwards to the sentence start.
 *
 * - A trigger counts when at most CONTEXT_WINDOW_WORDS - 1 counted words separate it from the span
 *   (i.e. the trigger is one of the five words preceding the phrase, spec §2).
 * - List connectors and words belonging to other lexicon mentions are not counted, so
 *   "denies chest pain, hyperpyrexia, or new allergy" negates "allergy".
 * - A scope terminator ("but", "however", …) ends the search: "no fever but chest pain" affirms.
 * - Negation dominates: "no history of chest pain" is NEGATED, not HISTORICAL.
 */
export function classifyMentionContext(
  body: string,
  start: number,
  otherMentionSpans: Array<[number, number]> = [],
): MentionContext {
  const from = sentenceStart(body, start);
  const tokens = tokenize(body.slice(from, start), from, otherMentionSpans);

  let counted = 0;
  let demoted: "HISTORICAL" | "HYPOTHETICAL" | null = null;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!;
    if (SCOPE_TERMINATORS.has(token.text)) {
      break;
    }
    if (counted < CONTEXT_WINDOW_WORDS) {
      const negationLength = triggerLengthEndingAt(tokens, index, "NEGATED");
      if (negationLength > 0) {
        return "NEGATED";
      }
      if (!demoted) {
        const historicalLength = triggerLengthEndingAt(tokens, index, "HISTORICAL");
        const hypotheticalLength = historicalLength > 0 ? 0 : triggerLengthEndingAt(tokens, index, "HYPOTHETICAL");
        const triggerLength = historicalLength || hypotheticalLength;
        if (triggerLength > 0) {
          demoted = historicalLength > 0 ? "HISTORICAL" : "HYPOTHETICAL";
          // Skip the rest of the trigger's own tokens; they are not counted words.
          index -= triggerLength - 1;
          continue;
        }
      }
    } else {
      break;
    }
    if (!token.skip) {
      counted += 1;
    }
  }
  return demoted ?? "AFFIRMED";
}

type RawMention = Omit<TermMention, "context">;

const SORTED_TERMS = [...LOCAL_RISK_TERMS].sort((left, right) => right.phrase.length - left.phrase.length);

const SPO2_PATTERN =
  /\b(?:spo2|sp02|o2 sat(?:uration)?s?|oxygen saturations?|saturations?|sats)\b[^\d\n.;]{0,16}?(\d{2,3})\s*%/gi;
const BP_PATTERN = /\b(?:bp|blood pressure)\b[^\d\n.;]{0,16}?(\d{2,3})\s*\/\s*(\d{2,3})\b/gi;

/** Spec §1 severe-vitals rules: SpO2 < 90%, BP > 180/110. */
function findVitalMentions(body: string): RawMention[] {
  const mentions: RawMention[] = [];
  for (const match of body.matchAll(SPO2_PATTERN)) {
    const value = Number(match[1]);
    if (value < 90) {
      const start = match.index ?? 0;
      mentions.push({
        startOffset: start,
        endOffset: start + match[0].length,
        excerpt: match[0],
        termKey: "vital:spo2<90",
        baseLabel: "CRITICAL",
      });
    }
  }
  for (const match of body.matchAll(BP_PATTERN)) {
    const systolic = Number(match[1]);
    const diastolic = Number(match[2]);
    if (systolic > 180 || diastolic > 110) {
      const start = match.index ?? 0;
      mentions.push({
        startOffset: start,
        endOffset: start + match[0].length,
        excerpt: match[0],
        termKey: "vital:bp>180/110",
        baseLabel: "CRITICAL",
      });
    }
  }
  return mentions;
}

function findRawMentions(body: string): RawMention[] {
  const lower = body.toLowerCase();
  const taken = new Array<boolean>(body.length).fill(false);
  const mentions: RawMention[] = [];

  for (const vital of findVitalMentions(body)) {
    for (let index = vital.startOffset; index < vital.endOffset; index += 1) {
      taken[index] = true;
    }
    mentions.push(vital);
  }

  for (const term of SORTED_TERMS) {
    let from = 0;
    while (from < lower.length) {
      const start = lower.indexOf(term.phrase, from);
      if (start < 0) {
        break;
      }
      const end = start + term.phrase.length;
      const overlaps = taken.slice(start, end).some(Boolean);
      if (!overlaps && isWordishBoundary(body, start, end)) {
        for (let index = start; index < end; index += 1) {
          taken[index] = true;
        }
        mentions.push({
          startOffset: start,
          endOffset: end,
          excerpt: body.slice(start, end),
          termKey: `term:${term.phrase}`,
          baseLabel: term.label,
        });
      }
      from = start + 1;
    }
  }
  return mentions.sort((left, right) => left.startOffset - right.startOffset);
}

/** Every lexicon / vital mention in `body`, with its assertion context. */
export function findTermMentions(body: string): TermMention[] {
  if (!body) {
    return [];
  }
  const raw = findRawMentions(body);
  const spans = raw.map((mention) => [mention.startOffset, mention.endOffset] as [number, number]);
  return raw.map((mention, index) => ({
    ...mention,
    context: classifyMentionContext(
      body,
      mention.startOffset,
      spans.filter((_, spanIndex) => spanIndex !== index),
    ),
  }));
}

/**
 * Auto-highlight hits for a note body (spec §1–§3):
 * - negated mentions are never highlighted;
 * - historical / hypothetical mentions are demoted to INFO;
 * - one hit per term: the first AFFIRMED mention wins, else the first demoted mention;
 * - low-signal terms are suppressed.
 */
export function findLocalRiskPhrases(body: string): RiskPhraseHit[] {
  const byTerm = new Map<string, TermMention>();
  for (const mention of findTermMentions(body)) {
    if (mention.context === "NEGATED") {
      continue;
    }
    const current = byTerm.get(mention.termKey);
    if (!current || (current.context !== "AFFIRMED" && mention.context === "AFFIRMED")) {
      byTerm.set(mention.termKey, mention);
    }
  }

  return [...byTerm.values()]
    .filter((mention) => {
      const key = mention.excerpt.toLowerCase();
      return mention.baseLabel !== "LOW" && !GENERIC_LOW_TERMS.has(key);
    })
    .map((mention) => ({
      startOffset: mention.startOffset,
      endOffset: mention.endOffset,
      excerpt: mention.excerpt,
      label: mention.context === "AFFIRMED" ? mention.baseLabel : ("INFO" as const),
      context: mention.context as Exclude<MentionContext, "NEGATED">,
      termKey: mention.termKey,
    }))
    .sort((left, right) => left.startOffset - right.startOffset);
}

/** Confidence written alongside each engine label. */
export function engineConfidence(label: RiskLabel): number {
  if (label === "CRITICAL") {
    return 0.95;
  }
  if (label === "HIGH") {
    return 0.85;
  }
  if (label === "MEDIUM") {
    return 0.7;
  }
  return 0.55;
}
