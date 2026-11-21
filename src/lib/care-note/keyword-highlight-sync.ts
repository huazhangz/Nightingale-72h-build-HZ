import { prisma } from "../db";
import { invalidateGlanceForCareEntry } from "./glance";
import { createProvenancePointer } from "./provenance-utils";
import { ENGINE_LABELS, engineConfidence, findLocalRiskPhrases } from "./keyword-highlights";

export async function syncLocalRiskHighlights(careEntryId: string, body: string, createdById: string): Promise<void> {
  await prisma.highlight.deleteMany({
    where: {
      careEntryId,
      source: "MODEL",
      label: { in: [...ENGINE_LABELS] },
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
      confidence: engineConfidence(hit.label),
      provenancePointer: createProvenancePointer(careEntryId, hit.startOffset, hit.endOffset),
    })),
  });
  await invalidateGlanceForCareEntry(careEntryId);
}
