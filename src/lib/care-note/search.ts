import { type Actor, assertPatientIsolation } from "../auth/rbac";
import { recencyScore } from "./recency";
import { getPatientTimeline } from "./timeline";

export type SearchHit = {
  id: string;
  title: string;
  encounterAt: string;
  patientFacingSummary: string;
  body?: string;
  authorRole?: string;
};

export type SearchSort = "newest" | "oldest" | "relevance";

export type SearchOptions = {
  sort?: SearchSort;
  from?: string;
  to?: string;
};

function parseDayStart(value: string): Date | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function relevanceScore(entry: {
  title: string;
  patientFacingSummary: string;
  body?: string;
  encounterAt: string;
}, needle: string): number {
  if (!needle) {
    return recencyScore(new Date(entry.encounterAt));
  }
  const title = entry.title.toLowerCase();
  const summary = entry.patientFacingSummary.toLowerCase();
  const body = (entry.body ?? "").toLowerCase();
  let score = recencyScore(new Date(entry.encounterAt)) / 100;
  if (title.includes(needle)) {
    score += 3;
  }
  if (body.includes(needle)) {
    score += 2;
  }
  if (summary.includes(needle)) {
    score += 1;
  }
  return score;
}

export async function searchPatientEntries(
  patientId: string,
  actor: Actor,
  query: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  assertPatientIsolation(actor, patientId);
  const entries = await getPatientTimeline(patientId, actor);
  const needle = query.trim().toLowerCase();
  const patientView = actor.role === "PATIENT";
  const from = options.from ? parseDayStart(options.from) : null;
  const to = options.to ? parseDayStart(options.to) : null;
  const sort: SearchSort = options.sort ?? (needle ? "relevance" : "newest");

  const mapped = entries
    .filter((entry) => {
      const at = new Date(entry.encounterAt);
      if (from && at < from) {
        return false;
      }
      if (to && at > to) {
        return false;
      }
      if (!needle) {
        return true;
      }
      const haystack = patientView
        ? [entry.title, entry.patientFacingSummary]
        : [entry.title, entry.body ?? "", entry.patientFacingSummary];
      return haystack.join(" ").toLowerCase().includes(needle);
    })
    .map((entry) => {
      if (patientView) {
        return {
          id: entry.id,
          title: entry.title,
          encounterAt: entry.encounterAt,
          patientFacingSummary: entry.patientFacingSummary,
        };
      }
      return {
        id: entry.id,
        title: entry.title,
        encounterAt: entry.encounterAt,
        patientFacingSummary: entry.patientFacingSummary,
        body: entry.body,
        authorRole: entry.authorRole,
      };
    });

  mapped.sort((left, right) => {
    if (sort === "oldest") {
      return left.encounterAt.localeCompare(right.encounterAt);
    }
    if (sort === "relevance") {
      const delta =
        relevanceScore(right, needle) - relevanceScore(left, needle);
      if (delta !== 0) {
        return delta;
      }
    }
    return right.encounterAt.localeCompare(left.encounterAt);
  });

  return mapped;
}
