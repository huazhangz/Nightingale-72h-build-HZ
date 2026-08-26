import {
  NoteSection,
  type Actor,
  assertClinicScope,
  assertPatientIsolation,
  canReadAiDoctorContent,
  canReadInternalComments,
  canReadRevisionLog,
  canReadSection,
  isAiDoctorHighlight,
  isUnreleasedClinicianDraft,
} from "../auth/rbac";
import { ForbiddenError } from "../auth/rbac";
import { prisma } from "../db";
import { resolveAssignedClinician } from "./transparency";
import { redactPhi } from "../security/redact";
import { archiveFlagsForEntry } from "./decay";
import { recencyScore } from "./recency";

function patientFacingSummary(body: string): string {
  const first = body.split(/\n+/)[0]?.trim() ?? "";
  return redactPhi(first).slice(0, 240);
}

function includeRawBody(actor: Actor, authorRole: string, status: string): boolean {
  if (!canReadSection(actor, NoteSection.RAW_NOTE)) {
    return false;
  }
  if (actor.role === "STAFF" && isUnreleasedClinicianDraft(authorRole, status)) {
    return false;
  }
  return true;
}

export async function getPatientTimeline(patientId: string, actor: Actor) {
  const patient = await prisma.user.findUniqueOrThrow({ where: { id: patientId } });
  if (!patient.clinicId) {
    throw new ForbiddenError("Patient is missing clinic scope");
  }
  assertClinicScope(actor, patient.clinicId);
  assertPatientIsolation(actor, patientId);

  const assignedClinician = patient.clinicId
    ? await resolveAssignedClinician(patient.clinicId)
    : { name: "Attending clinician", title: "Attending Physician", department: "Internal Medicine" };

  const includeComments = actor.role !== "PATIENT" && canReadInternalComments(actor.role);
  const includeRevisions = actor.role !== "PATIENT" && canReadRevisionLog(actor.role);
  const includeAiDoctor = canReadAiDoctorContent(actor.role);

  const entries = await prisma.careEntry.findMany({
    where: { patientId },
    include: {
      author: { select: { id: true, role: true, name: true } },
      comments: {
        include: { author: { select: { id: true, role: true } } },
        orderBy: { createdAt: "asc" as const },
      },
      highlights: {
        include: { createdBy: { select: { role: true } } },
        orderBy: { createdAt: "asc" },
      },
      revisions: includeRevisions
        ? {
            orderBy: { version: "asc" as const },
            include: { editor: { select: { role: true, name: true } } },
          }
        : {
            orderBy: { version: "desc" as const },
            take: 1,
            include: { editor: { select: { role: true, name: true } } },
          },
    },
    orderBy: { encounterAt: "desc" },
  });

  return entries.map((entry) => {
    const authorRole = entry.author.role;
    const latestRevision = Array.isArray(entry.revisions) ? entry.revisions.at(-1) : undefined;
    const lastUpdatedBy = latestRevision
      ? { name: latestRevision.editor.name, role: latestRevision.editor.role }
      : { name: entry.author.name, role: entry.author.role };

    const highlightRows = Array.isArray(entry.highlights) ? entry.highlights : [];
    const commentRows = entry.comments;
    const flags = archiveFlagsForEntry({
      encounterAt: entry.encounterAt,
      body: entry.body,
      comments: commentRows,
      highlights: highlightRows,
    });

    if (actor.role === "PATIENT") {
      return {
        id: entry.id,
        title: redactPhi(entry.title),
        encounterAt: entry.encounterAt.toISOString(),
        updatedAt: entry.updatedAt.toISOString(),
        consultationStage: entry.consultationStage,
        assignedClinician,
        lastUpdatedBy,
        patientFacingSummary: patientFacingSummary(entry.body),
        archived: flags.archived,
        decayed: flags.decayed,
      };
    }

    const showRaw = includeRawBody(actor, authorRole, entry.status);
    const redactedBody = redactPhi(entry.body);
    const comments = includeComments
      ? commentRows.map((comment) => ({
          id: comment.id,
          authorRole: comment.author.role,
          body: redactPhi(comment.body),
          createdAt: comment.createdAt.toISOString(),
        }))
      : [];

    const highlights = highlightRows
      .filter((highlight) => {
        if (!includeAiDoctor && isAiDoctorHighlight(highlight.source, highlight.createdBy.role)) {
          return false;
        }
        if (!showRaw && highlight.source === "MODEL") {
          return false;
        }
        return true;
      })
      .map((highlight) => ({
        id: highlight.id,
        excerpt: redactPhi(highlight.excerpt),
        label: highlight.label,
        provenancePointer: highlight.provenancePointer,
        startOffset: highlight.startOffset,
        endOffset: highlight.endOffset,
        source: highlight.source,
        createdByRole: highlight.createdBy.role,
      }));

    const historical =
      includeRevisions && Array.isArray(entry.revisions)
        ? entry.revisions.map((revision) => ({
            version: revision.version,
            createdAt: revision.createdAt.toISOString(),
            editorRole: revision.editor.role,
            editorName: revision.editor.name,
            summary: revision.summary,
            body: showRaw ? redactPhi(revision.body) : undefined,
            isCurrent: false as const,
          }))
        : [];

    const currentRevision = {
      version: entry.version,
      createdAt: entry.updatedAt.toISOString(),
      editorRole: lastUpdatedBy.role,
      editorName: lastUpdatedBy.name,
      summary: "current",
      body: showRaw ? redactedBody : undefined,
      isCurrent: true as const,
    };

    const revisions = includeRevisions
      ? [
          ...historical.filter((revision) => revision.version !== entry.version),
          currentRevision,
        ]
      : undefined;

    return {
      id: entry.id,
      title: redactPhi(entry.title),
      encounterAt: entry.encounterAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
      version: entry.version,
      status: entry.status,
      consultationStage: entry.consultationStage,
      authorRole,
      authorName: entry.author.name,
      assignedClinician,
      lastUpdatedBy,
      patientFacingSummary: patientFacingSummary(entry.body),
      body: showRaw ? redactedBody : undefined,
      comments,
      highlights,
      revisions,
      recencyScore: recencyScore(entry.encounterAt),
      archived: flags.archived,
      decayed: flags.decayed,
    };
  });
}
