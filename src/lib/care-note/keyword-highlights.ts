export type RiskLabel = "HIGH" | "CRITICAL";

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
];

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
      if (!overlaps) {
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

  return hits.sort((left, right) => left.startOffset - right.startOffset);
}
