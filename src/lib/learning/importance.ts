import type { FeedbackVerdict } from "@prisma/client";
import { ForbiddenError, type Actor, assertClinicScope } from "../auth/rbac";
import { prisma } from "../db";
import { invalidateGlanceForCareEntry } from "../care-note/glance";
import { clinicalFloorRank } from "../care-note/risk-tone";

const STOPWORDS = new Set([
  "this",
  "that",
  "with",
  "from",
  "have",
  "been",
  "were",
  "they",
  "them",
  "then",
  "than",
  "into",
  "plan",
  "note",
  "patient",
]);

const VERDICT_DELTA: Partial<Record<FeedbackVerdict, number>> = {
  PIN: 1,
  EDIT: 0.75,
  AGREE: 0.25,
  DISAGREE: -0.25,
};

export function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z]{4,}/g) ?? []) {
    if (STOPWORDS.has(raw) || seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    keywords.push(raw);
  }
  return keywords;
}

export function keywordFeatureKey(keyword: string): string {
  return `keyword:${keyword.toLowerCase()}`;
}

export function scoreKeywords(text: string, weights: Map<string, number>): number {
  return extractKeywords(text).reduce(
    (total, keyword) => total + (weights.get(keywordFeatureKey(keyword)) ?? 0),
    0,
  );
}

export async function importanceScore(text: string): Promise<number> {
  const keywords = extractKeywords(text);
  if (keywords.length === 0) {
    return 0;
  }
  const rows = await prisma.featureWeight.findMany({
    where: { featureKey: { in: keywords.map(keywordFeatureKey) } },
  });
  const weights = new Map(rows.map((row) => [row.featureKey, row.weight]));
  return scoreKeywords(text, weights);
}

/** Negative learning never reduces the reporting floor of critical/high-risk labels. */
export function weightDeltaForVerdict(
  verdict: FeedbackVerdict,
  highlightLabel: string | null,
): number {
  const delta = VERDICT_DELTA[verdict] ?? 0;
  if (delta < 0 && clinicalFloorRank(highlightLabel) >= 100) {
    return 0;
  }
  return delta;
}

export async function recordHighlightFeedback(input: {
  highlightId: string;
  userId: string;
  verdict: Extract<FeedbackVerdict, "PIN" | "EDIT" | "AGREE" | "DISAGREE">;
  note?: string;
}): Promise<{ weights: Array<{ featureKey: string; weight: number }> }> {
  const highlight = await prisma.highlight.findUniqueOrThrow({
    where: { id: input.highlightId },
  });
  const delta = weightDeltaForVerdict(input.verdict, highlight.label);

  await prisma.highlightFeedback.upsert({
    where: {
      highlightId_userId: {
        highlightId: input.highlightId,
        userId: input.userId,
      },
    },
    create: {
      highlightId: input.highlightId,
      userId: input.userId,
      verdict: input.verdict,
      note: input.note,
    },
    update: {
      verdict: input.verdict,
      note: input.note,
    },
  });

  const updated: Array<{ featureKey: string; weight: number }> = [];
  for (const keyword of extractKeywords(highlight.excerpt)) {
    const featureKey = keywordFeatureKey(keyword);
    const existing = await prisma.featureWeight.findUnique({ where: { featureKey } });
    const nextWeight = Math.max(0, (existing?.weight ?? 0) + delta);
    const row = await prisma.featureWeight.upsert({
      where: { featureKey },
      create: {
        featureKey,
        weight: nextWeight,
        description: `Learned importance for "${keyword}"`,
        version: 1,
      },
      update: {
        weight: nextWeight,
        version: { increment: 1 },
      },
    });
    updated.push({ featureKey: row.featureKey, weight: row.weight });
  }

  await invalidateGlanceForCareEntry(highlight.careEntryId);
  return { weights: updated };
}

export async function submitHighlightFeedback(
  actor: Actor,
  highlightId: string,
  input: {
    verdict: Extract<FeedbackVerdict, "PIN" | "EDIT" | "AGREE" | "DISAGREE">;
    note?: string;
  },
) {
  if (actor.role !== "STAFF" && actor.role !== "CLINICIAN" && actor.role !== "ADMIN") {
    throw new ForbiddenError("Patients cannot submit highlight feedback");
  }
  const highlight = await prisma.highlight.findUniqueOrThrow({
    where: { id: highlightId },
    include: { careEntry: { select: { clinicId: true } } },
  });
  assertClinicScope(actor, highlight.careEntry.clinicId);
  return recordHighlightFeedback({
    highlightId,
    userId: actor.id,
    verdict: input.verdict,
    note: input.note,
  });
}
