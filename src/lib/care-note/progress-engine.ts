import type { ConsultationStage, Role } from "@prisma/client";
import {
  type Actor,
  ForbiddenError,
  assertClinicScope,
  assertPatientIsolation,
} from "../auth/rbac";
import { prisma } from "../db";
import { invalidateGlanceForCareEntry } from "./glance";
import { CONSULTATION_STAGES, type ConsultationStageName } from "./transparency-utils";

const CLINICAL_ROLES = new Set<Role>(["STAFF", "CLINICIAN", "ADMIN"]);

function isClinicalRole(role: Role): boolean {
  return CLINICAL_ROLES.has(role);
}

export function deriveConsultationStage(input: {
  current: ConsultationStage;
  viewerCount: number;
  contributorCount: number;
}): ConsultationStageName {
  if (input.current === "FINAL_SUMMARY") {
    return "FINAL_SUMMARY";
  }
  if (input.contributorCount >= 2) {
    return "MDT_CONSULTATION";
  }
  if (input.viewerCount >= 1) {
    return "CLINICIAN_REVIEWING";
  }
  return "SUBMITTED";
}

export async function syncConsultationStage(entryId: string): Promise<ConsultationStageName> {
  const entry = await prisma.careEntry.findUniqueOrThrow({
    where: { id: entryId },
    include: {
      author: { select: { id: true, role: true } },
      revisions: { select: { editorId: true, editor: { select: { role: true } } } },
      comments: { select: { authorId: true, author: { select: { role: true } } } },
      highlights: { select: { createdById: true, createdBy: { select: { role: true } } } },
      viewers: { select: { userId: true, user: { select: { role: true } } } },
    },
  });

  const contributors = new Set<string>();
  if (isClinicalRole(entry.author.role)) {
    contributors.add(entry.author.id);
  }
  for (const revision of entry.revisions) {
    if (isClinicalRole(revision.editor.role)) {
      contributors.add(revision.editorId);
    }
  }
  for (const comment of entry.comments) {
    if (isClinicalRole(comment.author.role)) {
      contributors.add(comment.authorId);
    }
  }
  for (const highlight of entry.highlights) {
    if (isClinicalRole(highlight.createdBy.role)) {
      contributors.add(highlight.createdById);
    }
  }

  const viewers = new Set(
    entry.viewers.filter((row) => isClinicalRole(row.user.role)).map((row) => row.userId),
  );

  const next = deriveConsultationStage({
    current: entry.consultationStage,
    viewerCount: viewers.size,
    contributorCount: contributors.size,
  });

  if (next !== entry.consultationStage) {
    await prisma.careEntry.update({
      where: { id: entryId },
      data: { consultationStage: next },
    });
    await invalidateGlanceForCareEntry(entryId);
  }
  return next;
}

export async function recordEntryViews(actor: Actor, entryIds: string[]): Promise<
  Array<{ id: string; consultationStage: ConsultationStageName }>
> {
  if (actor.role !== "STAFF" && actor.role !== "CLINICIAN" && actor.role !== "ADMIN") {
    return [];
  }
  const uniqueIds = [...new Set(entryIds.filter(Boolean))];
  const updates: Array<{ id: string; consultationStage: ConsultationStageName }> = [];
  for (const entryId of uniqueIds) {
    const entry = await prisma.careEntry.findUniqueOrThrow({ where: { id: entryId } });
    assertClinicScope(actor, entry.clinicId);
    assertPatientIsolation(actor, entry.patientId);
    await prisma.careEntryViewer.upsert({
      where: { careEntryId_userId: { careEntryId: entryId, userId: actor.id } },
      update: { viewedAt: new Date() },
      create: { careEntryId: entryId, userId: actor.id },
    });
    const stage = await syncConsultationStage(entryId);
    updates.push({ id: entryId, consultationStage: stage });
  }
  return updates;
}

export async function releaseFinalSummary(actor: Actor, entryId: string) {
  if (actor.role !== "CLINICIAN") {
    throw new ForbiddenError("Only clinicians can submit the final summary");
  }
  const entry = await prisma.careEntry.findUniqueOrThrow({ where: { id: entryId } });
  assertClinicScope(actor, entry.clinicId);
  assertPatientIsolation(actor, entry.patientId);
  const updated = await prisma.careEntry.update({
    where: { id: entryId },
    data: { consultationStage: "FINAL_SUMMARY", status: "LOCKED" },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: "NOTE_FINAL_SUMMARY",
      entityType: "CareEntry",
      entityId: entryId,
      metadata: { userId: actor.id, entryId, newVersion: updated.version },
    },
  });
  await invalidateGlanceForCareEntry(entryId);
  return updated;
}

export function isSummaryReleased(stage: string): boolean {
  return stage === "FINAL_SUMMARY";
}

export { CONSULTATION_STAGES };
