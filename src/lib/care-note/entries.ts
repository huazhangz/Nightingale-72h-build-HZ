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
import { revertCareEntry } from "./revision";

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
  return entry;
}

export async function patchCareEntry(
  actor: Actor,
  entryId: string,
  input: { body: string; baseVersion: number; title?: string },
) {
  return applyOptimisticEdit({
    entryId,
    userId: actor.id,
    newContent: redactPhi(input.body),
    baseVersion: input.baseVersion,
    title: input.title !== undefined ? redactPhi(input.title) : undefined,
  });
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
  return revertCareEntry(entryId, targetVersion, actor.id);
}
