import { type Actor, assertPatientIsolation } from "../auth/rbac";
import { getPatientTimeline } from "./timeline";

export type SearchHit = {
  id: string;
  title: string;
  encounterAt: string;
  patientFacingSummary: string;
  body?: string;
  authorRole?: string;
};

export async function searchPatientEntries(
  patientId: string,
  actor: Actor,
  query: string,
): Promise<SearchHit[]> {
  assertPatientIsolation(actor, patientId);
  const entries = await getPatientTimeline(patientId, actor);
  const needle = query.trim().toLowerCase();
  const patientView = actor.role === "PATIENT";

  return entries
    .filter((entry) => {
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
}
