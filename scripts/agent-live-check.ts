/**
 * One real request per agent: the first thing to run when an API key is configured.
 *
 *   npm run agent:live-check -- --yes                       # one handover run + one risk run on the API
 *   npm run agent:live-check -- --offline                   # same flow with the offline policies (no key)
 *   npm run agent:live-check -- --yes --model claude-sonnet-5-5 --effort low
 *   npm run agent:live-check -- --yes --provider gemini                     # same agents on Gemini (GEMINI_API_KEY)
 *
 * Each run uses a freshly built evaluation fixture in an isolated SQLite file (prisma/eval.db), goes
 * through the production code path (tools, guardrails, persistence), and prints what an operator
 * needs before a larger evaluation: outcome, served model, steps, tokens, measured cost, latency and
 * the guardrail verdicts. Exit code 0 only when both agents submitted a result.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    provider: { type: "string", default: "anthropic" },
    model: { type: "string" },
    effort: { type: "string", default: "medium" },
    "handover-case": { type: "string", default: "seed-elena-bp" },
    "risk-case": { type: "string", default: "crit-ischaemic-pain" },
    db: { type: "string", default: "prisma/eval.db" },
    offline: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
});

const root = process.cwd();
process.env.DATABASE_URL = `file:${path.resolve(root, values.db!).replace(/\\/g, "/")}`;
const provider = values.offline ? "simulated" : values.provider === "gemini" ? "gemini" : "anthropic";
if (values.provider !== "anthropic" && values.provider !== "gemini") {
  console.error(`Unknown --provider "${values.provider}" (anthropic | gemini).`);
  process.exit(2);
}
const model = values.model ?? (provider === "gemini" ? "gemini-2.5-flash" : "claude-opus-5-5");
// The handover agent reads its client from the environment, exactly as the app does.
process.env.NIGHTINGALE_AGENT_CLIENT = provider;

type Line = [string, string];

function print(title: string, lines: Line[]): void {
  console.log(`\n${title}`);
  for (const [key, value] of lines) {
    console.log(`  ${key.padEnd(18)} ${value}`);
  }
}

async function main(): Promise<number> {
  const { geminiApiKey, hasAnthropicCredentials } = await import("../src/lib/agent/handover/config");
  const { costUsd } = await import("../evals/lib/pricing");
  if (provider === "anthropic" && !hasAnthropicCredentials()) {
    console.error("No ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment. Use --offline to check the flow without a key.");
    return 2;
  }
  if (provider === "gemini" && !geminiApiKey()) {
    console.error("No GEMINI_API_KEY in the environment.");
    return 2;
  }
  if (provider !== "simulated") {
    console.log(
      provider === "gemini"
        ? `Live check on ${model} via the Gemini transport: 2 agent runs (free tier or billed to the key's Google project).`
        : `Live check on ${model} (effort ${values.effort}): 2 agent runs, typically well under $0.50 in total.`,
    );
    if (!values.yes) {
      console.error("Re-run with --yes to confirm the spend.");
      return 3;
    }
  }

  const push = spawnSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: root,
    env: process.env,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  if (push.status !== 0) {
    console.error("prisma db push failed for the evaluation database");
    return 1;
  }

  const { selectCases } = await import("../evals/cases");
  const { materializeCase, destroyCase } = await import("../evals/lib/fixtures");
  const { gradeTrial } = await import("../evals/lib/graders");
  const { EVAL_NOW } = await import("../evals/lib/runner");
  const { runHandoverAgent } = await import("../src/lib/agent/handover/agent");
  const { selectRiskCases } = await import("../evals/risk/cases");
  const { runRiskTrial } = await import("../evals/risk/runner");
  const { prisma } = await import("../src/lib/db");
  const { geminiClientFactory } = await import("../src/lib/agent/handover/config");
  const { createAnthropicClient } = await import("../src/lib/agent/core/client");
  const { capped, spendGuardFromEnv } = await import("../evals/lib/spend");
  const effort = values.effort as import("../src/lib/agent/core/types").Effort;
  const report: Record<string, unknown> = { provider, model, effort, at: new Date().toISOString() };
  let ok = true;

  // ---------------------------------------------------------------- handover agent
  const [handoverCase] = selectCases(values["handover-case"]);
  const materialized = await materializeCase(handoverCase!, `live-${Date.now().toString(36)}`);
  try {
    // Live providers go through the evaluation spend cap (NIGHTINGALE_EVAL_MAX_USD) like the eval runners.
    const clientFactory =
      provider === "gemini"
        ? geminiClientFactory({ wrapFetch: capped })
        : provider === "anthropic"
          ? ({ onResponseStatus }: { onResponseStatus: (status: number) => void }) => createAnthropicClient({ timeoutMs: 120_000, fetch: capped(), onResponseStatus })
          : undefined;
    const result = await runHandoverAgent(materialized.reader, materialized.patientId, {
      ...(clientFactory ? { clientFactory } : {}),
      settings: { ...(provider === "simulated" ? {} : { model }), effort, deadlineMs: 240_000 },
      now: EVAL_NOW,
    });
    const grade = gradeTrial(materialized, result);
    const cost = costUsd(result.servedModel ?? result.model, result.usage);
    const http = result.internal.run.trace.filter((event) => event.type === "http_retry").length;
    ok &&= result.outcome === "SUBMITTED";
    print(`Handover agent · case ${handoverCase!.id}`, [
      ["outcome", `${result.outcome}${result.error ? ` (${result.error.kind}: ${result.error.message})` : ""}`],
      ["served model", `${result.servedModel ?? "none"}${result.fallbackUsed ? " (server-side fallback)" : ""}`],
      ["steps / HTTP errors", `${result.steps} / ${http} (retried when retryable)`],
      ["tokens in/out", `${result.usage.inputTokens} / ${result.usage.outputTokens} (cache read ${result.usage.cacheReadInputTokens}, write ${result.usage.cacheCreationInputTokens})`],
      ["cost", cost === null ? "unknown model price" : `$${cost.toFixed(4)}`],
      ["latency", `${(result.durationMs / 1000).toFixed(1)} s`],
      ["items accepted", `${result.summary.items.length} (rejected ${result.guardrail.rejected.length})`],
      ["grade", `${grade.passed ? "PASS" : "FAIL"}${grade.failures.length ? ` (${grade.failures.join(", ")})` : ""}`],
    ]);
    report.handover = {
      caseId: handoverCase!.id,
      outcome: result.outcome,
      servedModel: result.servedModel,
      steps: result.steps,
      usage: result.usage,
      costUsd: cost,
      durationMs: result.durationMs,
      accepted: result.summary.items.length,
      rejected: result.guardrail.rejected,
      grade: { passed: grade.passed, failures: grade.failures, checks: grade.checks },
    };
  } finally {
    await destroyCase(materialized.clinicId);
  }

  // ---------------------------------------------------------------- risk triage agent
  const [riskCase] = selectRiskCases(values["risk-case"]);
  const variant =
    provider === "simulated"
      ? { id: "simulated", kind: "simulated" as const, model: "simulated-rule-policy" }
      : provider === "gemini"
        ? { id: "gemini", kind: "gemini" as const, model }
        : { id: "claude", kind: "anthropic" as const, model, effort };
  const trial = await runRiskTrial({ variant, item: riskCase!, rep: 0 }, { runTag: `live-${Date.now().toString(36)}` });
  if ("error" in trial) {
    ok = false;
    print(`Risk agent · case ${riskCase!.id}`, [["error", `${trial.error.errorClass}: ${trial.error.message}`]]);
    report.risk = { caseId: riskCase!.id, error: trial.error };
  } else {
    const row = trial.row;
    ok &&= row.outcome === "SUBMITTED";
    print(`Risk agent · case ${riskCase!.id}`, [
      ["outcome", row.outcome ?? "no model run"],
      ["served model", row.servedModel ?? "none"],
      ["levels", `gold ${row.gold} · model ${row.modelLevel ?? "-"} · floor ${row.floorLevel ?? "-"} · final ${row.final} (${row.review})`],
      ["steps", String(row.steps)],
      ["tokens in/out", `${row.usage.inputTokens} / ${row.usage.outputTokens} (cache read ${row.usage.cacheReadInputTokens}, write ${row.usage.cacheCreationInputTokens})`],
      ["cost", row.costUsd === null ? "unknown model price" : `$${row.costUsd.toFixed(4)}`],
      ["latency", `${(row.wallMs / 1000).toFixed(1)} s`],
      ["guardrails", `rejected drivers ${row.rejectedDrivers} · unsupported level ${row.unsupportedLevel} · floor applied ${row.floorApplied}`],
    ]);
    report.risk = row;
  }

  const outDir = path.join(root, "evals", "results");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `live-check-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${ok ? "OK" : "FAILED"}: both agents ${ok ? "submitted" : "did not both submit"}. Details: ${path.relative(root, file)}`);
  const guard = spendGuardFromEnv();
  if (guard) {
    console.log(`Spend ledger: $${guard.totalUsd.toFixed(4)} of $${guard.capUsd.toFixed(2)} cap (${path.relative(root, guard.file)}).`);
  }
  await prisma.$disconnect();
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
