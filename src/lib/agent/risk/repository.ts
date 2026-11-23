import type { RiskAssessment } from "@prisma/client";
import { ForbiddenError, assertClinicScope, type Actor } from "../../auth/rbac";
import { getPatientTimeline } from "../../care-note/timeline";
import { prisma } from "../../db";
import { redactPhi } from "../../security/redact";
import { HttpError } from "../../auth/session";
import { createRecordContext } from "../shared/record-context";
import { ensureServiceAccount, riskInputHash, runRiskAssessment, type RunRiskOptions } from "./assess";
import type { FloorReason } from "./floor";
import { REVIEW_FOR_LEVEL, reviewRank, riskRank, RISK_LEVELS, type ReviewWindow, type RiskLevel } from "./levels";
import { enqueueRiskAssessment } from "./queue";
import type { RiskDriver, RiskGuardrailReport } from "./schema";

/**
 * Read model of risk assessments. Levels are visible to all clinical roles; the evidence behind
 * them is filtered per viewer, because automatic runs read with clinician visibility (a nurse must
 * not see quotes from an unreleased clinician draft, though the level itself is shared).
 */

export type PublicRiskAssessment = {
  id: string;
  method: "agent" | "rules";
  /** Effective level: a clinician override if present, else the assessed level. */
  level: RiskLevel;
  assessedLevel: RiskLevel;
  modelLevel: RiskLevel | null;
  floorLevel: RiskLevel | null;
  review: ReviewWindow;
  confidence: string | null;
  summary: string;
  drivers: RiskDriver[];
  floorReasons: FloorReason[];
  hiddenEvidence: number;
  report: RiskGuardrailReport | null;
  trigger: string;
  assessedAt: string;
  override: { level: RiskLevel; reason: string; by: string | null; at: string } | null;
};

export type PatientRiskView = {
  assessment: PublicRiskAssessment | null;
  /** A newer assessment is queued or running. */
  pending: boolean;
  /** The record changed since the shown assessment and no new one has finished yet. */
  stale: boolean;
  lastError: string | null;
};

export function assertRiskReader(actor: Actor): void {
  if (actor.role !== "STAFF" && actor.role !== "CLINICIAN" && actor.role !== "ADMIN") {
    throw new ForbiddenError("Risk assessments are visible to clinical staff only");
  }
}

async function patientInScope(actor: Actor, patientId: string) {
  const patient = await prisma.user.findUniqueOrThrow({ where: { id: patientId } });
  if (patient.role !== "PATIENT" || !patient.clinicId || patient.isServiceAccount) {
    throw new ForbiddenError("Risk assessments exist only for patient records");
  }
  assertClinicScope(actor, patient.clinicId);
  return patient;
}

function toPublic(row: RiskAssessment, visibleNotes: Set<string>, overriderName: string | null): PublicRiskAssessment {
  const drivers = ((row.drivers as RiskDriver[] | null) ?? []).map((driver) => ({
    ...driver,
    citations: driver.citations.filter((citation) => visibleNotes.has(citation.noteId)),
  }));
  const floorReasons = (row.floorReasons as FloorReason[] | null) ?? [];
  const visibleDrivers = drivers.filter((driver) => driver.citations.length > 0);
  const visibleFloor = floorReasons.filter((reason) => visibleNotes.has(reason.noteId));
  const assessedLevel = (row.finalLevel ?? "LOW") as RiskLevel;
  return {
    id: row.id,
    method: (row.method ?? "rules") as "agent" | "rules",
    level: (row.overrideLevel ?? assessedLevel) as RiskLevel,
    assessedLevel,
    modelLevel: row.modelLevel as RiskLevel | null,
    floorLevel: row.floorLevel as RiskLevel | null,
    review: (row.review ?? REVIEW_FOR_LEVEL[assessedLevel]) as ReviewWindow,
    confidence: row.confidence,
    summary: row.summary ?? "",
    drivers: visibleDrivers,
    floorReasons: visibleFloor,
    hiddenEvidence: drivers.length - visibleDrivers.length + (floorReasons.length - visibleFloor.length),
    report: (row.guardrail as RiskGuardrailReport | null) ?? null,
    trigger: row.trigger,
    assessedAt: (row.completedAt ?? row.createdAt).toISOString(),
    override: row.overrideLevel
      ? {
          level: row.overrideLevel as RiskLevel,
          reason: row.overrideReason ?? "",
          by: overriderName,
          at: (row.overriddenAt ?? row.createdAt).toISOString(),
        }
      : null,
  };
}

