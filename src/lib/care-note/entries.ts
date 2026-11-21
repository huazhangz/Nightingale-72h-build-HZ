import type { CareEntry } from "@prisma/client";
import {
  type Actor,
  type NoteAuthorRole,
  ForbiddenError,
  assertCanEditNote,
  assertCanWriteNote,
  assertClinicScope,
  assertPatientIsolation,
} from "../auth/rbac";
import { prisma } from "../db";
import { redactPhi } from "../security/redact";
import { applyOptimisticEdit } from "./concurrency";
import { syncLocalRiskHighlights } from "./keyword-highlight-sync";
import { syncConsultationStage } from "./progress-engine";
import { revertCareEntry } from "./revision";
import { enqueueRiskAssessment } from "../agent/risk/queue";

function writeRole(actor: Actor): NoteAuthorRole {
  if (actor.role === "STAFF" || actor.role === "CLINICIAN") {
    return actor.role;
  }
  if (actor.role === "ADMIN") {
    return "CLINICIAN";
  }
  throw new ForbiddenError("Patients cannot write clinical notes");
}

export async function createCareEntry(
  actor: Actor,
  input: {
    patientId: string;
    title: string;
    body: string;
    encounterAt?: string;
  },
): Promise<CareEntry> {
  const patient = await prisma.user.findUniqueOrThrow({ where: { id: input.patientId } });
  if (!patient.clinicId) {
    throw new ForbiddenError("Patient is missing clinic scope");
  }
  assertClinicScope(actor, patient.clinicId);
  assertPatientIsolation(actor, patient.id);
  assertCanWriteNote(actor, writeRole(actor), patient.clinicId);

  const entry = await prisma.careEntry.create({
    data: {
      clinicId: patient.clinicId,
      patientId: patient.id,
      authorId: actor.id,
      title: redactPhi(input.title),
      body: redactPhi(input.body),
      version: 1,
      encounterAt: input.encounterAt ? new Date(input.encounterAt) : new Date(),
    },
  });
  await syncLocalRiskHighlights(entry.id, entry.body, actor.id);
  await syncConsultationStage(entry.id);
  await enqueueRiskAssessment({
    patientId: entry.patientId,
    clinicId: entry.clinicId,
    trigger: "NOTE_CREATED",
    requestedById: actor.id,
  });
  return entry;
}

export async function patchCareEntry(
  actor: Actor,
  entryId: string,
  input: { body: string; baseVersion: number; title?: string },
) {
  const result = await applyOptimisticEdit({
    entryId,
    userId: actor.id,
    newContent: redactPhi(input.body),
    baseVersion: input.baseVersion,
    title: input.title !== undefined ? redactPhi(input.title) : undefined,
  });
  await enqueueRiskAssessment({
    patientId: result.entry.patientId,
    clinicId: result.entry.clinicId,
    trigger: "NOTE_UPDATED",
    requestedById: actor.id,
  });
  return result;
}

export async function revertEntry(actor: Actor, entryId: string, targetVersion: number) {
  const entry = await prisma.careEntry.findUniqueOrThrow({
    where: { id: entryId },
    include: { author: true },
  });
  assertClinicScope(actor, entry.clinicId);
  const authorRole =
    entry.author.role === "STAFF" || entry.author.role === "CLINICIAN"
      ? entry.author.role
      : "CLINICIAN";
  assertCanEditNote(actor, { authorRole, clinicId: entry.clinicId }, { hasVersionSnapshot: true });
  const reverted = await revertCareEntry(entryId, targetVersion, actor.id);
  await syncConsultationStage(entryId);
  await enqueueRiskAssessment({
    patientId: reverted.patientId,
    clinicId: reverted.clinicId,
    trigger: "NOTE_REVERTED",
    requestedById: actor.id,
  });
  return reverted;
}
