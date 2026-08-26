export type RiskTone = "critical" | "medium" | "low";

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

export function riskTone(label: string | null | undefined): RiskTone {
  const normalized = label?.trim().toLowerCase() ?? "";
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
