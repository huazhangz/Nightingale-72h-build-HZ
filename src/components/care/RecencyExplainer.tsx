"use client";

import { RECENCY_FORMULA } from "../../lib/care-note/recency";
import { useI18n } from "../../lib/i18n/I18nContext";

export function RecencyExplainer({
  score,
  testId = "recency-score",
}: {
  score: number;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="recency-with-help">
      <span className="score" data-testid={testId}>
        {score}
      </span>
      <details className="info-tip">
        <summary aria-label={t("recency.aria")}>?</summary>
        <div className="info-popover" role="tooltip">
          <p>
            <code>{RECENCY_FORMULA}</code>
          </p>
          <p>{t("glance.recencyMeaning")}</p>
        </div>
      </details>
    </div>
  );
}
