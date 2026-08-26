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
import { ForbiddenError, type Actor, assertClinicScope } from "../auth/rbac";
import { createProvenancePointer } from "./provenance";
import { scoreKeywords } from "../learning/importance";

const RISK_LABELS = new Set(["risk", "red-flag", "red_flag", "critical", "urgent", "high"]);

function recencyScore(latestEncounterAt: Date | null): number {
  if (!latestEncounterAt) {
    return 0;
  }
  const ageDays = Math.max(0, (Date.now() - latestEncounterAt.getTime()) / 86_400_000);
  return Math.round(100 * Math.exp(-ageDays / 14));
}

function isRiskHighlight(label: string | null, confidence: number | null): boolean {
  const normalized = label?.trim().toLowerCase() ?? "";
  if (RISK_LABELS.has(normalized)) {
    return true;
  }
  return (confidence ?? 0) >= 0.75;
}

function isUnresolvedAction(text: string, label: string | null): boolean {
  const haystack = `${label ?? ""} ${text}`.toLowerCase();
  return /todo|follow[- ]?up|unresolved|open action|plan:/.test(haystack);
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

export async function computeGlanceCard(patientId: string): Promise<GlanceTopCard> {
  const entries = await prisma.careEntry.findMany({
    where: { patientId },
    include: {
      highlights: true,
      comments: true,
    },
    orderBy: { encounterAt: "desc" },
  });

  const weightRows = await prisma.featureWeight.findMany();
  const weights = new Map(weightRows.map((row) => [row.featureKey, row.weight]));

  const highlights: GlanceHighlight[] = entries
    .flatMap((entry) =>
      entry.highlights.map((highlight) => ({
        ...highlight,
        careEntryId: entry.id,
        importanceScore: scoreKeywords(highlight.excerpt, weights),
      })),
    )
    .filter((highlight) => isRiskHighlight(highlight.label, highlight.confidence))
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
    }));

  const unresolvedActions: GlanceAction[] = [];
  for (const entry of entries) {
    for (const comment of entry.comments) {
      if (isUnresolvedAction(comment.body, null)) {
        unresolvedActions.push({
          id: comment.id,
          kind: "comment",
          text: redactPhi(comment.body),
          careEntryId: entry.id,
        });
      }
    }
    for (const highlight of entry.highlights) {
      if (isUnresolvedAction(highlight.excerpt, highlight.label)) {
        unresolvedActions.push({
          id: highlight.id,
          kind: "highlight",
          text: redactPhi(highlight.excerpt),
          careEntryId: entry.id,
          startOffset: highlight.startOffset,
          endOffset: highlight.endOffset,
        });
      }
    }
    for (const line of entry.body.split("\n")) {
      if (/^\s*plan:/i.test(line) || /^\s*todo:/i.test(line)) {
        unresolvedActions.push({
          id: `${entry.id}:plan`,
          kind: "plan",
          text: redactPhi(line.trim()),
          careEntryId: entry.id,
        });
      }
    }
  }

  const latest = entries[0]?.encounterAt ?? null;

  return {
    patientId,
    highestRiskHighlights: highlights,
    unresolvedActions: unresolvedActions.slice(0, 8),
    recencyScore: recencyScore(latest),
    generatedAt: new Date().toISOString(),
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
  if (actor.role === "PATIENT" && actor.id !== patientId) {
    throw new ForbiddenError("Patients can only view their own glance card");
  }

  const cached = readGlanceCache(patientId);
  if (cached) {
    return { card: cached, cacheHit: true };
  }

  const card = writeGlanceCache(patientId, await computeGlanceCard(patientId));
  return { card, cacheHit: false };
}
