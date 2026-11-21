import { ForbiddenError, assertClinicScope, type Actor } from "../../auth/rbac";
import { prisma } from "../../db";
import type { ClientFactory } from "../core/client";
import type { RunAgentResult } from "../core/run-agent";
import type { RunOutcome, UsageTotals } from "../core/types";
import { executeAgent, failAgentRun, finishAgentRun } from "../shared/execute";
import { createRecordContext, type EvidenceLedger } from "../shared/record-context";
import { agentSettingsFromEnv, createClientFactory, type HandoverAgentSettings } from "./config";
import { applyGuardrails, criticalFindingsFor, type CriticalFinding } from "./guardrails";
import { handoverUserMessage, promptHash, systemPrompt, type PromptVersion } from "./prompts";
import { HandoverSubmission, type GuardrailReport, type HandoverSummary } from "./schema";
import { HANDOVER_TOOLS, type HandoverContext } from "./tools";

export const HANDOVER_AGENT = "handover";

export type HandoverRunOptions = {
  promptVersion?: PromptVersion;
  /** Inject the client factory (tests, evaluation). Defaults to the configured client. */
  clientFactory?: ClientFactory;
  settings?: Partial<HandoverAgentSettings>;
  signal?: AbortSignal;
  now?: Date;
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
  outcome: RunOutcome;
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
    run: RunAgentResult;
  };
};

export function assertAgentActor(actor: Actor): void {
  if (actor.role !== "STAFF" && actor.role !== "CLINICIAN" && actor.role !== "ADMIN") {
    throw new ForbiddenError("Only clinical staff can run the handover agent");
  }
}

export async function loadPatientForAgent(actor: Actor, patientId: string) {
  const patient = await prisma.user.findUniqueOrThrow({ where: { id: patientId } });
  if (patient.role !== "PATIENT" || !patient.clinicId) {
    throw new ForbiddenError("Agent results are only available for patient records");
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
  const clientFactory = options.clientFactory ?? createClientFactory(settings);
  const promptVersion = options.promptVersion ?? settings.promptVersion;
  const now = options.now ?? new Date();
  const context: HandoverContext = { ...createRecordContext(actor, patientId, now), proposals: [] };

  const { runId, result } = await executeAgent({
    agent: HANDOVER_AGENT,
    clinicId: patient.clinicId!,
    patientId,
    actor,
    promptVersion,
    promptHash: promptHash(promptVersion),
    clientFactory,
    config: {
      model: settings.model,
      system: systemPrompt(promptVersion),
      maxIterations: settings.maxIterations,
      maxTokens: settings.maxTokens,
      effort: settings.effort,
      tokenBudget: settings.tokenBudget,
      deadlineMs: settings.deadlineMs,
      maxNudges: 1,
      fallbacks: settings.fallbacks,
    },
    tools: HANDOVER_TOOLS,
    context,
    messages: [{ role: "user", content: handoverUserMessage({ readerRole: actor.role, today: now }) }],
    signal: options.signal,
  });

  try {
    const criticalFindings = criticalFindingsFor(await context.timeline());
    const submitted = result.outcome === "SUBMITTED";
    const submission = submitted ? HandoverSubmission.parse(result.submission) : null;
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
                runId,
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

    await finishAgentRun(runId, result, { status, summary, guardrail: report });
    await prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: submitted ? "AGENT_HANDOVER_RUN" : "AGENT_HANDOVER_FAILED",
        entityType: "AgentRun",
        entityId: runId,
        metadata: { userId: actor.id },
      },
    });

    return {
      runId,
      status,
      outcome: result.outcome,
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
      servedModel: result.servedModels.at(-1) ?? null,
      fallbackUsed: result.fallbackUsed,
      promptVersion,
      promptHash: promptHash(promptVersion),
      steps: result.steps,
      durationMs: result.durationMs,
      usage: result.usage,
      ...(result.error ? { error: { kind: result.error.kind, message: result.error.message } } : {}),
      internal: { submission, ledger: context.ledger, criticalFindings, run: result },
    };
  } catch (error) {
    await failAgentRun(runId);
    throw error;
  }
}
