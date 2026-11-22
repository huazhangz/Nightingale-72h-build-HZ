import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runHandoverAgent, type HandoverRunResult } from "../../src/lib/agent/handover/agent";
import { geminiClientFactory } from "../../src/lib/agent/handover/config";
import { promptHash, type PromptVersion } from "../../src/lib/agent/handover/prompts";
import { simulatedResponder, type SimulationProfile } from "../../src/lib/agent/handover/simulated-client";
import { createAnthropicClient, type ClientFactory } from "../../src/lib/agent/core/client";
import { hashSeed } from "../../src/lib/agent/core/random";
import { scriptedFetch, type Responder } from "../../src/lib/agent/core/testing";
import { INFRASTRUCTURE_OUTCOMES, type Effort, type RunOutcome, type UsageTotals } from "../../src/lib/agent/core/types";
import { clearGlanceCache } from "../../src/lib/cache/glanceCache";
import { caseSetHash, type EvalCase } from "../cases";
import { nullResponder, oracleResponder } from "./baselines";
import { destroyCase, materializeCase, type MaterializedCase } from "./fixtures";
import { GRADER_VERSION, gradeTrial, type Check, type FailureClass, type TrialMetrics } from "./graders";
import { costUsd } from "./pricing";
import { capped, spendGuardFromEnv } from "./spend";

/** "anthropic" and "gemini" call a live API (gemini through the transport adapter); the rest are offline. */
export type VariantKind = "anthropic" | "gemini" | "simulated" | "oracle" | "null";

export const LIVE_KINDS: ReadonlySet<VariantKind> = new Set(["anthropic", "gemini"]);

export type Variant = {
  id: string;
  kind: VariantKind;
  model: string;
  promptVersion: PromptVersion;
  effort?: Effort;
  profile?: SimulationProfile;
  /** Repair rounds for unverifiable citations (default: the agent setting, 1). */
  citationRepairs?: number;
};

export type RunConfig = {
  variants: Variant[];
  cases: EvalCase[];
  reps: number;
  concurrency: number;
  outDir: string;
  keepFixtures?: boolean;
  log?: (line: string) => void;
};

export type ResultRow = {
  variant: string;
  caseId: string;
  stratum: string;
  tags: string[];
  rep: number;
  outcome: RunOutcome;
  passed: boolean;
  failures: FailureClass[];
  checks: Check[];
  metrics: TrialMetrics;
  usage: UsageTotals;
  costUsd: number | null;
  /** Wall clock of the whole run, including tool time and any retry backoff. */
  wallMs: number;
  /** Sum of final-attempt model latencies (retries and backoff excluded). */
  modelLatencyMs: number;
  modelCalls: number;
  retries: number;
  /** Submissions sent back for citation repair (0 when repair is off or not needed). */
  repairs?: number;
  requestedModel: string;
  servedModel: string | null;
  fallbackUsed: boolean;
  promptVersion: string;
  promptHash: string;
  startedAt: string;
};

export type ErrorRow = {
  variant: string;
  caseId: string;
  rep: number;
  errorClass: string;
  message: string;
  startedAt: string;
};

/**
 * True when the served model is the requested one. The API may report a dated snapshot of an alias
 * ("<requested>-<date>"), which is the same model; anything else is a substitution.
 */
export function servedAsRequested(requested: string, served: string): boolean {
  return served === requested || served.startsWith(`${requested}-`);
}

/** Fixed "today" so prompts are byte-identical across runs (and cacheable). */
export const EVAL_NOW = new Date("2026-11-21T12:00:00.000Z");

const trialKey = (variant: string, caseId: string, rep: number) => `${variant}|${caseId}|${rep}`;

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function loadResults(outDir: string): { results: ResultRow[]; errors: ErrorRow[]; config: Record<string, unknown> } {
  return {
    results: readJsonl<ResultRow>(path.join(outDir, "results.jsonl")),
    errors: readJsonl<ErrorRow>(path.join(outDir, "errors.jsonl")),
    config: JSON.parse(readFileSync(path.join(outDir, "config.json"), "utf8")) as Record<string, unknown>,
  };
}

