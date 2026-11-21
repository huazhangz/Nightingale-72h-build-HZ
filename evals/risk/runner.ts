import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createAnthropicClient, type ClientFactory } from "../../src/lib/agent/core/client";
import type { RunAgentResult } from "../../src/lib/agent/core/run-agent";
import { assistantMessage, scriptedFetch, toolUseBlock, type Responder } from "../../src/lib/agent/core/testing";
import { INFRASTRUCTURE_OUTCOMES, type Effort, type UsageTotals } from "../../src/lib/agent/core/types";
import { runRiskAssessment } from "../../src/lib/agent/risk/assess";
import { REVIEW_FOR_LEVEL, type RiskLevel } from "../../src/lib/agent/risk/levels";
import { riskPromptHash, RISK_PROMPT_VERSION } from "../../src/lib/agent/risk/prompts";
import { enqueueRiskAssessment } from "../../src/lib/agent/risk/queue";
import type { RiskGuardrailReport } from "../../src/lib/agent/risk/schema";
import { simulatedRiskResponder } from "../../src/lib/agent/risk/simulated";
import { RISK_TOOL_NAMES } from "../../src/lib/agent/risk/tools";
import { MAX_NOTES_PER_CALL } from "../../src/lib/agent/shared/record-tools";
import { geminiClientFactory } from "../../src/lib/agent/handover/config";
import { prisma } from "../../src/lib/db";
import type { EvalCase } from "../cases/types";
import { destroyCase, materializeCase, type MaterializedCase } from "../lib/fixtures";
import { costUsd } from "../lib/pricing";
import { EVAL_NOW, servedAsRequested } from "../lib/runner";
import { riskCaseSetHash, type RiskCase } from "./cases";

export type RiskVariantKind = "rules" | "simulated" | "oracle" | "anthropic" | "gemini";

export type RiskVariant = { id: string; kind: RiskVariantKind; model: string; effort?: Effort };

export type RiskRow = {
  variant: string;
  caseId: string;
  stratum: string;
  rep: number;
  gold: RiskLevel;
  /** What the worklist shows: max(model level, floor), or the floor alone for rules / failed runs. */
  final: RiskLevel;
  /** The model's own level before the floor; null for rules-only runs and failed model runs. */
  modelLevel: RiskLevel | null;
  floorLevel: RiskLevel | null;
  review: string;
  method: "agent" | "rules";
  /** Agent outcome (SUBMITTED, NO_SUBMISSION, ...); null when no model ran. */
  outcome: string | null;
  /** A model ran but did not submit, so production fell back to the floor. Scored, and counted. */
  modelFailed: boolean;
  floorApplied: boolean;
  rejectedDrivers: number;
  unsupportedLevel: boolean;
  usage: UsageTotals;
  costUsd: number | null;
  wallMs: number;
  steps: number;
  requestedModel: string;
  servedModel: string | null;
  promptHash: string;
  startedAt: string;
};

export type RiskErrorRow = { variant: string; caseId: string; rep: number; errorClass: string; message: string; startedAt: string };

const EMPTY_USAGE: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function asEvalCase(item: RiskCase): EvalCase {
  return {
    id: `risk-${item.id}`,
    tags: [item.stratum],
    description: item.description,
    readerRole: "CLINICIAN",
    notes: item.notes,
    expect: { mustCover: [], mustNotAssert: [], forbiddenText: [], followups: { expected: "any" } },
  };
}

/**
 * Harness check, not a competitor: lists the timeline, reads every note, then submits the gold
 * level citing the case's evidence quote. Its MODEL level must match gold on every case; its FINAL
 * level measures what the floor adds on top of a perfect model (floor false positives).
 */
export function riskOracleResponder(item: RiskCase, materialized: MaterializedCase): Responder {
  const noteIds = Object.values(materialized.noteIds);
  return (request) => {
    const message = (content: BetaContentBlock[]) => assistantMessage(content, { model: "oracle-baseline" });
    const turns = request.messages.filter((entry) => entry.role === "assistant").length;
    if (turns === 0) {
      return message([toolUseBlock(RISK_TOOL_NAMES.timeline, { limit: 50 })]);
    }
    if (turns === 1) {
      return message([toolUseBlock(RISK_TOOL_NAMES.notes, { note_ids: noteIds.slice(0, MAX_NOTES_PER_CALL) })]);
    }
    return message([
      toolUseBlock(RISK_TOOL_NAMES.submit, {
        level: item.gold,
        review: REVIEW_FOR_LEVEL[item.gold],
        summary: `Author-labelled ${item.gold} case.`,
        confidence: "high",
        drivers: [
          {
            factor: "Documented finding",
            direction: item.gold === "LOW" ? "lowers" : "raises",
            citations: [{ note_id: materialized.noteIds[item.evidence.noteKey]!, quote: item.evidence.quote }],
          },
        ],
      }),
    ]);
  };
}

