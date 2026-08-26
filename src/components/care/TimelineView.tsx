"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../lib/api/client";
import { subscribePatientRefresh } from "../../lib/events/patientRefresh";

export type TimelineEntry = {
  id: string;
  title: string;
  encounterAt: string;
  version: number;
  status: string;
  authorRole: string;
  patientFacingSummary: string;
  body?: string;
  comments: Array<{ id: string; authorRole: string; body: string; createdAt: string }>;
  highlights: Array<{ id: string; excerpt: string; label: string | null }>;
};

export async function loadTimeline(patientId: string, userId: string): Promise<TimelineEntry[]> {
  const data = await apiFetch<{ entries: TimelineEntry[] }>(`/api/patients/${patientId}/timeline`, {
    userId,
  });
  return data.entries;
}

export function TimelineView({ patientId, userId }: { patientId: string; userId: string }) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setEntries(await loadTimeline(patientId, userId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load timeline");
    } finally {
      setLoading(false);
    }
  }, [patientId, userId]);

  useEffect(() => {
    void refresh();
    return subscribePatientRefresh(patientId, () => {
      void refresh();
    });
  }, [patientId, refresh]);

  if (loading) {
    return <p className="status">Loading timeline…</p>;
  }
  if (error) {
    return <p className="status error" role="alert">{error}</p>;
  }
  if (entries.length === 0) {
    return <p className="status">No encounters yet. Create a note to start the timeline.</p>;
  }

  return (
    <ol className="timeline" aria-label="Patient encounter timeline">
      {entries.map((entry) => (
        <li key={entry.id} className="timeline-item">
          <header className="timeline-item-head">
            <h2>{entry.title}</h2>
            <p className="meta">
              {new Date(entry.encounterAt).toLocaleString()} · {entry.authorRole} · v{entry.version}
            </p>
          </header>
          <p>{entry.body ?? entry.patientFacingSummary}</p>
          {entry.highlights.length > 0 ? (
            <ul className="chip-row" aria-label="Highlights">
              {entry.highlights.map((highlight) => (
                <li key={highlight.id} className="chip">
                  {highlight.label ?? "highlight"}: {highlight.excerpt}
                </li>
              ))}
            </ul>
          ) : null}
          {entry.comments.length > 0 ? (
            <ul className="comment-list" aria-label="Internal comments">
              {entry.comments.map((comment) => (
                <li key={comment.id}>
                  <strong>{comment.authorRole}:</strong> {comment.body}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
