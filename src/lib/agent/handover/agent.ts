import type { Prisma } from "@prisma/client";
import { ForbiddenError, assertClinicScope, type Actor } from "../../auth/rbac";
import { prisma } from "../../db";
import { runAgentLoop, type AgentLoopResult, type LoopHooks } from "../runtime/loop";
import { DEFAULT_RETRY_POLICY } from "../runtime/retry";
import type { LoopOutcome, ModelClient, UsageTotals } from "../runtime/types";
import { agentSettingsFromEnv, createModelClient, type HandoverAgentSettings } from "./config";
import { createHandoverContext, type EvidenceLedger } from "./context";
import { applyGuardrails, criticalFindingsFor, type CriticalFinding } from "./guardrails";
import { handoverUserMessage, promptHash, systemPrompt, type PromptVersion } from "./prompts";
import { HandoverSubmission, type GuardrailReport, type HandoverSummary } from "./schema";
import { HANDOVER_TOOLS } from "./tools";

export const HANDOVER_AGENT = "handover";

export type HandoverRunOptions = {
  promptVersion?: PromptVersion;
  /** Inject a model client (tests, evaluation). Defaults to the configured client. */
  client?: ModelClient;
  settings?: Partial<HandoverAgentSettings>;
  signal?: AbortSignal;
  now?: Date;
  hooks?: LoopHooks;
};

export type PublicProposal = {
  id: string;
  ref: string;
  text: string;
  kind: string;
  sourceNoteId: string;
  rationale: string;
  status: "PROPOSED" | "ACCEPTED" | "DISMISSED";
};

export type HandoverRunResult = {
  runId: string;
  status: "SUCCEEDED" | "FAILED";
  outcome: LoopOutcome;
  /** True when the model did not deliver: the summary holds only safety-rule findings. */
  degraded: boolean;
  summary: HandoverSummary;
  guardrail: GuardrailReport;
  proposals: PublicProposal[];
  model: string;
  servedModel: string | null;
  fallbackUsed: boolean;
  promptVersion: PromptVersion;
  promptHash: string;
  steps: number;
  durationMs: number;
  usage: UsageTotals;
  error?: { kind: string; message: string };
  /** Evaluation-only diagnostics. Never serialised to API clients. */
  internal: {
    submission: HandoverSubmission | null;
    ledger: EvidenceLedger;
    criticalFindings: CriticalFinding[];
    loop: AgentLoopResult;
  };
};

export function assertAgentActor(actor: Actor): void {
  if (actor.role !== "STAFF" && actor.role !== "CLINICIAN" && actor.role !== "ADMIN") {
    throw new ForbiddenError("Only clinical staff can run the handover agent");
  }
}

async function loadPatientForAgent(actor: Actor, patientId: string) {
  const patient = await prisma.user.findUniqueOrThrow({ where: { id: patientId } });
  if (patient.role !== "PATIENT" || !patient.clinicId) {
    throw new ForbiddenError("Handover summaries are only available for patient records");
  }
  assertClinicScope(actor, patient.clinicId);
  return patient;
}

/**
 * Run the handover agent for one patient on behalf of `actor`. The production API and the
 * evaluation harness both call this function, so the evaluated configuration is the shipped one.
 */
