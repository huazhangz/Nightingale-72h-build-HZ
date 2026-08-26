"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "../../lib/api/client";
import { parseProvenancePointer } from "../../lib/care-note/provenance-utils";
import { subscribePatientRefresh } from "../../lib/events/patientRefresh";
import { ConsultationBoard } from "./ConsultationBoard";
import { riskLabelKey, useI18n } from "../../lib/i18n/I18nContext";

export type TimelineRevision = {
  version: number;
  createdAt: string;
  editorRole: string;
  summary: string | null;
  body: string;
};

export type TimelineEntry = {
  id: string;
  title: string;
  encounterAt: string;
  updatedAt?: string;
  version?: number;
  status?: string;
  consultationStage?: string;
  authorRole?: string;
  authorName?: string;
  assignedClinician?: { name: string; title: string; department: string };
  lastUpdatedBy?: { name: string; role: string };
  patientFacingSummary: string;
  body?: string;
  comments?: Array<{ id: string; authorRole: string; body: string; createdAt: string }>;
  highlights?: Array<{
    id: string;
    excerpt: string;
    label: string | null;
    provenancePointer: string | null;
    startOffset: number;
    endOffset: number;
  }>;
  revisions?: TimelineRevision[];
};

export async function loadTimeline(patientId: string, userId: string): Promise<TimelineEntry[]> {
  const data = await apiFetch<{ entries: TimelineEntry[] }>(`/api/patients/${patientId}/timeline`, {
    userId,
  });
  return data.entries;
}

function markedText(text: string, start?: number, end?: number): ReactNode {
  if (start === undefined || end === undefined || start < 0 || end > text.length || end <= start) {
    return text;
  }
  return (
    <>
      {text.slice(0, start)}
      <mark className="provenance-mark" data-testid="provenance-mark">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

function canShowStaffActions(role: string | undefined, authorRole: string | undefined): boolean {
  return role === "STAFF" && authorRole === "STAFF";
}

function canShowClinicianActions(role: string | undefined, authorRole: string | undefined): boolean {
  return (role === "CLINICIAN" || role === "ADMIN") && authorRole === "CLINICIAN";
}

export function TimelineView({
  patientId,
  userId,
  role,
}: {
  patientId: string;
  userId: string;
  role?: string;
}) {
  const { t, formatDateTime } = useI18n();
  const searchParams = useSearchParams();
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const isPatient = role === "PATIENT";

  const targetEntryId = searchParams?.get("entryId") ?? null;
  let targetStart = searchParams?.get("offset") ?? null;
  let targetEnd = searchParams?.get("endOffset") ?? null;
  const pointer = searchParams?.get("pointer");
  if (pointer) {
    try {
      const parsed = parseProvenancePointer(pointer);
      targetStart = String(parsed.startOffset);
      targetEnd = String(parsed.endOffset);
    } catch {
      // keep query offsets
    }
  }
  const startOffset = targetStart !== null ? Number(targetStart) : undefined;
  const endOffset = targetEnd !== null ? Number(targetEnd) : undefined;

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setEntries(await loadTimeline(patientId, userId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("timeline.error"));
    } finally {
      setLoading(false);
    }
  }, [patientId, userId, t]);

  useEffect(() => {
    void refresh();
    return subscribePatientRefresh(patientId, () => {
      void refresh();
    });
  }, [patientId, refresh]);

  useEffect(() => {
    if (!targetEntryId || loading) {
      return;
    }
    const node = document.getElementById(`entry-${targetEntryId}`);
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [targetEntryId, loading, entries]);

  if (loading) {
    return <p className="status">{t("timeline.loading")}</p>;
  }
  if (error) {
    return <p className="status error" role="alert">{error}</p>;
  }
  if (entries.length === 0) {
    return <p className="status">{t("timeline.empty")}</p>;
  }

  return (
    <ol className="timeline" aria-label={t("timeline.aria")}>
      {entries.map((entry) => {
        const focused = entry.id === targetEntryId;
        const display = isPatient
          ? entry.patientFacingSummary
          : (entry.body ?? entry.patientFacingSummary);
        const showEdit =
          canShowStaffActions(role, entry.authorRole) ||
          canShowClinicianActions(role, entry.authorRole);
        return (
          <li
            key={entry.id}
            id={`entry-${entry.id}`}
            className={focused ? "timeline-item focused" : "timeline-item"}
          >
            <header className="timeline-item-head">
              <h2>{entry.title}</h2>
              <p className="meta">
                {formatDateTime(entry.encounterAt)}
                {isPatient ? null : (
                  <>
                    {" · "}
                    {entry.authorRole}
                    {" · "}
                    {t("timeline.version", { n: entry.version ?? 1 })}
                  </>
                )}
              </p>
              {showEdit ? (
                <Link className="jump-link" href={`/note-editor?entryId=${entry.id}`}>
                  {t("note.editExisting")}
                </Link>
              ) : null}
            </header>
            <p>{focused && !isPatient ? markedText(display, startOffset, endOffset) : display}</p>
            {isPatient && entry.assignedClinician && entry.lastUpdatedBy ? (
              <ConsultationBoard
                stage={entry.consultationStage ?? "SUBMITTED"}
                assignedClinician={entry.assignedClinician}
                lastUpdatedBy={entry.lastUpdatedBy}
                lastUpdatedAt={entry.updatedAt ?? entry.encounterAt}
                formatDateTime={formatDateTime}
              />
            ) : null}
            {!isPatient && (entry.highlights?.length ?? 0) > 0 ? (
              <ul className="chip-row" aria-label={t("timeline.highlights")}>
                {entry.highlights?.map((highlight) => (
                  <li key={highlight.id} className="chip">
                    {t(riskLabelKey(highlight.label))}: {highlight.excerpt}
                  </li>
                ))}
              </ul>
            ) : null}
            {!isPatient && (entry.comments?.length ?? 0) > 0 ? (
              <ul className="comment-list" aria-label={t("timeline.comments")}>
                {entry.comments?.map((comment) => (
                  <li key={comment.id}>
                    <strong>{comment.authorRole}:</strong> {comment.body}
                  </li>
                ))}
              </ul>
            ) : null}
            {role === "CLINICIAN" && entry.revisions && entry.revisions.length > 0 ? (
              <ul className="comment-list" aria-label={t("version.history")}>
                {entry.revisions.map((revision) => (
                  <li key={`${entry.id}-rev-${revision.version}`}>
                    {t("timeline.version", { n: revision.version })}
                    {revision.summary ? ` · ${revision.summary}` : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export const TimelineFeed = TimelineView;
