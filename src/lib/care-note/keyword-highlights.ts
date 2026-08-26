export type RiskLabel =
  | "HIGH"
  | "CRITICAL"
  | "MEDIUM"
  | "LOW"
  | "WARNING"
  | "INFO"
  | "UNRESOLVED_ACTION"
  | "PATIENT_INSIGHT";

export type RiskPhraseHit = {
  startOffset: number;
  endOffset: number;
  excerpt: string;
  label: RiskLabel;
};

/** Longest phrases first so "chest pain" wins over overlapping shorter tokens. */
export const LOCAL_RISK_TERMS: Array<{ phrase: string; label: RiskLabel }> = [
  { phrase: "shortness of breath", label: "CRITICAL" },
  { phrase: "chest pain", label: "CRITICAL" },
  { phrase: "hyperpyrexia", label: "CRITICAL" },
  { phrase: "allergy", label: "HIGH" },
  { phrase: "fever", label: "HIGH" },
  { phrase: "dizziness", label: "MEDIUM" },
  { phrase: "nausea", label: "MEDIUM" },
  { phrase: "headache", label: "MEDIUM" },
  { phrase: "cough", label: "LOW" },
  { phrase: "fatigue", label: "LOW" },
];

/** Generic / low-signal tokens that create highlight fatigue. */
export const GENERIC_LOW_TERMS = new Set(["cough", "fatigue", "headache"]);

function isWordishBoundary(body: string, start: number, end: number): boolean {
  const before = start === 0 ? " " : body[start - 1] ?? " ";
  const after = end >= body.length ? " " : body[end] ?? " ";
  return !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after);
}

export function findLocalRiskPhrases(body: string): RiskPhraseHit[] {
  const lower = body.toLowerCase();
  const taken = new Array<boolean>(body.length).fill(false);
  const hits: RiskPhraseHit[] = [];

  for (const term of LOCAL_RISK_TERMS) {
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
        hits.push({
          startOffset: start,
          endOffset: end,
          excerpt: body.slice(start, end),
          label: term.label,
        });
      }
      from = start + 1;
    }
  }

  const seenTerms = new Set<string>();
  return hits
    .sort((left, right) => left.startOffset - right.startOffset)
    .filter((hit) => {
      const key = hit.excerpt.toLowerCase();
      if (hit.label === "LOW" || GENERIC_LOW_TERMS.has(key)) {
        return false;
      }
      if (seenTerms.has(key)) {
        return false;
      }
      seenTerms.add(key);
      return true;
    });
}
