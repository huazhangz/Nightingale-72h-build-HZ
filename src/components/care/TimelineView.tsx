"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "../../lib/api/client";
import { parseProvenancePointer } from "../../lib/care-note/provenance-utils";
import { riskBadgeClass } from "../../lib/care-note/risk-tone";
import { notifyEntryChanged, subscribePatientRefresh } from "../../lib/events/patientRefresh";
import { ConsultationBoard } from "./ConsultationBoard";
import { HighlightedNoteBody } from "./HighlightedNoteBody";
import { NoteDetailModal } from "./NoteDetailModal";
import { RecencyExplainer } from "./RecencyExplainer";
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

export type TimelineHighlight = {
  id: string;
  excerpt: string;
  label: string | null;
  provenancePointer: string | null;
  startOffset: number;
  endOffset: number;
  source?: string;
  createdByRole?: string;
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
  summaryReleased?: boolean;
  body?: string;
  comments?: Array<{ id: string; authorRole: string; body: string; createdAt: string }>;
  highlights?: TimelineHighlight[];
  revisions?: TimelineRevision[];
  recencyScore?: number;
  archived?: boolean;
  decayed?: boolean;
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

function selectionOffsets(root: HTMLElement): { start: number; end: number; text: string } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    return null;
  }
  const prefix = document.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  const end = start + range.toString().length;
  const text = range.toString().trim();
  if (!text || end - start < 2) {
    return null;
  }
  return { start, end, text };
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
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<{
    entryId: string;
    start: number;
    end: number;
    text: string;
    label: string;
  } | null>(null);
  const [savingHighlight, setSavingHighlight] = useState(false);
  const [submittingFinal, setSubmittingFinal] = useState<string | null>(null);
  const isPatient = role === "PATIENT";
  const canHighlight = role === "STAFF" || role === "CLINICIAN";

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
    if (isPatient || loading || entries.length === 0) {
      return;
    }
    const ids = entries.map((entry) => entry.id);
    void apiFetch<{ updates: Array<{ id: string; consultationStage: string }> }>(
      `/api/patients/${patientId}/views`,
      { userId, method: "POST", body: { entryIds: ids } },
    )
      .then((data) => {
        if (!data.updates?.length) {
          return;
        }
        setEntries((current) =>
          current.map((entry) => {
            const next = data.updates.find((row) => row.id === entry.id);
            return next ? { ...entry, consultationStage: next.consultationStage } : entry;
          }),
        );
      })
      .catch(() => {
        /* viewing is best-effort */
      });
  }, [isPatient, loading, patientId, userId, entries.map((entry) => entry.id).join(",")]);

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

  async function saveHighlight() {
    if (!draft) {
      return;
    }
    setSavingHighlight(true);
    try {
      await apiFetch(`/api/entries/${draft.entryId}/highlights`, {
        userId,
        method: "POST",
        body: {
          startOffset: draft.start,
          endOffset: draft.end,
          excerpt: draft.text,
          label: draft.label,
        },
      });
      notifyEntryChanged({ patientId, entryId: draft.entryId, reason: "updated" });
      setDraft(null);
      setEntries(await loadTimeline(patientId, userId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("note.saveError"));
    } finally {
      setSavingHighlight(false);
    }
  }

  async function submitFinal(entryId: string) {
    setSubmittingFinal(entryId);
    try {
      const result = await apiFetch<{
        entry: { id: string; consultationStage: string; patientId?: string };
      }>(`/api/entries/${entryId}/final-summary`, { userId, method: "POST", body: {} });
      notifyEntryChanged({
        patientId,
        entryId: result.entry.id,
        reason: "updated",
      });
      setEntries(await loadTimeline(patientId, userId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("note.saveError"));
    } finally {
      setSubmittingFinal(null);
    }
  }

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
  const active = entries.filter((entry) => !entry.archived);
  const archived = entries.filter((entry) => entry.archived);
  const visible = showArchived ? [...active, ...archived] : active;

  function renderEntry(entry: TimelineEntry, muted: boolean) {
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
      ? entry.summaryReleased
        ? entry.patientFacingSummary
        : t("progress.summaryPending")
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
      muted ? "timeline-item-archived" : "",
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
            {!isPatient && entry.recencyScore !== undefined ? (
              <>
                {" · "}
                {t("timeline.recency")}{" "}
                <RecencyExplainer score={entry.recencyScore} testId={`timeline-recency-${entry.id}`} />
              </>
            ) : null}
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
        <div
          className="note-body"
          onMouseUp={
            canHighlight && entry.body
              ? (event) => {
                  const offsets = selectionOffsets(event.currentTarget);
                  if (!offsets) {
                    return;
                  }
                  setDraft({
                    entryId: entry.id,
                    start: offsets.start,
                    end: offsets.end,
                    text: offsets.text,
                    label: "PATIENT_INSIGHT",
                  });
                }
              : undefined
          }
        >
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
        </div>
        {draft?.entryId === entry.id ? (
          <form
            className="highlight-draft"
            onSubmit={(event) => {
              event.preventDefault();
              void saveHighlight();
            }}
          >
            <label htmlFor={`hl-label-${entry.id}`}>{t("highlight.label")}</label>
            <select
              id={`hl-label-${entry.id}`}
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            >
              <option value="PATIENT_INSIGHT">PATIENT_INSIGHT</option>
              <option value="UNRESOLVED_ACTION">UNRESOLVED_ACTION</option>
              <option value="CRITICAL">CRITICAL</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="LOW">LOW</option>
            </select>
            <button type="submit" className="btn" disabled={savingHighlight}>
              {t("highlight.create")}
            </button>
            <button type="button" className="btn secondary" onClick={() => setDraft(null)}>
              {t("highlight.cancel")}
            </button>
          </form>
        ) : null}
        {entry.assignedClinician && entry.lastUpdatedBy ? (
          <ConsultationBoard
            stage={entry.consultationStage ?? "SUBMITTED"}
            assignedClinician={entry.assignedClinician}
            lastUpdatedBy={entry.lastUpdatedBy}
            lastUpdatedAt={entry.updatedAt ?? entry.encounterAt}
            formatDateTime={formatDateTime}
            canSubmitFinal={
              role === "CLINICIAN" && entry.consultationStage !== "FINAL_SUMMARY"
            }
            submittingFinal={submittingFinal === entry.id}
            onSubmitFinal={() => void submitFinal(entry.id)}
          />
        ) : null}
        {!isPatient && (entry.highlights?.length ?? 0) > 0 ? (
          <ul className="chip-row" aria-label={t("timeline.highlights")}>
            {entry.highlights?.map((highlight) => {
              const manual = highlight.source === "HUMAN";
              const icon = manual
                ? highlight.createdByRole === "STAFF"
                  ? "🩺"
                  : "⚕️"
                : "🤖";
              const originClass = manual
                ? highlight.createdByRole === "STAFF"
                  ? "chip-manual-staff"
                  : "chip-manual-clinician"
                : "chip-model";
              return (
                <li key={highlight.id}>
                  <button
                    type="button"
                    data-action-id={highlight.id}
                    className={`chip ${riskBadgeClass(highlight.label)} ${originClass}${
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
                    <span aria-hidden="true">{icon}</span>{" "}
                    {manual ? t("highlight.manual") : t("highlight.model")} ·{" "}
                    {t(riskLabelKey(highlight.label))}: {highlight.excerpt}
                  </button>
                </li>
              );
            })}
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
  }

  return (
    <>
    <h2 className="timeline-heading">{t("timeline.longitudinal")}</h2>
    {canHighlight ? <p className="muted">{t("highlight.selectHint")}</p> : null}
    <ol className="timeline" aria-label={t("timeline.aria")}>
      {visible.filter((entry) => !entry.archived).map((entry) => renderEntry(entry, false))}
    </ol>
    {archived.length > 0 ? (
      <section className="archived-notes">
        <label className="archived-toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />{" "}
          {t("timeline.archivedToggle")}
        </label>
        {showArchived ? (
          <>
            <h3>{t("timeline.archivedHeading")}</h3>
            <ol className="timeline timeline-archived" aria-label={t("timeline.archivedHeading")}>
              {archived.map((entry) => renderEntry(entry, true))}
            </ol>
          </>
        ) : null}
      </section>
    ) : null}
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