function clientFactoryFor(variant: RiskVariant, item: RiskCase, materialized: MaterializedCase): ClientFactory | undefined {
  if (variant.kind === "rules") {
    return undefined;
  }
  if (variant.kind === "anthropic") {
    return ({ onResponseStatus }) => createAnthropicClient({ timeoutMs: 120_000, onResponseStatus });
  }
  if (variant.kind === "gemini") {
    return geminiClientFactory();
  }
  const responder = variant.kind === "oracle" ? riskOracleResponder(item, materialized) : simulatedRiskResponder(variant.model);
  return ({ onResponseStatus }) =>
    createAnthropicClient({ apiKey: "offline", maxRetries: 0, fetch: scriptedFetch(responder).fetch, onResponseStatus });
}

type Trial = { variant: RiskVariant; item: RiskCase; rep: number };

/** Everything needed to read a trial after the fixture is gone. Synthetic data only. */
export type RiskTranscript = {
  case: string;
  variant: string;
  rep: number;
  gold: RiskLevel;
  evidence: RiskCase["evidence"];
  outcome: string | null;
  messages: RunAgentResult["messages"] | null;
  trace: RunAgentResult["trace"] | null;
  submission: unknown;
  assessment: Record<string, unknown> | null;
};

export type RiskTrialResult = ({ row: RiskRow } | { error: RiskErrorRow }) & { transcript: RiskTranscript };

