import { z } from "zod";
import type { CitationRejection, VerifiedCitation } from "../shared/citations";

export type { VerifiedCitation } from "../shared/citations";

/** Output contract of the handover agent: what the terminal tool accepts and what clinicians see. */

export const SEVERITIES = ["critical", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };

export const CATEGORIES = [
  "critical_finding",
  "active_problem",
  "medication_allergy",
  "pending_action",
  "plan",
  "patient_concern",
  "context",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const FOLLOWUP_KINDS = ["follow_up", "lab_order", "plan"] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

export const CitationInput = z.object({
  note_id: z.string().min(1).describe("note_id of the note this statement comes from"),
  quote: z
    .string()
    .min(1)
    .max(400)
    .describe("Exact words copied from that note's body or comments that support the statement"),
});

export const SummaryItemInput = z.object({
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  statement: z.string().min(1).max(400).describe("One short handover statement"),
  citations: z.array(CitationInput).min(1).max(3),
});

export const HandoverSubmission = z.object({
  items: z.array(SummaryItemInput).max(20),
});

export type HandoverSubmission = z.infer<typeof HandoverSubmission>;

/** Evidence mode (handover-v5): a citation names a server-issued sentence id instead of quoting. */
export const EvidenceCitationInput = z.object({
  evidence_id: z.number().int().min(1).describe("An evidence id (an integer) from get_notes"),
});

export const SummaryItemEvidenceInput = z.object({
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  statement: z.string().min(1).max(400).describe("One short handover statement"),
  citations: z.array(EvidenceCitationInput).min(1).max(3),
});

export const HandoverEvidenceSubmission = z.object({
  items: z.array(SummaryItemEvidenceInput).max(20),
});

export type HandoverEvidenceSubmission = z.infer<typeof HandoverEvidenceSubmission>;
export type SummaryItemInput = z.infer<typeof SummaryItemInput>;

export type ItemFlag = "SEVERITY_UPGRADED" | "PHI_REDACTED";

export type SummaryItem = {
  id: string;
  category: Category;
  severity: Severity;
  statement: string;
  citations: VerifiedCitation[];
  /** "guardrail" items were added by the deterministic safety floor, not written by the model. */
  origin: "model" | "guardrail";
  flags: ItemFlag[];
  /** Severity the model chose, when the safety floor raised it. */
  modelSeverity?: Severity;
};

export type RejectionReason = CitationRejection;

export type GuardrailReport = {
  modelItemCount: number;
  acceptedCount: number;
  rejected: Array<{ index: number; statement: string; reason: RejectionReason; detail?: string }>;
  /** Citations dropped from items that still had at least one valid citation. */
  droppedCitations: Array<{ index: number; noteId: string; reason: RejectionReason }>;
  severityUpgrades: Array<{ itemId: string; from: Severity; findingId: string }>;
  injectedCritical: Array<{ itemId: string; findingId: string; noteId: string; excerpt: string }>;
  requiredCriticalCount: number;
  phiRedactions: number;
};

export type HandoverSummary = {
  items: SummaryItem[];
  generatedAt: string;
};

export type FollowupProposalDraft = {
  ref: string;
  text: string;
  kind: FollowupKind;
  sourceNoteId: string;
  rationale: string;
};