async function visibleNoteIds(actor: Actor, patientId: string): Promise<Set<string>> {
  const timeline = await getPatientTimeline(patientId, actor);
  return new Set(timeline.filter((entry) => "body" in entry && entry.body !== undefined).map((entry) => entry.id));
}

export async function getPatientRisk(actor: Actor, patientId: string): Promise<PatientRiskView> {
  assertRiskReader(actor);
  const patient = await patientInScope(actor, patientId);
  const [latest, pendingRow, lastFailed] = await Promise.all([
    prisma.riskAssessment.findFirst({ where: { patientId, status: "COMPLETED" }, orderBy: { completedAt: "desc" } }),
    prisma.riskAssessment.findFirst({ where: { patientId, status: { in: ["PENDING", "RUNNING"] } } }),
    prisma.riskAssessment.findFirst({ where: { patientId, status: "FAILED" }, orderBy: { createdAt: "desc" } }),
  ]);
  if (!latest) {
    return { assessment: null, pending: Boolean(pendingRow), stale: false, lastError: lastFailed?.error ?? null };
  }
  const service = await ensureServiceAccount(patient.clinicId!);
  const serviceTimeline = await createRecordContext({ id: service.id, role: "CLINICIAN", clinicId: patient.clinicId }, patientId).timeline();
  const currentHash = await riskInputHash(patientId, serviceTimeline);
  const overrider = latest.overriddenById
    ? await prisma.user.findUnique({ where: { id: latest.overriddenById }, select: { name: true } })
    : null;
  return {
    assessment: toPublic(latest, await visibleNoteIds(actor, patientId), overrider?.name ?? null),
    pending: Boolean(pendingRow),
    stale: latest.inputHash !== currentHash,
    lastError: lastFailed && lastFailed.createdAt > (latest.completedAt ?? latest.createdAt) ? lastFailed.error : null,
  };
}

/** Clinician-requested reassessment: queued like any other, then run immediately for this request. */
export async function requestRiskAssessment(actor: Actor, patientId: string, options: RunRiskOptions = {}): Promise<PatientRiskView> {
  assertRiskReader(actor);
  const patient = await patientInScope(actor, patientId);
  const id = await enqueueRiskAssessment({ patientId, clinicId: patient.clinicId!, trigger: "MANUAL", requestedById: actor.id });
  await runRiskAssessment(id, options);
  return getPatientRisk(actor, patientId);
}

