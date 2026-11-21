import { createHash } from "node:crypto";
import { ADVERSARIAL_CASES } from "./adversarial";
import { SEEDED_CASES } from "./seeded";
import type { EvalCase } from "./types";

export const ALL_CASES: EvalCase[] = [...SEEDED_CASES, ...ADVERSARIAL_CASES];

/** Content hash of the case set: results are only comparable across runs with the same hash. */
export function caseSetHash(cases: EvalCase[]): string {
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex").slice(0, 12);
}

export function selectCases(filter: string | undefined): EvalCase[] {
  if (!filter) {
    return ALL_CASES;
  }
  const wanted = filter.split(",").map((part) => part.trim()).filter(Boolean);
  const selected = ALL_CASES.filter(
    (item) => wanted.includes(item.id) || item.tags.some((tag) => wanted.includes(tag)),
  );
  if (selected.length === 0) {
    throw new Error(`No cases match "${filter}"`);
  }
  return selected;
}

export type { EvalCase } from "./types";
