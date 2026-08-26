export type GlanceHighlight = {
  id: string;
  careEntryId: string;
  excerpt: string;
  label: string | null;
  confidence: number | null;
  startOffset: number;
  endOffset: number;
  provenancePointer: string | null;
  importanceScore: number;
};

export type GlanceAction = {
  id: string;
  kind: "comment" | "highlight" | "plan";
  text: string;
  careEntryId: string;
  startOffset?: number;
  endOffset?: number;
};

export type GlanceTopCard = {
  patientId: string;
  highestRiskHighlights: GlanceHighlight[];
  unresolvedActions: GlanceAction[];
  recencyScore: number;
  generatedAt: string;
};

const glanceCache = new Map<string, GlanceTopCard>();

export function invalidateGlanceCache(patientId: string): void {
  glanceCache.delete(patientId);
}

export function readGlanceCache(patientId: string): GlanceTopCard | undefined {
  return glanceCache.get(patientId);
}

export function writeGlanceCache(patientId: string, card: GlanceTopCard): GlanceTopCard {
  glanceCache.set(patientId, card);
  return card;
}

export function clearGlanceCache(): void {
  glanceCache.clear();
}
