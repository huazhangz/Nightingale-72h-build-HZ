"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { subscribePatientRefresh } from "../../lib/events/patientRefresh";
import { useI18n } from "../../lib/i18n/I18nContext";
import { loadTimeline, type TimelineEntry } from "./TimelineView";

export function SearchView({ patientId, userId }: { patientId: string; userId: string }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setEntries(await loadTimeline(patientId, userId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("search.error"));
    }
  }, [patientId, userId, t]);

  useEffect(() => {
    void refresh();
    return subscribePatientRefresh(patientId, () => {
      void refresh();
    });
  }, [patientId, refresh]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return entries;
    }
    return entries.filter((entry) => {
      const haystack = [entry.title, entry.body ?? "", entry.patientFacingSummary]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [entries, query]);

  return (
    <section className="search-panel">
      <div className="field">
        <label htmlFor="note-search">{t("search.label")}</label>
        <input
          id="note-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("search.placeholder")}
        />
      </div>
      {error ? (
        <p className="status error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="search-results" aria-label={t("search.aria")}>
        {results.map((entry) => (
          <li key={entry.id}>
            <h2>{entry.title}</h2>
            <p>{entry.body ?? entry.patientFacingSummary}</p>
          </li>
        ))}
      </ul>
      {results.length === 0 ? <p className="muted">{t("search.empty")}</p> : null}
    </section>
  );
}

export const SearchBar = SearchView;
