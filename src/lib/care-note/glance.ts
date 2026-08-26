import { prisma } from "../db";
import { redactPhi } from "../security/redact";
import {
  invalidateGlanceCache,
  readGlanceCache,
  writeGlanceCache,
  type GlanceAction,
  type GlanceHighlight,
  type GlanceTopCard,
} from "../cache/glanceCache";
import {
  ForbiddenError,
  type Actor,
  assertClinicScope,
  assertPatientIsolation,
  canReadAiDoctorContent,
  canReadInternalComments,
  isAiDoctorHighlight,
  isUnreleasedClinicianDraft,
} from "../auth/rbac";
import { createProvenancePointer } from "./provenance-utils";
import { recencyScore } from "./recency";
import { isUnresolvedActionText } from "./unresolved";
import { scoreKeywords } from "../learning/importance";
import { resolveAssignedClinician } from "./transparency";
import { normalizeActionKind, type ActionKind } from "./actions";

const RISK_LABELS = new Set([
  "risk",
  "red-flag",
  "red_flag",
  "critical",
  "urgent",
  "high",
  "medium",
  "warning",
  "low",
  "info",
]);

function isRiskHighlight(label: string | null, confidence: number | null): boolean {
  const normalized = label?.trim().toLowerCase() ?? "";
  if (normalized === "patient_insight" || normalized === "unresolved_action") {
    return false;
  }
  if (RISK_LABELS.has(normalized)) {
    return true;
  }
  return (confidence ?? 0) >= 0.75;
}

function isUnresolvedAction(text: string, label: string | null): boolean {
  return isUnresolvedActionText(text, label);
}

export async function invalidateGlanceForCareEntry(careEntryId: string): Promise<void> {
  const entry = await prisma.careEntry.findUnique({
    where: { id: careEntryId },
    select: { patientId: true },
  });
  if (entry) {
    invalidateGlanceCache(entry.patientId);
  }
}

