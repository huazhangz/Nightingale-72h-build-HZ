import { createHash } from "node:crypto";
import type { Prisma, RiskAssessment } from "@prisma/client";
import type { Actor } from "../../auth/rbac";
import { prisma } from "../../db";
import type { ClientFactory } from "../core/client";
import type { RunAgentResult } from "../core/run-agent";
import { agentSettingsFromEnv, createClientFactory, isAgentAvailable, type HandoverAgentSettings } from "../handover/config";
import { executeAgent, failAgentRun, finishAgentRun } from "../shared/execute";
import { createRecordContext, type ClinicalTimelineEntry } from "../shared/record-context";
import { computeRiskFloor } from "./floor";
import { applyRiskGuardrails, ruleBasedAssessment } from "./guardrails";
import { isRiskPromptVersion, RISK_PROMPT_VERSION, riskPromptHash, riskSystemPrompt, riskUserMessage, type RiskPromptVersion } from "./prompts";
import { RiskSubmission, type RiskResult } from "./schema";
import { simulatedRiskResponder } from "./simulated";
import { RISK_TOOLS } from "./tools";

export const RISK_AGENT = "risk-triage";
export const MAX_RISK_ATTEMPTS = 3;
const RISK_MAX_ITERATIONS = 8;

/**
 * Automatic risk runs act as the clinic's service account, which reads with clinician visibility.
 * Results therefore do not depend on who happened to write the note that triggered them; what each
 * viewer may see of the rationale is filtered at read time.
 */
export async function ensureServiceAccount(clinicId: string) {
  const email = `triage-agent+${clinicId}@service.nightingale.internal`;
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name: "Nightingale triage agent",
      role: "CLINICIAN",
      clinicId,
      isServiceAccount: true,
      // Not a valid hash of any password: service accounts can never sign in.
      passwordHash: "!service-account",
      status: "DISABLED",
    },
  });
}

