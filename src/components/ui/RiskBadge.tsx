"use client";

import { useI18n } from "../../lib/i18n/I18nContext";
import type { MessageKey } from "../../lib/i18n/messages";

export type RiskLevelValue = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

const TONE: Record<RiskLevelValue, string> = {
  CRITICAL: "risk-critical",
  HIGH: "risk-high",
  MEDIUM: "risk-medium",
  LOW: "risk-low",
};

/** Patient-level risk badge. Colour is never the only signal: the level is always written out. */
export function RiskBadge({ level, pending }: { level: RiskLevelValue | null; pending?: boolean }) {
  const { t } = useI18n();
  if (!level) {
    return <span className="level-badge level-none">{t(pending ? "worklist.assessing" : "worklist.unassessed")}</span>;
  }
  return (
    <span className={`level-badge ${TONE[level]}`} data-level={level}>
      {t(`risk.level.${level}` as MessageKey)}
    </span>
  );
}

/** Polite live region for status and error messages. */
export function Notice({ tone = "info", children }: { tone?: "info" | "error" | "success"; children: React.ReactNode }) {
  return (
    <p className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"}>
      {children}
    </p>
  );
}
