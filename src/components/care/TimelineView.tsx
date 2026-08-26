"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "../../lib/api/client";
import { parseProvenancePointer } from "../../lib/care-note/provenance-utils";
import { riskBadgeClass } from "../../lib/care-note/risk-tone";
import { subscribePatientRefresh } from "../../lib/events/patientRefresh";
import { ConsultationBoard } from "./ConsultationBoard";
import { HighlightedNoteBody } from "./HighlightedNoteBody";
import { NoteDetailModal } from "./NoteDetailModal";
import { riskLabelKey, useI18n } from "../../lib/i18n/I18nContext";

export type TimelineRevision = {
  version: number;
  createdAt: string;
  editorRole: string;
  editorName?: string;
  summary: string | null;
  body?: string;
  isCurrent?: boolean;
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

function canShowStaffActions(role: string | undefined, authorRole: string | undefined): boolean {
  return role === "STAFF" && authorRole === "STAFF";
}

function canShowClinicianActions(role: string | undefined, authorRole: string | undefined): boolean {
  return role === "CLINICIAN" && authorRole === "CLINICIAN";
}

function authorBadge(authorRole: string | undefined): { className: string; icon: string } {
  if (authorRole === "STAFF") {
    return { className: "author-badge author-badge-staff", icon: "🩺" };
  }
  return { className: "author-badge author-badge-clinician", icon: "⚕️" };
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
  const [detailId, setDetailId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const isPatient = role === "PATIENT";

  const targetEntryId = searchParams?.get("entryId") ?? null;
  const highlightAction = searchParams?.get("highlightAction") === "true";
  const actionId = searchParams?.get("actionId");
  const actionKind = searchParams?.get("actionKind");
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
    if (highlightAction && actionId) {
      const actionNode = document.querySelector(`[data-action-id="${CSS.escape(actionId)}"]`);
      if (actionNode instanceof HTMLElement) {
        actionNode.scrollIntoView({ behavior: "smooth", block: "center" });
        actionNode.classList.add("action-focused");
      }
    }
    if (startOffset !== undefined && endOffset !== undefined) {
      const mark = document.getElementById(`hl-${targetEntryId}-${startOffset}-${endOffset}`);
      mark?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [targetEntryId, loading, entries, startOffset, endOffset, highlightAction, actionId]);

  if (loading) {
    return <p className="status">{t("timeline.loading")}</p>;
  }
  if (error) {
    return <p className="status error" role="alert">{error}</p>;
  }
  if (entries.length === 0) {
    return <p className="status">{t("timeline.empty")}</p>;
  }

  const detailEntry = entries.find((entry) => entry.id === detailId) ?? null;
  const historyEntry = entries.find((entry) => entry.id === historyId) ?? null;
  const modalEntry = detailEntry ?? historyEntry;

  return (
    <>
    <ol className="timeline" aria-label={t("timeline.aria")}>
      {entries.map((entry) => {
        const focused = entry.id === targetEntryId;
        const actionOnEntry =
          highlightAction &&
          (actionId === `${entry.id}:plan` ||
            (actionKind === "comment" && entry.comments?.some((comment) => comment.id === actionId)) ||
            (actionKind === "highlight" &&
              entry.highlights?.some(
                (highlight) =>
                  highlight.id === actionId ||
                  (highlight.startOffset === startOffset && highlight.endOffset === endOffset),
              )));
        const display = isPatient
          ? entry.patientFacingSummary
          : (entry.body ?? entry.patientFacingSummary);
        const showEdit =
          canShowStaffActions(role, entry.authorRole) ||
          canShowClinicianActions(role, entry.authorRole);
        const badge = authorBadge(entry.authorRole);
        const itemRoleClass =
          entry.authorRole === "STAFF"
            ? "timeline-item timeline-item-staff"
            : entry.authorRole === "CLINICIAN"
              ? "timeline-item timeline-item-clinician"
              : "timeline-item";
        const itemClass = [
          itemRoleClass,
          focused ? "focused" : "",
          actionOnEntry ? "action-focused" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <li
            key={entry.id}
            id={`entry-${entry.id}`}
            className={itemClass}
            data-action-id={actionId === `${entry.id}:plan` ? `${entry.id}:plan` : undefined}
          >
            <header className="timeline-item-head">
              <h2>
                {!isPatient && entry.authorRole ? (
                  <span className={badge.className} title={entry.authorRole}>
                    <span aria-hidden="true">{badge.icon}</span>{" "}
                    {t(entry.authorRole === "STAFF" ? "role.STAFF_NOTE" : "role.CLINICIAN_NOTE")}
                  </span>
                ) : null}
                {entry.title}
              </h2>
              <p className="meta">
                {formatDateTime(entry.encounterAt)}
                {isPatient ? null : (
                  <>
                    {" · "}
                    {entry.authorName ?? entry.authorRole}
                    {" · "}
                    {t("timeline.version", { n: entry.version ?? 1 })}
                  </>
                )}
              </p>
              <div className="timeline-actions">
                {!isPatient ? (
                  <button
                    type="button"
                    className="jump-link"
                    onClick={() => {
                      setHistoryId(null);
                      setDetailId(entry.id);
                    }}
                  >
                    {t("timeline.viewDetail")}
                  </button>
                ) : null}
                {!isPatient ? (
                  <button
                    type="button"
                    className="jump-link"
                    onClick={() => {
                      setDetailId(null);
                      setHistoryId(entry.id);
                    }}
                  >
                    {t("timeline.viewHistory")}
                  </button>
                ) : null}
                {showEdit ? (
                  <Link className="jump-link" href={`/note-editor?entryId=${entry.id}`}>
                    {t("note.editExisting")}
                  </Link>
                ) : null}
              </div>
            </header>
            <p className="note-body">
              {isPatient ? (
                display
              ) : (
                <HighlightedNoteBody
                  entryId={entry.id}
                  text={display}
                  highlights={entry.highlights ?? []}
                  focusStart={focused ? startOffset : undefined}
                  focusEnd={focused ? endOffset : undefined}
                />
              )}
            </p>
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
                  <li key={highlight.id}>
                    <button
                      type="button"
                      data-action-id={highlight.id}
                      className={`chip ${riskBadgeClass(highlight.label)}${
                        highlightAction && actionId === highlight.id ? " action-focused" : ""
                      }`}
                      onClick={() => {
                        const mark = document.getElementById(
                          `hl-${entry.id}-${highlight.startOffset}-${highlight.endOffset}`,
                        );
                        document.getElementById(`entry-${entry.id}`)?.scrollIntoView({
                          behavior: "smooth",
                          block: "center",
                        });
                        mark?.scrollIntoView({ behavior: "smooth", block: "center" });
                        mark?.classList.add("provenance-mark");
                      }}
                    >
                      {t(riskLabelKey(highlight.label))}: {highlight.excerpt}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {!isPatient && (entry.comments?.length ?? 0) > 0 ? (
              <ul className="comment-list" aria-label={t("timeline.comments")}>
                {entry.comments?.map((comment) => (
                  <li
                    key={comment.id}
                    data-action-id={comment.id}
                    className={highlightAction && actionId === comment.id ? "action-focused" : undefined}
                  >
                    <strong>{comment.authorRole}:</strong> {comment.body}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
    {modalEntry && !isPatient ? (
      <NoteDetailModal
        entry={modalEntry}
        role={role}
        showEdit={
          canShowStaffActions(role, modalEntry.authorRole) ||
          canShowClinicianActions(role, modalEntry.authorRole)
        }
        onClose={() => {
          setDetailId(null);
          setHistoryId(null);
        }}
      />
    ) : null}
    </>
  );
}

export const TimelineFeed = TimelineView;
