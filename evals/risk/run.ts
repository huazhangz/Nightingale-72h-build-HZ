/**
 * Evaluation CLI for the risk triage agent.
 *
 *   npm run eval:risk -- --variants rules,simulated,oracle --reps 1          # offline, no API key
 *   npm run eval:risk -- --variants rules,claude --reps 3 --yes              # paid: needs ANTHROPIC_API_KEY
 *   npm run eval:risk -- --report-only evals/results/risk-<run>              # rebuild report from rows
 *
 * Each trial builds its own clinic in an isolated SQLite file (prisma/eval.db by default) and runs
 * one MANUAL assessment through the production path (queue claim, tools, guardrails, floor).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    variants: { type: "string", default: "rules,simulated,oracle" },
    model: { type: "string", default: "claude-opus-5-5" },
    "gemini-model": { type: "string", default: "gemini-2.5-flash" },
    effort: { type: "string", default: "medium" },
    reps: { type: "string", default: "1" },
    cases: { type: "string" },
    concurrency: { type: "string" },
    out: { type: "string" },
    db: { type: "string", default: "prisma/eval.db" },
    "report-only": { type: "string" },
    "assert-baselines": { type: "boolean", default: false },
    "keep-fixtures": { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
});

const root = process.cwd();
const dbFile = path.resolve(root, values.db!);
process.env.DATABASE_URL = `file:${dbFile.replace(/\\/g, "/")}`;

/** Rough per-trial cost for the pre-flight estimate only (measured cost is reported per row). */
const ESTIMATED_USD_PER_TRIAL: Record<string, number> = {
  "claude-opus-5-5": 0.08,
  "claude-sonnet-5-5": 0.04,
  "claude-haiku-5-5": 0.003,
};

async function main(): Promise<number> {
  const { RISK_CASES, selectRiskCases } = await import("./cases");
  const { loadRiskResults, runRiskEvaluation } = await import("./runner");
  const { writeRiskReport } = await import("./report");
  const { geminiApiKey, hasAnthropicCredentials } = await import("../../src/lib/agent/handover/config");
  type RiskVariant = import("./runner").RiskVariant;

  if (values["report-only"]) {
    const outDir = path.resolve(root, values["report-only"]);
    const { rows, errors, config } = loadRiskResults(outDir);
    writeRiskReport(outDir, rows, errors, config);
    console.log(`Report written to ${path.join(outDir, "report.md")}`);
    return 0;
  }

  const model = values.model!;
  const effort = values.effort as RiskVariant["effort"];
  const presets: Record<string, RiskVariant> = {
    rules: { id: "rules", kind: "rules", model: "rules-floor" },
    simulated: { id: "simulated", kind: "simulated", model: "simulated-rule-policy" },
    oracle: { id: "oracle", kind: "oracle", model: "oracle-baseline" },
    claude: { id: "claude", kind: "anthropic", model, effort },
    gemini: { id: "gemini", kind: "gemini", model: values["gemini-model"]! },
    "gemini-lite": { id: "gemini-lite", kind: "gemini", model: "gemini-2.5-flash-lite" },
  };
  const variants = values.variants!.split(",").map((name) => {
    const preset = presets[name.trim()];
    if (!preset) {
      throw new Error(`Unknown variant "${name}". Known: ${Object.keys(presets).join(", ")}`);
    }
    return preset;
  });
  const cases = selectRiskCases(values.cases);
  const reps = Math.max(1, Number.parseInt(values.reps!, 10));
  const paid = variants.filter((variant) => variant.kind === "anthropic");
  const gemini = variants.filter((variant) => variant.kind === "gemini");

  if (gemini.length > 0) {
    if (!geminiApiKey()) {
      console.error("The gemini variant needs GEMINI_API_KEY.");
      return 2;
    }
    console.log(
      `Gemini trials: ${gemini.length * cases.length * reps} on ${[...new Set(gemini.map((variant) => variant.model))].join(", ")} (free tier or billed to the key's Google project; ` +
        "free-tier prompts may be used by Google, so use synthetic data only).",
    );
    if (!values.yes) {
      console.error("Re-run with --yes to confirm.");
      return 3;
    }
  }

  if (paid.length > 0) {
    if (!hasAnthropicCredentials()) {
      console.error("The claude variant needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN).");
      return 2;
    }
    const trials = paid.length * cases.length * reps;
    const perTrial = ESTIMATED_USD_PER_TRIAL[model];
    console.log(`Paid trials: ${trials} on ${model} (${perTrial === undefined ? "unknown" : `~$${(trials * perTrial).toFixed(2)}`} estimated).`);
    if (!values.yes) {
      console.error("Re-run with --yes to confirm spending.");
      return 3;
    }
  }

  // The evaluation database is disposable: a schema change may drop its rows, never the demo data.
  const push = spawnSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (push.status !== 0) {
    console.error("prisma db push failed for the evaluation database");
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(root, values.out ?? path.join("evals", "results", `risk-${stamp}`));
  // Gemini free-tier rate limits are low: one trial at a time unless asked otherwise.
  const concurrency = values.concurrency ? Number.parseInt(values.concurrency, 10) : paid.length > 0 && gemini.length === 0 ? 4 : 1;
  console.log(`Risk eval: ${variants.map((variant) => variant.id).join(", ")} on ${cases.length}/${RISK_CASES.length} cases × ${reps} rep(s) → ${outDir}`);
  const outcome = await runRiskEvaluation({ variants, cases, reps, concurrency, outDir, keepFixtures: values["keep-fixtures"] });
  const { rows, errors, config } = loadRiskResults(outDir);
  const { summaries, violations } = writeRiskReport(outDir, rows, errors, config);

  console.log(`\nScored ${outcome.scored}, infrastructure errors ${outcome.errors}. Report: ${path.join(outDir, "report.md")}`);
  for (const item of summaries) {
    console.log(
      `  ${item.variant.padEnd(10)} exact ${(item.final.exact * 100).toFixed(1)}%  under-triage ${(item.final.underTriage * 100).toFixed(1)}%  QWK ${item.final.qwk === null ? "n/a" : item.final.qwk.toFixed(2)}`,
    );
  }

  const problems = violations.map((item) => `invariant: ${item}`);
  if (values["assert-baselines"]) {
    const oracle = summaries.find((item) => item.variant === "oracle");
    if (oracle && (oracle.model?.exact ?? 0) < 1) {
      problems.push("oracle model level should match gold on every case");
    }
    if (oracle && oracle.final.underTriage > 0) {
      problems.push("the floor lowered a correct level (oracle under-triaged after the floor)");
    }
    if (outcome.errors > 0) {
      problems.push(`${outcome.errors} infrastructure error(s) in an offline run`);
    }
  }
  if (problems.length > 0) {
    console.error(`\nChecks failed:\n- ${problems.join("\n- ")}`);
    return 1;
  }
  if (values["assert-baselines"]) {
    console.log("\nBaseline checks passed: oracle model level matches gold everywhere and the floor never lowers a level.");
  }
  return 0;
}

main()
  .then(async (code) => {
    const { prisma } = await import("../../src/lib/db");
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    process.exit(1);
  });
