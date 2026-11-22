import { createHash } from "node:crypto";
import { ADVERSARIAL_CASES } from "./adversarial";
import { CHALLENGE_CASES } from "./challenge";
import { SEEDED_CASES } from "./seeded";
import type { EvalCase } from "./types";

/**
 * Core set: frozen (its hash is pinned in tests/test_case_sets.test.ts), so results stay comparable
 * across prompts and models. New cases go to the challenge set, reported separately.
 */
export const CORE_CASES: EvalCase[] = [...SEEDED_CASES, ...ADVERSARIAL_CASES];
export const ALL_CASES: EvalCase[] = CORE_CASES;
export { CHALLENGE_CASES };

/** Content hash of the case set: results are only comparable across runs with the same hash. */
export function caseSetHash(cases: EvalCase[]): string {
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex").slice(0, 12);
}

/** No filter: the core set. "core", "challenge" and "all" select whole sets; otherwise ids or tags. */
export function selectCases(filter: string | undefined): EvalCase[] {
  if (!filter || filter === "core") {
    return CORE_CASES;
  }
  if (filter === "challenge") {
    return CHALLENGE_CASES;
  }
  if (filter === "all") {
    return [...CORE_CASES, ...CHALLENGE_CASES];
  }
  const wanted = filter.split(",").map((part) => part.trim()).filter(Boolean);
  const selected = [...CORE_CASES, ...CHALLENGE_CASES].filter(
    (item) => wanted.includes(item.id) || item.tags.some((tag) => wanted.includes(tag)),
  );
  if (selected.length === 0) {
    throw new Error(`No cases match "${filter}"`);
  }
  return selected;
}

export type { EvalCase } from "./types";
