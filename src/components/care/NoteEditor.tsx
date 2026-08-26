"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api/client";
import { notifyEntryChanged } from "../../lib/events/patientRefresh";
import { loadTimeline, type TimelineEntry } from "./TimelineView";

export function NoteEditor({ patientId, userId }: { patientId: string; userId: string }) {
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
        setStatus(caught instanceof Error ? caught.message : "Unable to load notes");
      });
  }, [patientId, userId]);

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
        setStatus("Note updated. Timeline and glance will refresh.");
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
        setStatus("Note saved. Timeline and glance will refresh.");
      }
      setEntries(await loadTimeline(patientId, userId));
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : "Save failed");
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
        <label htmlFor="existing-note">Edit existing note</label>
        <select
          id="existing-note"
          value={entryId ?? ""}
          onChange={(event) => {
            const nextId = event.target.value || null;
            setEntryId(nextId);
            const match = entries.find((entry) => entry.id === nextId);
            if (match) {
              setTitle(match.title);
              setBody(match.body ?? match.patientFacingSummary);
              setVersion(match.version);
            } else {
              setVersion(null);
            }
          }}
        >
          <option value="">Create new note</option>
          {entries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.title} (v{entry.version})
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="note-title">Title</label>
        <input
          id="note-title"
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="note-body">Clinical note</label>
        <textarea
          id="note-body"
          name="body"
          rows={10}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          required
        />
      </div>
      <button type="submit" className="btn" disabled={saving}>
        {saving ? "Saving…" : "Save note"}
      </button>
      {status ? (
        <p className="status" role="status">
          {status}
        </p>
      ) : null}
    </form>
  );
}
