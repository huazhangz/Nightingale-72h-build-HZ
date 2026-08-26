import { NoteSection, type Actor, assertClinicScope, canReadSection } from "../auth/rbac";
import { ForbiddenError } from "../auth/rbac";
import { prisma } from "../db";
import { redactPhi } from "../security/redact";

function patientFacingSummary(body: string): string {
  const first = body.split(/\n+/)[0]?.trim() ?? "";
  return redactPhi(first).slice(0, 240);
}

export async function getPatientTimeline(patientId: string, actor: Actor) {
  const patient = await prisma.user.findUniqueOrThrow({ where: { id: patientId } });
  if (!patient.clinicId) {
    throw new ForbiddenError("Patient is missing clinic scope");
  }
  assertClinicScope(actor, patient.clinicId);
  if (actor.role === "PATIENT" && actor.id !== patientId) {
    throw new ForbiddenError("Patients can only view their own timeline");
  }

  const entries = await prisma.careEntry.findMany({
    where: { patientId },
    include: {
      author: { select: { id: true, role: true, name: true } },
      comments: {
        include: { author: { select: { id: true, role: true } } },
        orderBy: { createdAt: "asc" },
      },
      highlights: { orderBy: { createdAt: "asc" } },
    },
    orderBy: { encounterAt: "desc" },
  });

  const includeRaw = canReadSection(actor, NoteSection.RAW_NOTE);
  const includeComments = canReadSection(actor, NoteSection.INTERNAL_COMMENT);

  return entries.map((entry) => {
    const redactedBody = redactPhi(entry.body);
    return {
      id: entry.id,
      title: redactPhi(entry.title),
      encounterAt: entry.encounterAt.toISOString(),
      version: entry.version,
      status: entry.status,
      authorRole: entry.author.role,
      patientFacingSummary: patientFacingSummary(entry.body),
      body: includeRaw ? redactedBody : undefined,
      comments: includeComments
        ? entry.comments.map((comment) => ({
            id: comment.id,
            authorRole: comment.author.role,
            body: redactPhi(comment.body),
            createdAt: comment.createdAt.toISOString(),
          }))
        : [],
      highlights: includeRaw
        ? entry.highlights.map((highlight) => ({
            id: highlight.id,
            excerpt: redactPhi(highlight.excerpt),
            label: highlight.label,
            provenancePointer: highlight.provenancePointer,
            startOffset: highlight.startOffset,
            endOffset: highlight.endOffset,
          }))
        : [],
    };
  });
}
