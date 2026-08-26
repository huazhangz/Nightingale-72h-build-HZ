"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { subscribePatientRefresh } from "../../lib/events/patientRefresh";
import { useI18n } from "../../lib/i18n/I18nContext";
import { apiFetch } from "../../lib/api/client";

type SearchHit = {
  id: string;
  title: string;
  encounterAt: string;
  patientFacingSummary: string;
  body?: string;
  authorRole?: string;
};

export function SearchView({
  patientId,
  userId,
  role,
}: {
  patientId: string;
  userId: string;
  role?: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const isPatient = role === "PATIENT";

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const params = new URLSearchParams();
      if (query.trim()) {
        params.set("q", query.trim());
      }
      const qs = params.toString();
      const data = await apiFetch<{ results: SearchHit[] }>(
        `/api/patients/${patientId}/search${qs ? `?${qs}` : ""}`,
        { userId },
      );
      setResults(data.results);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("search.error"));
    }
  }, [patientId, userId, query, t]);

  useEffect(() => {
    void refresh();
    return subscribePatientRefresh(patientId, () => {
      void refresh();
    });
  }, [patientId, refresh]);

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
            <Link className="jump-link search-result-link" href={`/timeline?entryId=${entry.id}`}>
              <h2>{entry.title}</h2>
              <p>{isPatient ? entry.patientFacingSummary : (entry.body ?? entry.patientFacingSummary)}</p>
            </Link>
          </li>
        ))}
      </ul>
      {results.length === 0 ? <p className="muted">{t("search.empty")}</p> : null}
    </section>
  );
}

export const SearchBar = SearchView;
