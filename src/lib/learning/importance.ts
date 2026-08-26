import type { FeedbackVerdict } from "@prisma/client";
import { prisma } from "../db";

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

export async function recordHighlightFeedback(input: {
  highlightId: string;
  userId: string;
  verdict: Extract<FeedbackVerdict, "PIN" | "EDIT" | "AGREE" | "DISAGREE">;
  note?: string;
}): Promise<{ weights: Array<{ featureKey: string; weight: number }> }> {
  const highlight = await prisma.highlight.findUniqueOrThrow({
    where: { id: input.highlightId },
  });
  const delta = VERDICT_DELTA[input.verdict] ?? 0;

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
    const row = await prisma.featureWeight.upsert({
      where: { featureKey },
      create: {
        featureKey,
        weight: Math.max(0, delta),
        description: `Learned importance for "${keyword}"`,
        version: 1,
      },
      update: {
        weight: { increment: delta },
        version: { increment: 1 },
      },
    });
    updated.push({ featureKey: row.featureKey, weight: row.weight });
  }

  return { weights: updated };
}
