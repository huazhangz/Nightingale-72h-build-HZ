"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../lib/api/client";
import type { GlanceAction, GlanceHighlight, GlanceTopCard } from "../../lib/cache/glanceCache";
import { subscribePatientRefresh } from "../../lib/events/patientRefresh";
import { ConsultationBoard } from "./ConsultationBoard";
import { RecencyExplainer } from "./RecencyExplainer";
import { riskBadgeClass, riskTone } from "../../lib/care-note/risk-tone";
import { riskLabelKey, useI18n } from "../../lib/i18n/I18nContext";
import type { MessageKey } from "../../lib/i18n/messages";

export async function loadGlance(patientId: string, userId: string): Promise<GlanceTopCard> {
  return apiFetch<GlanceTopCard>(`/api/patients/${patientId}/glance`, { userId });
}

function actionHref(action: GlanceAction): string {
  const params = new URLSearchParams({
    entryId: action.careEntryId,
    highlightAction: "true",
    actionId: action.id,
    actionKind: action.kind,
  });
  if (action.startOffset !== undefined) {
    params.set("offset", String(action.startOffset));
  }
  if (action.endOffset !== undefined) {
    params.set("endOffset", String(action.endOffset));
  }
  return `/timeline?${params.toString()}`;
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

function AlertIcon() {
  return (
    <svg className="glance-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 3.1 2.7 20.2h18.6L12 3.1Zm0 5.4c.5 0 .8.4.8.9v4.3c0 .5-.3.9-.8.9s-.9-.4-.9-.9V9.4c0-.5.4-.9.9-.9Zm0 8.3c.6 0 1.1.5 1.1 1.1S12.6 19 12 19s-1.1-.5-1.1-1.1.5-1.1 1.1-1.1Z"
      />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg className="glance-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M4 6.5A1.5 1.5 0 1 0 4 9.5 1.5 1.5 0 0 0 4 6.5Zm4 .3h13v2H8v-2Zm-4 5.2A1.5 1.5 0 1 0 4 15.5 1.5 1.5 0 0 0 4 12Zm4 .3h13v2H8v-2Zm-4 5.2A1.5 1.5 0 1 0 4 21.5 1.5 1.5 0 0 0 4 17.5Zm4 .3h13v2H8v-2Z"
      />
    </svg>
  );
}

function noteRef(careEntryId: string): string {
  return careEntryId.slice(-6).toUpperCase();
}

export function GlanceView({
  patientId,
  userId,
  role,
}: {
  patientId: string;
  userId: string;
  role?: string;
}) {
  const { t, formatDateTime } = useI18n();
  const [card, setCard] = useState<GlanceTopCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const isPatient = role === "PATIENT";

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setCard(await loadGlance(patientId, userId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("glance.error"));
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

  if (loading) {
    return <p className="status">{t("glance.loading")}</p>;
  }
  if (error) {
    return <p className="status error" role="alert">{error}</p>;
  }
  if (!card) {
    return <p className="status">{t("glance.empty")}</p>;
  }

  const actions = isPatient ? [] : card.unresolvedActions;
  const risks = isPatient ? [] : card.highestRiskHighlights;

  return (
    <section className="glance-card glance-top" aria-label={t("glance.aria")}>
      {!isPatient ? (
      <div className="glance-score">
        <p className="label">{t("glance.recency")}</p>
        <RecencyExplainer score={card.recencyScore ?? 0} />
        <p className="muted" data-testid="recency-generated">
          {formatDateTime(card.generatedAt)}
        </p>
      </div>
      ) : null}
      {card.transparency ? (
        <ConsultationBoard
          stage={card.transparency.consultationStage}
          assignedClinician={card.transparency.assignedClinician}
          lastUpdatedBy={card.transparency.lastUpdatedBy}
          lastUpdatedAt={card.transparency.lastUpdatedAt}
          formatDateTime={formatDateTime}
        />
      ) : null}
      {!isPatient ? (
        <section className="glance-block">
          <header className="glance-block-head">
            <AlertIcon />
            <h2>{t("glance.riskTitle")}</h2>
          </header>
          {risks.length === 0 ? (
            <p className="muted">{t("glance.noRisk")}</p>
          ) : (
            <ul className="risk-stack">
              {risks.map((highlight: GlanceHighlight) => (
                <li key={highlight.id}>
                  <Link className="risk-card" href={timelineHref(highlight)}>
                    <span className={`status-pill ${riskBadgeClass(highlight.label)}`}>
                      {t(riskLabelKey(highlight.label))}
                    </span>
                    <span className="risk-card-body">
                      {highlight.source === "HUMAN" ? t("highlight.manual") : t("highlight.model")}
                      {": "}
                      {highlight.excerpt}
                    </span>
                    <span className="risk-card-ref">
                      {t("glance.viewNote")} #{noteRef(highlight.careEntryId)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {!isPatient ? (
      <section className="glance-block">
        <header className="glance-block-head">
          <ListIcon />
          <h2>{t("glance.actionsTitle")}</h2>
        </header>
        {actions.length === 0 ? (
          <p className="muted">{t("glance.noActions")}</p>
        ) : (
          <ul className="action-stack">
            {actions.map((action: GlanceAction) => (
              <li key={action.id}>
                <Link className="action-card" href={actionHref(action)}>
                  <div className="action-card-head">
                    <span className="action-pending">{t("action.pending")}</span>
                    <span className="action-card-title">
                      {t(`action.${action.kind}` as MessageKey)}
                    </span>
                    <span className={`status-pill ${riskBadgeClass("UNRESOLVED_ACTION")}`}>
                      {t(`action.${action.kind}` as MessageKey)}
                    </span>
                  </div>
                  <div className={`action-subblock tone-${riskTone("UNRESOLVED_ACTION")}`}>
                    <p className="action-sub-meta">
                      {t("glance.viewNote")} #{noteRef(action.careEntryId)}
                    </p>
                    <p className="action-sub-text">{action.text}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      ) : null}
    </section>
  );
}
