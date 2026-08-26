export type RiskTone = "critical" | "medium" | "low" | "action" | "insight";

const CRITICAL = new Set([
  "critical",
  "high",
  "risk",
  "red-flag",
  "red_flag",
  "urgent",
]);

const MEDIUM = new Set(["medium", "warning", "moderate", "amber"]);

const LOW = new Set(["low", "info", "informational", "note"]);

const ACTION = new Set(["unresolved_action", "unresolved", "action", "todo"]);

const INSIGHT = new Set(["patient_insight", "insight"]);

export function riskTone(label: string | null | undefined): RiskTone {
  const normalized = label?.trim().toLowerCase() ?? "";
  if (ACTION.has(normalized)) {
    return "action";
  }
  if (INSIGHT.has(normalized)) {
    return "insight";
  }
  if (LOW.has(normalized)) {
    return "low";
  }
  if (MEDIUM.has(normalized)) {
    return "medium";
  }
  if (CRITICAL.has(normalized) || normalized.length === 0) {
    return "critical";
  }
  return "critical";
}

export function riskBadgeClass(label: string | null | undefined): string {
  return `risk-badge risk-${riskTone(label)}`;
}

/** Mandatory reporting floor. Learned weights may reorder within a floor, never demote a higher floor. */
export function clinicalFloorRank(label: string | null | undefined): number {
  const tone = riskTone(label);
  if (tone === "critical") {
    return 100;
  }
  if (tone === "action") {
    return 60;
  }
  if (tone === "medium") {
    return 50;
  }
  if (tone === "insight") {
    return 20;
  }
  return 10;
}
