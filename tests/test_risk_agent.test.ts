import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "../src/lib/auth/rbac";
import { clearGlanceCache } from "../src/lib/cache/glanceCache";
import { createCareEntry } from "../src/lib/care-note/entries";
import { resolveAssignedClinician } from "../src/lib/care-note/transparency";
import { prisma } from "../src/lib/db";
import { createAnthropicClient, type ClientFactory } from "../src/lib/agent/core/client";
import { assistantMessage, scriptedFetch, scriptResponder, textBlock, toolUseBlock, type Responder } from "../src/lib/agent/core/testing";
import { runRiskAssessment } from "../src/lib/agent/risk/assess";
import { computeRiskFloor } from "../src/lib/agent/risk/floor";
import { applyRiskGuardrails } from "../src/lib/agent/risk/guardrails";
import { maxLevel, tightenReview } from "../src/lib/agent/risk/levels";
import { drainRiskQueue, enqueueRiskAssessment } from "../src/lib/agent/risk/queue";
import { getPatientRisk, listWorklist, overridePatientRisk, requestRiskAssessment } from "../src/lib/agent/risk/repository";
import { RISK_TOOL_NAMES } from "../src/lib/agent/risk/tools";
import { EvidenceLedger } from "../src/lib/agent/shared/record-context";
import { createAgentFixture, deleteAgentFixture, NOTE_A_BODY } from "./helpers/agent-fixtures";

function offline(responder: Responder): ClientFactory {
  const { fetch } = scriptedFetch(responder);
  return ({ onResponseStatus }) => createAnthropicClient({ apiKey: "test", maxRetries: 0, fetch, onResponseStatus });
}

const entry = (id: string, body: string | undefined, encounterAt: string, highlights: Array<{ source: string; label: string; excerpt: string }> = []) =>
  ({ id, title: `Note ${id}`, encounterAt, body, highlights, comments: [] }) as never;

describe("risk levels and floor", () => {
  it("orders levels and keeps review windows at least as tight as the level", () => {
    expect(maxLevel("LOW", "HIGH", "MEDIUM")).toBe("HIGH");
    expect(maxLevel(null, undefined)).toBe("LOW");
    expect(tightenReview("HIGH", "ROUTINE")).toBe("WITHIN_4H");
    expect(tightenReview("MEDIUM", "IMMEDIATE")).toBe("IMMEDIATE");
  });

  it("counts affirmed findings only, within the recency window", () => {
    const floor = computeRiskFloor([
      entry("n1", "Patient reports chest pain on stairs. Denies shortness of breath.", "2026-11-20T09:00:00Z"),
      entry("n2", "SpO2 86% on air three weeks ago.", "2026-10-25T09:00:00Z"),
      entry("n3", "If fever returns call the clinic.", "2026-11-19T09:00:00Z"),
    ]);
    // Lexical red flags floor at MEDIUM; HIGH or CRITICAL needs context (the agent) or a clinician.
    expect(floor.level).toBe("MEDIUM");
    expect(floor.reasons.map((reason) => reason.rule)).toEqual(["term:chest pain"]);
  });

  it("puts severe vitals at CRITICAL and clinician-marked critical highlights at HIGH", () => {
    const floor = computeRiskFloor([
      entry("n1", "BP 196/118 in triage.", "2026-11-20T09:00:00Z", [{ source: "HUMAN", label: "CRITICAL", excerpt: "BP 196/118" }]),
    ]);
    expect(floor.level).toBe("CRITICAL");
    expect(floor.reasons.map((reason) => reason.source).sort()).toEqual(["clinician-highlight", "rule-engine"]);
  });

  it("raises a model level to the floor, never lowers it, and drops unverifiable drivers", () => {
    const ledger = new EvidenceLedger();
    ledger.recordRead({ noteId: "n1", title: "Note", encounterAt: "2026-11-20", authorRole: "CLINICIAN", body: NOTE_A_BODY, comments: [] });
    const result = applyRiskGuardrails({
      submission: {
        level: "MEDIUM",
        review: "ROUTINE",
        summary: "Exertional chest pain under investigation.",
        confidence: "medium",
        drivers: [
          { factor: "Exertional chest pain", direction: "raises", citations: [{ note_id: "n1", quote: "reports chest pain on exertion since Monday" }] },
          { factor: "Elevated troponin", direction: "raises", citations: [{ note_id: "n1", quote: "troponin was 0.9" }] },
          { factor: "Shortness of breath at rest", direction: "raises", citations: [{ note_id: "n1", quote: "Denies shortness of breath at rest" }] },
        ],
      },
      ledger,
      floor: { level: "HIGH", reasons: [] },
    });
    expect(result).toMatchObject({ level: "HIGH", review: "WITHIN_4H" });
    expect(result.report).toMatchObject({ modelLevel: "MEDIUM", floorApplied: true, reviewTightened: true });
    expect(result.drivers.map((driver) => driver.factor)).toEqual(["Exertional chest pain"]);
    expect(result.report.rejectedDrivers.map((driver) => driver.reason)).toEqual(["UNGROUNDED_QUOTE", "NEGATION_CONFLICT"]);
  });
});

