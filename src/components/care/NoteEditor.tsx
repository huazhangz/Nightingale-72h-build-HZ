"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "../../lib/api/client";
import { notifyEntryChanged } from "../../lib/events/patientRefresh";
import { useI18n } from "../../lib/i18n/I18nContext";
import { loadTimeline, type TimelineEntry } from "./TimelineView";

export function NoteEditor({
  patientId,
  userId,
  role,
}: {
  patientId: string;
  userId: string;
  role?: string;
}) {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const requestedEntryId = searchParams?.get("entryId");
  const canWrite = role === "STAFF" || role === "CLINICIAN" || role === "ADMIN";
  const [title, setTitle] = useState("Follow-up visit");
  const [body, setBody] = useState("Plan: review symptoms and continue current care.");
  const [entryId, setEntryId] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadTimeline(patientId, userId)
      .then(setEntries)
      .catch((caught: unknown) => {
        setStatus(caught instanceof Error ? caught.message : t("note.loadError"));
      });
  }, [patientId, userId, t]);

  const editableEntries = entries.filter((entry) => {
    if (role === "STAFF") {
      return entry.authorRole === "STAFF";
    }
    if (role === "CLINICIAN") {
      return entry.authorRole === "CLINICIAN";
    }
    return true;
  });

  useEffect(() => {
    if (!requestedEntryId) {
      return;
    }
    const match = editableEntries.find((entry) => entry.id === requestedEntryId);
    if (!match) {
      return;
    }
    setEntryId(match.id);
    setTitle(match.title);
    setBody(match.body ?? match.patientFacingSummary);
    setVersion(match.version);
  }, [requestedEntryId, entries, role]);

  if (!canWrite) {
    return null;
  }

  async function saveNote() {
    setSaving(true);
    setStatus(null);
    try {
      if (entryId && version !== null) {
        const result = await apiFetch<{
          entry: { id: string; version: number; patientId: string };
        }>(`/api/entries/${entryId}`, {
          userId,
          method: "PATCH",
          body: { body, title, baseVersion: version },
        });
        setVersion(result.entry.version);
        notifyEntryChanged({
          patientId: result.entry.patientId,
          entryId: result.entry.id,
          reason: "updated",
        });
        setStatus(t("note.updated"));
      } else {
        const result = await apiFetch<{ entry: { id: string; version: number; patientId: string } }>(
          "/api/entries",
          {
            userId,
            method: "POST",
            body: { patientId, title, body },
          },
        );
        setEntryId(result.entry.id);
        setVersion(result.entry.version);
        notifyEntryChanged({
          patientId: result.entry.patientId,
          entryId: result.entry.id,
          reason: "created",
        });
        setStatus(t("note.saved"));
      }
      setEntries(await loadTimeline(patientId, userId));
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : t("note.saveError"));
    } finally {
      setSaving(false);
    }
  }

  async function revertNote() {
    if (!entryId || version === null || version < 2) {
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const result = await apiFetch<{
        entry: { id: string; version: number; patientId: string; title: string; body: string };
      }>(`/api/entries/${entryId}/revert`, {
        userId,
        method: "POST",
        body: { targetVersion: version - 1 },
      });
      setVersion(result.entry.version);
      if (result.entry.title) {
        setTitle(result.entry.title);
      }
      if (result.entry.body) {
        setBody(result.entry.body);
      }
      notifyEntryChanged({
        patientId: result.entry.patientId,
        entryId: result.entry.id,
        reason: "reverted",
      });
      setEntries(await loadTimeline(patientId, userId));
      setStatus(t("note.updated"));
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : t("note.saveError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="editor"
      onSubmit={(event) => {
        event.preventDefault();
        void saveNote();
      }}
    >
      <div className="field">
        <label htmlFor="existing-note">{t("note.editExisting")}</label>
        <select
          id="existing-note"
          value={entryId ?? ""}
          onChange={(event) => {
            const nextId = event.target.value || null;
            setEntryId(nextId);
            const match = editableEntries.find((entry) => entry.id === nextId);
            if (match) {
              setTitle(match.title);
              setBody(match.body ?? match.patientFacingSummary);
              setVersion(match.version);
            } else {
              setVersion(null);
            }
          }}
        >
          <option value="">{t("note.createNew")}</option>
          {editableEntries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {t("note.versionOption", { title: entry.title, n: entry.version })}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="note-title">{t("note.title")}</label>
        <input
          id="note-title"
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="note-body">{t("note.body")}</label>
        <textarea
          id="note-body"
          name="body"
          rows={10}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          required
        />
      </div>
      {entryId && version !== null ? (
        <div className="version-history" aria-label={t("version.history")}>
          <p className="muted">{t("version.current", { n: version })}</p>
          <button
            type="button"
            className="btn secondary"
            disabled={saving || version < 2}
            onClick={() => void revertNote()}
          >
            {t("version.revert")}
          </button>
        </div>
      ) : null}
      <button type="submit" className="btn" disabled={saving}>
        {saving ? t("note.saving") : t("note.save")}
      </button>
      {status ? (
        <p className="status" role="status">
          {status}
        </p>
      ) : null}
    </form>
  );
}
