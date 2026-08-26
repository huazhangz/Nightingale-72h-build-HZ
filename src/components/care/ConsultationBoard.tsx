"use client";

import { CONSULTATION_STAGES, stageIndex } from "../../lib/care-note/transparency-utils";
import { useI18n } from "../../lib/i18n/I18nContext";
import type { MessageKey } from "../../lib/i18n/messages";

const STAGE_KEYS: Record<(typeof CONSULTATION_STAGES)[number], MessageKey> = {
  SUBMITTED: "progress.submitted",
  CLINICIAN_REVIEWING: "progress.reviewing",
  MDT_CONSULTATION: "progress.mdt",
  FINAL_SUMMARY: "progress.final",
};

export function ConsultationBoard({
  stage,
  assignedClinician,
  lastUpdatedBy,
  lastUpdatedAt,
  formatDateTime,
}: {
  stage: (typeof CONSULTATION_STAGES)[number] | string;
  assignedClinician: { name: string; title: string; department: string };
  lastUpdatedBy: { name: string; role: string };
  lastUpdatedAt: string;
  formatDateTime: (value: Date | string | number) => string;
}) {
  const { t } = useI18n();
  const current = Math.max(0, stageIndex(stage));
  const updaterKey =
    lastUpdatedBy.role === "STAFF"
      ? "progress.updatedByStaff"
      : lastUpdatedBy.role === "CLINICIAN"
        ? "progress.updatedByClinician"
        : "progress.updatedByOther";

  return (
    <div className="consult-board" data-testid="consult-board">
      <ol className="consult-stepper" aria-label={t("progress.aria")}>
        {CONSULTATION_STAGES.map((item, index) => (
          <li
            key={item}
            className={
              index < current ? "step done" : index === current ? "step current" : "step"
            }
          >
            <span className="step-index">{index + 1}</span>
            <span>{t(STAGE_KEYS[item])}</span>
          </li>
        ))}
      </ol>
      <p className="meta">
        <strong>{t("progress.assigned")}:</strong> {assignedClinician.name},{" "}
        {assignedClinician.title} · {assignedClinician.department}
      </p>
      <p className="meta">
        <strong>{t("progress.lastUpdated")}:</strong> {t(updaterKey, { name: lastUpdatedBy.name })}{" "}
        · {formatDateTime(lastUpdatedAt)}
      </p>
    </div>
  );
}
