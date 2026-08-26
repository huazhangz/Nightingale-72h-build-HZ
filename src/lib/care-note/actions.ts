import type { CareAction } from "@prisma/client";
import { type Actor, ForbiddenError, assertClinicScope, assertPatientIsolation } from "../auth/rbac";
import { prisma } from "../db";
import { redactPhi } from "../security/redact";
import { invalidateGlanceCache } from "../cache/glanceCache";

export const ACTION_KINDS = ["comment", "highlight", "plan", "lab_order", "follow_up"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

function assertClinicalActor(actor: Actor): void {
  if (actor.role !== "STAFF" && actor.role !== "CLINICIAN" && actor.role !== "ADMIN") {
    throw new ForbiddenError("Patients cannot manage care actions");
  }
}

export function normalizeActionKind(value: string | undefined | null): ActionKind {
  const normalized = (value ?? "plan").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((ACTION_KINDS as readonly string[]).includes(normalized)) {
    return normalized as ActionKind;
  }
  if (normalized === "lab" || normalized === "laborder") {
    return "lab_order";
  }
  if (normalized === "followup") {
    return "follow_up";
  }
  return "plan";
}

function toGlanceShape(row: CareAction & { resolvedBy?: { name: string } | null }) {
  return {
    id: row.id,
    sourceKey: row.sourceKey,
    kind: normalizeActionKind(row.kind),
    text: redactPhi(row.text),
    careEntryId: row.careEntryId,
    status: row.status,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedByRole: row.resolvedByRole,
    resolvedByName: row.resolvedBy?.name ?? null,
  };
}

async function loadPatientScope(patientId: string, actor: Actor) {
  const patient = await prisma.user.findUniqueOrThrow({ where: { id: patientId } });
  if (!patient.clinicId) {
    throw new ForbiddenError("Patient is missing clinic scope");
  }
  assertClinicScope(actor, patient.clinicId);
  assertPatientIsolation(actor, patientId);
  return patient;
}

export async function createPatientAction(
  actor: Actor,
  patientId: string,
  input: { text: string; kind?: string; careEntryId?: string },
) {
  assertClinicalActor(actor);
  await loadPatientScope(patientId, actor);
  const text = redactPhi(input.text.trim());
  if (text.length < 2) {
    throw new ForbiddenError("Action text is too short");
  }

  let careEntryId = input.careEntryId;
  if (careEntryId) {
    const entry = await prisma.careEntry.findUniqueOrThrow({ where: { id: careEntryId } });
    if (entry.patientId !== patientId) {
      throw new ForbiddenError("Action does not belong to this patient");
    }
    assertClinicScope(actor, entry.clinicId);
  } else {
    const latest = await prisma.careEntry.findFirst({
      where: { patientId },
      orderBy: { encounterAt: "desc" },
      select: { id: true },
    });
    if (!latest) {
      throw new ForbiddenError("Create a care note before adding actions");
    }
    careEntryId = latest.id;
  }

  const action = await prisma.careAction.create({
    data: {
      patientId,
      careEntryId,
      createdById: actor.id,
      sourceKey: `custom:${crypto.randomUUID()}`,
      kind: normalizeActionKind(input.kind),
      text,
      status: "PENDING",
    },
    include: { resolvedBy: { select: { name: true } } },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: "CARE_ACTION_CREATE",
      entityType: "CareAction",
      entityId: action.id,
      metadata: { userId: actor.id, entryId: careEntryId },
    },
  });
  invalidateGlanceCache(patientId);
  return toGlanceShape(action);
}

export async function patchPatientAction(
  actor: Actor,
  patientId: string,
  actionId: string,
  input: {
    status?: "PENDING" | "RESOLVED";
    kind?: string;
    text?: string;
    careEntryId?: string;
    startOffset?: number;
    endOffset?: number;
  },
) {
  assertClinicalActor(actor);
  await loadPatientScope(patientId, actor);

  let row = await prisma.careAction.findFirst({
    where: {
      patientId,
      OR: [{ id: actionId }, { sourceKey: actionId }],
    },
    include: { resolvedBy: { select: { name: true } } },
  });

  if (!row) {
    if (!input.careEntryId || !(input.text ?? "").trim()) {
      throw new ForbiddenError("Unknown action");
    }
    const entry = await prisma.careEntry.findUniqueOrThrow({ where: { id: input.careEntryId } });
    if (entry.patientId !== patientId) {
      throw new ForbiddenError("Action does not belong to this patient");
    }
    assertClinicScope(actor, entry.clinicId);
    row = await prisma.careAction.create({
      data: {
        patientId,
        careEntryId: entry.id,
        createdById: actor.id,
        sourceKey: actionId,
        kind: normalizeActionKind(input.kind),
        text: redactPhi(input.text!.trim()),
        status: "PENDING",
      },
      include: { resolvedBy: { select: { name: true } } },
    });
  }

  const nextKind = input.kind !== undefined ? normalizeActionKind(input.kind) : normalizeActionKind(row.kind);
  const nextText = input.text !== undefined ? redactPhi(input.text.trim()) : row.text;
  const resolving = input.status === "RESOLVED" && row.status !== "RESOLVED";

  const updated = await prisma.careAction.update({
    where: { id: row.id },
    data: {
      kind: nextKind,
      text: nextText,
      status: input.status ?? row.status,
      resolvedAt: resolving ? new Date() : row.resolvedAt,
      resolvedById: resolving ? actor.id : row.resolvedById,
      resolvedByRole: resolving ? actor.role : row.resolvedByRole,
    },
    include: { resolvedBy: { select: { name: true } } },
  });

  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: resolving ? "CARE_ACTION_RESOLVE" : "CARE_ACTION_UPDATE",
      entityType: "CareAction",
      entityId: updated.id,
      metadata: { userId: actor.id, entryId: updated.careEntryId },
    },
  });
  invalidateGlanceCache(patientId);
  return toGlanceShape(updated);
}