/** Offline variants drive the real SDK Tool Runner through a scripted fetch; anthropic uses the API. */
function clientFactoryFor(variant: Variant, materialized: MaterializedCase, rep: number): ClientFactory {
  if (variant.kind === "anthropic") {
    return ({ onResponseStatus }) => createAnthropicClient({ timeoutMs: 120_000, fetch: capped(), onResponseStatus });
  }
  if (variant.kind === "gemini") {
    return geminiClientFactory({ wrapFetch: capped });
  }
  let responder: Responder;
  if (variant.kind === "simulated") {
    responder = simulatedResponder(
      {
        ...(variant.profile ?? { omitRate: 0, fabricateRate: 0, negationFlipRate: 0, proposeFollowups: true, seed: 1 }),
        seed: hashSeed(`${variant.id}|${materialized.evalCase.id}|${rep}`),
      },
      variant.model,
    );
  } else if (variant.kind === "oracle") {
    responder = oracleResponder(materialized);
  } else {
    responder = nullResponder();
  }
  return ({ onResponseStatus }) =>
    createAnthropicClient({ apiKey: "offline", maxRetries: 0, fetch: scriptedFetch(responder).fetch, onResponseStatus });
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function rowFrom(
  variant: Variant,
  materialized: MaterializedCase,
  rep: number,
  result: HandoverRunResult,
  startedAt: Date,
): ResultRow {
  const grade = gradeTrial(materialized, result);
  const modelCalls = result.internal.run.trace.filter((event) => event.type === "model_turn");
  return {
    variant: variant.id,
    caseId: materialized.evalCase.id,
    stratum: materialized.evalCase.tags[0] ?? "untagged",
    tags: materialized.evalCase.tags,
    rep,
    outcome: result.outcome,
    passed: grade.passed,
    failures: grade.failures,
    checks: grade.checks,
    metrics: grade.metrics,
    usage: result.usage,
    costUsd: costUsd(result.servedModel ?? variant.model, result.usage),
    wallMs: result.durationMs,
    modelLatencyMs: modelCalls.reduce((sum, event) => sum + (event.type === "model_turn" ? event.latencyMs : 0), 0),
    modelCalls: modelCalls.length,
    retries: result.internal.run.trace.filter((event) => event.type === "http_retry").length,
    repairs: result.internal.run.trace.filter((event) => event.type === "repair").length,
    requestedModel: variant.model,
    servedModel: result.servedModel,
    fallbackUsed: result.fallbackUsed,
    promptVersion: result.promptVersion,
    promptHash: result.promptHash,
    startedAt: startedAt.toISOString(),
  };
}

/**
 * Run variants x cases x reps against freshly materialised fixtures. Resumable: completed
 * (variant, case, rep) rows in results.jsonl are skipped. Infrastructure failures go to errors.jsonl
 * and are retried on the next invocation; they are never scored as model failures.
 */
export async function runEvaluation(config: RunConfig): Promise<{ outDir: string; scored: number; errors: number }> {
  const log = config.log ?? ((line: string) => console.log(line));
  mkdirSync(path.join(config.outDir, "transcripts"), { recursive: true });
  const configFile = path.join(config.outDir, "config.json");
  const descriptor = {
    graderVersion: GRADER_VERSION,
    caseSetHash: caseSetHash(config.cases),
    caseIds: config.cases.map((item) => item.id),
    reps: config.reps,
    evalNow: EVAL_NOW.toISOString(),
    variants: config.variants.map((variant) => ({ ...variant, promptHash: promptHash(variant.promptVersion) })),
  };
  if (existsSync(configFile)) {
    const previous = JSON.parse(readFileSync(configFile, "utf8")) as typeof descriptor & { createdAt: string };
    if (previous.graderVersion !== descriptor.graderVersion || previous.caseSetHash !== descriptor.caseSetHash) {
      throw new Error(
        `${config.outDir} holds results from another grader/case set (${previous.graderVersion}/${previous.caseSetHash}); ` +
          "use a new --out directory.",
      );
    }
    const knownVariants = new Map(previous.variants.map((variant) => [variant.id, variant]));
    for (const variant of descriptor.variants) {
      const known = knownVariants.get(variant.id);
      if (known && (known.promptHash !== variant.promptHash || known.model !== variant.model)) {
        throw new Error(`Variant ${variant.id} changed since the previous run in ${config.outDir}; use a new --out directory.`);
      }
      knownVariants.set(variant.id, variant);
    }
    writeFileSync(configFile, JSON.stringify({ ...previous, variants: [...knownVariants.values()], reps: Math.max(previous.reps, config.reps) }, null, 2));
  } else {
    writeFileSync(configFile, JSON.stringify({ ...descriptor, createdAt: new Date().toISOString() }, null, 2));
  }

  const resultsFile = path.join(config.outDir, "results.jsonl");
  const errorsFile = path.join(config.outDir, "errors.jsonl");
  const done = new Set(readJsonl<ResultRow>(resultsFile).map((row) => trialKey(row.variant, row.caseId, row.rep)));

  const runTag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const materialized = new Map<string, MaterializedCase>();
  for (const evalCase of config.cases) {
    materialized.set(evalCase.id, await materializeCase(evalCase, runTag));
  }

  const trials: Array<{ variant: Variant; materialized: MaterializedCase; rep: number }> = [];
  for (let rep = 1; rep <= config.reps; rep += 1) {
    for (const variant of config.variants) {
      for (const evalCase of config.cases) {
        if (!done.has(trialKey(variant.id, evalCase.id, rep))) {
          trials.push({ variant, materialized: materialized.get(evalCase.id)!, rep });
        }
      }
    }
  }

  let finished = 0;
  let scored = 0;
  let errors = 0;
  try {
    await pool(trials, config.concurrency, async ({ variant, materialized: item, rep }) => {
      const startedAt = new Date();
      const prefix = `${variant.id} ${item.evalCase.id} rep${rep}`;
      const guard = spendGuardFromEnv();
      if (LIVE_KINDS.has(variant.kind) && guard?.exhausted()) {
        log(`[skip] ${prefix}: spend cap reached ($${guard.totalUsd.toFixed(4)}); not started, rerun later to resume.`);
        return;
      }
      let result: HandoverRunResult;
      try {
        clearGlanceCache();
        result = await runHandoverAgent(item.reader, item.patientId, {
          clientFactory: clientFactoryFor(variant, item, rep),
          promptVersion: variant.promptVersion,
          settings: {
            model: variant.model,
            effort: variant.effort ?? "medium",
            fallbacks: variant.kind === "anthropic" ? "default" : null,
            // Offline baselines are harness self-tests: they keep measuring single-shot behaviour.
            ...(variant.citationRepairs !== undefined
              ? { citationRepairs: variant.citationRepairs }
              : LIVE_KINDS.has(variant.kind)
                ? {}
                : { citationRepairs: 0 }),
            deadlineMs: 240_000,
          },
          now: EVAL_NOW,
        });
      } catch (error) {
        errors += 1;
        const row: ErrorRow = {
          variant: variant.id,
          caseId: item.evalCase.id,
          rep,
          errorClass: "harness_exception",
          message: error instanceof Error ? error.message : String(error),
          startedAt: startedAt.toISOString(),
        };
        appendFileSync(errorsFile, `${JSON.stringify(row)}\n`);
        log(`[${++finished}/${trials.length}] ${prefix} ERROR harness_exception: ${row.message}`);
        return;
      }

      const servedMismatch =
        LIVE_KINDS.has(variant.kind) &&
        !result.fallbackUsed &&
        result.internal.run.servedModels.some((served) => !servedAsRequested(variant.model, served));
      if (INFRASTRUCTURE_OUTCOMES.has(result.outcome) || servedMismatch) {
        errors += 1;
        const row: ErrorRow = {
          variant: variant.id,
          caseId: item.evalCase.id,
          rep,
          errorClass: servedMismatch ? "served_model_mismatch" : result.outcome,
          message: servedMismatch
            ? `served ${result.internal.run.servedModels.join(",")} for ${variant.model}`
            : `${result.error?.kind ?? ""} ${result.error?.message ?? ""}`.trim(),
          startedAt: startedAt.toISOString(),
        };
        appendFileSync(errorsFile, `${JSON.stringify(row)}\n`);
        log(`[${++finished}/${trials.length}] ${prefix} ERROR ${row.errorClass}`);
        return;
      }

      const row = rowFrom(variant, item, rep, result, startedAt);
      appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
      const transcriptDir = path.join(config.outDir, "transcripts", variant.id, item.evalCase.id);
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(
        path.join(transcriptDir, `rep-${rep}.json`),
        JSON.stringify(
          {
            case: item.evalCase.id,
            variant: variant.id,
            rep,
            expectations: item.expect,
            outcome: result.outcome,
            messages: result.internal.run.messages,
            trace: result.internal.run.trace,
            submission: result.internal.submission,
            guardrail: result.guardrail,
            summary: result.summary,
            proposals: result.proposals,
            grade: { passed: row.passed, failures: row.failures, checks: row.checks, metrics: row.metrics },
          },
          null,
          2,
        ),
      );
      scored += 1;
      const cost = row.costUsd === null ? "n/a" : `$${row.costUsd.toFixed(4)}`;
      log(
        `[${++finished}/${trials.length}] ${prefix} ${row.passed ? "PASS" : `FAIL ${row.failures.join("+")}`} ` +
          `${(row.wallMs / 1000).toFixed(1)}s ${cost}`,
      );
    });
  } finally {
    if (!config.keepFixtures) {
      for (const item of materialized.values()) {
        await destroyCase(item.clinicId);
      }
    }
  }
  return { outDir: config.outDir, scored, errors };
}
