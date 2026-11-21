"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../../lib/api/client";
import { notifyEntryChanged } from "../../lib/events/patientRefresh";
import { useI18n } from "../../lib/i18n/I18nContext";
import type { MessageKey } from "../../lib/i18n/messages";
import type { PublicRun } from "../../lib/agent/handover/repository";
import type { Severity, SummaryItem } from "../../lib/agent/handover/schema";

type AgentStatus = { available: boolean; client: "anthropic" | "simulated"; model: string; promptVersion: string };

const SEVERITY_TONE: Record<Severity, string> = { critical: "risk-critical", warning: "risk-medium", info: "risk-low" };

function noteRef(noteId: string): string {
  return noteId.slice(-6).toUpperCase();
}

function citationHref(noteId: string): string {
  return `/timeline?${new URLSearchParams({ entryId: noteId }).toString()}`;
}

function SparkIcon() {
  return (
    <svg className="glance-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 2.5 13.9 8l5.6 1.9-5.6 1.9L12 17.4l-1.9-5.6L4.5 9.9 10.1 8 12 2.5Zm6.5 11 1 2.9 2.9 1-2.9 1-1 2.9-1-2.9-2.9-1 2.9-1 1-2.9Z"
      />
    </svg>
  );
}

function ItemRow({ item }: { item: SummaryItem }) {
  const { t } = useI18n();
  return (
    <li className={`handover-item${item.origin === "guardrail" ? " handover-item-guardrail" : ""}`}>
      <div className="handover-item-head">
        <span className={`status-pill risk-badge ${SEVERITY_TONE[item.severity]}`}>
          {t(`handover.severity.${item.severity}` as MessageKey)}
        </span>
        <span className="handover-statement">{item.statement}</span>
      </div>
      {item.origin === "guardrail" || item.modelSeverity ? (
        <p className="handover-flags">
          {item.origin === "guardrail" ? <span className="chip handover-chip-safety">{t("handover.addedBySafety")}</span> : null}
          {item.modelSeverity ? (
            <span className="chip handover-chip-safety">
              {t("handover.severityRaised", { from: t(`handover.severity.${item.modelSeverity}` as MessageKey) })}
            </span>
          ) : null}
        </p>
      ) : null}
      <ul className="handover-citations">
        {item.citations.map((citation, index) => (
          <li key={`${citation.noteId}-${index}`}>
            <Link className="handover-citation" href={citationHref(citation.noteId)}>
              {t("handover.source", { ref: noteRef(citation.noteId) })} · {citation.title}
            </Link>
            <q className="handover-quote">{citation.quote}</q>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function HandoverPanel({ patientId, userId }: { patientId: string; userId: string }) {
  const { t, formatDateTime } = useI18n();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [run, setRun] = useState<PublicRun | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyProposal, setBusyProposal] = useState<string | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRun(null);
    setError(null);
    void Promise.all([
      apiFetch<AgentStatus>("/api/agent/status", { userId }),
      apiFetch<{ run: PublicRun | null }>(`/api/patients/${patientId}/handover`, { userId }),
    ])
      .then(([agentStatus, latest]) => {
        if (!cancelled) {
          setStatus(agentStatus);
          setRun(latest.run);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : t("handover.error"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [patientId, userId, t]);

  useEffect(() => () => {
    if (timer.current) {
      clearInterval(timer.current);
    }
  }, []);

  const generate = useCallback(async () => {
    setRunning(true);
    setError(null);
    setElapsed(0);
    const started = Date.now();
    timer.current = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    try {
      const response = await apiFetch<{ run: PublicRun }>(`/api/patients/${patientId}/handover`, {
        userId,
        method: "POST",
        body: {},
      });
      setRun(response.run);
      setShowRemoved(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        setError(t("handover.rateLimited"));
      } else {
        setError(caught instanceof Error ? caught.message : t("handover.error"));
      }
    } finally {
      if (timer.current) {
        clearInterval(timer.current);
      }
      setRunning(false);
    }
  }, [patientId, userId, t]);

  async function decide(proposalId: string, decision: "accept" | "dismiss") {
    setBusyProposal(proposalId);
    try {
      const { proposal } = await apiFetch<{ proposal: { id: string; status: "ACCEPTED" | "DISMISSED" } }>(
        `/api/agent/proposals/${proposalId}`,
        { userId, method: "POST", body: { decision } },
      );
      setRun((current) =>
        current
          ? {
              ...current,
              proposals: current.proposals.map((item) =>
                item.id === proposal.id ? { ...item, status: proposal.status } : item,
              ),
            }
          : current,
      );
      if (decision === "accept") {
        notifyEntryChanged({ patientId, entryId: "action", reason: "updated" });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("handover.error"));
    } finally {
      setBusyProposal(null);
    }
  }

  const items = run?.summary?.items ?? [];
  const report = run?.guardrail ?? null;
  const tokens = run
    ? run.usage.inputTokens + run.usage.outputTokens + run.usage.cacheReadTokens + run.usage.cacheWriteTokens
    : 0;

  return (
    <section className="glance-block handover-panel" aria-label={t("handover.title")} data-testid="handover-panel">
      <header className="glance-block-head">
        <SparkIcon />
        <h2>{t("handover.title")}</h2>
        {status?.available ? (
          <button type="button" className="btn action-add-btn" onClick={() => void generate()} disabled={running}>
            {run ? t("handover.regenerate") : t("handover.generate")}
          </button>
        ) : null}
      </header>
      <p className="muted handover-disclaimer">{t("handover.disclaimer")}</p>
      {status && !status.available ? <p className="muted">{t("handover.unavailable")}</p> : null}
      {status?.client === "simulated" ? <p className="chip handover-chip-sim">{t("handover.simulated")}</p> : null}
      {running ? (
        <p className="status" role="status" aria-live="polite">
          {t("handover.running", { seconds: elapsed })}
        </p>
      ) : null}
      {error ? (
        <p className="status error" role="alert">
          {error}
        </p>
      ) : null}

      {run && !running ? (
        <>
          {run.degraded ? (
            <p className="status error" role="alert">
              {t("handover.degraded", { outcome: run.outcome ?? "FAILED" })}
            </p>
          ) : null}
          {report && (report.rejected.length || report.severityUpgrades.length || report.injectedCritical.length) ? (
            <p className="chip-row handover-report">
              {report.rejected.length ? (
                <button type="button" className="chip" onClick={() => setShowRemoved((open) => !open)}>
                  {t("handover.rejected", { count: report.rejected.length })}
                </button>
              ) : null}
              {report.severityUpgrades.length ? (
                <span className="chip">{t("handover.upgraded", { count: report.severityUpgrades.length })}</span>
              ) : null}
              {report.injectedCritical.length ? (
                <span className="chip">{t("handover.injected", { count: report.injectedCritical.length })}</span>
              ) : null}
            </p>
          ) : null}
          {showRemoved && report ? (
            <ul className="handover-removed" aria-label={t("handover.showRemoved")}>
              {report.rejected.map((rejection) => (
                <li key={rejection.index}>
                  <s>{rejection.statement}</s> — {t(`handover.reason.${rejection.reason}` as MessageKey)}
                </li>
              ))}
            </ul>
          ) : null}

          {items.length === 0 ? (
            <p className="muted">{t("handover.noItems")}</p>
          ) : (
            <ol className="handover-items">
              {items.map((item) => (
                <ItemRow key={item.id} item={item} />
              ))}
            </ol>
          )}

          {run.proposals.length ? (
            <section className="handover-proposals">
              <h3>{t("handover.proposals")}</h3>
              <ul>
                {run.proposals.map((proposal) => (
                  <li key={proposal.id} className="action-card">
                    <p className="action-sub-text">{proposal.text}</p>
                    <p className="muted">
                      {proposal.rationale} ·{" "}
                      <Link href={citationHref(proposal.sourceNoteId)}>
                        {t("handover.source", { ref: noteRef(proposal.sourceNoteId) })}
                      </Link>
                    </p>
                    {proposal.status === "PROPOSED" ? (
                      <div className="handover-proposal-actions">
                        <button
                          type="button"
                          className="btn"
                          disabled={busyProposal === proposal.id}
                          onClick={() => void decide(proposal.id, "accept")}
                        >
                          {t("handover.accept")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busyProposal === proposal.id}
                          onClick={() => void decide(proposal.id, "dismiss")}
                        >
                          {t("handover.dismiss")}
                        </button>
                      </div>
                    ) : (
                      <p className="muted">
                        {proposal.status === "ACCEPTED" ? t("handover.accepted") : t("handover.dismissed")}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="muted handover-meta" data-testid="handover-meta">
            {t("handover.meta", {
              model: run.servedModel ?? run.model,
              prompt: run.promptVersion,
              steps: run.steps,
              seconds: Math.round((run.durationMs ?? 0) / 100) / 10,
              tokens,
            })}{" "}
            · {formatDateTime(run.finishedAt ?? run.startedAt)}
          </p>
        </>
      ) : null}
      {!run && !running && status?.available ? <p className="muted">{t("handover.empty")}</p> : null}
    </section>
  );
}
