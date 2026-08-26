import { prisma } from "../db";
import { invalidateGlanceForCareEntry } from "./glance";
import { createProvenancePointer } from "./provenance-utils";
import { findLocalRiskPhrases } from "./keyword-highlights";

const LOCAL_LABELS = ["HIGH", "CRITICAL"] as const;

export async function syncLocalRiskHighlights(careEntryId: string, body: string, createdById: string): Promise<void> {
  await prisma.highlight.deleteMany({
    where: {
      careEntryId,
      source: "MODEL",
      label: { in: [...LOCAL_LABELS] },
    },
  });

  const hits = findLocalRiskPhrases(body);
  if (hits.length === 0) {
    await invalidateGlanceForCareEntry(careEntryId);
    return;
  }

  await prisma.highlight.createMany({
    data: hits.map((hit) => ({
      careEntryId,
      createdById,
      startOffset: hit.startOffset,
      endOffset: hit.endOffset,
      excerpt: hit.excerpt,
      label: hit.label,
      source: "MODEL" as const,
      confidence: hit.label === "CRITICAL" ? 0.95 : 0.85,
      provenancePointer: createProvenancePointer(careEntryId, hit.startOffset, hit.endOffset),
    })),
  });
  await invalidateGlanceForCareEntry(careEntryId);
}