/** Fingerprint of everything the assessment reads; unchanged input means no new model run. */
export async function riskInputHash(patientId: string, timeline: ClinicalTimelineEntry[]): Promise<string> {
  const actions = await prisma.careAction.findMany({
    where: { patientId },
    select: { id: true, status: true },
    orderBy: { id: "asc" },
  });
  const material = {
    notes: timeline
      .map((entry) => ({
        id: entry.id,
        version: entry.version,
        updatedAt: entry.updatedAt,
        status: entry.status,
        highlights: entry.highlights.map((highlight) => `${highlight.id}:${highlight.label}`).sort(),
        comments: entry.comments.length,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    actions,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 24);
}

export type RunRiskOptions = {
  clientFactory?: ClientFactory;
  settings?: Partial<HandoverAgentSettings>;
  /** Skip the model even when configured (seed data, emergency kill switch). */
  rulesOnly?: boolean;
  now?: Date;
  /** Prompt version (default: NIGHTINGALE_RISK_PROMPT if valid, else the current default). */
  promptVersion?: RiskPromptVersion;
  /** Evaluation-only: receives the full agent run (messages, trace, submission) for transcripts. */
  onRun?: (run: RunAgentResult) => void;
};

/**
 * Process one PENDING assessment. The row is claimed atomically (PENDING → RUNNING), so concurrent
 * workers never run the same assessment twice. Failures return the row to PENDING until
 * MAX_RISK_ATTEMPTS, then mark it FAILED; the previous completed assessment stays visible meanwhile.
 */
export async function runRiskAssessment(assessmentId: string, options: RunRiskOptions = {}): Promise<RiskAssessment | null> {
  const claimed = await prisma.riskAssessment.updateMany({
    where: { id: assessmentId, status: "PENDING" },
    data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) {
    return null;
  }
  const row = await prisma.riskAssessment.findUniqueOrThrow({ where: { id: assessmentId } });
  let agentRunId: string | null = null;
  try {
    const service = await ensureServiceAccount(row.clinicId);
    const actor: Actor = { id: service.id, role: "CLINICIAN", clinicId: row.clinicId };
    const now = options.now ?? new Date();
    const context = createRecordContext(actor, row.patientId, now);
    const timeline = await context.timeline();
    const inputHash = await riskInputHash(row.patientId, timeline);

    const previous = await prisma.riskAssessment.findFirst({
      where: { patientId: row.patientId, status: "COMPLETED" },
      orderBy: { completedAt: "desc" },
    });
    if (previous?.inputHash === inputHash && row.trigger !== "MANUAL") {
      return prisma.riskAssessment.update({
        where: { id: row.id },
        data: { status: "SUPERSEDED", inputHash, error: "Input unchanged since the last assessment", completedAt: new Date() },
      });
    }

    const floor = computeRiskFloor(timeline);
    const envPrompt = process.env.NIGHTINGALE_RISK_PROMPT;
    const promptVersion: RiskPromptVersion = options.promptVersion ?? (isRiskPromptVersion(envPrompt) ? envPrompt : RISK_PROMPT_VERSION);
    const settings = { ...agentSettingsFromEnv(), ...options.settings };
    const useModel = !options.rulesOnly && (options.clientFactory !== undefined || isAgentAvailable(settings));
    let result: RiskResult;
    if (useModel) {
      const clientFactory = options.clientFactory ?? createClientFactory(settings, () => simulatedRiskResponder(settings.model));
      const executed = await executeAgent({
        agent: RISK_AGENT,
        clinicId: row.clinicId,
        patientId: row.patientId,
        actor,
        promptVersion,
        promptHash: riskPromptHash(promptVersion),
        clientFactory,
        config: {
          model: settings.model,
          system: riskSystemPrompt(promptVersion),
          maxIterations: Math.min(settings.maxIterations, RISK_MAX_ITERATIONS),
          maxTokens: settings.maxTokens,
          effort: settings.effort,
          tokenBudget: settings.tokenBudget,
          deadlineMs: settings.deadlineMs,
          maxNudges: 1,
          fallbacks: settings.fallbacks,
        },
        tools: RISK_TOOLS,
        context,
        messages: [{ role: "user", content: riskUserMessage(now) }],
      });
      agentRunId = executed.runId;
      options.onRun?.(executed.result);
      const submitted = executed.result.outcome === "SUBMITTED";
      result = submitted
        ? applyRiskGuardrails({ submission: RiskSubmission.parse(executed.result.submission), ledger: context.ledger, floor })
        : ruleBasedAssessment(floor, "model_failed");
      await finishAgentRun(executed.runId, executed.result, {
        status: submitted ? "SUCCEEDED" : "FAILED",
        summary: result,
        guardrail: result.report,
      });
    } else {
      result = ruleBasedAssessment(floor, "no_model");
    }

    const completed = await prisma.riskAssessment.update({
      where: { id: row.id },
      data: {
        status: "COMPLETED",
        inputHash,
        method: result.method,
        modelLevel: result.report.modelLevel,
        floorLevel: result.report.floorLevel,
        finalLevel: result.level,
        review: result.review,
        confidence: result.confidence,
        summary: result.summary,
        drivers: result.drivers as unknown as Prisma.InputJsonValue,
        floorReasons: result.floorReasons as unknown as Prisma.InputJsonValue,
        guardrail: result.report as unknown as Prisma.InputJsonValue,
        agentRunId,
        error: null,
        completedAt: new Date(),
      },
    });
    await prisma.auditLog.create({
      data: {
        actorId: service.id,
        action: "RISK_ASSESSMENT_COMPLETED",
        entityType: "RiskAssessment",
        entityId: row.id,
        metadata: { userId: service.id },
      },
    });
    return completed;
  } catch (error) {
    if (agentRunId) {
      await failAgentRun(agentRunId);
    }
    const exhausted = row.attempts >= MAX_RISK_ATTEMPTS;
    console.error(`[nightingale] risk assessment ${row.id} failed (attempt ${row.attempts})`, error);
    await prisma.riskAssessment.update({
      where: { id: row.id },
      data: {
        status: exhausted ? "FAILED" : "PENDING",
        error: "Assessment failed; see server logs",
        ...(exhausted ? { completedAt: new Date() } : {}),
      },
    });
    return null;
  }
}