export async function runHandoverAgent(
  actor: Actor,
  patientId: string,
  options: HandoverRunOptions = {},
): Promise<HandoverRunResult> {
  assertAgentActor(actor);
  const patient = await loadPatientForAgent(actor, patientId);
  const settings = { ...agentSettingsFromEnv(), ...options.settings };
  const client = options.client ?? createModelClient(settings);
  const promptVersion = options.promptVersion ?? settings.promptVersion;
  const now = options.now ?? new Date();
  const context = createHandoverContext(actor, patientId, now);

  const run = await prisma.agentRun.create({
    data: {
      agent: HANDOVER_AGENT,
      clinicId: patient.clinicId!,
      patientId,
      actorId: actor.id,
      actorRole: actor.role,
      promptVersion,
      promptHash: promptHash(promptVersion),
      model: settings.model,
    },
  });

  const loop = await runAgentLoop({
    client,
    config: {
      model: settings.model,
      system: systemPrompt(promptVersion),
      maxSteps: settings.maxSteps,
      maxTokens: settings.maxTokens,
      effort: settings.effort,
      tokenBudget: settings.tokenBudget,
      deadlineMs: settings.deadlineMs,
      retry: DEFAULT_RETRY_POLICY,
      maxNudges: 1,
      fallbacks: settings.fallbacks,
      promptCaching: true,
    },
    tools: HANDOVER_TOOLS,
    context,
    initialMessages: [{ role: "user", content: handoverUserMessage({ readerRole: actor.role, today: now }) }],
    signal: options.signal,
    hooks: options.hooks,
  });

  const criticalFindings = criticalFindingsFor(await context.timeline());
  const submitted = loop.outcome === "SUBMITTED";
  const submission = submitted ? HandoverSubmission.parse(loop.submission) : null;
  // A failed run still yields the deterministic safety floor, so the reader is never left with nothing.
  const { items, report } = applyGuardrails({
    submission: submission ?? { items: [] },
    ledger: context.ledger,
    criticalFindings,
  });
  const summary: HandoverSummary = { items, generatedAt: new Date().toISOString() };
  const status = submitted ? "SUCCEEDED" : "FAILED";

  // Proposals from an incomplete run are not trustworthy enough to show; only persist on success.
  const proposals = submitted
    ? await prisma.$transaction(
        context.proposals.map((proposal) =>
          prisma.agentFollowupProposal.create({
            data: {
              runId: run.id,
              patientId,
              ref: proposal.ref,
              sourceNoteId: proposal.sourceNoteId,
              kind: proposal.kind,
              text: proposal.text,
              rationale: proposal.rationale,
            },
          }),
        ),
      )
    : [];

  const servedModel = loop.servedModels.at(-1) ?? null;
  await prisma.agentRun.update({
    where: { id: run.id },
    data: {
      status,
      outcome: loop.outcome,
      errorKind: loop.error?.kind ?? null,
      servedModel,
      fallbackUsed: loop.fallbackUsed,
      steps: loop.steps,
      inputTokens: loop.usage.inputTokens,
      outputTokens: loop.usage.outputTokens,
      cacheReadTokens: loop.usage.cacheReadInputTokens,
      cacheWriteTokens: loop.usage.cacheCreationInputTokens,
      durationMs: loop.durationMs,
      trace: loop.trace as unknown as Prisma.InputJsonValue,
      summary: summary as unknown as Prisma.InputJsonValue,
      guardrail: report as unknown as Prisma.InputJsonValue,
      finishedAt: new Date(),
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: submitted ? "AGENT_HANDOVER_RUN" : "AGENT_HANDOVER_FAILED",
      entityType: "AgentRun",
      entityId: run.id,
      metadata: { userId: actor.id },
    },
  });

  return {
    runId: run.id,
    status,
    outcome: loop.outcome,
    degraded: !submitted,
    summary,
    guardrail: report,
    proposals: proposals.map((row) => ({
      id: row.id,
      ref: row.ref,
      text: row.text,
      kind: row.kind,
      sourceNoteId: row.sourceNoteId,
      rationale: row.rationale,
      status: row.status,
    })),
    model: settings.model,
    servedModel,
    fallbackUsed: loop.fallbackUsed,
    promptVersion,
    promptHash: promptHash(promptVersion),
    steps: loop.steps,
    durationMs: loop.durationMs,
    usage: loop.usage,
    ...(loop.error ? { error: { kind: loop.error.kind, message: loop.error.message } } : {}),
    internal: { submission, ledger: context.ledger, criticalFindings, loop },
  };
}
