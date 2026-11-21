import type { AgentFollowupProposal, AgentRun } from "@prisma/client";
import { ForbiddenError, assertClinicScope, type Actor } from "../../auth/rbac";
import { createPatientAction } from "../../care-note/actions";
import { prisma } from "../../db";
import { assertAgentActor, HANDOVER_AGENT, type HandoverRunResult, type PublicProposal } from "./agent";
import type { GuardrailReport, HandoverSummary } from "./schema";

/**
 * Read side of agent runs and the human-in-the-loop decision on proposals.
 *
 * Visibility rule: a summary inherits the permissions of the role that generated it (a clinician's
 * summary may quote clinician drafts a nurse must not see), so runs are only ever shown to actors of
 * the same role in the same clinic.
 */

export type PublicRun = {
  id: string;
  status: AgentRun["status"];
  outcome: string | null;
  degraded: boolean;
  model: string;
  servedModel: string | null;
  fallbackUsed: boolean;
  promptVersion: string;
  steps: number;
  durationMs: number | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  startedAt: string;
  finishedAt: string | null;
  summary: HandoverSummary | null;
  guardrail: GuardrailReport | null;
  proposals: PublicProposal[];
  errorKind: string | null;
};

function toPublicProposal(row: AgentFollowupProposal): PublicProposal {
  return {
    id: row.id,
    ref: row.ref,
    text: row.text,
    kind: row.kind,
    sourceNoteId: row.sourceNoteId,
    rationale: row.rationale,
    status: row.status,
  };
}

export function toPublicRun(run: AgentRun & { proposals: AgentFollowupProposal[] }): PublicRun {
  return {
    id: run.id,
    status: run.status,
    outcome: run.outcome,
    degraded: run.status === "FAILED",
    model: run.model,
    servedModel: run.servedModel,
    fallbackUsed: run.fallbackUsed,
    promptVersion: run.promptVersion,
    steps: run.steps,
    durationMs: run.durationMs,
    usage: {
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cacheReadTokens: run.cacheReadTokens,
      cacheWriteTokens: run.cacheWriteTokens,
    },
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    summary: (run.summary as HandoverSummary | null) ?? null,
    guardrail: (run.guardrail as GuardrailReport | null) ?? null,
    proposals: run.proposals.map(toPublicProposal),
    errorKind: run.errorKind,
  };
}

/** API shape of a just-finished run (drops evaluation-only internals). */
export function publicRunFromResult(result: HandoverRunResult, startedAt: Date): PublicRun {
  return {
    id: result.runId,
    status: result.status,
    outcome: result.outcome,
    degraded: result.degraded,
    model: result.model,
    servedModel: result.servedModel,
    fallbackUsed: result.fallbackUsed,
    promptVersion: result.promptVersion,
    steps: result.steps,
    durationMs: result.durationMs,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadInputTokens,
      cacheWriteTokens: result.usage.cacheCreationInputTokens,
    },
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    summary: result.summary,
    guardrail: result.guardrail,
    proposals: result.proposals,
    errorKind: result.error?.kind ?? null,
  };
}

async function assertPatientInScope(actor: Actor, patientId: string): Promise<void> {
  const patient = await prisma.user.findUniqueOrThrow({ where: { id: patientId } });
  if (patient.role !== "PATIENT" || !patient.clinicId) {
    throw new ForbiddenError("Handover summaries are only available for patient records");
  }
  assertClinicScope(actor, patient.clinicId);
}

export async function latestHandoverRun(actor: Actor, patientId: string): Promise<PublicRun | null> {
  assertAgentActor(actor);
  await assertPatientInScope(actor, patientId);
  const run = await prisma.agentRun.findFirst({
    where: {
      agent: HANDOVER_AGENT,
      patientId,
      clinicId: actor.clinicId!,
      actorRole: actor.role,
      status: { not: "RUNNING" },
    },
    include: { proposals: { orderBy: { ref: "asc" } } },
    orderBy: { startedAt: "desc" },
  });
  return run ? toPublicRun(run) : null;
}

export async function decideProposal(
  actor: Actor,
  proposalId: string,
  decision: "accept" | "dismiss",
): Promise<PublicProposal & { careActionId: string | null }> {
  assertAgentActor(actor);
  const proposal = await prisma.agentFollowupProposal.findUniqueOrThrow({
    where: { id: proposalId },
    include: { run: true },
  });
  assertClinicScope(actor, proposal.run.clinicId);
  if (proposal.run.actorRole !== actor.role) {
    throw new ForbiddenError("This proposal belongs to a summary generated for another role");
  }
  if (proposal.status !== "PROPOSED") {
    throw new ForbiddenError(`Proposal already ${proposal.status.toLowerCase()}`);
  }

  let careActionId: string | null = null;
  if (decision === "accept") {
    // Goes through the normal CareAction path: same RBAC, PHI redaction and audit trail as a human entry.
    const action = await createPatientAction(actor, proposal.patientId, {
      text: proposal.text,
      kind: proposal.kind,
      careEntryId: proposal.sourceNoteId,
    });
    careActionId = action.id;
  }

  const updated = await prisma.agentFollowupProposal.update({
    where: { id: proposal.id },
    data: {
      status: decision === "accept" ? "ACCEPTED" : "DISMISSED",
      careActionId,
      decidedById: actor.id,
      decidedAt: new Date(),
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: decision === "accept" ? "AGENT_PROPOSAL_ACCEPT" : "AGENT_PROPOSAL_DISMISS",
      entityType: "AgentFollowupProposal",
      entityId: proposal.id,
      metadata: { userId: actor.id },
    },
  });
  return { ...toPublicProposal(updated), careActionId };
}