export async function computeGlanceCard(patientId: string, actor: Actor): Promise<GlanceTopCard> {
  const patientView = actor.role === "PATIENT";
  const entries = await prisma.careEntry.findMany({
    where: { patientId },
    include: {
      author: { select: { role: true, name: true } },
      highlights: patientView
        ? false
        : { include: { createdBy: { select: { role: true } } } },
      comments: patientView ? false : true,
    },
    orderBy: { encounterAt: "desc" },
  });

  const includeComments = canReadInternalComments(actor.role);
  const includeAiDoctor = canReadAiDoctorContent(actor.role);

  const weights = patientView
    ? new Map<string, number>()
    : new Map(
        (await prisma.featureWeight.findMany()).map((row) => [row.featureKey, row.weight]),
      );

  const highlights: GlanceHighlight[] = patientView
    ? []
    : entries
        .flatMap((entry) =>
          entry.highlights
            .filter((highlight) => {
              if (
                !includeAiDoctor &&
                isAiDoctorHighlight(highlight.source, highlight.createdBy.role)
              ) {
                return false;
              }
              if (
                actor.role === "STAFF" &&
                isUnreleasedClinicianDraft(entry.author.role, entry.status)
              ) {
                return false;
              }
              return isRiskHighlight(highlight.label, highlight.confidence);
            })
            .map((highlight) => ({
              ...highlight,
              careEntryId: entry.id,
              importanceScore: scoreKeywords(highlight.excerpt, weights),
            })),
        )
        .sort(
          (left, right) =>
            right.importanceScore - left.importanceScore ||
            (right.confidence ?? 0) - (left.confidence ?? 0),
        )
        .slice(0, 5)
        .map((highlight) => ({
          id: highlight.id,
          careEntryId: highlight.careEntryId,
          excerpt: redactPhi(highlight.excerpt),
          label: highlight.label,
          confidence: highlight.confidence,
          startOffset: highlight.startOffset,
          endOffset: highlight.endOffset,
          provenancePointer:
            highlight.provenancePointer ??
            createProvenancePointer(highlight.careEntryId, highlight.startOffset, highlight.endOffset),
          importanceScore: highlight.importanceScore,
          source: highlight.source,
          createdByRole: highlight.createdBy.role,
        }));

  const unresolvedActions: GlanceAction[] = [];
  const storedActions = patientView
    ? []
    : await prisma.careAction.findMany({
        where: { patientId },
        include: { resolvedBy: { select: { name: true } } },
        orderBy: { updatedAt: "desc" },
      });
  const storedBySource = new Map(storedActions.map((row) => [row.sourceKey, row]));

  if (!patientView) {
  for (const entry of entries) {
    const hideClinicianDraft =
      actor.role === "STAFF" && isUnreleasedClinicianDraft(entry.author.role, entry.status);

    if (includeComments && !patientView) {
      for (const comment of entry.comments) {
        if (isUnresolvedAction(comment.body, null) && !storedBySource.has(comment.id)) {
          unresolvedActions.push({
            id: comment.id,
            kind: "comment",
            text: redactPhi(comment.body),
            careEntryId: entry.id,
            status: "PENDING",
            sourceKey: comment.id,
          });
        }
      }
    }

    if (!patientView && !hideClinicianDraft) {
      for (const highlight of entry.highlights) {
        if (
          !includeAiDoctor &&
          isAiDoctorHighlight(highlight.source, highlight.createdBy.role)
        ) {
          continue;
        }
        if (isUnresolvedAction(highlight.excerpt, highlight.label) && !storedBySource.has(highlight.id)) {
          unresolvedActions.push({
            id: highlight.id,
            kind: "highlight",
            text: redactPhi(highlight.excerpt),
            careEntryId: entry.id,
            startOffset: highlight.startOffset,
            endOffset: highlight.endOffset,
            status: "PENDING",
            sourceKey: highlight.id,
          });
        }
      }
    }

    const planSource = hideClinicianDraft || patientView ? entry.body.split(/\n+/)[0] ?? "" : entry.body;
    for (const line of planSource.split("\n")) {
      if (/^\s*plan:/i.test(line) || /^\s*todo:/i.test(line)) {
        const sourceKey = `${entry.id}:plan`;
        if (!storedBySource.has(sourceKey)) {
          unresolvedActions.push({
            id: sourceKey,
            kind: "plan",
            text: redactPhi(line.trim()),
            careEntryId: entry.id,
            status: "PENDING",
            sourceKey,
          });
        }
      }
    }
  }
  }

  for (const row of storedActions) {
    if (row.status !== "PENDING") {
      continue;
    }
    unresolvedActions.push({
      id: row.id,
      kind: normalizeActionKind(row.kind) as ActionKind,
      text: redactPhi(row.text),
      careEntryId: row.careEntryId,
      status: "PENDING",
      sourceKey: row.sourceKey,
    });
  }

  const resolvedActions: GlanceAction[] = storedActions
    .filter((row) => row.status === "RESOLVED")
    .slice(0, 12)
    .map((row) => ({
      id: row.id,
      kind: normalizeActionKind(row.kind) as ActionKind,
      text: redactPhi(row.text),
      careEntryId: row.careEntryId,
      status: "RESOLVED" as const,
      sourceKey: row.sourceKey,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolvedByRole: row.resolvedByRole,
      resolvedByName: row.resolvedBy?.name ?? null,
    }));

  const latestEntry = entries[0] ?? null;
  const patientRow = await prisma.user.findUniqueOrThrow({ where: { id: patientId } });
  const assignedClinician = patientRow.clinicId
    ? await resolveAssignedClinician(patientRow.clinicId)
    : { name: "Attending clinician", title: "Attending Physician", department: "Internal Medicine" };

  const transparency = latestEntry
    ? {
        consultationStage: latestEntry.consultationStage,
        assignedClinician,
        lastUpdatedBy: { name: latestEntry.author.name, role: latestEntry.author.role },
        lastUpdatedAt: latestEntry.updatedAt.toISOString(),
      }
    : undefined;

  if (patientView) {
    return {
      patientId,
      highestRiskHighlights: [],
      unresolvedActions: [],
      resolvedActions: [],
      generatedAt: new Date().toISOString(),
      transparency,
    };
  }

  return {
    patientId,
    highestRiskHighlights: highlights,
    unresolvedActions: unresolvedActions.slice(0, 8),
    resolvedActions,
    recencyScore: recencyScore(latestEntry?.encounterAt ?? null),
    generatedAt: new Date().toISOString(),
    transparency,
  };
}

export async function getGlanceCard(
  patientId: string,
  actor: Actor,
): Promise<{ card: GlanceTopCard; cacheHit: boolean }> {
  const patient = await prisma.user.findUniqueOrThrow({ where: { id: patientId } });
  if (!patient.clinicId) {
    throw new ForbiddenError("Patient is missing clinic scope");
  }
  assertClinicScope(actor, patient.clinicId);
  assertPatientIsolation(actor, patientId);
  if (actor.role === "PATIENT" && actor.id !== patientId) {
    throw new ForbiddenError("Patients can only view their own glance card");
  }

  const cached = readGlanceCache(patientId, actor.role);
  if (cached) {
    return { card: cached, cacheHit: true };
  }

  const card = writeGlanceCache(patientId, await computeGlanceCard(patientId, actor), actor.role);
  return { card, cacheHit: false };
}
