export type GlanceHighlight = {
  id: string;
  careEntryId: string;
  excerpt: string;
  label: string | null;
  confidence: number | null;
  startOffset: number;
  endOffset: number;
  provenancePointer: string | null;
  source?: string;
  createdByRole?: string;
  importanceScore: number;
};

export type GlanceActionKind = "comment" | "highlight" | "plan" | "lab_order" | "follow_up";

export type GlanceAction = {
  id: string;
  kind: GlanceActionKind;
  text: string;
  careEntryId: string;
  startOffset?: number;
  endOffset?: number;
  status?: "PENDING" | "RESOLVED";
  sourceKey?: string;
  resolvedAt?: string | null;
  resolvedByRole?: string | null;
  resolvedByName?: string | null;
};

export type GlanceTransparency = {
  consultationStage: "SUBMITTED" | "CLINICIAN_REVIEWING" | "MDT_CONSULTATION" | "FINAL_SUMMARY";
  assignedClinician: { name: string; title: string; department: string };
  lastUpdatedBy: { name: string; role: string };
  lastUpdatedAt: string;
};

export type GlanceTopCard = {
  patientId: string;
  highestRiskHighlights: GlanceHighlight[];
  unresolvedActions: GlanceAction[];
  resolvedActions?: GlanceAction[];
  recencyScore?: number;
  generatedAt: string;
  transparency?: GlanceTransparency;
};

const glanceCache = new Map<string, GlanceTopCard>();

function roleCacheKey(patientId: string, role: string): string {
  return `${patientId}:${role}`;
}

export function invalidateGlanceCache(patientId: string): void {
  glanceCache.delete(patientId);
  for (const key of [...glanceCache.keys()]) {
    if (key.startsWith(`${patientId}:`)) {
      glanceCache.delete(key);
    }
  }
}

export function readGlanceCache(patientId: string, role?: string): GlanceTopCard | undefined {
  if (role) {
    return glanceCache.get(roleCacheKey(patientId, role));
  }
  return glanceCache.get(patientId);
}

export function writeGlanceCache(
  patientId: string,
  card: GlanceTopCard,
  role?: string,
): GlanceTopCard {
  const key = role ? roleCacheKey(patientId, role) : patientId;
  glanceCache.set(key, card);
  return card;
}

export function clearGlanceCache(): void {
  glanceCache.clear();
}
