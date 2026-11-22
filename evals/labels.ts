/**
 * Independent label review for the evaluation sets.
 *
 *   npm run eval:export-labels -- [--out evals/results/label-review] [--with-gold]
 *   npm run eval:label-agreement -- <reviewed risk CSV> [<reviewed handover CSV>]
 *
 * export: writes two CSV files a clinician can fill in without seeing the author's labels (blind by
 * default; --with-gold adds them for adjudication):
 *   risk-labels.csv      one row per risk case: note text, columns reviewer_level and reviewer_comment
 *   handover-labels.csv  one row per handover expectation (must cover / must not assert / follow-ups):
 *                        columns reviewer_agrees (Y/N) and reviewer_comment
 * agreement: reads the filled-in files and reports agreement with the author's labels: for risk,
 * exact agreement, within-one agreement, quadratic weighted kappa and the confusion matrix; for
 * handover, the share of expectations the reviewer agrees with. Every disagreement is listed, so
 * it can be adjudicated and, if the author's label was wrong, fixed in a reviewed commit (which
 * changes the pinned core-set hash, on purpose).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { RISK_LEVELS, type RiskLevel } from "../src/lib/agent/risk/levels";
import { CHALLENGE_CASES, CORE_CASES } from "./cases";
import { RISK_CASES, RISK_CHALLENGE_CASES } from "./risk/cases";
import { confusionMatrix, quadraticWeightedKappa, type LevelPair } from "./risk/metrics";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string", default: "evals/results/label-review" }, "with-gold": { type: "boolean", default: false } },
});

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  const headers = Object.keys(rows[0] ?? {});
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n") + "\n";
}

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, embedded newlines). */
export function parseCsv(text: string): Array<Record<string, string>> {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }
  const [headers, ...rows] = records.filter((row) => row.some((cell) => cell.trim() !== ""));
  return rows.map((row) => Object.fromEntries((headers ?? []).map((header, index) => [header, row[index] ?? ""])));
}

function exportLabels(): void {
  const outDir = path.resolve(values.out!);
  mkdirSync(outDir, { recursive: true });
  const withGold = values["with-gold"];

  const riskRows = [...RISK_CASES.map((item) => ({ item, set: "core" })), ...RISK_CHALLENGE_CASES.map((item) => ({ item, set: "challenge" }))].map(
    ({ item, set }) => ({
      case_id: item.id,
      set,
      notes: item.notes.map((spec) => `[${spec.encounterAt.slice(0, 10)}] ${spec.title}: ${spec.body}`).join("\n\n"),
      question: "How urgently does a clinician need to review this patient now? LOW / MEDIUM / HIGH / CRITICAL",
      ...(withGold ? { author_level: item.gold, author_evidence: item.evidence.quote } : {}),
      reviewer_level: "",
      reviewer_comment: "",
    }),
  );

  const handoverRows = [...CORE_CASES.map((item) => ({ item, set: "core" })), ...CHALLENGE_CASES.map((item) => ({ item, set: "challenge" }))].flatMap(
    ({ item, set }) => {
      const notes = item.notes
        .map((spec) => `[${spec.encounterAt.slice(0, 10)}] ${spec.title} (${spec.authorRole}, ${spec.status}): ${spec.body}${(spec.comments ?? []).map((comment) => `\n  Comment (${comment.authorRole}): ${comment.body}`).join("")}`)
        .join("\n\n");
      const base = { case_id: item.id, set, reader_role: item.readerRole, notes };
      return [
        ...item.expect.mustCover.map((expectation) => ({
          ...base,
          expectation: `MUST COVER (${expectation.id}): a handover must mention one of: ${expectation.anyOf.join(" | ")}${expectation.minSeverity ? `, rated at least ${expectation.minSeverity}` : ""}`,
          reviewer_agrees: "",
          reviewer_comment: "",
        })),
        ...item.expect.mustNotAssert.map((expectation) => ({
          ...base,
          expectation: `MUST NOT ASSERT (${expectation.id}): presenting ${expectation.anyOf.join(" | ")} as a current problem is wrong (${expectation.reason})`,
          reviewer_agrees: "",
          reviewer_comment: "",
        })),
        {
          ...base,
          expectation: `FOLLOW-UPS: ${item.expect.followups.expected === "none" ? "no follow-up task should be proposed" : item.expect.followups.expected === "some" ? `a follow-up should be proposed${item.expect.followups.anyOf ? ` (about ${item.expect.followups.anyOf.join(" | ")})` : ""}` : "either is acceptable"}`,
          reviewer_agrees: "",
          reviewer_comment: "",
        },
      ];
    },
  );

  writeFileSync(path.join(outDir, "risk-labels.csv"), toCsv(riskRows));
  writeFileSync(path.join(outDir, "handover-labels.csv"), toCsv(handoverRows));
  console.log(`Wrote ${riskRows.length} risk cases and ${handoverRows.length} handover expectations to ${outDir} (${withGold ? "with" : "without"} author labels).`);
}

