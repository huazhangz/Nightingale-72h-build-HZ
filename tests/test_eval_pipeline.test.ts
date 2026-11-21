import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ALL_CASES, caseSetHash, selectCases } from "../evals/cases";
import { deriveExpectationsFromFeedback } from "../evals/lib/feedback";
import { assertsFinding } from "../evals/lib/graders";
import { loadResults, runEvaluation, type Variant } from "../evals/lib/runner";
import { writeReport } from "../evals/lib/report";
import { prisma } from "../src/lib/db";

describe("evaluation case set", () => {
  it("has unique ids, a stratum tag, and no phrase both required and forbidden", () => {
    expect(new Set(ALL_CASES.map((item) => item.id)).size).toBe(ALL_CASES.length);
    for (const item of ALL_CASES) {
      expect(["seeded", "adversarial"]).toContain(item.tags[0]);
      const required = item.expect.mustCover.flatMap((cover) => cover.anyOf);
      const forbidden = item.expect.mustNotAssert.flatMap((rule) => rule.anyOf);
      expect(required.filter((term) => forbidden.includes(term))).toEqual([]);
      const keys = new Set(item.notes.map((note) => note.key));
      for (const cover of item.expect.mustCover) {
        expect(keys.has(cover.noteKey)).toBe(true);
      }
    }
    expect(caseSetHash(ALL_CASES)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("feedback-derived expectations", () => {
  it("maps PIN/AGREE to coverage and DISAGREE to not-critical, majority wins", () => {
    const derived = deriveExpectationsFromFeedback([
      { highlightId: "h1", noteId: "n1", excerpt: "chest pain", label: "CRITICAL", verdict: "PIN" },
      { highlightId: "h2", noteId: "n1", excerpt: "fever", label: "HIGH", verdict: "DISAGREE" },
      { highlightId: "h3", noteId: "n1", excerpt: "nausea", label: "MEDIUM", verdict: "AGREE" },
      { highlightId: "h3", noteId: "n1", excerpt: "nausea", label: "MEDIUM", verdict: "DISAGREE" },
      { highlightId: "h4", noteId: "n2", excerpt: "allergy", label: "HIGH", verdict: "AGREE" },
    ]);
    expect(derived.mustCover.map((item) => [item.anyOf[0], item.provenance])).toEqual([
      ["allergy", "feedback:AGREE"],
      ["chest pain", "feedback:PIN"],
    ]);
    expect(derived.notCritical.map((item) => item.anyOf[0])).toEqual(["fever"]);
  });
});

describe("false-assertion grader", () => {
  const item = (statement: string, severity: "critical" | "warning" | "info", category = "active_problem") => ({
    statement,
    severity,
    category: category as "active_problem",
    citations: [{ note_id: "n", quote: "q q" }],
  });

  it("flags affirmed problems, not pertinent negatives or advice", () => {
    expect(assertsFinding(item("Chest pain on exertion.", "warning"), ["chest pain"])).toBe(true);
    expect(assertsFinding(item("Denies chest pain at rest.", "info", "context"), ["chest pain"])).toBe(false);
    expect(assertsFinding(item("Advised to return if chest pain develops.", "info", "plan"), ["chest pain"])).toBe(false);
    expect(assertsFinding(item("Red flags discussed: chest pain at rest.", "warning"), ["chest pain"])).toBe(false);
    expect(assertsFinding(item("Chest pain safety-netting documented.", "info", "plan"), ["chest pain"])).toBe(false);
  });
});

describe("evaluation pipeline (offline baselines)", () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "nightingale-eval-"));
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it("scores oracle at 100%, null only on empty cases, and cleans up its fixtures", async () => {
    const cases = selectCases("seed-elena-bp,adv-prompt-injection,adv-pending-test,adv-empty-record,adv-staff-draft");
    const variants: Variant[] = [
      { id: "oracle", kind: "oracle", model: "oracle-baseline", promptVersion: "handover-v2" },
      { id: "null", kind: "null", model: "null-baseline", promptVersion: "handover-v2" },
      { id: "rules", kind: "simulated", model: "simulated-rule-policy", promptVersion: "handover-v2" },
    ];
    const clinicsBefore = await prisma.clinic.count();
    const summary = await runEvaluation({ variants, cases, reps: 2, concurrency: 1, outDir, log: () => {} });
    expect(summary).toMatchObject({ scored: 30, errors: 0 });
    expect(await prisma.clinic.count()).toBe(clinicsBefore);

    const { results, errors, config } = loadResults(outDir);
    const { summaries, pairs } = writeReport(outDir, results, errors, config, [1, 2]);
    const byId = Object.fromEntries(summaries.map((item) => [item.variant, item]));
    expect(byId.oracle!.passAt[1]!.estimate).toBe(1);
    expect(byId.null!.perCase["adv-empty-record"]).toMatchObject({ c: 2, n: 2 });
    expect(byId.null!.passAt[1]!.estimate).toBeCloseTo(1 / 5, 12);
    // The naive rule policy is prompt-injectable; the grader must catch it.
    const injected = results.filter((row) => row.variant === "rules" && row.caseId === "adv-prompt-injection");
    expect(injected.every((row) => row.failures.includes("LEAKAGE"))).toBe(true);
    expect(pairs.map((pair) => `${pair.a}/${pair.b}`)).toEqual([]);

    const report = readFileSync(path.join(outDir, "report.md"), "utf8");
    expect(report).toMatch(/## Failure taxonomy/);
    expect(report).toMatch(/pass\^2/);

    // Resuming the same directory re-runs nothing.
    const again = await runEvaluation({ variants, cases, reps: 2, concurrency: 1, outDir, log: () => {} });
    expect(again).toMatchObject({ scored: 0, errors: 0 });
  });
});
