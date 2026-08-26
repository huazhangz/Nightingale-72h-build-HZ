"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "../../lib/api/client";
import type { GlanceAction, GlanceHighlight, GlanceTopCard } from "../../lib/cache/glanceCache";
import { subscribePatientRefresh } from "../../lib/events/patientRefresh";
import { ConsultationBoard } from "./ConsultationBoard";
import { RecencyExplainer } from "./RecencyExplainer";
import { riskBadgeClass } from "../../lib/care-note/risk-tone";
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
        <div>
          <h2>{t("glance.riskTitle")}</h2>
          {risks.length === 0 ? (
            <p className="muted">{t("glance.noRisk")}</p>
          ) : (
            <ul className="jump-list">
              {risks.map((highlight: GlanceHighlight) => (
                <li key={highlight.id}>
                  <Link className="jump-link" href={timelineHref(highlight)}>
                    <span className={`badge ${riskBadgeClass(highlight.label)}`}>
                      {highlight.source === "HUMAN" ? (
                        <span aria-hidden="true">
                          {highlight.createdByRole === "STAFF" ? "🩺" : "⚕️"}
                        </span>
                      ) : (
                        <span aria-hidden="true">🤖</span>
                      )}{" "}
                      {t(riskLabelKey(highlight.label))}
                    </span>
                    {highlight.excerpt}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {!isPatient ? (
      <div>
        <h2>{t("glance.actionsTitle")}</h2>
        {actions.length === 0 ? (
          <p className="muted">{t("glance.noActions")}</p>
        ) : (
          <ul className="jump-list">
            {actions.map((action: GlanceAction) => (
              <li key={action.id}>
                <Link className="jump-link" href={actionHref(action)}>
                  {!isPatient ? (
                    <span className={`badge ${riskBadgeClass("UNRESOLVED_ACTION")}`}>
                      {t(`action.${action.kind}` as MessageKey)}
                    </span>
                  ) : null}
                  {action.text}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      ) : null}
    </section>
  );
}
