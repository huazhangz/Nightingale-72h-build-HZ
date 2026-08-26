export const CONSULTATION_STAGES = [
  "SUBMITTED",
  "CLINICIAN_REVIEWING",
  "MDT_CONSULTATION",
  "FINAL_SUMMARY",
] as const;

export type ConsultationStageName = (typeof CONSULTATION_STAGES)[number];

export function stageIndex(stage: string): number {
  return (CONSULTATION_STAGES as readonly string[]).indexOf(stage);
}
