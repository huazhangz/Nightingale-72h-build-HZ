/**
 * Evaluation CLI for the handover agent.
 *
 *   npm run eval -- --variants oracle,null,rules --reps 2                 # offline, no API key
 *   npm run eval -- --variants claude-v1,claude-v2 --reps 5 --yes         # paid: needs ANTHROPIC_API_KEY
 *   npm run eval -- --report-only evals/results/<run>                     # rebuild report from rows
 *
 * Runs against an isolated SQLite file (prisma/eval.db by default), never the demo database.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    variants: { type: "string", default: "oracle,null,rules" },
    model: { type: "string", default: "claude-opus-5-5" },
    "gemini-model": { type: "string", default: "gemini-2.5-flash" },
    effort: { type: "string", default: "medium" },
    reps: { type: "string", default: "3" },
    k: { type: "string", default: "1,3,5" },
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

/** Rough per-run cost used only for the pre-flight estimate (measured cost is reported per row). */
const ESTIMATED_USD_PER_RUN: Record<string, number> = {
  "claude-opus-5-5": 0.18,
  "claude-sonnet-5-5": 0.09,
  "claude-haiku-5-5": 0.005,
};

async function main(): Promise<number> {
  const { ALL_CASES, selectCases } = await import("./cases");
  const { loadResults, runEvaluation } = await import("./lib/runner");
  const { writeReport } = await import("./lib/report");
  const { geminiApiKey, hasAnthropicCredentials } = await import("../src/lib/agent/handover/config");
  type Variant = import("./lib/runner").Variant;

  const ks = values.k!.split(",").map((value) => Number.parseInt(value, 10)).filter((value) => value > 0);

  if (values["report-only"]) {
    const outDir = path.resolve(root, values["report-only"]);
    const { results, errors, config } = loadResults(outDir);
    const reps = Number(config.reps ?? 1);
    writeReport(outDir, results, errors, config, ks.filter((k) => k <= reps));
    console.log(`Report written to ${path.join(outDir, "report.md")}`);
    return 0;
  }

  const reps = Math.max(1, Number.parseInt(values.reps!, 10));
  const model = values.model!;
  const effort = values.effort as Variant["effort"];
  const presets: Record<string, Variant> = {
    oracle: { id: "oracle", kind: "oracle", model: "oracle-baseline", promptVersion: "handover-v2" },
    null: { id: "null", kind: "null", model: "null-baseline", promptVersion: "handover-v2" },
    rules: { id: "rules", kind: "simulated", model: "simulated-rule-policy", promptVersion: "handover-v2" },
    "rules-noisy": {
      id: "rules-noisy",
      kind: "simulated",
      model: "simulated-rule-policy",
      promptVersion: "handover-v2",
      profile: { omitRate: 0.2, fabricateRate: 0.1, negationFlipRate: 0.3, proposeFollowups: true, seed: 1 },
    },
    "claude-v1": { id: "claude-v1", kind: "anthropic", model, promptVersion: "handover-v1", effort },
    "claude-v2": { id: "claude-v2", kind: "anthropic", model, promptVersion: "handover-v2", effort },
    "gemini-v1": { id: "gemini-v1", kind: "gemini", model: values["gemini-model"]!, promptVersion: "handover-v1" },
    "gemini-v2": { id: "gemini-v2", kind: "gemini", model: values["gemini-model"]!, promptVersion: "handover-v2" },
    "gemini-lite-v2": { id: "gemini-lite-v2", kind: "gemini", model: "gemini-3.5-flash-lite", promptVersion: "handover-v2" },
  };
  const variants = values.variants!.split(",").map((name) => {
    const preset = presets[name.trim()];
    if (!preset) {
      throw new Error(`Unknown variant "${name}". Known: ${Object.keys(presets).join(", ")}`);
    }
    return preset;
  });
  const cases = selectCases(values.cases);
  const paid = variants.filter((variant) => variant.kind === "anthropic");
  const gemini = variants.filter((variant) => variant.kind === "gemini");

  if (gemini.length > 0) {
    if (!geminiApiKey()) {
      console.error("Gemini variants need GEMINI_API_KEY.");
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
      console.error("Paid variants need ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN).");
      return 2;
    }
    const runs = paid.length * cases.length * reps;
    const perRun = ESTIMATED_USD_PER_RUN[model];
    const estimate = perRun === undefined ? "unknown" : `~$${(runs * perRun).toFixed(2)}`;
    console.log(`Paid trials: ${runs} on ${model} (${estimate} estimated; measured cost is reported per run).`);
    if (!values.yes) {
      console.error("Re-run with --yes to confirm spending.");
      return 3;
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(root, values.out ?? path.join("evals", "results", stamp));

  // Fresh, isolated schema for the evaluation database (disposable: schema changes may drop its data).
  if (!existsSync(dbFile)) {
    console.log(`Creating evaluation database at ${dbFile}`);
  }
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

  // Gemini free-tier rate limits are low: one trial at a time unless asked otherwise.
  const concurrency = values.concurrency ? Number.parseInt(values.concurrency, 10) : paid.length > 0 && gemini.length === 0 ? 4 : 1;
  console.log(`Evaluating ${variants.map((variant) => variant.id).join(", ")} on ${cases.length}/${ALL_CASES.length} cases × ${reps} reps → ${outDir}`);
  const summary = await runEvaluation({
    variants,
    cases,
    reps,
    concurrency,
    outDir,
    keepFixtures: values["keep-fixtures"],
  });
  const { results, errors, config } = loadResults(outDir);
  const { summaries } = writeReport(outDir, results, errors, config, ks.filter((k) => k <= reps));
  console.log(`\nScored ${summary.scored}, infrastructure errors ${summary.errors}. Report: ${path.join(outDir, "report.md")}`);
  for (const item of summaries) {
    console.log(`  ${item.variant.padEnd(12)} pass@1 ${(item.passAt[1]!.estimate * 100).toFixed(1)}%`);
  }

  if (values["assert-baselines"]) {
    const byId = new Map(summaries.map((item) => [item.variant, item]));
    const oracle = byId.get("oracle");
    const nullBaseline = byId.get("null");
    const contentCases = cases.filter((item) => item.expect.mustCover.length > 0 || item.expect.followups.expected === "some").length;
    const problems: string[] = [];
    if (oracle && oracle.passAt[1]!.estimate < 1) {
      const failing = Object.entries(oracle.perCase).filter(([, count]) => count.c < count.n).map(([id]) => id);
      problems.push(`oracle should pass every case; failing: ${failing.join(", ")}`);
    }
    if (nullBaseline) {
      const passingWithContent = Object.entries(nullBaseline.perCase).filter(([id, count]) => {
        const evalCase = cases.find((item) => item.id === id)!;
        return count.c > 0 && (evalCase.expect.mustCover.length > 0 || evalCase.expect.followups.expected === "some");
      });
      if (passingWithContent.length > 0) {
        problems.push(`null baseline passed cases that require content: ${passingWithContent.map(([id]) => id).join(", ")}`);
      }
      console.log(`  null baseline can only pass the ${cases.length - contentCases} case(s) that expect nothing.`);
    }
    if (summary.errors > 0) {
      problems.push(`${summary.errors} infrastructure error(s) in an offline run`);
    }
    if (problems.length > 0) {
      console.error(`\nBaseline assertions failed:\n- ${problems.join("\n- ")}`);
      return 1;
    }
    console.log("\nBaseline assertions passed: oracle 100%, null fails every case that needs content.");
  }
  return 0;
}

main()
  .then(async (code) => {
    const { prisma } = await import("../src/lib/db");
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    process.exit(1);
  });