export async function overridePatientRisk(
  actor: Actor,
  patientId: string,
  input: { level: string; reason: string },
): Promise<PatientRiskView> {
  if (actor.role !== "CLINICIAN" && actor.role !== "ADMIN") {
    throw new ForbiddenError("Only clinicians can override a risk level");
  }
  await patientInScope(actor, patientId);
  // "CLEAR" removes the override (with a reason, audited); the assessed level applies again.
  const clearing = input.level === "CLEAR";
  if (!clearing && !(RISK_LEVELS as readonly string[]).includes(input.level)) {
    throw new HttpError(400, "INVALID_LEVEL", "level must be LOW, MEDIUM, HIGH, CRITICAL or CLEAR");
  }
  const reason = redactPhi(input.reason.trim());
  if (reason.length < 5 || reason.length > 500) {
    throw new HttpError(400, "INVALID_REASON", "A reason of 5-500 characters is required");
  }
  const latest = await prisma.riskAssessment.findFirst({ where: { patientId, status: "COMPLETED" }, orderBy: { completedAt: "desc" } });
  if (!latest) {
    throw new HttpError(409, "NO_ASSESSMENT", "There is no completed assessment to override yet");
  }
  if (clearing && !latest.overrideLevel) {
    throw new HttpError(409, "NO_OVERRIDE", "There is no override to clear");
  }
  await prisma.riskAssessment.update({
    where: { id: latest.id },
    data: clearing
      ? { overrideLevel: null, overrideReason: null, overriddenById: null, overriddenAt: null }
      : { overrideLevel: input.level as RiskLevel, overrideReason: reason, overriddenById: actor.id, overriddenAt: new Date() },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: clearing ? "RISK_OVERRIDE_CLEARED" : "RISK_OVERRIDE",
      entityType: "RiskAssessment",
      entityId: latest.id,
      metadata: { userId: actor.id, ...(clearing ? { previousLevel: latest.overrideLevel, reason } : {}) },
    },
  });
  return getPatientRisk(actor, patientId);
}

export type WorklistRow = {
  patientId: string;
  name: string;
  level: RiskLevel | null;
  review: ReviewWindow | null;
  method: "agent" | "rules" | null;
  overridden: boolean;
  assessedAt: string | null;
  pending: boolean;
  lastEncounterAt: string | null;
  noteCount: number;
  openActions: number;
};

/** Clinic worklist, most urgent first: level, then review window, then most recent encounter. */
export async function listWorklist(actor: Actor): Promise<WorklistRow[]> {
  assertRiskReader(actor);
  if (!actor.clinicId) {
    throw new ForbiddenError("No clinic scope");
  }
  const patients = await prisma.user.findMany({
    where: { clinicId: actor.clinicId, role: "PATIENT", isServiceAccount: false, status: { not: "DISABLED" } },
    select: {
      id: true,
      name: true,
      patientEntries: { select: { encounterAt: true }, orderBy: { encounterAt: "desc" }, take: 1 },
      _count: { select: { patientEntries: true } },
      // Only the columns the row needs: drivers, floor reasons and guardrail JSON stay in the database.
      riskAssessments: {
        where: { status: { in: ["COMPLETED", "PENDING", "RUNNING"] } },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { status: true, finalLevel: true, overrideLevel: true, review: true, method: true, completedAt: true },
      },
    },
  });
  const openActions = await prisma.careAction.groupBy({
    by: ["patientId"],
    where: { status: "PENDING", patientId: { in: patients.map((patient) => patient.id) } },
    _count: { _all: true },
  });
  const openByPatient = new Map(openActions.map((row) => [row.patientId, row._count._all]));

  const rows: WorklistRow[] = patients.map((patient) => {
    const completed = patient.riskAssessments.find((row) => row.status === "COMPLETED");
    const level = (completed?.overrideLevel ?? completed?.finalLevel ?? null) as RiskLevel | null;
    return {
      patientId: patient.id,
      name: patient.name,
      level,
      review: (completed?.review ?? null) as ReviewWindow | null,
      method: (completed?.method ?? null) as "agent" | "rules" | null,
      overridden: Boolean(completed?.overrideLevel),
      assessedAt: completed?.completedAt?.toISOString() ?? null,
      pending: patient.riskAssessments.some((row) => row.status === "PENDING" || row.status === "RUNNING"),
      lastEncounterAt: patient.patientEntries[0]?.encounterAt.toISOString() ?? null,
      noteCount: patient._count.patientEntries,
      openActions: openByPatient.get(patient.id) ?? 0,
    };
  });
  return rows.sort(
    (left, right) =>
      riskRank(right.level) - riskRank(left.level) ||
      (right.review ? reviewRank(right.review) : -1) - (left.review ? reviewRank(left.review) : -1) ||
      (right.lastEncounterAt ?? "").localeCompare(left.lastEncounterAt ?? "") ||
      left.name.localeCompare(right.name),
  );
}
