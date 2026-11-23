"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch, ApiError } from "../../lib/api/client";
import { useI18n } from "../../lib/i18n/I18nContext";
import type { MessageKey } from "../../lib/i18n/messages";
import { notifyEntryChanged, subscribePatientRefresh } from "../../lib/events/patientRefresh";
import type { PatientRiskView } from "../../lib/agent/risk/repository";
import { Notice, RiskBadge } from "../ui/RiskBadge";

const POLL_MS = 6_000;
const LEVELS = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

function noteHref(noteId: string): string {
  return `/timeline?${new URLSearchParams({ entryId: noteId }).toString()}`;
}

/**
 * Patient risk triage on the Glance page: level, review window, evidence with citations, safety-rule
 * reasons, freshness, reassessment and (clinicians) override. Polls while an assessment is running.
 */
export function RiskPanel({ patientId, role }: { patientId: string; role: string }) {
  const { t, formatDateTime } = useI18n();
  const [view, setView] = useState<PatientRiskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [overriding, setOverriding] = useState(false);
  const [level, setLevel] = useState<(typeof LEVELS)[number] | "CLEAR">("HIGH");
  const [reason, setReason] = useState("");
  const canOverride = role === "CLINICIAN" || role === "ADMIN";

  const load = useCallback(async () => {
    try {
      setView(await apiFetch<PatientRiskView>(`/api/patients/${patientId}/risk`));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("riskPanel.error"));
    }
  }, [patientId, t]);

  useEffect(() => {
    setView(null);
    void load();
    // A saved note queues a new assessment: refresh so "running" shows straight away.
    // Ignore the panel's own "risk" notifications: it already holds the server's answer.
    return subscribePatientRefresh(patientId, (payload) => {
      if (payload.entryId !== "risk") void load();
    });
  }, [patientId, load]);

  useEffect(() => {
    if (!view?.pending) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [view?.pending, load]);

  async function reassess() {
    setBusy(true);
    setError(null);
    try {
      setView(await apiFetch<PatientRiskView>(`/api/patients/${patientId}/risk`, { method: "POST", body: {} }));
      notifyEntryChanged({ patientId, entryId: "risk", reason: "updated" });
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 429 ? t("handover.rateLimited") : caught instanceof Error ? caught.message : t("riskPanel.error"));
    } finally {
      setBusy(false);
    }
  }

  async function saveOverride(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setView(await apiFetch<PatientRiskView>(`/api/patients/${patientId}/risk/override`, { method: "POST", body: { level, reason } }));
      setOverriding(false);
      setReason("");
      notifyEntryChanged({ patientId, entryId: "risk", reason: "updated" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("riskPanel.error"));
    } finally {
      setBusy(false);
    }
  }

  const assessment = view?.assessment ?? null;
  return (
    <section className="glance-block risk-panel" aria-labelledby="risk-panel-title" data-testid="risk-panel">
      <header className="glance-block-head">
        <h2 id="risk-panel-title">{t("riskPanel.title")}</h2>
        <button type="button" className="btn btn-secondary btn-small" onClick={() => void reassess()} disabled={busy}>
          {busy ? t("riskPanel.reassessing") : t("riskPanel.reassess")}
        </button>
      </header>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {view === null && !error ? <p className="status">{t("shell.loading")}</p> : null}
      {view && !assessment ? <p className="muted">{view.pending ? t("riskPanel.pending") : t("riskPanel.none")}</p> : null}
      {assessment ? (
        <>
          <div className="risk-headline">
            <RiskBadge level={assessment.level} />
            <span className="risk-review">{t(`risk.review.${assessment.review}` as MessageKey)}</span>
            <span className="chip chip-quiet">{t(assessment.method === "agent" ? "riskPanel.methodAgent" : "riskPanel.methodRules")}</span>
            {assessment.confidence ? <span className="muted small">{t("riskPanel.confidence", { value: assessment.confidence })}</span> : null}
          </div>
          {assessment.summary ? <p className="risk-summary">{assessment.summary}</p> : null}
          {assessment.override ? (
            <Notice>
              <span>
                {t("riskPanel.overridden", {
                  level: t(`risk.level.${assessment.override.level}` as MessageKey),
                  name: assessment.override.by ?? "—",
                  reason: assessment.override.reason,
                })}
              </span>{" "}
              <span className="muted small">{t("riskPanel.overrideKept")}</span>
            </Notice>
          ) : null}
          {assessment.report?.floorApplied && assessment.modelLevel ? (
            <p className="chip handover-chip-safety">{t("riskPanel.floorApplied", { from: t(`risk.level.${assessment.modelLevel}` as MessageKey) })}</p>
          ) : null}
          {assessment.report?.unsupportedLevel ? <Notice tone="error">{t("riskPanel.unsupported")}</Notice> : null}
          {view?.pending ? <Notice>{t("riskPanel.pending")}</Notice> : view?.stale ? <Notice>{t("riskPanel.stale")}</Notice> : null}

          {assessment.drivers.length > 0 ? (
            <>
              <h3 className="risk-subhead">{t("riskPanel.drivers")}</h3>
              <ul className="risk-drivers">
                {assessment.drivers.map((driver, index) => (
                  <li key={`${driver.factor}-${index}`} className={`risk-driver risk-driver-${driver.direction}`}>
                    <span className="risk-driver-direction">{t(driver.direction === "raises" ? "riskPanel.raises" : "riskPanel.lowers")}</span>
                    <span className="risk-driver-factor">{driver.factor}</span>
                    {driver.citations.map((citation, citationIndex) => (
                      <span key={citationIndex} className="risk-driver-citation">
                        <Link className="handover-citation" href={noteHref(citation.noteId)}>
                          {t("handover.source", { ref: citation.noteId.slice(-6).toUpperCase() })} · {citation.title}
                        </Link>
                        <q className="handover-quote">{citation.quote}</q>
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {assessment.floorReasons.length > 0 && assessment.method === "agent" ? (
            <>
              <h3 className="risk-subhead">{t("riskPanel.floor")}</h3>
              <ul className="risk-floor">
                {assessment.floorReasons.map((reason, index) => (
                  <li key={`${reason.rule}-${index}`}>
                    <RiskBadge level={reason.level} /> {reason.label}: <q>{reason.excerpt}</q> ·{" "}
                    <Link href={noteHref(reason.noteId)}>{reason.title}</Link>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {assessment.hiddenEvidence > 0 ? <p className="muted small">{t("riskPanel.hidden", { count: assessment.hiddenEvidence })}</p> : null}
          <p className="muted small">{t("riskPanel.assessedAt", { time: formatDateTime(assessment.assessedAt) })}</p>

          {canOverride ? (
            overriding ? (
              <form className="risk-override" onSubmit={(event) => void saveOverride(event)}>
                <div className="field">
                  <label htmlFor="risk-override-level">{t("riskPanel.override")}</label>
                  <select id="risk-override-level" value={level} onChange={(event) => setLevel(event.target.value as (typeof LEVELS)[number] | "CLEAR")}>
                    {LEVELS.map((value) => (
                      <option key={value} value={value}>
                        {t(`risk.level.${value}` as MessageKey)}
                      </option>
                    ))}
                    {assessment.override ? <option value="CLEAR">{t("riskPanel.clearOverride")}</option> : null}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="risk-override-reason">{t("riskPanel.overrideReason")}</label>
                  <textarea id="risk-override-reason" required minLength={5} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
                </div>
                <div className="form-actions">
                  <button type="submit" className="btn" disabled={busy || reason.trim().length < 5}>
                    {t("riskPanel.overrideSave")}
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => setOverriding(false)}>
                    {t("login.cancel")}
                  </button>
                </div>
              </form>
            ) : (
              <button type="button" className="btn btn-secondary btn-small" onClick={() => setOverriding(true)}>
                {t("riskPanel.override")}
              </button>
            )
          ) : null}
        </>
      ) : null}
    </section>
  );
}
