"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../lib/api/client";
import type { GlanceAction, GlanceHighlight, GlanceTopCard } from "../../lib/cache/glanceCache";
import { subscribePatientRefresh } from "../../lib/events/patientRefresh";

export async function loadGlance(patientId: string, userId: string): Promise<GlanceTopCard> {
  return apiFetch<GlanceTopCard>(`/api/patients/${patientId}/glance`, { userId });
}

function timelineHref(item: {
  careEntryId: string;
  startOffset?: number;
  endOffset?: number;
  provenancePointer?: string | null;
}): string {
  const params = new URLSearchParams({ entryId: item.careEntryId });
  if (item.startOffset !== undefined) {
    params.set("offset", String(item.startOffset));
  }
  if (item.endOffset !== undefined) {
    params.set("endOffset", String(item.endOffset));
  }
  if (item.provenancePointer) {
    params.set("pointer", item.provenancePointer);
  }
  return `/timeline?${params.toString()}`;
}

export function GlanceView({ patientId, userId }: { patientId: string; userId: string }) {
  const [card, setCard] = useState<GlanceTopCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setCard(await loadGlance(patientId, userId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load glance");
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
    return <p className="status">Loading glance card…</p>;
  }
  if (error) {
    return <p className="status error" role="alert">{error}</p>;
  }
  if (!card) {
    return <p className="status">No glance data.</p>;
  }

  return (
    <section className="glance-card" aria-label="Patient glance top card">
      <div className="glance-score">
        <p className="label">Recency score</p>
        <p className="score" data-testid="recency-score">
          {card.recencyScore}
        </p>
      </div>
      <div>
        <h2>Highest-risk highlights</h2>
        {card.highestRiskHighlights.length === 0 ? (
          <p className="muted">No high-risk highlights.</p>
        ) : (
          <ul className="jump-list">
            {card.highestRiskHighlights.map((highlight: GlanceHighlight) => (
              <li key={highlight.id}>
                <Link
                  className="jump-link"
                  href={timelineHref(highlight)}
                >
                  <strong>{highlight.label ?? "risk"}</strong> — {highlight.excerpt}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h2>Unresolved actions</h2>
        {card.unresolvedActions.length === 0 ? (
          <p className="muted">No open actions.</p>
        ) : (
          <ul className="jump-list">
            {card.unresolvedActions.map((action: GlanceAction) => (
              <li key={action.id}>
                <Link className="jump-link" href={timelineHref(action)}>
                  {action.text}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