describe("risk triage agent", () => {
  let fixture: Awaited<ReturnType<typeof createAgentFixture>>;
  const savedEnv = { key: process.env.ANTHROPIC_API_KEY, client: process.env.NIGHTINGALE_AGENT_CLIENT };

  beforeEach(async () => {
    clearGlanceCache();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.NIGHTINGALE_AGENT_CLIENT;
    fixture = await createAgentFixture("risk");
  });

  afterEach(async () => {
    clearGlanceCache();
    if (savedEnv.key !== undefined) process.env.ANTHROPIC_API_KEY = savedEnv.key;
    if (savedEnv.client !== undefined) process.env.NIGHTINGALE_AGENT_CLIENT = savedEnv.client;
    if (fixture) {
      await prisma.riskAssessment.deleteMany({ where: { clinicId: fixture.clinic.id } });
      await prisma.agentRun.deleteMany({ where: { clinicId: fixture.clinic.id } });
      await prisma.auditLog.deleteMany({ where: { actor: { clinicId: fixture.clinic.id } } });
      await prisma.user.deleteMany({ where: { clinicId: fixture.clinic.id, isServiceAccount: true } });
      await deleteAgentFixture(fixture);
    }
  });

  /** A model that reads the chest-pain note and rates the patient LOW (below the MEDIUM floor). */
  function mediumModel(): ClientFactory {
    return offline(
      scriptResponder([
        assistantMessage([toolUseBlock(RISK_TOOL_NAMES.glance, {}), toolUseBlock(RISK_TOOL_NAMES.timeline, {})]),
        assistantMessage([toolUseBlock(RISK_TOOL_NAMES.notes, { note_ids: [fixture.noteA.id, fixture.noteB.id] })]),
        assistantMessage([
          toolUseBlock(RISK_TOOL_NAMES.submit, {
            level: "LOW",
            review: "ROUTINE",
            summary: "Exertional chest pain with tests ordered.",
            confidence: "medium",
            drivers: [
              { factor: "Exertional chest pain", direction: "raises", citations: [{ note_id: fixture.noteA.id, quote: "reports chest pain on exertion since Monday" }] },
              { factor: "Cardiology referral being considered", direction: "raises", citations: [{ note_id: fixture.noteB.id, quote: "considering cardiology referral" }] },
            ],
          }),
        ]),
      ]),
    );
  }

  it("enqueues on every note write and coalesces into one pending assessment", async () => {
    const pending = await prisma.riskAssessment.findMany({ where: { patientId: fixture.patient.id } });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: "PENDING", trigger: "NOTE_CREATED" });
  });

  it("runs the agent as the clinic service account and applies the floor", async () => {
    const [row] = await prisma.riskAssessment.findMany({ where: { patientId: fixture.patient.id } });
    const done = await runRiskAssessment(row!.id, { clientFactory: mediumModel() });
    expect(done).toMatchObject({ status: "COMPLETED", method: "agent", modelLevel: "LOW", floorLevel: "MEDIUM", finalLevel: "MEDIUM", review: "WITHIN_24H" });
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: done!.agentRunId! }, include: { actor: true } });
    expect(run).toMatchObject({ agent: "risk-triage", status: "SUCCEEDED" });
    expect(run.actor).toMatchObject({ isServiceAccount: true, role: "CLINICIAN", status: "DISABLED" });
    // The service account reads like a clinician but is never shown as anyone's assigned clinician.
    // (Real clinicians carry an employee code; the service account does not, and NULL sorts first.)
    await prisma.user.update({ where: { id: fixture.clinician.id }, data: { employeeCode: `EMP-${fixture.clinic.id}` } });
    expect((await resolveAssignedClinician(fixture.clinic.id)).name).toBe("Cara Clinician");
  });

  it("falls back to the rule floor when no model is configured, and when the model fails", async () => {
    const [row] = await prisma.riskAssessment.findMany({ where: { patientId: fixture.patient.id } });
    const rules = await runRiskAssessment(row!.id);
    expect(rules).toMatchObject({ status: "COMPLETED", method: "rules", finalLevel: "MEDIUM", agentRunId: null });

    await createCareEntry(fixture.actors.clinician, { patientId: fixture.patient.id, title: "Follow-up", body: "Chest pain settled. Plan: review.", encounterAt: "2026-11-21T09:00:00.000Z" });
    const next = await prisma.riskAssessment.findFirstOrThrow({ where: { patientId: fixture.patient.id, status: "PENDING" } });
    const prose = offline(() => assistantMessage([textBlock("The patient is fine.")]));
    const failed = await runRiskAssessment(next.id, { clientFactory: prose });
    expect(failed).toMatchObject({ status: "COMPLETED", method: "rules" });
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: failed!.agentRunId! } });
    expect(run).toMatchObject({ status: "FAILED", outcome: "NO_SUBMISSION" });
  });

  it("skips a model run when the record has not changed", async () => {
    const [row] = await prisma.riskAssessment.findMany({ where: { patientId: fixture.patient.id } });
    await runRiskAssessment(row!.id);
    const again = await enqueueRiskAssessment({ patientId: fixture.patient.id, clinicId: fixture.clinic.id, trigger: "NOTE_UPDATED" });
    const skipped = await runRiskAssessment(again);
    expect(skipped?.status).toBe("SUPERSEDED");
  });

  it("retries failures and gives up after three attempts", async () => {
    const [row] = await prisma.riskAssessment.findMany({ where: { patientId: fixture.patient.id } });
    const broken: ClientFactory = () => {
      throw new Error("transport exploded");
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await runRiskAssessment(row!.id, { clientFactory: broken });
    }
    const final = await prisma.riskAssessment.findUniqueOrThrow({ where: { id: row!.id } });
    expect(final).toMatchObject({ status: "FAILED", attempts: 3 });
    expect(final.error).not.toMatch(/exploded/);
  });

  it("drains the queue and shows a staff-safe view of the evidence", async () => {
    expect(await drainRiskQueue({ clientFactory: mediumModel() })).toBe(1);
    const clinicianView = await getPatientRisk(fixture.actors.clinician, fixture.patient.id);
    const staffView = await getPatientRisk(fixture.actors.staff, fixture.patient.id);
    expect(clinicianView.assessment).toMatchObject({ level: "MEDIUM", method: "agent", hiddenEvidence: 0 });
    expect(clinicianView.assessment!.drivers).toHaveLength(2);
    // The second driver quotes the clinician draft: the nurse sees the level but not that quote.
    expect(staffView.assessment!.level).toBe("MEDIUM");
    expect(staffView.assessment!.drivers).toHaveLength(1);
    expect(staffView.assessment!.hiddenEvidence).toBeGreaterThan(0);
    expect(JSON.stringify(staffView)).not.toMatch(/cardiology referral/);
    await expect(getPatientRisk(fixture.actors.patient, fixture.patient.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getPatientRisk(fixture.actors.outsider, fixture.patient.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("marks the assessment stale after a new note and reassesses on request", async () => {
    await drainRiskQueue();
    await createCareEntry(fixture.actors.clinician, { patientId: fixture.patient.id, title: "Update", body: "SpO2 87% on room air.", encounterAt: "2026-11-21T08:00:00.000Z" });
    const stale = await getPatientRisk(fixture.actors.clinician, fixture.patient.id);
    expect(stale).toMatchObject({ stale: true, pending: true });
    const fresh = await requestRiskAssessment(fixture.actors.clinician, fixture.patient.id);
    expect(fresh).toMatchObject({ stale: false, pending: false });
    expect(fresh.assessment).toMatchObject({ level: "CRITICAL", review: "IMMEDIATE", trigger: "MANUAL" });
  });

  it("lets clinicians (not nurses) override with a reason, and the worklist sorts by effective level", async () => {
    await drainRiskQueue();
    await expect(overridePatientRisk(fixture.actors.staff, fixture.patient.id, { level: "LOW", reason: "Reviewed in person" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(overridePatientRisk(fixture.actors.clinician, fixture.patient.id, { level: "LOW", reason: "" })).rejects.toMatchObject({ status: 400 });
    const overridden = await overridePatientRisk(fixture.actors.clinician, fixture.patient.id, { level: "CRITICAL", reason: "Ongoing pain on arrival" });
    expect(overridden.assessment).toMatchObject({ level: "CRITICAL", assessedLevel: "MEDIUM", override: { level: "CRITICAL", by: "Cara Clinician" } });

    const worklist = await listWorklist(fixture.actors.staff);
    expect(worklist.map((row) => row.patientId)).toEqual([fixture.patient.id]);
    expect(worklist[0]).toMatchObject({ level: "CRITICAL", overridden: true, noteCount: 3 });
    expect(JSON.stringify(worklist)).not.toMatch(/service\.nightingale\.internal/);
    await expect(listWorklist(fixture.actors.patient)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