/** One isolated trial: fresh clinic and patient, one MANUAL assessment through the production path. */
export async function runRiskTrial({ variant, item, rep }: Trial, options: { keepFixtures?: boolean; runTag: string }): Promise<RiskTrialResult> {
  const startedAt = new Date();
  const materialized = await materializeCase(asEvalCase(item), `${options.runTag}-${variant.id}-${rep}`);
  let agentRun: RunAgentResult | null = null;
  let assessment: Record<string, unknown> | null = null;
  const transcript = (): RiskTranscript => ({
    case: item.id,
    variant: variant.id,
    rep,
    gold: item.gold,
    evidence: item.evidence,
    outcome: agentRun?.outcome ?? null,
    messages: agentRun?.messages ?? null,
    trace: agentRun?.trace ?? null,
    submission: agentRun?.submission ?? null,
    assessment,
  });
  const fail = (errorClass: string, message: string): RiskTrialResult => ({
    error: { variant: variant.id, caseId: item.id, rep, errorClass, message: message.slice(0, 500), startedAt: startedAt.toISOString() },
    transcript: transcript(),
  });
  try {
    const assessmentId = await enqueueRiskAssessment({ patientId: materialized.patientId, clinicId: materialized.clinicId, trigger: "MANUAL" });
    const clientFactory = clientFactoryFor(variant, item, materialized);
    const done = await runRiskAssessment(assessmentId, {
      ...(clientFactory ? { clientFactory } : { rulesOnly: true }),
      // Server-side refusal fallback is an Anthropic feature; other transports get none.
      settings: { model: variant.model, effort: variant.effort ?? "medium", ...(variant.kind === "anthropic" ? {} : { fallbacks: null }) },
      now: EVAL_NOW,
      onRun: (run) => {
        agentRun = run;
      },
    });
    if (done) {
      assessment = {
        status: done.status,
        method: done.method,
        modelLevel: done.modelLevel,
        floorLevel: done.floorLevel,
        finalLevel: done.finalLevel,
        review: done.review,
        confidence: done.confidence,
        summary: done.summary,
        drivers: done.drivers,
        floorReasons: done.floorReasons,
        guardrail: done.guardrail,
        error: done.error,
      };
    }
    if (!done || done.status !== "COMPLETED" || !done.finalLevel) {
      return fail("assessment_not_completed", done?.error ?? `status ${done?.status ?? "unclaimed"}`);
    }
    const run = done.agentRunId ? await prisma.agentRun.findUnique({ where: { id: done.agentRunId } }) : null;
    if (run?.outcome && (INFRASTRUCTURE_OUTCOMES as ReadonlySet<string>).has(run.outcome)) {
      // Infrastructure failures are retried on the next invocation, never scored as model errors.
      return fail(run.outcome, run.errorKind ?? "infrastructure failure");
    }
    const live = variant.kind === "anthropic" || variant.kind === "gemini";
    if (live && run?.servedModel && !run.fallbackUsed && !servedAsRequested(variant.model, run.servedModel)) {
      return fail("served_model_mismatch", `served ${run.servedModel} for ${variant.model}`);
    }
    const report = done.guardrail as unknown as RiskGuardrailReport;
    const usage: UsageTotals = run
      ? {
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          cacheReadInputTokens: run.cacheReadTokens,
          cacheCreationInputTokens: run.cacheWriteTokens,
        }
      : EMPTY_USAGE;
    return {
      row: {
        variant: variant.id,
        caseId: item.id,
        stratum: item.stratum,
        rep,
        gold: item.gold,
        final: done.finalLevel,
        modelLevel: done.method === "agent" ? done.modelLevel : null,
        floorLevel: done.floorLevel,
        review: done.review ?? "",
        method: done.method === "agent" ? "agent" : "rules",
        outcome: run?.outcome ?? null,
        modelFailed: run !== null && run.outcome !== "SUBMITTED",
        floorApplied: report.floorApplied,
        rejectedDrivers: report.rejectedDrivers.length,
        unsupportedLevel: report.unsupportedLevel,
        usage,
        costUsd: run ? costUsd(run.servedModel ?? variant.model, usage) : 0,
        wallMs: Date.now() - startedAt.getTime(),
        steps: run?.steps ?? 0,
        requestedModel: variant.model,
        servedModel: run?.servedModel ?? null,
        promptHash: riskPromptHash(),
        startedAt: startedAt.toISOString(),
      },
      transcript: transcript(),
    };
  } catch (error) {
    return fail("harness_exception", error instanceof Error ? error.message : String(error));
  } finally {
    if (!options.keepFixtures) {
      await destroyCase(materialized.clinicId);
    }
  }
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function loadRiskResults(outDir: string): { rows: RiskRow[]; errors: RiskErrorRow[]; config: Record<string, unknown> } {
  const configFile = path.join(outDir, "config.json");
  const rows = readJsonl<RiskRow>(path.join(outDir, "results.jsonl"));
  // A trial that errored and later succeeded keeps only its success.
  const scored = new Set(rows.map((row) => `${row.variant}|${row.caseId}|${row.rep}`));
  const errors = readJsonl<RiskErrorRow>(path.join(outDir, "errors.jsonl")).filter(
    (error) => !scored.has(`${error.variant}|${error.caseId}|${error.rep}`),
  );
  return { rows, errors, config: existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {} };
}

/**
 * Run variants x cases x reps. Resumable: scored trials in results.jsonl are skipped, errored ones
 * are retried. Refuses to resume a directory written with a different case set or prompt.
 */
export async function runRiskEvaluation(config: {
  variants: RiskVariant[];
  cases: RiskCase[];
  reps: number;
  concurrency: number;
  outDir: string;
  keepFixtures?: boolean;
  log?: (line: string) => void;
}): Promise<{ scored: number; errors: number }> {
  const log = config.log ?? ((line: string) => console.log(line));
  mkdirSync(config.outDir, { recursive: true });
  const configFile = path.join(config.outDir, "config.json");
  const identity = { caseSetHash: riskCaseSetHash(config.cases), promptVersion: RISK_PROMPT_VERSION, promptHash: riskPromptHash() };
  if (existsSync(configFile)) {
    const previous = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(identity)) {
      if (previous[key] !== value) {
        throw new Error(`${config.outDir} was written with ${key}=${String(previous[key])}, now ${value}. Use a new --out directory.`);
      }
    }
  }
  writeFileSync(
    configFile,
    JSON.stringify({ ...identity, variants: config.variants, reps: config.reps, cases: config.cases.map((item) => item.id), evalNow: EVAL_NOW.toISOString() }, null, 2),
  );

  const done = new Set(loadRiskResults(config.outDir).rows.map((row) => `${row.variant}|${row.caseId}|${row.rep}`));
  const trials: Trial[] = [];
  for (const variant of config.variants) {
    for (const item of config.cases) {
      for (let rep = 0; rep < config.reps; rep += 1) {
        if (!done.has(`${variant.id}|${item.id}|${rep}`)) {
          trials.push({ variant, item, rep });
        }
      }
    }
  }
  log(`${trials.length} trial(s) to run (${done.size} already scored).`);

  const runTag = `r${Date.now().toString(36)}`;
  let scored = 0;
  let errors = 0;
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(config.concurrency, trials.length)) }, async () => {
    while (next < trials.length) {
      const trial = trials[next]!;
      next += 1;
      const result = await runRiskTrial(trial, { keepFixtures: config.keepFixtures, runTag });
      const transcriptDir = path.join(config.outDir, "transcripts", trial.variant.id, trial.item.id);
      mkdirSync(transcriptDir, { recursive: true });
      writeFileSync(path.join(transcriptDir, `rep-${trial.rep}.json`), JSON.stringify(result.transcript, null, 2));
      if ("row" in result) {
        scored += 1;
        appendFileSync(path.join(config.outDir, "results.jsonl"), `${JSON.stringify(result.row)}\n`);
        log(`  ${trial.variant.id.padEnd(10)} ${trial.item.id.padEnd(22)} rep ${trial.rep}  gold ${trial.item.gold.padEnd(8)} final ${result.row.final}`);
      } else {
        errors += 1;
        appendFileSync(path.join(config.outDir, "errors.jsonl"), `${JSON.stringify(result.error)}\n`);
        log(`  ${trial.variant.id.padEnd(10)} ${trial.item.id.padEnd(22)} rep ${trial.rep}  ERROR ${result.error.errorClass}`);
      }
    }
  });
  await Promise.all(workers);
  return { scored, errors };
}
