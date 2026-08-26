import type { Highlight } from "@prisma/client";
import { type Actor, ForbiddenError, assertClinicScope, assertPatientIsolation } from "../auth/rbac";
import { prisma } from "../db";
import { redactPhi } from "../security/redact";
import { invalidateGlanceForCareEntry } from "./glance";
import { syncConsultationStage } from "./progress-engine";
import { createProvenancePointer } from "./provenance-utils";

const MANUAL_LABELS = new Set([
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "WARNING",
  "INFO",
  "UNRESOLVED_ACTION",
  "PATIENT_INSIGHT",
]);

export async function createHumanHighlight(
  actor: Actor,
  entryId: string,
  input: { startOffset: number; endOffset: number; excerpt?: string; label?: string },
): Promise<Highlight> {
  if (actor.role !== "STAFF" && actor.role !== "CLINICIAN" && actor.role !== "ADMIN") {
    throw new ForbiddenError("Patients cannot create highlights");
  }

  const entry = await prisma.careEntry.findUniqueOrThrow({
    where: { id: entryId },
  });
  assertClinicScope(actor, entry.clinicId);
  assertPatientIsolation(actor, entry.patientId);

  const start = Math.max(0, Math.min(input.startOffset, entry.body.length));
  const end = Math.max(0, Math.min(input.endOffset, entry.body.length));
  if (end - start < 2) {
    throw new ForbiddenError("Highlight selection is too short");
  }

  const excerpt = redactPhi(input.excerpt?.trim() || entry.body.slice(start, end));
  const requested = input.label?.trim().toUpperCase().replace(/[\s-]+/g, "_") ?? "PATIENT_INSIGHT";
  const label = MANUAL_LABELS.has(requested) ? requested : "PATIENT_INSIGHT";

  const highlight = await prisma.highlight.create({
    data: {
      careEntryId: entry.id,
      createdById: actor.id,
      startOffset: start,
      endOffset: end,
      excerpt,
      label,
      source: "HUMAN",
      confidence: 1,
      provenancePointer: createProvenancePointer(entry.id, start, end),
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.id,
      action: "HIGHLIGHT_CREATE",
      entityType: "Highlight",
      entityId: highlight.id,
      metadata: { userId: actor.id, entryId: entry.id, newVersion: entry.version },
    },
  });
  await invalidateGlanceForCareEntry(entry.id);
  await syncConsultationStage(entry.id);
  return highlight;
}