function agreement(riskFile: string, handoverFile?: string): void {
  const gold = new Map([...RISK_CASES, ...RISK_CHALLENGE_CASES].map((item) => [item.id, item.gold]));
  const reviewed = parseCsv(readFileSync(riskFile, "utf8")).filter((row) => row.reviewer_level?.trim());
  const pairs: Array<LevelPair & { id: string; comment: string }> = [];
  for (const row of reviewed) {
    const level = row.reviewer_level!.trim().toUpperCase() as RiskLevel;
    const author = gold.get(row.case_id!);
    if (!author || !RISK_LEVELS.includes(level)) {
      console.warn(`skipped ${row.case_id}: ${!author ? "unknown case" : `level "${row.reviewer_level}"`}`);
      continue;
    }
    // Reviewer as the reference, author as the rating under test.
    pairs.push({ id: row.case_id!, gold: level, predicted: author, comment: row.reviewer_comment ?? "" });
  }
  const exact = pairs.filter((pair) => pair.gold === pair.predicted).length;
  const withinOne = pairs.filter((pair) => Math.abs(RISK_LEVELS.indexOf(pair.gold) - RISK_LEVELS.indexOf(pair.predicted)) <= 1).length;
  console.log(`Risk labels: ${pairs.length} reviewed of ${gold.size}`);
  console.log(`  exact agreement ${((exact / Math.max(1, pairs.length)) * 100).toFixed(1)}%, within one level ${((withinOne / Math.max(1, pairs.length)) * 100).toFixed(1)}%, quadratic weighted kappa ${quadraticWeightedKappa(pairs)?.toFixed(2) ?? "n/a"}`);
  console.log("  confusion (rows: reviewer, columns: author):", RISK_LEVELS.join("/"));
  confusionMatrix(pairs).forEach((row, index) => console.log(`    ${RISK_LEVELS[index]!.padEnd(8)} ${row.join("  ")}`));
  for (const pair of pairs.filter((item) => item.gold !== item.predicted)) {
    console.log(`  DISAGREE ${pair.id}: reviewer ${pair.gold}, author ${pair.predicted}${pair.comment ? ` (${pair.comment})` : ""}`);
  }
  if (handoverFile) {
    const rows = parseCsv(readFileSync(handoverFile, "utf8")).filter((row) => row.reviewer_agrees?.trim());
    const agreed = rows.filter((row) => /^y/i.test(row.reviewer_agrees!.trim()));
    console.log(`Handover expectations: ${rows.length} reviewed, ${agreed.length} agreed (${((agreed.length / Math.max(1, rows.length)) * 100).toFixed(1)}%)`);
    for (const row of rows.filter((item) => !/^y/i.test(item.reviewer_agrees!.trim()))) {
      console.log(`  DISAGREE ${row.case_id}: ${row.expectation}${row.reviewer_comment ? ` (${row.reviewer_comment})` : ""}`);
    }
  }
}

const command = process.env.NIGHTINGALE_LABELS_COMMAND ?? "export";
if (command === "agreement") {
  if (!positionals[0]) {
    console.error("Usage: npm run eval:label-agreement -- <reviewed risk CSV> [<reviewed handover CSV>]");
    process.exit(2);
  }
  agreement(positionals[0], positionals[1]);
} else {
  exportLabels();
}
