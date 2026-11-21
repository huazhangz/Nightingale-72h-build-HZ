/**
 * Re-score a finished handover run after a grader fix, without calling any model.
 *
 *   npm run eval:regrade -- evals/results/<run> --out evals/results/<run>-regraded
 *
 * Scope: the checks that depend only on what each transcript stores, namely the model's raw
 * submission and the case expectations: `not_asserted:*` (and through them the FABRICATION class
 * and the false-assertion metric). Checks that need the fixture database (citation verification,
 * coverage, follow-ups) keep their recorded verdicts. The original run directory is not modified;
 * the new one records the grader version and where it was regraded from, and gets a fresh report.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { SummaryItemInput } from "../src/lib/agent/handover/schema";
import type { NotAssertExpectation } from "./cases/types";
import { assertsFinding, GRADER_VERSION, type FailureClass } from "./lib/graders";
import { writeReport } from "./lib/report";
import { loadResults, type ResultRow } from "./lib/runner";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, k: { type: "string", default: "1,3" } },
});

const source = positionals[0];
if (!source) {
  console.error("Usage: npm run eval:regrade -- <run-directory> [--out <new-directory>]");
  process.exit(2);
}
const sourceDir = path.resolve(source);
const outDir = path.resolve(values.out ?? `${sourceDir}-regraded`);
const { results, errors, config } = loadResults(sourceDir);

let changed = 0;
const regraded: ResultRow[] = results.map((row) => {
  const file = path.join(sourceDir, "transcripts", row.variant, row.caseId, `rep-${row.rep}.json`);
  if (!existsSync(file)) {
    throw new Error(`Missing transcript ${file}`);
  }
  const transcript = JSON.parse(readFileSync(file, "utf8")) as {
    submission: { items: SummaryItemInput[] } | null;
    expectations: { mustNotAssert: NotAssertExpectation[] };
  };
  if (!transcript.submission) {
    return row; // no submission: no assertion checks were made
  }
  let falseAssertions = 0;
  const assertionChecks = transcript.expectations.mustNotAssert.map((expectation) => {
    const offenders = transcript.submission!.items.filter((item) => assertsFinding(item, expectation.anyOf));
    falseAssertions += offenders.length;
    return { name: `not_asserted:${expectation.id}`, passed: offenders.length === 0, detail: offenders[0]?.statement.slice(0, 120) };
  });
  const checks = [...row.checks.filter((check) => !check.name.startsWith("not_asserted:")), ...assertionChecks];
  const citationsFailed = checks.some((check) => check.name === "all_citations_verified" && !check.passed);
  const fabricated = citationsFailed || assertionChecks.some((check) => !check.passed);
  const failures = new Set<FailureClass>(row.failures.filter((failure) => failure !== "FABRICATION"));
  if (fabricated) {
    failures.add("FABRICATION");
  }
  const next: ResultRow = {
    ...row,
    checks,
    failures: [...failures],
    passed: failures.size === 0,
    metrics: { ...row.metrics, falseAssertions },
  };
  if (next.passed !== row.passed || next.failures.length !== row.failures.length) {
    changed += 1;
  }
  return next;
});

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "results.jsonl"), regraded.map((row) => JSON.stringify(row)).join("\n") + "\n");
if (existsSync(path.join(sourceDir, "errors.jsonl"))) {
  copyFileSync(path.join(sourceDir, "errors.jsonl"), path.join(outDir, "errors.jsonl"));
}
const nextConfig = { ...config, graderVersion: GRADER_VERSION, regradedFrom: path.relative(process.cwd(), sourceDir), regradedScope: "not_asserted checks" };
writeFileSync(path.join(outDir, "config.json"), JSON.stringify(nextConfig, null, 2));
const reps = Number(config.reps ?? 1);
const ks = values.k!.split(",").map((value) => Number.parseInt(value, 10)).filter((k) => k > 0 && k <= reps);
writeReport(outDir, regraded, errors, nextConfig, ks);
console.log(`Regraded ${regraded.length} rows with grader ${GRADER_VERSION}; ${changed} changed. Report: ${path.join(outDir, "report.md")}`);
