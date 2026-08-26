"use client";

import Link from "next/link";
import { useI18n } from "../../lib/i18n/I18nContext";
import { HighlightedNoteBody } from "./HighlightedNoteBody";
import type { TimelineEntry } from "./TimelineView";

export function NoteDetailModal({
  entry,
  role,
  showEdit,
  onClose,
}: {
  entry: TimelineEntry;
  role?: string;
  showEdit: boolean;
  onClose: () => void;
}) {
  const { t, formatDateTime } = useI18n();
  const isPatient = role === "PATIENT";
  const body = isPatient ? entry.patientFacingSummary : (entry.body ?? entry.patientFacingSummary);
  const revisions = entry.revisions ?? [];

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal note-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-detail-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="timeline-item-head">
          <h2 id="note-detail-title">{entry.title}</h2>
          <p className="meta">
            {formatDateTime(entry.encounterAt)}
            {entry.authorName ? ` · ${entry.authorName}` : null}
            {entry.authorRole ? ` · ${entry.authorRole}` : null}
            {entry.version !== undefined ? ` · ${t("timeline.version", { n: entry.version })}` : null}
          </p>
        </header>
        <p className="note-detail-body">
          <HighlightedNoteBody
            entryId={`${entry.id}-modal`}
            text={body}
            highlights={isPatient ? [] : (entry.highlights ?? [])}
          />
        </p>
        {!isPatient ? (
          <>
            <h3>{t("note.auditTrail")}</h3>
            <ul className="comment-list" aria-label={t("note.auditTrail")}>
              <li>
                {t("note.author")}: {entry.authorName ?? "—"} ({entry.authorRole ?? "—"})
              </li>
              <li>
                {t("progress.lastUpdated")}: {entry.lastUpdatedBy?.name ?? "—"} (
                {entry.lastUpdatedBy?.role ?? "—"})
                {entry.updatedAt ? ` · ${formatDateTime(entry.updatedAt)}` : null}
              </li>
              <li>
                {t("note.status")}: {entry.status ?? "—"}
              </li>
            </ul>
            <h3>{t("version.history")}</h3>
            {revisions.length === 0 ? (
              <p className="muted">{t("version.empty")}</p>
            ) : (
              <ol className="revision-list" aria-label={t("version.history")}>
                {revisions.map((revision) => (
                  <li key={`${entry.id}-modal-rev-${revision.version}`}>
                    <p className="meta">
                      {t("timeline.version", { n: revision.version })}
                      {revision.isCurrent ? ` · ${t("version.currentBadge")}` : null}
                      {" · "}
                      {revision.editorName ?? revision.editorRole}
                      {" · "}
                      {formatDateTime(revision.createdAt)}
                    </p>
                    {revision.body ? <pre className="revision-body">{revision.body}</pre> : null}
                  </li>
                ))}
              </ol>
            )}
            {(entry.comments?.length ?? 0) > 0 ? (
              <>
                <h3>{t("timeline.comments")}</h3>
                <ul className="comment-list" aria-label={t("timeline.comments")}>
                  {entry.comments?.map((comment) => (
                    <li key={comment.id}>
                      <strong>{comment.authorRole}:</strong> {comment.body}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        ) : null}
        <div className="modal-actions">
          {showEdit ? (
            <Link className="btn secondary" href={`/note-editor?entryId=${entry.id}`}>
              {t("note.editExisting")}
            </Link>
          ) : null}
          <button type="button" className="btn" onClick={onClose}>
            {t("login.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
