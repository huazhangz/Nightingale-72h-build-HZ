"use client";

import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "../../lib/api/client";
import { useI18n } from "../../lib/i18n/I18nContext";
import { HighlightedNoteBody } from "./HighlightedNoteBody";
import { HighlightComposer, selectionOffsets } from "./HighlightComposer";
import type { TimelineEntry } from "./TimelineView";

export function NoteDetailModal({
  entry,
  role,
  userId,
  showEdit,
  mode,
  onClose,
  onHighlightCreated,
}: {
  entry: TimelineEntry;
  role?: string;
  userId: string;
  showEdit: boolean;
  mode: "detail" | "history";
  onClose: () => void;
  onHighlightCreated?: () => void;
}) {
  const { t, formatDateTime } = useI18n();
  const isPatient = role === "PATIENT";
  const canHighlight = (role === "STAFF" || role === "CLINICIAN") && Boolean(entry.body) && !isPatient;
  const body = isPatient ? entry.patientFacingSummary : (entry.body ?? entry.patientFacingSummary);
  const revisions = [...(entry.revisions ?? [])].sort((left, right) => left.version - right.version);
  const [draft, setDraft] = useState<{ start: number; end: number; text: string; label: string } | null>(
    null,
  );
  const [savingHighlight, setSavingHighlight] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveHighlight() {
    if (!draft) {
      return;
    }
    setSavingHighlight(true);
    try {
      await apiFetch(`/api/entries/${entry.id}/highlights`, {
        userId,
        method: "POST",
        body: {
          startOffset: draft.start,
          endOffset: draft.end,
          excerpt: draft.text,
          label: draft.label,
        },
      });
      setDraft(null);
      onHighlightCreated?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("note.saveError"));
    } finally {
      setSavingHighlight(false);
    }
  }

  if (mode === "history") {
    return (
      <div className="modal-backdrop" role="presentation" onClick={onClose}>
        <div
          className="modal revision-history-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="revision-history-title"
          onClick={(event) => event.stopPropagation()}
        >
          <h2 id="revision-history-title">{t("version.history")}</h2>
          {revisions.length === 0 ? (
            <p className="muted">{t("version.empty")}</p>
          ) : (
            <table className="revision-table" aria-label={t("version.history")}>
              <thead>
                <tr>
                  <th>{t("version.colTime")}</th>
                  <th>{t("version.colEditor")}</th>
                  <th>{t("version.colDiff")}</th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((revision, index) => {
                  const previous = revisions[index - 1];
                  const diff = revision.summary?.trim()
                    || (previous && previous.body && revision.body && previous.body !== revision.body
                      ? revision.body
                      : revision.body ?? t("version.noSummary"));
                  return (
                    <tr key={`${entry.id}-rev-${revision.version}`}>
                      <td>{formatDateTime(revision.createdAt)}</td>
                      <td>
                        {revision.editorName ?? "—"} ({revision.editorRole})
                        {revision.isCurrent ? ` · ${t("version.currentBadge")}` : null}
                      </td>
                      <td>
                        <pre className="revision-body">{diff}</pre>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              {t("login.cancel")}
            </button>
          </div>
        </div>
      </div>
    );
  }

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
        {canHighlight ? <p className="muted">{t("highlight.selectHint")}</p> : null}
        <div
          className="note-detail-body"
          onMouseUp={
            canHighlight
              ? (event) => {
                  const offsets = selectionOffsets(event.currentTarget);
                  if (!offsets) {
                    return;
                  }
                  setDraft({
                    start: offsets.start,
                    end: offsets.end,
                    text: offsets.text,
                    label: "PATIENT_INSIGHT",
                  });
                }
              : undefined
          }
        >
          <HighlightedNoteBody
            entryId={`${entry.id}-modal`}
            text={body}
            highlights={isPatient ? [] : (entry.highlights ?? [])}
          />
        </div>
        {draft ? (
          <HighlightComposer
            entryId={`${entry.id}-modal`}
            label={draft.label}
            saving={savingHighlight}
            onLabelChange={(label) => setDraft({ ...draft, label })}
            onSave={() => void saveHighlight()}
            onCancel={() => setDraft(null)}
            labelCaption={t("highlight.label")}
            saveCaption={t("highlight.create")}
            cancelCaption={t("highlight.cancel")}
          />
        ) : null}
        {error ? <p className="status error">{error}</p> : null}
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
